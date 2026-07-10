import { describe, it, expect } from "vitest";
import { compileGraph, verifyGraph, coverageGap } from "./graph";
import type { OntologyAction } from "./ontology-types";

// recruit-gen-v1 — the real 6-action recruitment ontology, inlined as a fixture so
// the graph logic is tested without the snapshot loader (which becomes the injected
// OntologySource port in M1-b). Values verified 1:1 against the OLD repo's
// lib/ontology-generator/snapshots/recruit-gen-v1/actions.json.
function act(p: Partial<OntologyAction> & { id: string; name: string }): OntologyAction {
  return {
    id: p.id,
    name: p.name,
    actor: p.actor ?? ["Agent"],
    trigger: p.trigger ?? [],
    triggered_event: p.triggered_event ?? [],
    target_objects: p.target_objects ?? [],
    tool_use: p.tool_use ?? [],
    system_prompt: p.system_prompt ?? "",
    user_prompt: p.user_prompt ?? "",
    ...(p.side_effects ? { side_effects: p.side_effects } : {}),
  };
}

const recruitActions: OntologyAction[] = [
  act({ id: "RG-1", name: "parseResume", trigger: ["RESUME_DOWNLOADED"], triggered_event: ["RESUME_PROCESSED", "RESUME_LOCKED_CONFLICT"] }),
  act({ id: "RG-2", name: "ruleCheck", trigger: ["RESUME_PROCESSED"], triggered_event: ["MATCH_RULE_CHECK_PASSED", "MATCH_RULE_CHECK_FAILED"] }),
  act({ id: "RG-3", name: "matchResume", trigger: ["MATCH_RULE_CHECK_PASSED"], triggered_event: ["MATCH_PASSED_NEED_INTERVIEW", "MATCH_FAILED"] }),
  act({ id: "RG-4", name: "inviteInterview", trigger: ["INTERVIEW_INVITATION_REQUESTED"], triggered_event: ["INTERVIEW_INVITATION_SENT", "INTERVIEW_INVITATION_FAILED"] }),
  act({ id: "RG-5", name: "createJd", trigger: ["REQUIREMENT_LOGGED", "CLARIFICATION_READY", "JD_REJECTED"], triggered_event: ["JD_GENERATED"] }),
  act({ id: "RG-6", name: "candidateIdentity", trigger: ["CANDIDATE_IDENTITY_REQUESTED"], triggered_event: ["CANDIDATE_IDENTITY_CHECKED"] }),
];

describe("compileGraph (recruit-gen-v1, real ontology)", () => {
  const g = compileGraph(recruitActions, { domainId: "recruit-gen-v1" });

  it("makes one node per action", () => {
    expect(g.nodes).toHaveLength(6);
    expect(g.nodes.map((n) => n.action).sort()).toEqual(
      ["candidateIdentity", "createJd", "inviteInterview", "matchResume", "parseResume", "ruleCheck"].sort(),
    );
  });

  it("derives edges from triggered_event → trigger (the real chain)", () => {
    const edge = (from: string, to: string) => g.edges.some((e) => e.from === from && e.to === to);
    // parseResume --RESUME_PROCESSED--> ruleCheck --MATCH_RULE_CHECK_PASSED--> matchResume
    expect(edge("parseResume", "ruleCheck")).toBe(true);
    expect(edge("ruleCheck", "matchResume")).toBe(true);
    expect(g.edges.find((e) => e.from === "parseResume" && e.to === "ruleCheck")?.event).toBe("RESUME_PROCESSED");
  });

  it("marks conditional emitters as branch actions (emit > 1)", () => {
    expect(g.branchActions).toContain("parseResume"); // RESUME_PROCESSED | RESUME_LOCKED_CONFLICT
    expect(g.branchActions).toContain("ruleCheck");
    expect(g.branchActions).toContain("matchResume");
    expect(g.branchActions).not.toContain("createJd"); // single emit
  });

  it("identifies entry events (consumed, never emitted) and terminals (emitted, never consumed)", () => {
    expect(g.entryEvents).toContain("RESUME_DOWNLOADED");
    expect(g.entryEvents).toContain("INTERVIEW_INVITATION_REQUESTED");
    expect(g.terminalEvents).toContain("RESUME_LOCKED_CONFLICT");
    expect(g.terminalEvents).toContain("JD_GENERATED");
    // RESUME_PROCESSED is consumed downstream → NOT terminal
    expect(g.terminalEvents).not.toContain("RESUME_PROCESSED");
  });

  it("recruitment has no HITL (all actors are Agent — verified ground truth)", () => {
    expect(g.hitlActions).toEqual([]);
  });
});

