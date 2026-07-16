#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { monitorHttp, waitForHttp } from "./wait-for-http.mjs";

const ROOT_DIR = fileURLToPath(new URL("../", import.meta.url));
const API_HEALTH_URL = "http://127.0.0.1:3501/health";
const DEFAULT_READY_TIMEOUT_MS = 90_000;
const DEFAULT_READY_INTERVAL_MS = 200;
const DEFAULT_OUTAGE_TIMEOUT_MS = 15_000;
const DEFAULT_WATCH_INTERVAL_MS = 2_000;
const DEFAULT_API_SHUTDOWN_TIMEOUT_MS = 10_000;
const SHUTDOWN_BUFFER_MS = 2_000;
const FORCE_SIGNAL_DELAY_MS = 500;
const FORCE_WAIT_MS = 1_000;
const POLL_INTERVAL_MS = 50;
const PNPM = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

const COLORS = {
  api: 32,
  web: 34,
  inngest: 35,
};

function positiveInteger(value, fallback, name) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function prefixFor(name) {
  if (!process.stdout.isTTY) return `[${name}] `;
  return `\u001b[${COLORS[name] ?? 0}m[${name}]\u001b[0m `;
}

function pipeWithPrefix(name, input, output) {
  const lines = createInterface({ input, crlfDelay: Infinity });
  const prefix = prefixFor(name);
  lines.on("line", (line) => output.write(`${prefix}${line}\n`));
}

function processTarget(record) {
  const pid = record.child.pid;
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  return process.platform === "win32" ? pid : -pid;
}

