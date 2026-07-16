#!/usr/bin/env node

import process from "node:process";
import { pathToFileURL } from "node:url";

const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_INTERVAL_MS = 200;
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_OUTAGE_TIMEOUT_MS = 15_000;
const DEFAULT_WATCH_INTERVAL_MS = 2_000;

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

async function releaseResponse(response) {
  try {
    await response.body?.cancel();
  } catch {
    // Readiness is already established once headers arrive. Releasing a test
    // double or an already-consumed body must not turn success into failure.
  }
}

/**
 * Wait until an HTTP listener accepts requests.
 *
 * Any HTTP response counts as ready, including 4xx/5xx. The startup ordering
 * problem this solves is transport-level ECONNREFUSED while the API is still
 * bootstrapping. Subsystem health remains the responsibility of `/health`.
 */
export async function waitForHttp(
  url,
  {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    intervalMs = DEFAULT_INTERVAL_MS,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    fetchImpl = fetch,
    now = Date.now,
    sleep = delay,
  } = {},
) {
  const target = new URL(url).toString();
  const startedAt = now();
  const deadline = startedAt + timeoutMs;
  let attempts = 0;
  let lastFailure = "no response";

  while (true) {
    attempts += 1;
    const remaining = Math.max(1, deadline - now());
    try {
      const response = await fetchImpl(target, {
        cache: "no-store",
        signal: AbortSignal.timeout(Math.min(requestTimeoutMs, remaining)),
      });
      const status = response.status;
      await releaseResponse(response);
      return {
        attempts,
        elapsedMs: Math.max(0, now() - startedAt),
        status,
      };
    } catch (error) {
      lastFailure = errorMessage(error);
    }

    const waitMs = Math.min(intervalMs, deadline - now());
    if (waitMs <= 0) {
      throw new Error(
        `timed out after ${timeoutMs} ms waiting for ${target}; last failure: ${lastFailure}`,
      );
    }
    await sleep(waitMs);
  }
}

/**
 * Keep checking a listener after initial readiness.
 *
 * A short outage is tolerated so `tsx watch` can restart the API during local
 * development. A continuous outage rejects, allowing the dev-stack supervisor
 * to stop the otherwise-still-running watcher and every dependent service.
 */
export async function monitorHttp(
  url,
  {
    outageTimeoutMs = DEFAULT_OUTAGE_TIMEOUT_MS,
    intervalMs = DEFAULT_WATCH_INTERVAL_MS,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    fetchImpl = fetch,
    now = Date.now,
    sleep = delay,
    onStateChange = () => {},
  } = {},
) {
  const target = new URL(url).toString();
  let outageStartedAt;
  let lastFailure = "no response";

  while (true) {
    try {
      const response = await fetchImpl(target, {
        cache: "no-store",
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      const status = response.status;
      await releaseResponse(response);
      if (outageStartedAt !== undefined) {
        onStateChange({
          state: "recovered",
          elapsedMs: Math.max(0, now() - outageStartedAt),
          status,
        });
      }
      outageStartedAt = undefined;
    } catch (error) {
      const failedAt = now();
      lastFailure = errorMessage(error);
      if (outageStartedAt === undefined) {
        outageStartedAt = failedAt;
        onStateChange({ state: "unavailable", error: lastFailure });
      } else if (failedAt - outageStartedAt >= outageTimeoutMs) {
        throw new Error(
          `${target} remained unavailable for ${outageTimeoutMs} ms; last failure: ${lastFailure}`,
        );
      }
    }

    await sleep(intervalMs);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const watch = args[0] === "--watch";
  if (watch) args.shift();
  const [url, label = "service"] = args;
  if (!url || args.length > 2) {
    console.error(
      "Usage: node scripts/wait-for-http.mjs [--watch] <url> [label]",
    );
    process.exitCode = 2;
    return;
  }

  const timeoutMs = positiveInteger(
    process.env.AGENTIC_DEV_READY_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
    "AGENTIC_DEV_READY_TIMEOUT_MS",
  );
  const intervalMs = positiveInteger(
    process.env.AGENTIC_DEV_READY_INTERVAL_MS,
    DEFAULT_INTERVAL_MS,
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

  console.log(`[startup] waiting for ${label} at ${url}`);
  try {
    const result = await waitForHttp(url, { timeoutMs, intervalMs });
    console.log(
      `[startup] ${label} accepted HTTP after ${result.elapsedMs} ms (${result.attempts} attempt${result.attempts === 1 ? "" : "s"}, status ${result.status})`,
    );
    if (!watch) return;

    console.log(
      `[startup] monitoring ${label}; allowing outages up to ${outageTimeoutMs} ms`,
    );
    await monitorHttp(url, {
      outageTimeoutMs,
      intervalMs: watchIntervalMs,
      onStateChange(state) {
        if (state.state === "unavailable") {
          console.warn(
            `[startup] ${label} became unavailable; waiting for recovery (${state.error})`,
          );
        } else {
          console.log(
            `[startup] ${label} recovered after ${state.elapsedMs} ms (status ${state.status})`,
          );
        }
      },
    });
  } catch (error) {
    console.error(`[startup] ERROR: ${errorMessage(error)}`);
    process.exitCode = 1;
  }
}

const entrypoint = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : undefined;
if (entrypoint === import.meta.url) {
  await main();
}
