import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  auditLog,
  events,
  getDb,
  runs,
  steps,
  tasks,
  tenants,
  workflows,
} from "@agentic/db";
import { getTenantInngest, inngest, tenantEventName } from "@agentic/runtime";
import { eq } from "drizzle-orm";
import { buildTestEnv, type TestEnv } from "./harness";

describe("manual task resolution", () => {
  let env: TestEnv;
  let tenantId: string;
  let tenantSlug: string;
  let agentId: string;
  let taskId: string | null = null;
  let runId: string | null = null;
  let stepId: string | null = null;
  let eventId: string | null = null;

  beforeAll(async () => {
    env = await buildTestEnv();
    const owner = getDb()
      .select({
        tenantId: tenants.id,
        tenantSlug: tenants.slug,
        agentId: agents.id,
      })
      .from(agents)
      .innerJoin(workflows, eq(workflows.id, agents.workflowId))
      .innerJoin(tenants, eq(tenants.id, workflows.tenantId))
      .where(eq(tenants.slug, "__system"))
      .all()[0];
    if (!owner) {
      throw new Error(
        "manual-task-resolve test requires a bootstrapped __system agent",
      );
    }
    tenantId = owner.tenantId;
    tenantSlug = owner.tenantSlug;
    agentId = owner.agentId;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    const db = getDb();
    if (taskId) {
      db.delete(auditLog).where(eq(auditLog.targetId, taskId)).run();
      db.delete(tasks).where(eq(tasks.id, taskId)).run();
      taskId = null;
    }
    // Deleting the run cascades its steps (steps.runId onDelete: cascade).
    if (runId) {
      db.delete(runs).where(eq(runs.id, runId)).run();
      runId = null;
    }
    if (eventId) {
      db.delete(events).where(eq(events.id, eventId)).run();
      eventId = null;
    }
    stepId = null;
  });

  it("accepts supplement and dispatches the durable tenant-scoped resume event", async () => {
    // The /resolve route is now the durable HITL-recovery entrypoint
    // (requestHumanTaskResolution): a resolvable task must own a `waiting`
    // run with a `manual`/`running` wait step. Seed that recoverable fixture
    // exactly like tc-hitl-recovery does, then drive it through the real
    // Fastify route so the auth gate, form validation, and durable dispatch
    // are exercised end to end.
    const suffix = `${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    taskId = `tsk-supplement-${suffix}`;
    runId = `run-supplement-${suffix}`;
    stepId = `stp-supplement-${suffix}`;
    eventId = `evt-supplement-${suffix}`;
    const marker = `hitl:${tenantId}:${runId}:${taskId}`;
    const db = getDb();

    db.insert(events)
      .values({
        id: eventId,
        tenantId,
        name: `${tenantSlug}/HITL_SUPPLEMENT`,
        subject: suffix,
      })
      .run();
    db.insert(runs)
      .values({
        id: runId,
        tenantId,
        agentId,
        triggerEventId: eventId,
        status: "waiting",
        startedAt: new Date(Date.now() - 1_000),
        correlationId: `corr-${suffix}`,
        subject: suffix,
      })
      .run();
    db.insert(steps)
      .values({
        id: stepId,
        runId,
        ord: 0,
        name: "human review",
        type: "manual",
        status: "running",
        startedAt: new Date(Date.now() - 500),
      })
      .run();
    db.insert(tasks)
      .values({
        id: taskId,
        tenantId,
        runId,
        originEventId: eventId,
        originEventName: `${tenantSlug}/HITL_SUPPLEMENT`,
        waitStepId: stepId,
        resumeMarker: marker,
        resumeState: "pending",
        type: "approval",
        title: "Supply missing decision evidence",
        awaitingRole: "operator",
        priority: "medium",
        status: "open",
        payloadJson: {
          formSchema: {
            type: "object",
            required: ["decision", "evidence"],
            properties: {
              decision: {
                type: "string",
                enum: ["approve", "reject", "revise"],
              },
              evidence: {
                type: "array",
                items: { type: "string" },
              },
            },
            additionalProperties: false,
          },
        },
      })
      .run();

    // The durable resume is dispatched through the per-tenant Inngest client
    // (hitl-recovery.ts defaultResumeSender → getTenantInngest(slug).send),
    // not the bare `inngest` singleton the legacy route used.
    const send = vi
      .spyOn(getTenantInngest(tenantSlug), "send")
      .mockResolvedValue({ ids: ["evt-task-resolved"] } as never);

    const response = await env.fetch(`/v1/tasks/${taskId}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        decision: "supplement",
        payload: { decision: "revise", evidence: ["policy-7"] },
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      data: {
        task_id: taskId,
        decision: "supplement",
        status: "resolving",
        resume_marker: marker,
      },
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        id: `hitl-resume-${taskId}-a1`,
        name: tenantEventName(tenantSlug, "task.resolved"),
        data: expect.objectContaining({
          taskId,
          tenantId,
          decision: "supplement",
          payload: { decision: "revise", evidence: ["policy-7"] },
          resumeMarker: marker,
        }),
      }),
    );
    expect(
      getDb()
        .select({ meta: auditLog.metaJson })
        .from(auditLog)
        .where(eq(auditLog.targetId, taskId))
        .all(),
    ).toContainEqual({
      meta: {
        decision: "supplement",
        deliveryStatus: "resolving",
        resumeMarker: marker,
        attempt: 1,
      },
    });
  });

  it("rejects payloads that do not satisfy the authored task form", async () => {
    taskId = `tsk-invalid-form-${Date.now().toString(36)}`;
    getDb()
      .insert(tasks)
      .values({
        id: taskId,
        tenantId,
        type: "approval",
        title: "Review a typed decision form",
        awaitingRole: "operator",
        priority: "medium",
        status: "open",
        payloadJson: {
          formSchema: {
            type: "object",
            required: ["decision", "notes"],
            properties: {
              decision: { type: "string", enum: ["approve", "reject"] },
              notes: { type: "string", minLength: 3 },
            },
            additionalProperties: false,
          },
        },
      })
      .run();
    const send = vi
      .spyOn(inngest, "send")
      .mockResolvedValue({ ids: ["should-not-send"] } as never);

    const response = await env.fetch(`/v1/tasks/${taskId}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        decision: "approve",
        payload: { decision: "approve", notes: "" },
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_task_payload" },
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects a form decision that contradicts the requested outcome", async () => {
    taskId = `tsk-mismatch-${Date.now().toString(36)}`;
    getDb()
      .insert(tasks)
      .values({
        id: taskId,
        tenantId,
        type: "approval",
        title: "Review one consistent decision",
        priority: "medium",
        status: "open",
        payloadJson: {
          formSchema: {
            type: "object",
            required: ["decision"],
            properties: {
              decision: { type: "string", enum: ["approve", "reject"] },
            },
            additionalProperties: false,
          },
        },
      })
      .run();
    const send = vi
      .spyOn(inngest, "send")
      .mockResolvedValue({ ids: ["should-not-send"] } as never);

    const response = await env.fetch(`/v1/tasks/${taskId}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        decision: "approve",
        payload: { decision: "reject" },
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "task_decision_mismatch" },
    });
    expect(send).not.toHaveBeenCalled();
  });
});
