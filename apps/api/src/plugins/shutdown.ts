/**
 * Graceful shutdown wiring (P4-API-01).
 *
 * Registers SIGTERM + SIGINT handlers that call `app.close()` so Fastify
 * drains in-flight requests and fires every `onClose` hook (db close, log
 * flush, inngest deregister). After the grace period the process exits.
 *
 * Idempotency: the handler latches on first signal so a second SIGTERM
 * (e.g. impatient `kill -TERM` from an operator) doesn't re-enter
 * `app.close()` and double-flush.
 *
 * Configuration:
 *   AGENTIC_SHUTDOWN_TIMEOUT_MS — hard deadline before `process.exit(1)`.
 *                                Default 10_000 ms. Tests set 5_000.
 *
 * Why a plugin and not inline in `server.ts`: keeping the signal-listener
 * lifecycle in one place means the test harness can `app.close()` directly
 * without inheriting these process-level listeners (they only register
 * when called from the `isMain` entrypoint).
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { FastifyInstance } from "fastify";

const DEFAULT_TIMEOUT_MS = 10_000;

export interface ShutdownOptions {
  /** Override the env-driven default. Useful for tests. */
  gracePeriodMs?: number;
  /** Override the signals we listen for. Defaults to ["SIGTERM", "SIGINT"]. */
  signals?: NodeJS.Signals[];
}

/**
 * Install SIGTERM / SIGINT handlers that drive `app.close()` with a deadline.
 *
 * Returns a `dispose()` function that detaches the listeners — useful when
 * a test harness wants to roll back the install between cases. Production
 * callers can ignore the return value (the process exits anyway).
 */
export function installGracefulShutdown(
  app: FastifyInstance,
  opts: ShutdownOptions = {},
): () => void {
  const envTimeout = Number(process.env.AGENTIC_SHUTDOWN_TIMEOUT_MS);
  const gracePeriodMs =
    opts.gracePeriodMs ??
    (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : DEFAULT_TIMEOUT_MS);
  const signals = opts.signals ?? ["SIGTERM", "SIGINT"];

  let shuttingDown = false;

  const handler = (signal: NodeJS.Signals): void => {
    // Latch: second signal is a no-op so we don't double-call app.close.
    if (shuttingDown) {
      app.log.warn({ signal }, "shutdown already in progress; ignoring repeat signal");
      return;
    }
    shuttingDown = true;

    app.log.info({ signal, gracePeriodMs }, "graceful shutdown initiated");
    // #FATAL-LOG — durable trace of WHICH signal ended the process. Under `tsx watch` the terminal
    // scrolls away (or belongs to another session); a silent restart loop is indistinguishable from a
    // crash loop without this file. Best-effort sync append; must never delay the drain.
    try {
      const dataRoot = resolve(process.cwd(), process.env.AGENTIC_DATA_ROOT?.trim() || "../../data");
      mkdirSync(dataRoot, { recursive: true });
      appendFileSync(resolve(dataRoot, "api-fatal.log"), `\n[${new Date().toISOString()}] signal ${signal} received (pid ${process.pid}) — graceful shutdown\n`);
    } catch { /* best-effort */ }

    // Hard deadline — if app.close() hangs (slow plugin, stuck request) we
    // still exit so the orchestrator's kill -9 doesn't have to.
    const deadline = setTimeout(() => {
      app.log.error(
        { signal, gracePeriodMs },
        "graceful shutdown exceeded grace period; forcing exit",
      );
      process.exit(1);
    }, gracePeriodMs);
    // Don't keep the event loop alive solely for this timer.
    deadline.unref();

    void app
      .close()
      .then(() => {
        clearTimeout(deadline);
        app.log.info({ signal }, "graceful shutdown complete");
        // Clean exit — exit code 0 confirms the drain succeeded.
        process.exit(0);
      })
      .catch((err: unknown) => {
        clearTimeout(deadline);
        app.log.error({ err, signal }, "graceful shutdown failed");
        process.exit(1);
      });
  };

  // Bind once and remember the function reference so dispose() can detach it.
  const listeners: Array<[NodeJS.Signals, NodeJS.SignalsListener]> = [];
  for (const sig of signals) {
    const listener: NodeJS.SignalsListener = () => handler(sig);
    process.on(sig, listener);
    listeners.push([sig, listener]);
  }

  return () => {
    for (const [sig, listener] of listeners) {
      process.off(sig, listener);
    }
  };
}
