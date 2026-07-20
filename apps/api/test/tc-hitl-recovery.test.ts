import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  events,
  getDb,
  runs,
  steps,
  tasks,
  tenants,
  workflows,
} from "@agentic/db";
import { buildTestEnv } from "./harness";
import {
  HumanTaskDispatchError,
  humanResolutionRequestKey,
  reconcileHumanTasks,
  requestHumanTaskResolution,
  validateHumanInputTaskResolution,
  type ResumeEvent,
} from "../src/services/hitl-recovery";

interface Fixture {
  tenantId: string;
  tenantSlug: string;
  runId: string;
  stepId: string;
  taskId: string;
  eventId: string;
  marker: string;
}

const fixtures: Fixture[] = [];

async function makeFixture(options: {
  runStatus?: "waiting" | "running" | "failed";
  taskStatus?: "open" | "resolving";
  requestedAt?: Date;
} = {}): Promise<Fixture> {
  await buildTestEnv();
  const db = getDb();
  const owner = db
    .select({ tenantId: tenants.id, tenantSlug: tenants.slug, agentId: agents.id })
    .from(agents)
    .innerJoin(workflows, eq(workflows.id, agents.workflowId))
    .innerJoin(tenants, eq(tenants.id, workflows.tenantId))
    .where(eq(tenants.slug, "__system"))
    .all()[0] ??
    db
      .select({ tenantId: tenants.id, tenantSlug: tenants.slug, agentId: agents.id })
      .from(agents)
      .innerJoin(workflows, eq(workflows.id, agents.workflowId))
      .innerJoin(tenants, eq(tenants.id, workflows.tenantId))
      .all()[0];
  if (!owner) throw new Error("HITL test requires one bootstrapped agent");
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const fixture: Fixture = {
    tenantId: owner.tenantId,
    tenantSlug: owner.tenantSlug,
    runId: `run-hitl-${suffix}`,
    stepId: `stp-hitl-${suffix}`,
    taskId: `tsk-hitl-${suffix}`,
    eventId: `evt-hitl-${suffix}`,
    marker: `hitl:${owner.tenantId}:run-hitl-${suffix}:tsk-hitl-${suffix}`,
  };
  db.insert(events)
    .values({
      id: fixture.eventId,
      tenantId: owner.tenantId,
      name: `${owner.tenantSlug}/HITL_TEST`,
      subject: suffix,
    })
    .run();
  db.insert(runs)
    .values({
      id: fixture.runId,
      tenantId: owner.tenantId,
      agentId: owner.agentId,
      triggerEventId: fixture.eventId,
      status: options.runStatus ?? "waiting",
      startedAt: new Date(Date.now() - 1_000),
      correlationId: `corr-${suffix}`,
      subject: suffix,
    })
    .run();
  db.insert(steps)
    .values({
      id: fixture.stepId,
      runId: fixture.runId,
      ord: 0,
      name: "human review",
      type: "manual",
      status: "running",
      startedAt: new Date(Date.now() - 500),
    })
    .run();
  const taskStatus = options.taskStatus ?? "open";
  const storedResolution = {
    taskId: fixture.taskId,
    decision: "approve" as const,
    payload: { reviewed: true },
    actorUserId: null,
    resumeMarker: fixture.marker,
  };
  db.insert(tasks)
    .values({
      id: fixture.taskId,
      tenantId: fixture.tenantId,
      runId: fixture.runId,
      originEventId: fixture.eventId,
      originEventName: `${fixture.tenantSlug}/HITL_TEST`,
      waitStepId: fixture.stepId,
      resumeMarker: fixture.marker,
      resumeState: "pending",
      type: "approval",
      title: "Human approval",
      status: taskStatus,
      ...(taskStatus === "resolving"
        ? {
            resolutionJson: storedResolution,
            resolutionRequestKey: humanResolutionRequestKey({
              tenantId: fixture.tenantId,
              taskId: fixture.taskId,
              decision: "approve",
              payload: { reviewed: true },
            }),
            resolutionRequestedAt: options.requestedAt ?? new Date(),
          }
        : {}),
    } as never)
    .run();
  fixtures.push(fixture);
  return fixture;
}

