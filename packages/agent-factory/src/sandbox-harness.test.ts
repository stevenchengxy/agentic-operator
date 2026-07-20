import { afterEach, describe, it, expect, vi } from "vitest";
import { synthesizeMockExternalAgents, caseOutcomeFromRuns } from "./sandbox-harness";
import { chainVerdictByKind } from "./verification";
import type { GeneratedAgentSpec } from "./spec-types";

function spec(p: Partial<GeneratedAgentSpec> & { actionName: string; trigger: string[]; emit: string[] }): GeneratedAgentSpec {
  return {
    key: p.actionName, actionName: p.actionName, slug: `rec-${p.actionName}`, short: p.actionName, domainId: "rec",
    nameZh: p.actionName, kind: "llm", trigger: p.trigger, emit: p.emit, tools: [], unresolvedTools: [], objects: [],
    systemPrompt: "x", userPrompt: "", steps: [], ruleRefs: [], retries: 1, hitl: false, confidence: 1, promptSource: "llm",
  } as GeneratedAgentSpec;
}

afterEach(() => vi.unstubAllEnvs());

describe("synthesizeMockExternalAgents", () => {
  it("is unavailable to a non-test process", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(() =>
      synthesizeMockExternalAgents(
        [spec({ actionName: "parser", trigger: ["EXTERNAL_INPUT"], emit: ["DONE"] })],
        { domainId: "rec", firedEntries: ["KICKOFF"], terminals: ["DONE"] },
      ),
    ).toThrow(/test-only/);
  });

  it("returns [] when there are no orphan trigger events", () => {
    const specs = [spec({ actionName: "a", trigger: ["E0"], emit: ["E1"] }), spec({ actionName: "b", trigger: ["E1"], emit: ["DONE"] })];
    expect(synthesizeMockExternalAgents(specs, { domainId: "rec", firedEntries: ["E0"], terminals: ["DONE"] })).toEqual([]);
  });

  it("synthesizes a mock that fires on the dangling handoff emit and produces the orphan trigger", () => {
    // createJD emits JD_GENERATED (consumed by no internal agent = handoff); resumeParser waits on
    // RESUME_DOWNLOADED (produced by no one, not fired = external input).
    const specs = [
      spec({ actionName: "createJD", trigger: ["REQUIREMENT_LOGGED"], emit: ["JD_GENERATED"] }),
      spec({ actionName: "resumeParser", trigger: ["RESUME_DOWNLOADED"], emit: ["RESUME_PROCESSED"] }),
    ];
    const mocks = synthesizeMockExternalAgents(specs, { domainId: "rec", firedEntries: ["REQUIREMENT_LOGGED"], terminals: ["RESUME_PROCESSED"] });
    expect(mocks).toHaveLength(1);
    expect(mocks[0]!.emit).toEqual(["RESUME_DOWNLOADED"]);
    expect(mocks[0]!.trigger).toContain("JD_GENERATED");
    expect(mocks[0]!.slug).toContain("-mock-");
  });

  it("falls back to firing on the entry events when there is no dangling handoff", () => {
    const specs = [spec({ actionName: "parser", trigger: ["RESUME_DOWNLOADED"], emit: ["DONE"] })];
    const mocks = synthesizeMockExternalAgents(specs, { domainId: "rec", firedEntries: ["KICKOFF"], terminals: ["DONE"] });
    expect(mocks).toHaveLength(1);
    expect(mocks[0]!.trigger).toEqual(["KICKOFF"]);
    expect(mocks[0]!.emit).toEqual(["RESUME_DOWNLOADED"]);
  });
});

describe("caseOutcomeFromRuns + chainVerdictByKind (live per-case attribution)", () => {
  const success = ["RESUME_PROCESSED", "INVITE_SENT"];
  it("pass case reaching a success terminal → pass", () => {
    const o = caseOutcomeFromRuns("pass", [{ status: "ok", emittedEvent: "JD_GENERATED" }, { status: "ok", emittedEvent: "RESUME_PROCESSED" }], { successTerminals: success });
    expect(o.reachedSuccessTerminal).toBe(true);
    expect(chainVerdictByKind([o]).allPass).toBe(true);
  });

  it("checks an exact event for structured decision-table boundary cases", () => {
    const ok = caseOutcomeFromRuns("edge", [{ status: "ok", emittedEvent: "MATCH_REVIEW" }], { successTerminals: [], expectedEvent: "MATCH_REVIEW" });
    const bad = caseOutcomeFromRuns("edge", [{ status: "ok", emittedEvent: "MATCH_PASSED" }], { successTerminals: [], expectedEvent: "MATCH_REVIEW" });
    expect(chainVerdictByKind([ok]).allPass).toBe(true);
    expect(chainVerdictByKind([bad]).allPass).toBe(false);
  });
  it("reject case reaching a FAIL terminal (clean reject) → pass, not counted against success", () => {
    const o = caseOutcomeFromRuns("reject", [{ status: "ok", emittedEvent: "RESUME_LOCKED_CONFLICT" }], { successTerminals: success });
    expect(o.reachedFailTerminal).toBe(true);
    expect(o.reachedSuccessTerminal).toBe(false);
    expect(chainVerdictByKind([o]).allPass).toBe(true);
  });
  it("a failed-status run counts as reaching a fail terminal", () => {
    const o = caseOutcomeFromRuns("reject", [{ status: "failed", emittedEvent: null }], { successTerminals: success });
    expect(o.reachedFailTerminal).toBe(true);
  });
  it("zero runs (entry didn't route) → crashed", () => {
    const o = caseOutcomeFromRuns("pass", [], { successTerminals: success });
    expect(o.crashed).toBe(true);
    expect(chainVerdictByKind([o]).allPass).toBe(false);
  });
  it("edge case completes without crash → pass", () => {
    const o = caseOutcomeFromRuns("edge", [{ status: "ok", emittedEvent: "JD_GENERATED" }], { successTerminals: success });
    expect(chainVerdictByKind([o]).allPass).toBe(true);
  });
});
