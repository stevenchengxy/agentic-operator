import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { agents, auditLog, getDb, runs, steps, workflows } from "@agentic/db";
import {
  REASONING_RUNTIME_RESTARTED_ERROR,
  reconcileRestartedReasoningRun,
  reasoningRestartRecoveryEnabled,
  shouldReconcileRestartedReasoningRun,
} from "../src/services/reasoning/run-recovery";

const insertedRunIds: string[] = [];

afterEach(() => {
  const db = getDb();
  for (const runId of insertedRunIds.splice(0)) {
    db.delete(auditLog).where(eq(auditLog.targetId, runId)).run();
    db.delete(runs).where(eq(runs.id, runId)).run();
  }
});

function reasoningBinding(): { tenantId: string; agentId: string } {
  const row = getDb()
    .select({ tenantId: workflows.tenantId, agentId: agents.id })
    .from(agents)
    .innerJoin(workflows, eq(workflows.id, agents.workflowId))
    .where(eq(agents.kebabId, "reasoningAgent"))
    .all()[0];
  if (!row) throw new Error("reasoningAgent test binding missing");
  return row;
}

describe("Reasoning run restart recovery", () => {
  it("requires an explicit single-owner invariant in production", () => {
    expect(reasoningRestartRecoveryEnabled({ NODE_ENV: "development" })).toBe(
      true,
    );
    expect(reasoningRestartRecoveryEnabled({ NODE_ENV: "production" })).toBe(
      false,
    );
    expect(
      reasoningRestartRecoveryEnabled({
        NODE_ENV: "production",
        REASONING_SINGLE_OWNER_RUNTIME: "true",
      }),
    ).toBe(true);
  });

  it("only identifies a running invocation from an older runtime generation", () => {
    const runtimeStartedAt = Date.now();
    expect(
      shouldReconcileRestartedReasoningRun({
        status: "running",
        startedAt: new Date(runtimeStartedAt - 1),
        runtimeStartedAt,
      }),
    ).toBe(true);
    for (const status of ["queued", "waiting", "ok", "failed", "cancelled"]) {
      expect(
        shouldReconcileRestartedReasoningRun({
          status,
          startedAt: new Date(runtimeStartedAt - 1),
          runtimeStartedAt,
        }),
      ).toBe(false);
    }
    expect(
      shouldReconcileRestartedReasoningRun({
        status: "running",
        startedAt: new Date(runtimeStartedAt + 1),
        runtimeStartedAt,
      }),
    ).toBe(false);
  });

  it("atomically terminalizes the parent, QualifiedAgent child, and dangling steps", () => {
    const db = getDb();
    const binding = reasoningBinding();
    const suffix = randomUUID();
    const parentRunId = `run-recovery-parent-${suffix}`;
    const childRunId = `run-recovery-child-${suffix}`;
    const correlationId = `cor-recovery-${suffix}`;
    const runtimeStartedAt = Date.now();
    const startedAt = new Date(runtimeStartedAt - 10_000);
    insertedRunIds.push(parentRunId, childRunId);

    db.insert(runs)
      .values([
        {
          id: parentRunId,
          tenantId: binding.tenantId,
          agentId: binding.agentId,
          status: "running",
          startedAt,
          correlationId,
          isTest: true,
        },
        {
          id: childRunId,
          tenantId: binding.tenantId,
          agentId: binding.agentId,
          parentRunId,
          status: "running",
          startedAt,
          correlationId,
          isTest: true,
        },
      ])
      .run();
    db.insert(steps)
      .values([
        {
          id: `stp-recovery-parent-${suffix}`,
          runId: parentRunId,
          ord: 1,
          name: "compile_qualified_prompt",
          type: "tool",
          status: "running",
          startedAt,
        },
        {
          id: `stp-recovery-child-${suffix}`,
          runId: childRunId,
          ord: 1,
          name: "llm.call",
          type: "logic",
          status: "running",
          startedAt,
        },
      ])
      .run();

    const recovered = reconcileRestartedReasoningRun({
      tenantId: binding.tenantId,
      runId: parentRunId,
      status: "running",
      startedAt,
      runtimeStartedAt,
      singleOwnerRuntime: true,
    });

    expect(new Set(recovered.runIds)).toEqual(
      new Set([parentRunId, childRunId]),
    );
    expect(
      db
        .select({ status: runs.status, error: runs.errorMessage })
        .from(runs)
        .where(eq(runs.correlationId, correlationId))
        .all(),
    ).toEqual([
      { status: "failed", error: REASONING_RUNTIME_RESTARTED_ERROR },
      { status: "failed", error: REASONING_RUNTIME_RESTARTED_ERROR },
    ]);
    expect(
      db
        .select({ status: steps.status, error: steps.error })
        .from(steps)
        .innerJoin(runs, eq(runs.id, steps.runId))
        .where(
          and(
            eq(runs.correlationId, correlationId),
            eq(runs.tenantId, binding.tenantId),
          ),
        )
        .all(),
    ).toEqual([
      { status: "failed", error: REASONING_RUNTIME_RESTARTED_ERROR },
      { status: "failed", error: REASONING_RUNTIME_RESTARTED_ERROR },
    ]);
    expect(recovered.auditId).toMatch(/^aud-/);
    expect(
      db
        .select({
          action: auditLog.action,
          targetId: auditLog.targetId,
          meta: auditLog.metaJson,
        })
        .from(auditLog)
        .where(eq(auditLog.id, recovered.auditId!))
        .all()[0],
    ).toMatchObject({
      action: "reasoning.run.recover.restart",
      targetId: parentRunId,
      meta: {
        reason: "api_runtime_generation_changed",
        recoveredRunIds: expect.arrayContaining([parentRunId, childRunId]),
        recoveredRuns: expect.arrayContaining([
          expect.objectContaining({
            runId: parentRunId,
            previousStatus: "running",
          }),
          expect.objectContaining({
            runId: childRunId,
            parentRunId,
            previousStatus: "running",
          }),
        ]),
        terminalStatus: "failed",
      },
    });
  });
});
