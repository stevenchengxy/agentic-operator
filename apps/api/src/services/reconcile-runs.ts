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
 * HITL waits are reconciled first: recoverable `resolving` tasks are redriven,
 * while a lost/terminal owning wait is explicitly failed. The generic sweep
 * excludes both OPEN and RESOLVING human tasks so it cannot pre-empt that state
 * machine.
 *
 * Modeled on inngest-sync.ts (singleton periodic reconciler, unref'd timer).
 * Env: AGENTIC_RUN_TIMEOUT_MS (default 1_800_000 = 30m),
 *      AGENTIC_RUN_RECONCILE_MS (default 60_000; 0 disables the timer).
 */

import { getDb, runs, steps, tasks, and, eq, sql, inArray } from "@agentic/db";
import { lt, isNotNull, notInArray } from "drizzle-orm";
import { publishStreamEvent } from "@agentic/runtime";
import { writeAudit } from "../plugins/audit";
import { reconcileHumanTasks } from "./hitl-recovery";

interface RecLogger {
  info?: (m: string) => void;
  warn?: (m: string) => void;
}

function durationEnv(
  name: string,
  fallback: number,
  allowZero = false,
): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || (allowZero ? value < 0 : value <= 0)) {
    throw new Error(
      `${name} must be ${allowZero ? "0 or " : ""}a positive integer`,
    );
  }
  return value;
}

export class RunReconcileError extends Error {
  override readonly cause: unknown;

  constructor(cause: unknown) {
    super(
      `orphaned-run reconciliation failed: ${String(
        (cause as { message?: unknown } | null)?.message ?? cause,
      ).slice(0, 240)}`,
    );
    this.name = "RunReconcileError";
    this.cause = cause;
  }
}

// Non-terminal statuses a dropped handler can be stranded in.
const TERMINABLE = ["running", "queued", "waiting"] as const;
type TerminableStatus = (typeof TERMINABLE)[number];

/** One reconcile pass: flip orphaned runs → failed, close their dangling steps,
 *  emit a live SSE update, and write an audit row. Returns the reaped ids. */
