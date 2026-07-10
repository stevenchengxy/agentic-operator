import { describe, it, expect } from "vitest";
import { acceptanceReport, acceptanceGate } from "./acceptance";
import type { GeneratedAgentSpec } from "./spec-types";
import type { DomainOntology } from "./ontology-types";

function spec(p: Partial<GeneratedAgentSpec> & { actionName: string }): GeneratedAgentSpec {
  return {
    key: p.actionName, actionName: p.actionName, slug: p.slug ?? `d-${p.actionName}`, short: p.short ?? p.actionName, domainId: "rec", nameZh: p.actionName, kind: "llm",
    trigger: p.trigger ?? [], emit: p.emit ?? [], tools: p.tools ?? [], unresolvedTools: p.unresolvedTools ?? [], objects: [], systemPrompt: "x", userPrompt: "",
    steps: [], ruleRefs: [], retries: 1, hitl: false, confidence: 1, promptSource: "llm", inputSchema: p.inputSchema, outputSchema: p.outputSchema,
    generatedCode: p.generatedCode ?? "export const agent = 1;", // a real deliverable carries code (has_code bar)
  } as GeneratedAgentSpec;
}
function ont(actionNames: string[]): DomainOntology {
  return { domainId: "rec", objects: [], rules: [], events: [], workflow: [], source: "allmeta", actions: actionNames.map((n) => ({ id: n, name: n, actor: ["Agent"], trigger: [], triggered_event: [], target_objects: [], tool_use: [], system_prompt: "", user_prompt: "" })) };
}
const okIO = [{ field: "a", type: "string" }];

describe("acceptanceReport (RAAS-v1 bar)", () => {
  it("passes when the whole bar is met", () => {
    const specs = [
      spec({ actionName: "createJD", tools: ["x"], inputSchema: okIO }),
      spec({ actionName: "ruleCheckForMatchResume", tools: ["ontology.fetchActionRules"], inputSchema: okIO }),
    ];
    const r = acceptanceReport(specs, ont(["createJD", "ruleCheckForMatchResume"]), { registeredIds: ["d-createJD", "d-ruleCheckForMatchResume"], ran: 2, fullChainRan: true, degradedAgents: [], simulated: false, fidelityFailures: [] });
    expect(r.allPass).toBe(true);
  });

  it("#P3 no_blocking_defects: >0 阻塞缺陷阻断 finish;0 或不传则通过(向后兼容)", () => {
    const specs = [
      spec({ actionName: "createJD", tools: ["x"], inputSchema: okIO }),
      spec({ actionName: "ruleCheckForMatchResume", tools: ["ontology.fetchActionRules"], inputSchema: okIO }),
    ];
    const sb = { registeredIds: ["d-createJD", "d-ruleCheckForMatchResume"], ran: 2, fullChainRan: true, degradedAgents: [], simulated: false, fidelityFailures: [] };
    const dom = ont(["createJD", "ruleCheckForMatchResume"]);
    // 不传 opts → 不加此判据,行为不变(向后兼容)
    expect(acceptanceReport(specs, dom, sb).criteria.find((c) => c.key === "no_blocking_defects")).toBeUndefined();
    // 0 阻塞 → 判据在且通过
    const clean = acceptanceReport(specs, dom, sb, { blockingDefects: 0 });
    expect(clean.criteria.find((c) => c.key === "no_blocking_defects")!.pass).toBe(true);
    expect(clean.allPass).toBe(true);
    // >0 阻塞 → 判据失败,finish 被阻断
    const blocked = acceptanceReport(specs, dom, sb, { blockingDefects: 2 });
    expect(blocked.criteria.find((c) => c.key === "no_blocking_defects")!.pass).toBe(false);
    expect(blocked.allPass).toBe(false);
  });

  it("fails coverage when an Agent action is uncovered", () => {
    const specs = [spec({ actionName: "createJD", tools: ["x"], inputSchema: okIO })];
    const r = acceptanceReport(specs, ont(["createJD", "matchResume"]), { registeredIds: ["d-createJD"], ran: 1, fullChainRan: true, degradedAgents: [], simulated: false });
    expect(r.allPass).toBe(false);
    expect(r.criteria.find((c) => c.key === "coverage")!.pass).toBe(false);
  });

  it("fails real_register on a simulated sandbox and flags an unbound rule gate + missing payload", () => {
    const specs = [spec({ actionName: "ruleCheckForX", tools: [] })]; // rule gate, no fetchActionRules, no I/O schema
    const r = acceptanceReport(specs, ont(["ruleCheckForX"]), { functionsRegistered: 1, ran: 1, fullChainRan: true, degradedAgents: [], simulated: true });
    expect(r.criteria.find((c) => c.key === "real_register")!.pass).toBe(false);
    expect(r.criteria.find((c) => c.key === "rule_gates")!.pass).toBe(false);
    expect(r.criteria.find((c) => c.key === "typed_payloads")!.pass).toBe(false);
  });

  it("fails has_code when an agent has no generated code (aligns the bar with finish())", () => {
    const specs = [spec({ actionName: "createJD", tools: ["x"], inputSchema: okIO, generatedCode: "" })];
    const r = acceptanceReport(specs, ont(["createJD"]), { registeredIds: ["d-createJD"], ran: 1, fullChainRan: true, degradedAgents: [], simulated: false });
    expect(r.criteria.find((c) => c.key === "has_code")!.pass).toBe(false);
    expect(r.allPass).toBe(false);
  });

  it("excludes mock-platform stand-ins from the real-registration count", () => {
    const specs = [
      spec({ actionName: "createJD", slug: "d-createJD", tools: ["x"], inputSchema: okIO }),
      spec({ actionName: "mock_robohire", slug: "d-mock-robohire", tools: [], inputSchema: okIO }),
    ];
    // only 1 real deliverable → 1 registered id is enough to pass real_register
    const r = acceptanceReport(specs, ont(["createJD"]), { registeredIds: ["d-createJD"], ran: 2, fullChainRan: true, degradedAgents: [], simulated: false });
    expect(r.criteria.find((c) => c.key === "real_register")!.pass).toBe(true);
  });
});

