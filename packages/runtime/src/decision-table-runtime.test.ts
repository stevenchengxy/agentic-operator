import { describe, expect, it } from "vitest";
import { ActionSchema, AgentSchema } from "./manifest";
import { runAction } from "./step-engine";

const decision = {
  id: "score",
  rows: [
    { id: "low", all: [{ path: "score", op: "lt", value: 40 }], outcome: "reject", emitEvent: "FAILED" },
    { id: "pass", all: [{ path: "score", op: "gte", value: 40 }], outcome: "pass", emitEvent: "PASSED" },
  ],
  missing: { outcome: "review", emitEvent: "REVIEW" },
  default: { outcome: "review", emitEvent: "REVIEW" },
} as const;

describe("decision-table runtime", () => {
  it("validates declared emits and routes 39/40/null without an LLM", async () => {
    const action = ActionSchema.parse({ order: "1", name: "route", type: "decision", decision_table: decision });
    const run = (data: Record<string, unknown>) => runAction({
      ctx: { agentName: "route", actionName: "route", correlationId: "c", tenantSlug: "t", event: { name: "IN", data } },
      action,
      agent: { triggeredEvents: ["FAILED", "PASSED", "REVIEW"] },
    });
    await expect(run({ score: 39 })).resolves.toMatchObject({ ok: true, data: { outcome: "reject", _emit: "FAILED" } });
    await expect(run({ score: 40 })).resolves.toMatchObject({ ok: true, data: { outcome: "pass", _emit: "PASSED" } });
    await expect(run({})).resolves.toMatchObject({ ok: true, data: { outcome: "review", _emit: "REVIEW" } });
  });

  it("rejects a table that can emit outside triggered_event", () => {
    const base = {
      id: "a", name: "a", actor: ["Agent"], trigger: ["IN"], triggered_event: ["PASSED"],
      actions: [{ order: "1", name: "route", type: "decision", decision_table: decision }],
    };
    expect(AgentSchema.safeParse(base).success).toBe(false);
  });
});
