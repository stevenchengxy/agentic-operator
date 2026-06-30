import { describe, it, expect } from "vitest";
import { projectPlanToActions, parsePlan, validatePlan } from "./plan-projection";
import type { GeneratedAgentSpec, PlanStep } from "./spec-types";

// Phase 1 — a generated spec's structured plan[] must project into ORDERED manifest actions
// (one durable step.run each), not collapse to a single logic action. Back-compat: no plan →
// the legacy single-logic action.

function spec(p: Partial<GeneratedAgentSpec> & { actionName: string }): GeneratedAgentSpec {
  return {
    key: p.actionName, actionName: p.actionName, slug: p.slug ?? `d-${p.actionName}`, short: p.short ?? p.actionName,
    domainId: "rec", nameZh: p.actionName, kind: "llm", trigger: [], emit: [], tools: [], unresolvedTools: [],
    objects: [], systemPrompt: "x", userPrompt: "", steps: [], ruleRefs: [], retries: 2, hitl: p.hitl ?? false,
    confidence: 1, promptSource: "llm", plan: p.plan,
  } as GeneratedAgentSpec;
}

describe("projectPlanToActions", () => {
  it("falls back to a single logic action when there is no plan (back-compat)", () => {
    const actions = projectPlanToActions(spec({ actionName: "createJD" }));
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ order: "1", name: "createJD", type: "logic", retries: 2 });
  });

  it("prefixes a manual approval gate for HITL agents with no plan", () => {
    const actions = projectPlanToActions(spec({ actionName: "approveOffer", hitl: true }));
    expect(actions.map((a) => a.type)).toEqual(["manual", "logic"]);
    expect(actions[0]!.name).toBe("approveOffer-approval");
  });

  it("projects each plan step into its own ordered action with the right type + fields", () => {
    const plan: PlanStep[] = [
      { stepId: "fetch-requirement", kind: "tool", tool: "getRequirement", idempotencyKeyFrom: "entity_id", onError: "terminal" },
      { stepId: "fetch-clarifications", kind: "tool", tool: "getClarifications", onError: "soft", defaultResult: [] },
      { stepId: "is-complete", kind: "condition", condition: "lastResult != null" },
      { stepId: "persist", kind: "tool", tool: "syncToPg", dependsOn: ["is-complete"], idempotencyKeyFrom: "entity_id" },
      { stepId: "dedup", kind: "invoke", invoke: "candidateIdentity", timeoutS: 90, onError: "soft", defaultResult: { verdict: "new" } },
    ];
    const actions = projectPlanToActions(spec({ actionName: "createJD", plan }));
    expect(actions).toHaveLength(5);
    // order is 1..5 in declaration order
    expect(actions.map((a) => a.order)).toEqual(["1", "2", "3", "4", "5"]);
    // a tool step's NAME is the tool (so step-engine resolves it); others use stepId
    expect(actions[0]).toMatchObject({ name: "getRequirement", type: "tool", idempotency_key_from: "entity_id" });
    expect(actions[1]).toMatchObject({ name: "getClarifications", type: "tool", on_error: "soft" });
    expect(actions[1]!.default_result).toEqual([]);
    expect(actions[2]).toMatchObject({ name: "is-complete", type: "condition", condition: "lastResult != null" });
    expect(actions[3]).toMatchObject({ name: "syncToPg", type: "tool", depends_on: ["is-complete"], idempotency_key_from: "entity_id" });
    expect(actions[4]).toMatchObject({ name: "dedup", type: "invoke", invoke: "candidateIdentity", timeout_s: 90, on_error: "soft" });
  });

  it("keeps the HITL manual gate as action 1, then the plan steps", () => {
    const plan: PlanStep[] = [{ stepId: "decide", kind: "logic" }];
    const actions = projectPlanToActions(spec({ actionName: "approveOffer", hitl: true, plan }));
    expect(actions.map((a) => a.type)).toEqual(["manual", "logic"]);
    expect(actions[0]!.name).toBe("approveOffer-approval");
    expect(actions[1]!.name).toBe("decide");
  });

  it("omits on_error for a 'park' policy (Inngest retries handle it; manifest enum is soft|terminal)", () => {
    const plan: PlanStep[] = [{ stepId: "call", kind: "tool", tool: "t", onError: "park" }];
    const actions = projectPlanToActions(spec({ actionName: "a", plan }));
    expect(actions[0]!.on_error).toBeUndefined();
  });
});