export async function reconcileOrphanedRuns(
  logger: RecLogger = {},
): Promise<{ reaped: number; ids: string[] }> {
  const timeoutMs = durationEnv("AGENTIC_RUN_TIMEOUT_MS", 1_800_000);
  const endedMs = Date.now();
  const cutoff = new Date(endedMs - timeoutMs);
  const db = getDb();

  let reaped: Array<{
    id: string;
    tenantId: string;
    startedAt: Date | null;
    previousStatus: TerminableStatus;
  }> = [];
  try {
    // Run + dangling-step transitions are one atomic recovery unit. If either write fails, the
    // process must not report a healthy startup with contradictory run/step state.
    db.transaction((tx) => {
      const eligiblePredicate = and(
        inArray(runs.status, [...TERMINABLE]),
        isNotNull(runs.startedAt),
        lt(runs.startedAt, cutoff),
        // HITL safety valve — the dedicated reconciler owns OPEN and
        // RESOLVING tasks, including their explicit timeout/failure path.
        // isNotNull(tasks.runId) is load-bearing: a single open task with a
        // NULL run_id would make `NOT IN (subquery)` evaluate to NULL for every
        // row (SQL 3-valued logic) and silently disable the whole sweep.
        notInArray(
          runs.id,
          tx
            .select({ rid: tasks.runId })
            .from(tasks)
            .where(
              and(
                inArray(tasks.status, ["open", "resolving"]),
                isNotNull(tasks.runId),
              ),
            ),
        ),
      );
      const eligible = tx
        .select({
          id: runs.id,
          tenantId: runs.tenantId,
          startedAt: runs.startedAt,
          status: runs.status,
        })
        .from(runs)
        .where(eligiblePredicate)
        .all();
      if (eligible.length === 0) return;

      // SQLite UPDATE .. RETURNING exposes the new status, not the status
      // that was replaced. Capture the eligible preimage inside the same
      // transaction, then intersect it with the rows actually transitioned.
      // This keeps audit evidence truthful for queued/waiting orphans instead
      // of hardcoding every recovery as previousStatus=running.
      const updatedIds = new Set(
        tx
          .update(runs)
          .set({
            status: "failed",
            endedAt: new Date(endedMs),
            durationMs: sql`${endedMs} - ${runs.startedAt}`,
            errorMessage: "orphaned_run_reconciled",
          })
          // Reuse the same SQL predicate instead of expanding every eligible
          // id into bound parameters. A large orphan backlog therefore cannot
          // exceed SQLite's host-parameter limit during recovery.
          .where(eligiblePredicate)
          .returning({ id: runs.id })
          .all()
          .map((row) => row.id),
      );
      reaped = eligible
        .filter((row) => updatedIds.has(row.id))
        .map((row) => ({
          id: row.id,
          tenantId: row.tenantId,
          startedAt: row.startedAt,
          previousStatus: row.status as TerminableStatus,
        }));
      for (const row of reaped) {
        tx.update(steps)
          .set({
            status: "failed",
            endedAt: new Date(endedMs),
            error: "orphaned_run_reconciled",
          })
          .where(
            and(
              eq(steps.runId, row.id),
              inArray(steps.status, ["running", "pending"]),
            ),
          )
          .run();
      }
    });
  } catch (err) {
    logger.warn?.(
      `[reconcile-runs] sweep failed: ${String((err as Error)?.message ?? err)}`,
    );
    throw new RunReconcileError(err);
  }

  for (const row of reaped) {
    try {
      publishStreamEvent({
        type: "run.failed",
        tenantId: row.tenantId,
        at: endedMs,
        runId: row.id,
        errorMessage: "orphaned_run_reconciled",
      });
    } catch (err) {
      logger.warn?.(
        `[reconcile-runs] stream notification failed for ${row.id}: ${String((err as Error)?.message ?? err)}`,
      );
    }
    try {
      writeAudit({
        tenantId: row.tenantId,
        action: "run.reconcile.timeout",
        targetType: "run",
        targetId: row.id,
        meta: {
          ageMs: endedMs - (row.startedAt?.getTime() ?? endedMs),
          previousStatus: row.previousStatus,
        },
      });
    } catch (err) {
      logger.warn?.(
        `[reconcile-runs] audit write failed for ${row.id}: ${String((err as Error)?.message ?? err)}`,
      );
    }
  }

  if (reaped.length > 0)
    logger.info?.(
      `[reconcile-runs] marked ${reaped.length} orphaned run(s) failed`,
    );
  return { reaped: reaped.length, ids: reaped.map((r) => r.id) };
}

/** Full startup/periodic recovery pass; HITL state must be settled first. */
export async function reconcileRuntimeState(logger: RecLogger = {}) {
  const hitl = await reconcileHumanTasks(logger);
  const orphaned = await reconcileOrphanedRuns(logger);
  return { ...orphaned, hitl };
}

let activeReconciler: { stop: () => void } | null = null;

/** Start the periodic reconciler (singleton, unref'd). Disabled under test or
 *  when AGENTIC_RUN_RECONCILE_MS=0. Stops any prior instance. */
export function startRunReconciler(logger: RecLogger = {}): {
  stop: () => void;
} {
  stopRunReconciler();
  if (process.env.NODE_ENV === "test") return { stop: () => {} };
  const ms = durationEnv("AGENTIC_RUN_RECONCILE_MS", 60_000, true);
  if (ms === 0) return { stop: () => {} };
  const timer = setInterval(() => {
    reconcileRuntimeState(logger).catch((err) => {
      logger.warn?.(
        `[reconcile-runs] periodic pass failed: ${String((err as Error)?.message ?? err)}`,
      );
    });
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