beforeAll(async () => {
  await buildTestEnv();
});

afterEach(() => {
  const db = getDb();
  for (const fixture of fixtures.splice(0)) {
    db.delete(runs).where(eq(runs.id, fixture.runId)).run();
    db.delete(events).where(eq(events.id, fixture.eventId)).run();
  }
  delete process.env.AGENTIC_HITL_RESUME_TIMEOUT_MS;
  delete process.env.AGENTIC_HITL_RESUME_RETRY_MS;
  delete process.env.AGENTIC_HITL_WAIT_TIMEOUT_MS;
});

describe("HITL durable resume recovery", () => {
  it("keeps an agent-input task open until a human supplies a correctly typed value", () => {
    const taskPayload = {
      inputBinding: {
        kind: "human_input",
        field: "approved",
        type: "Boolean",
        required: true,
        prompt: "是否继续？",
      },
    };
    expect(validateHumanInputTaskResolution({ taskPayload, decision: "approve", payload: undefined })).toContain("是否继续");
    expect(validateHumanInputTaskResolution({ taskPayload, decision: "approve", payload: { value: "yes" } })).toContain("Boolean");
    expect(validateHumanInputTaskResolution({ taskPayload, decision: "approve", payload: { value: false } })).toBeNull();
    expect(validateHumanInputTaskResolution({ taskPayload, decision: "reject", payload: undefined })).toBeNull();
  });

  it("persists a decision as resolving and redrives with one stable marker", async () => {
    const fixture = await makeFixture();
    const sent: ResumeEvent[] = [];
    const send = async (event: ResumeEvent) => sent.push(event);

    const first = await requestHumanTaskResolution({
      taskId: fixture.taskId,
      tenantId: fixture.tenantId,
      tenantSlug: fixture.tenantSlug,
      decision: "approve",
      payload: { b: 2, a: 1 },
      send,
    });
    expect(first).toMatchObject({ status: "resolving", attempt: 1 });

    // Same semantic payload with different key order is an idempotent retry.
    const second = await requestHumanTaskResolution({
      taskId: fixture.taskId,
      tenantId: fixture.tenantId,
      tenantSlug: fixture.tenantSlug,
      decision: "approve",
      payload: { a: 1, b: 2 },
      send,
    });
    expect(second).toMatchObject({ status: "resolving", attempt: 2 });
    expect(sent.map((event) => event.id)).toEqual([
      `hitl-resume-${fixture.taskId}-a1`,
      `hitl-resume-${fixture.taskId}-a2`,
    ]);
    expect(new Set(sent.map((event) => event.data.resumeMarker))).toEqual(
      new Set([fixture.marker]),
    );

    const row = getDb().select().from(tasks).where(eq(tasks.id, fixture.taskId)).all()[0]!;
    expect(row).toMatchObject({
      status: "resolving",
      resumeState: "dispatched",
      resumeAttempts: 2,
      originEventId: fixture.eventId,
      waitStepId: fixture.stepId,
    });
    expect(row.resolvedAt).toBeNull();
    expect(row.resumeAcknowledgedAt).toBeNull();

    await expect(
      requestHumanTaskResolution({
        taskId: fixture.taskId,
        tenantId: fixture.tenantId,
        tenantSlug: fixture.tenantSlug,
        decision: "reject",
        send,
      }),
    ).rejects.toMatchObject({ code: "resolution_conflict", statusCode: 409 });
  });

  it("keeps a failed transport decision durable, then reconciles it", async () => {
    const fixture = await makeFixture();
    await expect(
      requestHumanTaskResolution({
        taskId: fixture.taskId,
        tenantId: fixture.tenantId,
        tenantSlug: fixture.tenantSlug,
        decision: "approve",
        payload: { reviewed: true },
        send: async () => {
          throw new Error("broker unavailable");
        },
      }),
    ).rejects.toBeInstanceOf(HumanTaskDispatchError);

    let row = getDb().select().from(tasks).where(eq(tasks.id, fixture.taskId)).all()[0]!;
    expect(row.status).toBe("resolving");
    expect(row.resumeState).toBe("pending");
    expect(row.resumeError).toContain("broker unavailable");
    expect(row.resolvedAt).toBeNull();

    const sent: ResumeEvent[] = [];
    const report = await reconcileHumanTasks({}, {
      send: async (event) => sent.push(event),
    });
    expect(report.retried).toBeGreaterThanOrEqual(1);
    expect(sent.find((event) => event.data.taskId === fixture.taskId)).toMatchObject({
      id: `hitl-resume-${fixture.taskId}-a2`,
      data: { resumeMarker: fixture.marker },
    });
    row = getDb().select().from(tasks).where(eq(tasks.id, fixture.taskId)).all()[0]!;
    expect(row).toMatchObject({ status: "resolving", resumeState: "dispatched" });
  });

  it("never resolves a task whose owning run is terminal", async () => {
    const fixture = await makeFixture({ runStatus: "failed" });
    let sends = 0;
    await expect(
      requestHumanTaskResolution({
        taskId: fixture.taskId,
        tenantId: fixture.tenantId,
        tenantSlug: fixture.tenantSlug,
        decision: "approve",
        send: async () => {
          sends++;
        },
      }),
    ).rejects.toMatchObject({ code: "task_not_recoverable", statusCode: 409 });
    expect(sends).toBe(0);
    const [task, waitStep] = [
      getDb().select().from(tasks).where(eq(tasks.id, fixture.taskId)).all()[0]!,
      getDb().select().from(steps).where(eq(steps.id, fixture.stepId)).all()[0]!,
    ];
    expect(task).toMatchObject({ status: "failed", resumeState: "failed" });
    expect(task.resumeError).toContain("owning_run_not_waiting:failed");
    expect(waitStep.status).toBe("failed");
  });

  it("marks an unacknowledged lost wait failed after the recovery deadline", async () => {
    const fixture = await makeFixture({
      taskStatus: "resolving",
      requestedAt: new Date(Date.now() - 10_000),
    });
    process.env.AGENTIC_HITL_RESUME_TIMEOUT_MS = "100";
    const report = await reconcileHumanTasks({}, { send: async () => undefined });
    expect(report.failedTaskIds).toContain(fixture.taskId);
    const task = getDb().select().from(tasks).where(eq(tasks.id, fixture.taskId)).all()[0]!;
    const run = getDb().select().from(runs).where(eq(runs.id, fixture.runId)).all()[0]!;
    expect(task).toMatchObject({
      status: "failed",
      resumeState: "failed",
      resumeError: "hitl_resume_ack_timeout",
    });
    expect(run).toMatchObject({
      status: "failed",
      errorMessage: "hitl_resume_ack_timeout",
    });
  });

  it("migration exposes causal and resume-state columns/indexes", () => {
    const sqlite = getDb().$client;
    const columns = (
      sqlite.prepare("PRAGMA table_info('tasks')").all() as Array<{ name: string }>
    ).map((column) => column.name);
    expect(columns).toEqual(
      expect.arrayContaining([
        "origin_event_id",
        "origin_event_name",
        "wait_step_id",
        "resume_marker",
        "resume_state",
        "resume_attempts",
        "resolution_request_key",
        "resolution_requested_at",
        "resume_dispatched_at",
        "resume_acknowledged_at",
        "resume_error",
      ]),
    );
    const indexes = (
      sqlite.prepare("PRAGMA index_list('tasks')").all() as Array<{ name: string }>
    ).map((index) => index.name);
    expect(indexes).toEqual(
      expect.arrayContaining([
        "tasks_resume_marker_uq",
        "tasks_resume_state_idx",
        "tasks_wait_step_idx",
      ]),
    );
  });
});
