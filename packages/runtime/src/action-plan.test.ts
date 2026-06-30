import { describe, it, expect } from "vitest";
import {
  sanitizeStepId,
  stableStepId,
  evaluateCondition,
  shouldSkip,
  softInvoke,
} from "./action-plan";

// Phase 1a — pure decision logic extracted from the Inngest-coupled register.ts / step-engine.ts
// so branch/skip/idempotency/invoke semantics are unit-testable without a live Inngest or DB.

describe("sanitizeStepId", () => {
  it("strips unsafe chars, keeps [A-Za-z0-9_-], truncates to 80", () => {
    expect(sanitizeStepId("req:abc/def 123")).toBe("req-abc-def-123");
    expect(sanitizeStepId("x".repeat(100)).length).toBe(80);
  });
  it("falls back to 'step' on empty", () => {
    expect(sanitizeStepId("")).toBe("step");
    expect(sanitizeStepId("///")).toBe("step");
  });
});

describe("stableStepId — idempotencyKeyFrom threads into the step id", () => {
  const scope = { event: { data: { entity_id: "JR-77", nested: { id: "C/9" } } }, subject: "subj-1" };
  it("returns the action name alone when no idempotency key is declared", () => {
    expect(stableStepId("generate-jd", undefined, scope)).toBe("generate-jd");
  });
  it("appends a sanitized business key resolved from event.data", () => {
    expect(stableStepId("generate-jd", "entity_id", scope)).toBe("generate-jd-JR-77");
  });
  it("resolves a dotted path and sanitizes it", () => {
    expect(stableStepId("save", "nested.id", scope)).toBe("save-C-9");
  });
  it("resolves from subject", () => {
    expect(stableStepId("emit", "subject", scope)).toBe("emit-subj-1");
  });
  it("falls back to the name alone when the key path is missing", () => {
    expect(stableStepId("x", "does.not.exist", scope)).toBe("x");
  });
});

describe("evaluateCondition — real boolean evaluator (no eval)", () => {
  it("handles literals", () => {
    expect(evaluateCondition("true", {})).toBe(true);
    expect(evaluateCondition("false", {})).toBe(false);
  });
  it("handles lastResult null checks (back-compat with the old stub)", () => {
    expect(evaluateCondition("lastResult == null", { lastResult: null })).toBe(true);
    expect(evaluateCondition("lastResult != null", { lastResult: { x: 1 } })).toBe(true);
    expect(evaluateCondition("lastResult != null", { lastResult: null })).toBe(false);
  });
  it("compares a dotted path against a literal", () => {
    const scope = { lastResult: { decision: "approve", score: 80 } };
    expect(evaluateCondition("lastResult.decision == 'approve'", scope)).toBe(true);
    expect(evaluateCondition("lastResult.decision == 'reject'", scope)).toBe(false);
    expect(evaluateCondition("lastResult.score >= 60", scope)).toBe(true);
    expect(evaluateCondition("lastResult.score < 60", scope)).toBe(false);
  });
  it("reads event.data paths", () => {
    const scope = { event: { data: { is_urgent: true, kind: "rush" } } };
    expect(evaluateCondition("event.data.is_urgent == true", scope)).toBe(true);
    expect(evaluateCondition("event.data.kind == 'rush'", scope)).toBe(true);
  });
  it("supports && and ||", () => {
    const scope = { lastResult: { a: 1, b: 0 } };
    expect(evaluateCondition("lastResult.a == 1 && lastResult.b == 0", scope)).toBe(true);
    expect(evaluateCondition("lastResult.a == 2 || lastResult.b == 0", scope)).toBe(true);
    expect(evaluateCondition("lastResult.a == 2 && lastResult.b == 0", scope)).toBe(false);
  });
  it("treats an unparseable expression as false, never throws", () => {
    expect(evaluateCondition("this is (not) valid !!", {})).toBe(false);
    expect(evaluateCondition("", {})).toBe(false);
  });
});

describe("shouldSkip — dependsOn gating drives real branching", () => {
  it("runs an action with no dependsOn", () => {
    expect(shouldSkip({ name: "a" }, { conditionTrue: {}, skipped: new Set() }).skip).toBe(false);
  });
  it("skips when a depended-on condition evaluated false", () => {
    const r = shouldSkip({ name: "persist", dependsOn: ["isApproved"] }, { conditionTrue: { isApproved: false }, skipped: new Set() });
    expect(r.skip).toBe(true);
  });
  it("runs when the depended-on condition evaluated true", () => {
    const r = shouldSkip({ name: "persist", dependsOn: ["isApproved"] }, { conditionTrue: { isApproved: true }, skipped: new Set() });
    expect(r.skip).toBe(false);
  });
  it("skips transitively when a dependency was itself skipped", () => {
    const r = shouldSkip({ name: "notify", dependsOn: ["persist"] }, { conditionTrue: {}, skipped: new Set(["persist"]) });
    expect(r.skip).toBe(true);
  });
});

describe("softInvoke — synchronous sub-call with timeout + soft-fail", () => {
  it("returns the value on success", async () => {
    const r = await softInvoke(async () => ({ verdict: "ok" }), { timeoutMs: 1000 });
    expect(r.ok).toBe(true);
    expect(r.data).toEqual({ verdict: "ok" });
  });
  it("soft-fails to the fallback on a thrown error", async () => {
    const r = await softInvoke(async () => { throw new Error("boom"); }, { onError: "soft", fallback: { verdict: "new" } });
    expect(r.ok).toBe(false);
    expect(r.softFailed).toBe(true);
    expect(r.data).toEqual({ verdict: "new" });
  });
  it("rethrows on a thrown error when onError is terminal", async () => {
    await expect(softInvoke(async () => { throw new Error("boom"); }, { onError: "terminal" })).rejects.toThrow("boom");
  });
  it("times out and soft-fails to the fallback", async () => {
    const r = await softInvoke(() => new Promise((res) => setTimeout(() => res("late"), 50)), { timeoutMs: 5, onError: "soft", fallback: "default" });
    expect(r.timedOut).toBe(true);
    expect(r.data).toBe("default");
  });
});
