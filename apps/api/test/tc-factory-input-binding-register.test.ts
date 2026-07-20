import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { desc, eq } from "drizzle-orm";
import { AgentSchema, InputBindingResolutionError, registerAgent, type RegisterContext } from "@agentic/runtime";
import type { ToolContext, ToolDescriptor } from "@agentic/agent-kit";
import { agents, getDb, runs, tenants, workflows } from "@agentic/db";
import { makeId } from "@agentic/shared";

const suffix = Date.now().toString(36).toLowerCase();
const tenantSlug = `factory-bindings-${suffix}`;
const originalWorkApiKey = process.env.WORK_API_KEY;

describe.sequential("factory input bindings execute through registerAgent", () => {
  let tenantId: string;
  let agentId: string;
  let registered: { fn: (ctx: Record<string, unknown>) => Promise<unknown> };
  const seen: Array<Record<string, unknown>> = [];

  beforeAll(() => {
    process.env.WORK_API_KEY = "test-secret-never-exposed";
    const db = getDb();
    tenantId = makeId("ten");
    agentId = makeId("agt");
    const workflowId = makeId("wf");
    db.insert(tenants).values({ id: tenantId, slug: tenantSlug, name: "Factory binding E2E" }).run();
    db.insert(workflows).values({ id: workflowId, tenantId, slug: "factory-bindings", name: "Factory bindings" }).run();
    db.insert(agents).values({
      id: agentId,
      workflowId,
      kebabId: "factory-bound-agent",
      name: "factoryBoundAgent",
      actor: "Agent",
      kind: "manifest",
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    }).run();

    const lookupBinding = {
      field: "stored_result",
      type: "String",
      required: true,
      kind: "object_lookup" as const,
      source_object: "Work.result",
      tool: "records.getWork",
      arguments: { id: "bindings.work_id" },
      result_path: "result.value",
      depends_on: ["work_id"],
    };
    const agent = AgentSchema.parse({
      id: "factory-bound-agent",
      name: "factoryBoundAgent",
      actor: ["Agent"],
      trigger: ["START"],
      triggered_event: [],
      tool_use: [{ name: "records.getWork", config: { api_key_env: "WORK_API_KEY", region: "cn-east" } }, { name: "calculate" }],
      factory_tool_profile_refs: { "records.getWork": "profile-1" },
      factory_input_bindings: [
        { field: "work_id", type: "String", required: true, kind: "event", event_path: "work_id" },
        { field: "api_key", type: "String", required: true, kind: "secret", reference: "tool:records.getWork:api_key_env" },
        { field: "region", type: "String", required: true, kind: "config", reference: "tool:records.getWork:region" },
        lookupBinding,
        { field: "score", type: "Number", required: true, kind: "step_output", source_step: "calculate", source_output: "score" },
      ],
      actions: [
        { order: "1", name: "records.getWork", type: "tool", result_key: "input-binding-1", input_binding: lookupBinding },
        { order: "2", name: "calculate", type: "tool", result_key: "calculate" },
      ],
    });
    const lookupTool: ToolDescriptor = {
      kind: "tool",
      name: "records.getWork",
      async handler(ctx: ToolContext) {
        seen.push({ tool: "lookup", ...(ctx.event.data as Record<string, unknown>) });
        return { data: { result: { value: `stored:${String((ctx.event.data as Record<string, unknown>).id)}` } } };
      },
    };
    const calculateTool: ToolDescriptor = {
      kind: "tool",
      name: "calculate",
      async handler(ctx: ToolContext) {
        seen.push({ tool: "calculate", ...(ctx.event.data as Record<string, unknown>) });
        return { data: { score: 7 } };
      },
    };
    const context: RegisterContext = {
      tenantId,
      tenantSlug,
      workflowVersionId: makeId("wfv"),
      tenantRegistry: { tools: { "records.getWork": lookupTool, calculate: calculateTool } },
    };
    registered = registerAgent(agent, context) as unknown as typeof registered;
  });

  afterAll(() => {
    getDb().delete(tenants).where(eq(tenants.id, tenantId)).run();
    if (originalWorkApiKey === undefined) delete process.env.WORK_API_KEY;
    else process.env.WORK_API_KEY = originalWorkApiKey;
  });

  const invocation = (data: Record<string, unknown>) => ({
    event: { name: `${tenantSlug}/START`, data },
    step: {
      run: async (_id: string | { id: string }, fn: (...args: unknown[]) => unknown, ...args: unknown[]) => fn(...args),
      sendEvent: async () => undefined,
    },
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
  });

  it("binds event → registered lookup → step output end to end without exposing refs", async () => {
    await expect(registered.fn(invocation({ work_id: "W-7", subject: "ok" }))).resolves.toMatchObject({ ok: true });
    expect(seen).toEqual([
      expect.objectContaining({ tool: "lookup", id: "W-7", work_id: "W-7" }),
      expect.objectContaining({ tool: "calculate", work_id: "W-7", stored_result: "stored:W-7" }),
    ]);
    expect(seen.some((entry) => "api_key" in entry || "region" in entry)).toBe(false);
    expect(seen.some((entry) => "subject" in entry)).toBe(false);
    const run = getDb().select().from(runs).where(eq(runs.agentId, agentId)).orderBy(desc(runs.startedAt)).all()[0];
    expect(run?.status).toBe("ok");
  });

  it("fails before any tool runs when a required Event binding is absent", async () => {
    const callsBefore = seen.length;
    await expect(registered.fn(invocation({ subject: "missing" }))).rejects.toBeInstanceOf(InputBindingResolutionError);
    expect(seen).toHaveLength(callsBefore);
    const run = getDb().select().from(runs).where(eq(runs.agentId, agentId)).orderBy(desc(runs.startedAt)).all()[0];
    expect(run).toMatchObject({ status: "failed" });
    expect(run?.errorMessage).toContain("work_id");
  });
});