describe("parsePlan — tolerates snake_case + camelCase from the LLM", () => {
  it("normalizes snake_case keys into PlanStep", () => {
    const plan = parsePlan([
      { step_id: "fetch", kind: "tool", tool: "getX", idempotency_key_from: "entity_id", on_error: "terminal" },
      { step_id: "dedup", kind: "invoke", invoke: "idc", depends_on: ["fetch"], default_result: { v: 1 }, timeout_s: 30, on_error: "soft" },
    ]);
    expect(plan[0]).toMatchObject({ stepId: "fetch", kind: "tool", tool: "getX", idempotencyKeyFrom: "entity_id", onError: "terminal" });
    expect(plan[1]).toMatchObject({ stepId: "dedup", kind: "invoke", invoke: "idc", dependsOn: ["fetch"], timeoutS: 30, onError: "soft" });
    expect(plan[1]!.defaultResult).toEqual({ v: 1 });
  });
  it("drops malformed entries (no stepId/kind)", () => {
    const plan = parsePlan([{ kind: "tool" }, "garbage", { step_id: "ok", kind: "logic" }]);
    expect(plan).toHaveLength(1);
    expect(plan[0]!.stepId).toBe("ok");
  });
});

describe("validatePlan — enforces production discipline (Phase 1)", () => {
  const ok: PlanStep[] = [
    { stepId: "fetch", kind: "tool", tool: "getReq", idempotencyKeyFrom: "entity_id", onError: "terminal" },
    { stepId: "is-ok", kind: "condition", condition: "lastResult != null" },
    { stepId: "persist", kind: "tool", tool: "save", idempotencyKeyFrom: "entity_id", onError: "terminal", dependsOn: ["is-ok"] },
  ];
  it("accepts a well-formed plan", () => {
    expect(validatePlan(ok).ok).toBe(true);
  });
  it("rejects duplicate stepIds", () => {
    const r = validatePlan([{ stepId: "a", kind: "logic" }, { stepId: "a", kind: "logic" }]);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/duplicate/i);
  });
  it("rejects a tool step missing its tool", () => {
    expect(validatePlan([{ stepId: "x", kind: "tool", idempotencyKeyFrom: "id", onError: "terminal" }]).ok).toBe(false);
  });
  it("rejects a side-effecting (tool/invoke) step with no idempotencyKeyFrom", () => {
    const r = validatePlan([{ stepId: "x", kind: "tool", tool: "t", onError: "terminal" }]);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/idempotency/i);
  });
  it("rejects a side-effecting step with no onError policy", () => {
    const r = validatePlan([{ stepId: "x", kind: "tool", tool: "t", idempotencyKeyFrom: "id" }]);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/onError|on_error|failure/i);
  });
  it("rejects a condition step with no expression", () => {
    expect(validatePlan([{ stepId: "c", kind: "condition" }]).ok).toBe(false);
  });
  it("rejects an invoke step with no target", () => {
    expect(validatePlan([{ stepId: "i", kind: "invoke", idempotencyKeyFrom: "id", onError: "soft" }]).ok).toBe(false);
  });
  it("rejects a dependsOn that references an unknown / forward step", () => {
    const r = validatePlan([
      { stepId: "a", kind: "tool", tool: "t", idempotencyKeyFrom: "id", onError: "terminal", dependsOn: ["later"] },
      { stepId: "later", kind: "logic" },
    ]);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/depends|forward|unknown/i);
  });
  it("does not require idempotency/onError on logic or condition steps", () => {
    expect(validatePlan([{ stepId: "think", kind: "logic" }, { stepId: "c", kind: "condition", condition: "true" }]).ok).toBe(true);
  });
});