describe("acceptanceGate (maps the conductor's lastSandbox shape onto the bar)", () => {
  const good = [
    spec({ actionName: "createJD", tools: ["x"], inputSchema: okIO }),
    spec({ actionName: "ruleCheckForMatchResume", tools: ["ontology.fetchActionRules"], inputSchema: okIO }),
  ];
  const ontGood = ont(["createJD", "ruleCheckForMatchResume"]);

  it("accepts the conductor field names (deployed/agentsRan) and passes a met bar", () => {
    const r = acceptanceGate(good, ontGood, { deployed: 2, agentsRan: 2, fullChainRan: true, degradedAgents: [], simulated: false, fidelityFailures: [] });
    expect(r.pass).toBe(true);
    expect(r.failing).toEqual([]);
  });

  it("blocks when an agent carries an unresolved tool (the gap finish ignores today)", () => {
    const specs = [
      spec({ actionName: "createJD", tools: ["x"], unresolvedTools: ["ghostTool"], inputSchema: okIO }),
      spec({ actionName: "ruleCheckForMatchResume", tools: ["ontology.fetchActionRules"], inputSchema: okIO }),
    ];
    const r = acceptanceGate(specs, ontGood, { deployed: 2, agentsRan: 2, fullChainRan: true, degradedAgents: [], simulated: false, fidelityFailures: [] });
    expect(r.pass).toBe(false);
    expect(r.failing.map((c) => c.key)).toContain("tools_resolve");
  });

  it("blocks when the chain ran but an agent degraded (finish does not catch this today)", () => {
    const r = acceptanceGate(good, ontGood, { deployed: 2, agentsRan: 2, fullChainRan: true, degradedAgents: ["createJD"], simulated: false });
    expect(r.pass).toBe(false);
    expect(r.failing.map((c) => c.key)).toContain("chain_ran");
  });

  it("returns no failures (pass=false) when there is no sandbox evidence at all", () => {
    const r = acceptanceGate(good, ontGood, null);
    expect(r.pass).toBe(false);
  });

  // #AUDIT-FIX(P1-02) — 三态：真实跑过(ran>0)却【没采到保真证据】= UNKNOWN → 阻断（不再 fail-open）。
  it("BLOCKS execution_fidelity when a real run captured no fidelity evidence (unknown ≠ pass)", () => {
    const r = acceptanceGate(good, ontGood, { deployed: 2, agentsRan: 2, fullChainRan: true, degradedAgents: [], simulated: false }); // 无 fidelityFailures → unknown
    expect(r.report.criteria.find((c) => c.key === "execution_fidelity")!.pass).toBe(false);
    expect(r.pass).toBe(false);
  });
  it("PASSES execution_fidelity when a real run graded clean (fidelityFailures: [])", () => {
    const r = acceptanceGate(good, ontGood, { deployed: 2, agentsRan: 2, fullChainRan: true, degradedAgents: [], simulated: false, fidelityFailures: [] });
    expect(r.report.criteria.find((c) => c.key === "execution_fidelity")!.pass).toBe(true);
    expect(r.pass).toBe(true);
  });

  it("blocks when a real emit payload violated the downstream contract (the output_parse_error class)", () => {
    const r = acceptanceGate(good, ontGood, { deployed: 2, agentsRan: 2, fullChainRan: true, degradedAgents: [], simulated: false, fidelityFailures: ["CreateJD"] });
    expect(r.pass).toBe(false);
    expect(r.failing.map((c) => c.key)).toContain("execution_fidelity");
  });
});
