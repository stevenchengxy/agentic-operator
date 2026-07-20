import { describe, it, expect } from "vitest";
import {
  sanitizeStepId,
  applyToolResultMap,
  stableStepId,
  evaluateCondition,
  evaluateConditionDetailed,
  foreachStepId,
  stableDigest96,
  materializeForeach,
  materializeToolArguments,
  runSequentialForeach,
  shouldSkip,
  softInvoke,
} from "./action-plan";

describe("exact tool argument/result dataflow", () => {
  const scope = {
    event: { name: "START", data: { tenant: "t-1", nested: { id: "E-1" } } },
    input: { tenant: "t-1", nested: { id: "E-1" } },
    lastResult: { token: "prev" },
    // Named results contain the raw ToolResult.data value; `result` is only
    // the compatibility alias in the safe path dialect.
    results: { fetch: { object_key: "r/1.pdf" } },
    locals: { resume: { resume_id: "R-1" }, index: 0 },
  };

  it("materializes only explicit paths/constants, including foreach locals", () => {
    const result = materializeToolArguments({
      tenant_id: { from: "input.tenant" },
      event_id: { from: "event.data.nested.id" },
      token: { from: "lastResult.token" },
      object_key: { from: "results.fetch.result.object_key" },
      resume_id: { from: "locals.resume.resume_id" },
      mode: { const: "sandbox" },
      options: { const: { strict: true, retries: 0 } },
      absent_optional: { from: "input.not_there", required: false },
    }, scope);
    expect(result).toEqual({
      ok: true,
      args: {
        tenant_id: "t-1",
        event_id: "E-1",
        token: "prev",
        object_key: "r/1.pdf",
        resume_id: "R-1",
        mode: "sandbox",
        options: { strict: true, retries: 0 },
      },
    });
  });

  it("fails closed for missing required/unrooted paths and non-JSON constants", () => {
    expect(materializeToolArguments({ id: { from: "input.missing" } }, scope)).toMatchObject({ ok: false, argument: "id", path: "input.missing" });
    expect(materializeToolArguments({ id: { from: "nested.id" } }, scope)).toMatchObject({ ok: false, argument: "id" });
    expect(materializeToolArguments({ bad: { const: Number.NaN } }, scope)).toMatchObject({ ok: false, argument: "bad" });
  });

  it("maps a raw tool result to named fields and optionally retains raw", () => {
    const raw = { data: { candidate: { id: "C-7" } }, status: 201 };
    expect(applyToolResultMap(raw, {
      fields: { candidate_id: "result.data.candidate.id", status: "result.status" },
      include_raw: true,
    })).toEqual({ ok: true, value: { candidate_id: "C-7", status: 201, _raw: raw } });
    expect(applyToolResultMap(raw, { fields: { missing: "result.nope" } })).toMatchObject({ ok: false, field: "missing", path: "result.nope" });
  });
});

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

describe("foreach — stable frames and sequential state machine", () => {
  it("derives collision-safe stable keys from business ids, never array indexes", () => {
    const made = materializeForeach({
      items: [{ resume_id: "a/b" }, { resume_id: "a b" }],
      itemAs: "resume",
      itemKeyFrom: "resume.resume_id",
    });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    expect(made.frames.map((frame) => frame.businessKey)).toEqual(["a/b", "a b"]);
    expect(new Set(made.frames.map((frame) => frame.stableKey)).size).toBe(2);
    expect(made.frames.every((frame) => /-[a-f0-9]{24}$/.test(frame.stableKey))).toBe(true);
    expect(stableDigest96("a/b")).toMatch(/^[a-f0-9]{24}$/);
    expect(foreachStepId("parse-all", made.frames[0]!, "parse-one")).toMatch(/^parse-all-a-b-/);
  });

  it("fails closed on missing or duplicate stable business keys", () => {
    expect(materializeForeach({ items: [{ id: "x" }, { id: "x" }], itemKeyFrom: "id" }).ok).toBe(false);
    expect(materializeForeach({ items: [{ nope: 1 }], itemKeyFrom: "id" }).ok).toBe(false);
  });

  it("awaits one item before starting the next", async () => {
    const made = materializeForeach({ items: [{ id: "1" }, { id: "2" }, { id: "3" }], itemKeyFrom: "id" });
    if (!made.ok) throw new Error(made.error);
    let active = 0;
    let peak = 0;
    const order: string[] = [];
    const outputs = await runSequentialForeach(made.frames, async (frame) => {
      active++;
      peak = Math.max(peak, active);
      order.push(`start:${frame.businessKey}`);
      await Promise.resolve();
      order.push(`end:${frame.businessKey}`);
      active--;
      return frame.businessKey;
    });
    expect(peak).toBe(1);
    expect(order).toEqual(["start:1", "end:1", "start:2", "end:2", "start:3", "end:3"]);
    expect(outputs).toEqual(["1", "2", "3"]);
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
  it("addresses non-adjacent named step results, including hyphenated step ids", () => {
    const scope = {
      results: {
        "parse-resume": { name: "张三", phone: "13800000000" },
        "dedup-lock": { conflict: false },
      },
    };
    expect(evaluateCondition("results.parse-resume.result.name != null && results.parse-resume.result.phone != null", scope)).toBe(true);
    expect(evaluateCondition("dedup-lock.result.conflict == false", scope)).toBe(true);
    expect(evaluateCondition("steps['dedup-lock'].result.conflict === false", scope)).toBe(true);
  });
  it("addresses foreach locals by explicit and shorthand paths", () => {
    const scope = { locals: { resume: { resume_id: "R-1" }, index: 0 } };
    expect(evaluateCondition("locals.resume.resume_id == 'R-1'", scope)).toBe(true);
    expect(evaluateCondition("resume.resume_id == 'R-1' && index == 0", scope)).toBe(true);
  });
  it("does not treat a missing result as non-null", () => {
    expect(evaluateCondition("results.parse-resume.result.name != null", { results: {} })).toBe(false);
  });
  it("returns an invalid diagnostic for natural language / unsupported callbacks", () => {
    expect(evaluateConditionDetailed("invitation generation succeeded", {}).valid).toBe(false);
    expect(evaluateConditionDetailed("items.some(x => x.ok)", {}).valid).toBe(false);
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
  it("defaults to terminal when no onError policy is supplied", async () => {
    await expect(softInvoke(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
  });
  it("times out and soft-fails to the fallback", async () => {
    const r = await softInvoke(() => new Promise((res) => setTimeout(() => res("late"), 50)), { timeoutMs: 5, onError: "soft", fallback: "default" });
    expect(r.timedOut).toBe(true);
    expect(r.data).toBe("default");
  });
});