function signalProcessGroup(record, signal) {
  const target = processTarget(record);
  if (target === undefined) return false;
  try {
    process.kill(target, signal);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

function isProcessGroupAlive(record) {
  const target = processTarget(record);
  if (target === undefined) return false;
  try {
    process.kill(target, 0);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ESRCH") {
      return false;
    }
    return true;
  }
}

async function waitForProcessGroups(records, timeoutMs, pollIntervalMs) {
  const deadline = Date.now() + timeoutMs;
  while (records.some(isProcessGroupAlive) && Date.now() < deadline) {
    await delay(pollIntervalMs);
  }
  return records.filter(isProcessGroupAlive);
}

export async function terminateProcessGroups(
  records,
  {
    graceMs = DEFAULT_API_SHUTDOWN_TIMEOUT_MS + SHUTDOWN_BUFFER_MS,
    forceWaitMs = FORCE_WAIT_MS,
    pollIntervalMs = POLL_INTERVAL_MS,
  } = {},
) {
  for (const record of records) signalProcessGroup(record, "SIGTERM");
  const remaining = await waitForProcessGroups(
    records,
    graceMs,
    pollIntervalMs,
  );
  for (const record of remaining) signalProcessGroup(record, "SIGKILL");
  return waitForProcessGroups(remaining, forceWaitMs, pollIntervalMs);
}

export function forceKillProcessGroups(records) {
  const failures = [];
  for (const record of records) {
    try {
      signalProcessGroup(record, "SIGKILL");
    } catch (error) {
      failures.push({ name: record.name, error });
    }
  }
  return failures;
}

export function installSupervisorSignalHandlers({
  source = process,
  isShuttingDown,
  shutdown,
  forceShutdown,
  now = Date.now,
  forceDelayMs = FORCE_SIGNAL_DELAY_MS,
}) {
  const bindings = [
    ["SIGINT", 130],
    ["SIGTERM", 143],
    ["SIGHUP", 129],
  ];
  const listeners = [];
  let firstSignalAt;

  for (const [signal, forcedExitCode] of bindings) {
    const listener = () => {
      if (isShuttingDown()) {
        if (
          firstSignalAt === undefined ||
          now() - firstSignalAt >= forceDelayMs
        ) {
          forceShutdown(forcedExitCode, signal);
        }
      } else {
        firstSignalAt = now();
        shutdown(signal);
      }
    };
    source.on(signal, listener);
    listeners.push([signal, listener]);
  }

  return () => {
    for (const [signal, listener] of listeners) {
      source.off(signal, listener);
    }
  };
}

function startManagedProcess(name, args, onUnexpectedExit) {
  const child = spawn(PNPM, args, {
    cwd: ROOT_DIR,
    detached: process.platform !== "win32",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const record = { name, child };

  pipeWithPrefix(name, child.stdout, process.stdout);
  pipeWithPrefix(name, child.stderr, process.stderr);

  child.once("error", (error) => {
    onUnexpectedExit(record, `${name} failed to start: ${errorMessage(error)}`);
  });
  child.once("exit", (code, signal) => {
    const outcome =
      signal !== null ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
    onUnexpectedExit(record, `${name} stopped unexpectedly (${outcome})`);
  });

  return record;
}

export async function main() {
  const readyTimeoutMs = positiveInteger(
    process.env.AGENTIC_DEV_READY_TIMEOUT_MS,
    DEFAULT_READY_TIMEOUT_MS,
    "AGENTIC_DEV_READY_TIMEOUT_MS",
  );
  const readyIntervalMs = positiveInteger(
    process.env.AGENTIC_DEV_READY_INTERVAL_MS,
    DEFAULT_READY_INTERVAL_MS,
    "AGENTIC_DEV_READY_INTERVAL_MS",
  );
  const outageTimeoutMs = positiveInteger(
    process.env.AGENTIC_DEV_OUTAGE_TIMEOUT_MS,
    DEFAULT_OUTAGE_TIMEOUT_MS,
    "AGENTIC_DEV_OUTAGE_TIMEOUT_MS",
  );
  const watchIntervalMs = positiveInteger(
    process.env.AGENTIC_DEV_WATCH_INTERVAL_MS,
    DEFAULT_WATCH_INTERVAL_MS,
    "AGENTIC_DEV_WATCH_INTERVAL_MS",
  );
  const apiShutdownTimeoutMs = positiveInteger(
    process.env.AGENTIC_SHUTDOWN_TIMEOUT_MS,
    DEFAULT_API_SHUTDOWN_TIMEOUT_MS,
    "AGENTIC_SHUTDOWN_TIMEOUT_MS",
  );
  const shutdownGraceMs = positiveInteger(
    process.env.AGENTIC_DEV_SHUTDOWN_TIMEOUT_MS,
    apiShutdownTimeoutMs + SHUTDOWN_BUFFER_MS,
    "AGENTIC_DEV_SHUTDOWN_TIMEOUT_MS",
  );

  const processes = [];
  let shuttingDown = false;
  let shutdownPromise;

  const shutdown = (exitCode, reason) => {
    if (shutdownPromise) return shutdownPromise;
    shuttingDown = true;
    if (reason) {
      const output = exitCode === 0 ? process.stdout : process.stderr;
      output.write(`[startup] ${reason}\n`);
    }
    shutdownPromise = (async () => {
      const lingering = await terminateProcessGroups(processes, {
        graceMs: shutdownGraceMs,
      });
      if (lingering.length > 0) {
        process.stderr.write(
          `[startup] WARNING: unable to confirm shutdown for ${lingering.map((record) => record.name).join(", ")}\n`,
        );
      }
      process.exit(exitCode);
    })();
    return shutdownPromise;
  };

  const onUnexpectedExit = (_record, reason) => {
    if (!shuttingDown) void shutdown(1, reason);
  };

  installSupervisorSignalHandlers({
    isShuttingDown: () => shuttingDown,
    shutdown: (signal) => {
      void shutdown(0, `received ${signal}; stopping development services`);
    },
    forceShutdown: (exitCode, signal) => {
      process.stderr.write(
        `[startup] received ${signal} during shutdown; force-killing development services\n`,
      );
      const failures = forceKillProcessGroups(processes);
      if (failures.length > 0) {
        process.stderr.write(
          `[startup] WARNING: force-kill failed for ${failures.map((failure) => failure.name).join(", ")}\n`,
        );
      }
      process.exit(exitCode);
    },
  });

  processes.push(
    startManagedProcess(
      "api",
      ["--filter", "@agentic/api", "run", "dev"],
      onUnexpectedExit,
    ),
  );

  process.stdout.write(`[startup] waiting for API at ${API_HEALTH_URL}\n`);
  try {
    const ready = await waitForHttp(API_HEALTH_URL, {
      timeoutMs: readyTimeoutMs,
      intervalMs: readyIntervalMs,
    });
    if (shuttingDown) return;
    process.stdout.write(
      `[startup] API accepted HTTP after ${ready.elapsedMs} ms (${ready.attempts} attempt${ready.attempts === 1 ? "" : "s"}, status ${ready.status})\n`,
    );
  } catch (error) {
    await shutdown(1, `API readiness failed: ${errorMessage(error)}`);
    return;
  }

  processes.push(
    startManagedProcess(
      "web",
      ["--filter", "@agentic/web", "run", "dev"],
      onUnexpectedExit,
    ),
  );
  processes.push(
    startManagedProcess(
      "inngest",
      ["exec", "inngest", "dev", "-u", "http://127.0.0.1:3501/inngest"],
      onUnexpectedExit,
    ),
  );

  process.stdout.write(
    `[startup] monitoring API; allowing outages up to ${outageTimeoutMs} ms\n`,
  );
  try {
    await monitorHttp(API_HEALTH_URL, {
      outageTimeoutMs,
      intervalMs: watchIntervalMs,
      onStateChange(state) {
        if (state.state === "unavailable") {
          process.stderr.write(
            `[startup] API became unavailable; waiting for recovery (${state.error})\n`,
          );
        } else {
          process.stdout.write(
            `[startup] API recovered after ${state.elapsedMs} ms (status ${state.status})\n`,
          );
        }
      },
    });
  } catch (error) {
    if (!shuttingDown) {
      await shutdown(1, `API watchdog failed: ${errorMessage(error)}`);
    }
  }
}

const entrypoint = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : undefined;
if (entrypoint === import.meta.url) {
  await main();
}
