/**
 * P3-RT-02 — Scheduled-trigger fixture.
 *
 * Ships a minimal __system cron agent that fires every 60s in dev and proves
 * the scheduled-trigger path is wired end-to-end. Each fire writes a row
 * marker to a tracker (in-memory + DB-less for the fixture) so the e2e test
 * can assert that the cron is firing at the expected cadence.
 *
 * Real production scheduled agents are declared in tenant manifests via the
 * `cron` field (P3-RT-01); this file is the platform's "is the wheel spinning?"
 * heartbeat — equivalent to a smoke test that boots with the system.
 *
 * Cron expression:
 *   - `AGENTIC_SYSTEM_CRON` env var (default `* * * * *` — every minute).
 *     Tests override to `*\/30 * * * * *` (every 30s, 6-field cron) so a
 *     130s window catches at least two fires.
 *   - Inngest v4 accepts 5- and 6-field cron expressions.
 */

import { inngest } from "./client";
import type { InngestFunction } from "inngest";

/**
 * Simple in-process tracker. The test harness inspects this to confirm the
 * cron fired N times in a window. We deliberately avoid touching the DB so
 * the fixture doesn't depend on schema or tenant rows.
 */
const fireLog: number[] = [];

/** Returns all fire timestamps recorded so far. Test-only. */
export function __getCronFires(): readonly number[] {
  return [...fireLog];
}

/** Reset the fire log. Test-only. */
export function __resetCronFires(): void {
  fireLog.length = 0;
}

function defaultCron(): string {
  const v = process.env.AGENTIC_SYSTEM_CRON;
  if (typeof v === "string" && v.trim() !== "") return v.trim();
  return "* * * * *";
}

/**
 * Build the __system.dailyDigest function. Pure-internal heartbeat — never
 * persists, just appends a timestamp to the in-process tracker. Idempotent
 * under Inngest replays because the timestamp push lives inside `step.run`.
 */
function buildSystemCronFn(): InngestFunction.Any {
  return inngest.createFunction(
    {
      id: "__system.dailyDigest",
      name: "System scheduled heartbeat (P3-RT-02)",
      triggers: [{ cron: defaultCron() }],
    },
    async ({ step }) => {
      const at = await step.run("record", async () => {
        const now = Date.now();
        fireLog.push(now);
        return now;
      });
      return { ok: true, agent: "dailyDigest", at };
    },
  );
}

/**
 * Exported as an array so callers can spread it into their function-list
 * without conditional logic. Empty in tests that don't want a global cron.
 */
export const systemCronFns: InngestFunction.Any[] = (() => {
  // Allow tests to disable the heartbeat to keep their own assertions stable.
  if (process.env.AGENTIC_SYSTEM_CRON_DISABLED === "1") return [];
  return [buildSystemCronFn()];
})();
