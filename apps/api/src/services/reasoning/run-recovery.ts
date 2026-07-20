import { and, eq, inArray } from "drizzle-orm";
import { auditLog, getDb, runs, steps } from "@agentic/db";
import { publishStreamEvent } from "@agentic/runtime";
import { makeId } from "@agentic/shared";

const ACTIVE_RUN_STATUSES = ["queued", "running", "waiting"] as const;
const ACTIVE_STEP_STATUSES = ["pending", "running"] as const;

/**
 * The standalone Reasoning runtime keeps invocation state in the owning API
 * process while Inngest supplies the durable trigger. A process restart cannot
 * resume that in-memory state. Remember this runtime generation so the audit
 * poller can terminalize a run that demonstrably belongs to an older process
 * instead of showing "running" forever.
 */
export const REASONING_RUNTIME_STARTED_AT = Date.now();

export const REASONING_RUNTIME_RESTARTED_ERROR =
  "reasoning_runtime_restarted: the API worker restarted during this Reasoning run; rerun the request";

/**
 * Runtime-generation recovery assumes one API process owns the in-memory
 * Reasoning state for this SQLite-backed installation. Development/test are
 * single-owner by construction. A production deployment must opt in explicitly
 * after preserving that invariant; this prevents one replica from mistaking a
 * run owned by another live replica for an orphan.
 */
export function reasoningRestartRecoveryEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    env.NODE_ENV !== "production" ||
    env.REASONING_SINGLE_OWNER_RUNTIME?.trim().toLowerCase() === "true"
  );
}

export function shouldReconcileRestartedReasoningRun(input: {
  status: string;
  startedAt: Date | null;
  runtimeStartedAt?: number;
}): boolean {
  const runtimeStartedAt =
    input.runtimeStartedAt ?? REASONING_RUNTIME_STARTED_AT;
  return (
    input.status === "running" &&
    input.startedAt instanceof Date &&
    Number.isFinite(input.startedAt.getTime()) &&
    input.startedAt.getTime() < runtimeStartedAt
  );
}

export interface ReasoningRestartRecoveryResult {
  reconciled: boolean;
  runIds: string[];
  auditId: string | null;
}

/**
 * Fail-close one parent Reasoning run and its same-tenant/same-correlation
 * child hierarchy when the parent started under an older API runtime.
 *
 * This is intentionally scoped to a run already verified by the dedicated
 * Reasoning route; it does not inspect or mutate Agent Factory state.
 */
