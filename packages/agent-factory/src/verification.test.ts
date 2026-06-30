import { describe, it, expect } from "vitest";
import {
  caseVerdict,
  chainVerdictByKind,
  Cassette,
  duplicateSideEffectSteps,
  verificationPolicy,
  type CaseRunOutcome,
} from "./verification";

// Phase 3 — verification substrate.

describe("caseVerdict — per-kind semantics (resolves the reject-case contradiction)", () => {
  it("pass case: passes only on a clean success terminal", () => {
    expect(caseVerdict({ kind: "pass", reachedSuccessTerminal: true, reachedFailTerminal: false, crashed: false }).pass).toBe(true);
    expect(caseVerdict({ kind: "pass", reachedSuccessTerminal: true, reachedFailTerminal: false, crashed: false, degraded: true }).pass).toBe(false);
    expect(caseVerdict({ kind: "pass", reachedSuccessTerminal: false, reachedFailTerminal: true, crashed: false }).pass).toBe(false);
  });
  it("reject case: PASSES when it correctly reaches the FAIL terminal (not counted against success)", () => {
    expect(caseVerdict({ kind: "reject", reachedSuccessTerminal: false, reachedFailTerminal: true, crashed: false }).pass).toBe(true);
    expect(caseVerdict({ kind: "reject", reachedSuccessTerminal: true, reachedFailTerminal: false, crashed: false }).pass).toBe(false);
  });
  it("edge case: passes as long as it didn't crash", () => {
    expect(caseVerdict({ kind: "edge", reachedSuccessTerminal: false, reachedFailTerminal: true, crashed: false }).pass).toBe(true);
    expect(caseVerdict({ kind: "edge", reachedSuccessTerminal: false, reachedFailTerminal: false, crashed: true }).pass).toBe(false);
  });
});

describe("chainVerdictByKind", () => {
  it("aggregates: a correct reject + a success + a graceful edge all pass", () => {
    const outcomes: CaseRunOutcome[] = [
      { kind: "pass", reachedSuccessTerminal: true, reachedFailTerminal: false, crashed: false },
      { kind: "reject", reachedSuccessTerminal: false, reachedFailTerminal: true, crashed: false },
      { kind: "edge", reachedSuccessTerminal: true, reachedFailTerminal: false, crashed: false },
    ];
    const v = chainVerdictByKind(outcomes);
    expect(v.allPass).toBe(true);
    expect(v.byKind.reject).toEqual({ total: 1, passed: 1 });
  });
  it("fails overall if a pass case crashed", () => {
    const v = chainVerdictByKind([{ kind: "pass", reachedSuccessTerminal: false, reachedFailTerminal: false, crashed: true }]);
    expect(v.allPass).toBe(false);
  });
});

describe("Cassette — deterministic record/replay", () => {
  it("replays a recorded response by request key; misses are fail-closed", async () => {
    const tape = new Cassette();
    tape.record("GET", "https://api.example.com/x", undefined, 200, JSON.stringify({ ok: 1 }));
    const hit = tape.replay("GET", "https://api.example.com/x");
    expect(hit?.status).toBe(200);
    expect(tape.replay("GET", "https://api.example.com/other")).toBeUndefined();
  });
  it("round-trips through toJSON", () => {
    const tape = new Cassette();
    tape.record("POST", "https://api.example.com/p", '{"a":1}', 201, "{}");
    const tape2 = new Cassette(tape.toJSON());
    expect(tape2.replay("POST", "https://api.example.com/p", '{"a":1}')?.status).toBe(201);
  });
  it("exposes a fetch-compatible fetchFn (the injection point for makeDeclarativeTool) — replay hit + fail-closed miss", async () => {
    const tape = new Cassette();
    tape.record("GET", "https://api.example.com/jobs/J1", undefined, 200, JSON.stringify({ title: "Eng" }));
    const f = tape.fetchFn();
    const res = await f("https://api.example.com/jobs/J1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ title: "Eng" });
    await expect(f("https://api.example.com/miss")).rejects.toThrow(/cassette miss/);
  });
});

describe("duplicateSideEffectSteps — per-step durability", () => {
  it("flags a side-effecting step that ran twice (broken idempotency)", () => {
    const dup = duplicateSideEffectSteps([
      { ord: 1, name: "save-JR1", sideEffect: true },
      { ord: 2, name: "save-JR1", sideEffect: true },
      { ord: 3, name: "decide", sideEffect: false },
    ]);
    expect(dup).toEqual(["save-JR1"]);
  });
  it("clean when each side-effecting step appears once", () => {
    expect(duplicateSideEffectSteps([{ ord: 1, name: "a", sideEffect: true }, { ord: 2, name: "b", sideEffect: true }])).toEqual([]);
  });
});

describe("verificationPolicy", () => {
  it("defaults to mock model + mock tools + advisory judge (free, deterministic, no side effects)", () => {
    const p = verificationPolicy({});
    expect(p).toEqual({ realModel: false, toolMode: "mock", budgetTokens: 0, judgeIsBlocking: false });
  });
  it("honors explicit opt-ins", () => {
    const p = verificationPolicy({ FACTORY_SANDBOX_REAL_MODEL: "1", FACTORY_SANDBOX_TOOL_MODE: "replay", FACTORY_SANDBOX_BUDGET_TOKENS: "500000" });
    expect(p).toMatchObject({ realModel: true, toolMode: "replay", budgetTokens: 500000 });
  });
});