describe("verifyGraph", () => {
  const full = compileGraph(recruitActions, { domainId: "recruit-gen-v1" });

  it("ground-truth ontology closes (ok, no issues)", () => {
    const r = verifyGraph(full);
    expect(r.ok).toBe(true);
    expect(r.issues).toEqual([]);
  });

  it("catches the dangling-emit bug: a generated graph missing a producer", () => {
    // authoritative entry/terminal sets from the full ontology
    const known = { knownEntries: full.entryEvents, knownTerminals: full.terminalEvents };
    // a BAD generated plan that dropped `ruleCheck` (the real Planner 4-vs-6 failure)
    const bad = compileGraph(
      recruitActions.filter((a) => a.name !== "ruleCheck"),
      { domainId: "recruit-gen-v1" },
    );
    const r = verifyGraph(bad, known);
    expect(r.ok).toBe(false);
    // matchResume now consumes MATCH_RULE_CHECK_PASSED that nobody emits (and it's not an entry)
    expect(r.issues).toContainEqual({
      kind: "missing_producer",
      action: "matchResume",
      event: "MATCH_RULE_CHECK_PASSED",
    });
    // parseResume's RESUME_PROCESSED is now consumed by nobody and is not an authoritative terminal
    expect(r.issues).toContainEqual({
      kind: "orphan_emit",
      action: "parseResume",
      event: "RESUME_PROCESSED",
    });
  });

  it("detects an invented event the generator hallucinated", () => {
    const known = { knownEntries: full.entryEvents, knownTerminals: full.terminalEvents };
    const hallucinated: OntologyAction[] = [
      ...recruitActions,
      act({
        id: "RG-X",
        name: "phantomDedup",
        trigger: ["RESUME_PROCESSED"],
        triggered_event: ["CANDIDATE_DEDUP_PASSED"], // invented, nobody consumes, not a real terminal
      }),
    ];
    const g = compileGraph(hallucinated, { domainId: "recruit-gen-v1" });
    const r = verifyGraph(g, known);
    expect(r.ok).toBe(false);
    expect(r.issues).toContainEqual({
      kind: "orphan_emit",
      action: "phantomDedup",
      event: "CANDIDATE_DEDUP_PASSED",
    });
  });
});

describe("coverageGap (deterministic completeness, adaptive)", () => {
  it("returns the actor=Agent actions that have no covering spec", () => {
    // recruit-gen-v1 has 6 Agent actions; cover only 2.
    const gap = coverageGap(recruitActions, ["parseResume", "createJd"]);
    expect(gap).toContain("ruleCheck");
    expect(gap).toContain("matchResume");
    expect(gap).not.toContain("parseResume");
    expect(gap).not.toContain("createJd");
  });

  it("is empty when every Agent action is covered", () => {
    const all = recruitActions.filter((a) => a.actor.includes("Agent")).map((a) => a.name);
    expect(coverageGap(recruitActions, all)).toEqual([]);
  });

  it("ignores non-Agent (human/system) actions — never forces spurious agents", () => {
    const acts: OntologyAction[] = [
      act({ id: "h", name: "humanReview", actor: ["Human"], trigger: ["X"], triggered_event: ["Y"] }),
      act({ id: "s", name: "autoSync", actor: ["System"], trigger: ["Y"], triggered_event: ["Z"] }),
    ];
    expect(coverageGap(acts, [])).toEqual([]);
  });

  it("still requires coverage for an Agent+Human action (it is in read_ontology's set)", () => {
    const acts: OntologyAction[] = [
      act({ id: "m", name: "mixed", actor: ["Agent", "Human"], trigger: ["X"], triggered_event: ["Y"] }),
    ];
    expect(coverageGap(acts, [])).toEqual(["mixed"]);
  });
});

describe("HITL detection (synthetic)", () => {
  it("flags Human actors and gate side-effects", () => {
    const acts: OntologyAction[] = [
      act({ id: "E-1", name: "dispatchOrder", actor: ["Agent"], trigger: ["ORDER_REQUESTED"], triggered_event: ["ORDER_GATE_PENDING"] }),
      act({
        id: "E-2", name: "humanApprove", actor: ["Human"],
        trigger: ["ORDER_GATE_PENDING"], triggered_event: ["ORDER_APPROVED"],
        side_effects: { gate: "waitForEvent HUMAN_DECISION" },
      }),
    ];
    const g = compileGraph(acts, { domainId: "energy-synthetic" });
    expect(g.hitlActions).toContain("humanApprove");
  });
});

// #AUDIT-FIX(P2-02) — 反向可达 / dead_end 检测：可达但到不了终态的分支必须被标出。
describe("verifyGraph dead_end (#P2-02 reverse reachability)", () => {
  it("flags a node that is reachable from entry but cycles without ever reaching a terminal", () => {
    // A→X→Y→X (X/Y 互相环，永不产出终态)；B→DONE 提供一个合法终态让图别整体 no_terminal。
    const g = compileGraph(
      [
        act({ id: "n-a", name: "A", trigger: ["E_IN"], triggered_event: ["E_X"] }),
        act({ id: "n-x", name: "X", trigger: ["E_X"], triggered_event: ["E_Y"] }),
        act({ id: "n-y", name: "Y", trigger: ["E_Y"], triggered_event: ["E_X"] }), // 环回 X，无出口
        act({ id: "n-b", name: "B", trigger: ["E_IN2"], triggered_event: ["DONE"] }),
      ],
      { domainId: "cyc" },
    );
    const v = verifyGraph(g, { knownTerminals: ["DONE"] });
    const deadEnds = v.issues.filter((i) => i.kind === "dead_end").map((i) => (i as { action: string }).action).sort();
    // A/X/Y 都到不了 DONE → 全部 dead_end；B 能到 DONE → 不算。
    expect(deadEnds).toEqual(["A", "X", "Y"]);
    expect(v.ok).toBe(false);
  });

  it("a clean linear chain to a terminal has no dead_end", () => {
    const g = compileGraph(recruitActions, { domainId: "recruit-gen-v1" });
    const v = verifyGraph(g, { knownTerminals: ["MATCH_PASSED_NEED_INTERVIEW", "INTERVIEW_INVITATION_SENT", "JD_GENERATED", "CANDIDATE_IDENTITY_CHECKED", "MATCH_FAILED"] });
    expect(v.issues.some((i) => i.kind === "dead_end")).toBe(false);
  });
});