export function reconcileRestartedReasoningRun(input: {
  tenantId: string;
  runId: string;
  status: string;
  startedAt: Date | null;
  runtimeStartedAt?: number;
  singleOwnerRuntime?: boolean;
}): ReasoningRestartRecoveryResult {
  const singleOwnerRuntime =
    input.singleOwnerRuntime ?? reasoningRestartRecoveryEnabled();
  if (!singleOwnerRuntime || !shouldReconcileRestartedReasoningRun(input)) {
    return { reconciled: false, runIds: [], auditId: null };
  }

  const db = getDb();
  const endedMs = Date.now();
  let reconciledIds: string[] = [];
  let recoveryAuditId: string | null = null;

  db.transaction((tx) => {
    const root = tx
      .select({
        id: runs.id,
        tenantId: runs.tenantId,
        agentId: runs.agentId,
        correlationId: runs.correlationId,
        status: runs.status,
        startedAt: runs.startedAt,
      })
      .from(runs)
      .where(and(eq(runs.id, input.runId), eq(runs.tenantId, input.tenantId)))
      .all()[0];
    if (
      !root ||
      !shouldReconcileRestartedReasoningRun({
        status: root.status,
        startedAt: root.startedAt,
        runtimeStartedAt: input.runtimeStartedAt,
      })
    ) {
      return;
    }

    // QualifiedAgent is currently one level deep, but breadth-first traversal
    // keeps the recovery correct if a later Reasoning harness adds another
    // isolated child while retaining the same locked tenant/correlation/agent.
    const discovered = new Set<string>([root.id]);
    let frontier = [root.id];
    while (frontier.length > 0) {
      const children = tx
        .select({ id: runs.id })
        .from(runs)
        .where(
          and(
            inArray(runs.parentRunId, frontier),
            eq(runs.tenantId, root.tenantId),
            eq(runs.agentId, root.agentId),
            eq(runs.correlationId, root.correlationId),
          ),
        )
        .all()
        .map((row) => row.id)
        .filter((id) => !discovered.has(id));
      for (const id of children) discovered.add(id);
      frontier = children;
    }

    const candidateIds = [...discovered];
    const activeRows = tx
      .select({
        id: runs.id,
        parentRunId: runs.parentRunId,
        status: runs.status,
        startedAt: runs.startedAt,
      })
      .from(runs)
      .where(
        and(
          inArray(runs.id, candidateIds),
          inArray(runs.status, [...ACTIVE_RUN_STATUSES]),
        ),
      )
      .all();
    if (activeRows.length === 0) return;

    for (const row of activeRows) {
      const startedMs = row.startedAt?.getTime();
      tx.update(runs)
        .set({
          status: "failed",
          endedAt: new Date(endedMs),
          durationMs:
            typeof startedMs === "number" && Number.isFinite(startedMs)
              ? Math.max(0, endedMs - startedMs)
              : 0,
          errorMessage: REASONING_RUNTIME_RESTARTED_ERROR,
        })
        .where(
          and(
            eq(runs.id, row.id),
            inArray(runs.status, [...ACTIVE_RUN_STATUSES]),
          ),
        )
        .run();
    }

    const activeIds = activeRows.map((row) => row.id);
    tx.update(steps)
      .set({
        status: "failed",
        endedAt: new Date(endedMs),
        error: REASONING_RUNTIME_RESTARTED_ERROR,
      })
      .where(
        and(
          inArray(steps.runId, activeIds),
          inArray(steps.status, [...ACTIVE_STEP_STATUSES]),
        ),
      )
      .run();
    reconciledIds = activeIds;

    recoveryAuditId = makeId("aud");
    tx.insert(auditLog)
      .values({
        id: recoveryAuditId,
        tenantId: root.tenantId,
        actorUserId: null,
        action: "reasoning.run.recover.restart",
        targetType: "run",
        targetId: root.id,
        at: new Date(endedMs),
        metaJson: {
          reason: "api_runtime_generation_changed",
          runtimeStartedAt:
            input.runtimeStartedAt ?? REASONING_RUNTIME_STARTED_AT,
          recoveredRunIds: activeRows.map((row) => row.id),
          recoveredRuns: activeRows.map((row) => ({
            runId: row.id,
            parentRunId: row.parentRunId,
            previousStatus: row.status,
            startedAt: row.startedAt?.toISOString() ?? null,
          })),
          terminalStatus: "failed",
          error: REASONING_RUNTIME_RESTARTED_ERROR,
          decision: "deny",
        } as never,
      })
      .run();
  });

  for (const runId of reconciledIds) {
    try {
      publishStreamEvent({
        type: "run.failed",
        tenantId: input.tenantId,
        at: endedMs,
        runId,
        errorMessage: REASONING_RUNTIME_RESTARTED_ERROR,
      });
    } catch {
      // The durable failed rows are authoritative; live projection is best
      // effort and will converge on the next audit poll.
    }
  }

  if (recoveryAuditId) {
    try {
      publishStreamEvent({
        type: "audit.recorded",
        tenantId: input.tenantId,
        at: endedMs,
        auditId: recoveryAuditId,
        action: "reasoning.run.recover.restart",
        actorUserId: null,
        targetType: "run",
        targetId: input.runId,
        decision: "deny",
      });
    } catch {
      // The audit row is in the same transaction as terminalization.
    }
  }

  return {
    reconciled: reconciledIds.length > 0,
    runIds: reconciledIds,
    auditId: recoveryAuditId,
  };
}
