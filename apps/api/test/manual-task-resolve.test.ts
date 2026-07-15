import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { auditLog, getDb, tasks, tenants } from "@agentic/db";
import { inngest } from "@agentic/runtime";
import { eq } from "drizzle-orm";
import { buildTestEnv, type TestEnv } from "./harness";

describe("manual task resolution", () => {
  let env: TestEnv;
  let tenantId: string;
  let taskId: string | null = null;

  beforeAll(async () => {
    env = await buildTestEnv();
    tenantId = getDb()
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.slug, "__system"))
      .all()[0]!.id;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (!taskId) return;
    const db = getDb();
    db.delete(auditLog).where(eq(auditLog.targetId, taskId)).run();
    db.delete(tasks).where(eq(tasks.id, taskId)).run();
    taskId = null;
  });

  it("accepts supplement and publishes the tenant-scoped resume event", async () => {
    taskId = `tsk-supplement-${Date.now().toString(36)}`;
    getDb()
      .insert(tasks)
      .values({
        id: taskId,
        tenantId,
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
    const send = vi
      .spyOn(inngest, "send")
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
      data: { task_id: taskId, decision: "supplement" },
    });
    expect(send).toHaveBeenCalledWith({
      name: "task.resolved",
      data: {
        taskId,
        tenantId,
        decision: "supplement",
        payload: { decision: "revise", evidence: ["policy-7"] },
      },
    });
    expect(
      getDb()
        .select({ meta: auditLog.metaJson })
        .from(auditLog)
        .where(eq(auditLog.targetId, taskId))
        .all(),
    ).toContainEqual({ meta: { decision: "supplement" } });
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
