/**
 * reconcile-runs — stuck-run reconciler.
 *
 * Inngest dev mode is NOT crash-safe: an api restart (e.g. tsx-watch reload on a
 * file edit) drops in-flight handlers, so their runs never reach `failRun` and
 * stay `status="running"` forever — the durable side of the "Inngest dev is not
 * crash-safe" caveat. This service flips genuinely-orphaned runs to `failed` on
 * a startup sweep + a periodic timer, so the monitoring surface reflects reality
 * (the old AO's inngest-archiver reconcile role, new-arch-native).
 *
 * HITL SAFETY VALVE: manifest human-in-the-loop keeps a run `status="running"`
 * while parked in `step.waitForEvent` (timeout up to 7d). We NEVER reap a run
 * that has an OPEN human task — only orphans older than AGENTIC_RUN_TIMEOUT_MS.
 *
 * Modeled on inngest-sync.ts (singleton periodic reconciler, unref'd timer).
 * Env: AGENTIC_RUN_TIMEOUT_MS (default 1_800_000 = 30m),
 *      AGENTIC_RUN_RECONCILE_MS (default 60_000; 0 disables the timer).
 */

import { getDb, runs, steps, tasks, and, eq, sql, inArray } from "@agentic/db";
import { lt, isNotNull, notInArray } from "drizzle-orm";
import { publishStreamEvent } from "@agentic/runtime";
import { writeAudit } from "../plugins/audit";

interface RecLogger {
  info?: (m: string) => void;
  warn?: (m: string) => void;
}

// Non-terminal statuses a dropped handler can be stranded in.
const TERMINABLE = ["running", "queued", "waiting"] as const;

/** One reconcile pass: flip orphaned runs → failed, close their dangling steps,
 *  emit a live SSE update, and write an audit row. Returns the reaped ids. */
export async function reconcileOrphanedRuns(
  logger: RecLogger = {},
): Promise<{ reaped: number; ids: string[] }> {
  const rawTimeout = Number(process.env.AGENTIC_RUN_TIMEOUT_MS ?? 1_800_000);
  const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : 1_800_000;
  const endedMs = Date.now();
  const cutoff = new Date(endedMs - timeoutMs);
  const db = getDb();

  let reaped: Array<{ id: string; tenantId: string; startedAt: Date | null }> = [];
  try {
    reaped = db
      .update(runs)
      .set({
        status: "failed",
        endedAt: new Date(endedMs),
        durationMs: sql`${endedMs} - ${runs.startedAt}`,
        errorMessage: "orphaned_run_reconciled",
      })
      .where(
        and(
          inArray(runs.status, [...TERMINABLE]),
          isNotNull(runs.startedAt),
          lt(runs.startedAt, cutoff),
          // HITL safety valve — never reap a run blocked on an OPEN human task.
          // isNotNull(tasks.runId) is load-bearing: a single open task with a
          // NULL run_id would make `NOT IN (subquery)` evaluate to NULL for every
          // row (SQL 3-valued logic) and silently disable the whole sweep.
          notInArray(
            runs.id,
            db
              .select({ rid: tasks.runId })
              .from(tasks)
              .where(and(eq(tasks.status, "open"), isNotNull(tasks.runId))),
          ),
        ),
      )
      .returning({ id: runs.id, tenantId: runs.tenantId, startedAt: runs.startedAt })
      .all();
  } catch (err) {
    logger.warn?.(`[reconcile-runs] sweep failed: ${String((err as Error)?.message ?? err)}`);
    return { reaped: 0, ids: [] };
  }

  for (const row of reaped) {
    try {
      db.update(steps)
        .set({ status: "failed", endedAt: new Date(endedMs), error: "orphaned_run_reconciled" })
        .where(and(eq(steps.runId, row.id), inArray(steps.status, ["running", "pending"])))
        .run();
    } catch {
      /* best-effort */
    }
    try {
      publishStreamEvent({
        type: "run.failed",
        tenantId: row.tenantId,
        at: endedMs,
        runId: row.id,
        errorMessage: "orphaned_run_reconciled",
      });
    } catch {
      /* broadcast best-effort */
    }
    try {
      writeAudit({
        tenantId: row.tenantId,
        action: "run.reconcile.timeout",
        targetType: "run",
        targetId: row.id,
        meta: {
          ageMs: endedMs - (row.startedAt?.getTime() ?? endedMs),
          previousStatus: "running",
        },
      });
    } catch {
      /* audit best-effort */
    }
  }

  if (reaped.length > 0) logger.info?.(`[reconcile-runs] marked ${reaped.length} orphaned run(s) failed`);
  return { reaped: reaped.length, ids: reaped.map((r) => r.id) };
}

let activeReconciler: { stop: () => void } | null = null;

/** Start the periodic reconciler (singleton, unref'd). Disabled under test or
 *  when AGENTIC_RUN_RECONCILE_MS<=0. Stops any prior instance. */
export function startRunReconciler(logger: RecLogger = {}): { stop: () => void } {
  stopRunReconciler();
  if (process.env.NODE_ENV === "test") return { stop: () => {} };
  const ms = Number(process.env.AGENTIC_RUN_RECONCILE_MS ?? 60_000);
  if (!Number.isFinite(ms) || ms <= 0) return { stop: () => {} };
  const timer = setInterval(() => {
    reconcileOrphanedRuns(logger).catch(() => {});
  }, ms);
  timer.unref?.();
  activeReconciler = { stop: () => clearInterval(timer) };
  return activeReconciler;
}

/** Stop the periodic reconciler (called from the Fastify onClose drain). */
export function stopRunReconciler(): void {
  activeReconciler?.stop();
  activeReconciler = null;
}
