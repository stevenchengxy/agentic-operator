import { describe, it, expect } from "vitest";
import { compileGraph, verifyGraph } from "./graph";
import { lintGeneratedToolCode } from "./code-lint";
import { buildTestAuthorPrompt } from "./test-cases";
import { acceptanceReport } from "./acceptance";
import type { OntologyAction } from "./ontology-types";
import type { BrainCtx } from "./brain-types";
import type { GeneratedAgentSpec } from "./spec-types";

// #P0 gates — research-backed hard gates:
//   IAL cycle detection (arXiv 2607.01641), unbounded-loop lint,
//   independent test designer (AgentCoder 87.8 vs 61.0), harness-owned per-agent checklist.

const act = (name: string, trigger: string[], emit: string[], actor = ["Agent"]): OntologyAction =>
  ({ id: name, name, actor, trigger, triggered_event: emit, target_objects: [], tool_use: [], system_prompt: "", user_prompt: "" }) as unknown as OntologyAction;

describe("#IAL verifyGraph cycle detection", () => {
  it("flags an unbounded 2-node event cycle (A→B→A, no HITL)", () => {
    const g = compileGraph([act("A", ["START"], ["E1"]), act("B", ["E1"], ["E2"]), act("C", ["E2"], ["E1_BACK"])], { domainId: "d" });
    // rewire: make B also re-trigger A
    const g2 = compileGraph([act("A", ["START", "E2"], ["E1"]), act("B", ["E1"], ["E2", "DONE"])], { domainId: "d" });
    const v = verifyGraph(g2);
    const cycles = v.issues.filter((i) => i.kind === "cycle");
    expect(cycles).toHaveLength(1);
    expect((cycles[0] as { actions: string[] }).actions.sort()).toEqual(["A", "B"]);
    expect((cycles[0] as { events: string[] }).events).toEqual(expect.arrayContaining(["E1", "E2"]));
    expect(v.ok).toBe(false);
    void g;
  });

  it("does NOT flag the cycle when a HITL node sits inside it (human = the bound)", () => {
    const human = act("B", ["E1"], ["E2", "DONE"], ["Human"]);
    const g = compileGraph([act("A", ["START", "E2"], ["E1"]), human], { domainId: "d" });
    const v = verifyGraph(g);
    expect(v.issues.filter((i) => i.kind === "cycle")).toHaveLength(0);
  });

  it("flags a self-loop (action re-triggering itself)", () => {
    const g = compileGraph([act("A", ["START", "AGAIN"], ["AGAIN", "DONE"])], { domainId: "d" });
    const v = verifyGraph(g);
    const cycles = v.issues.filter((i) => i.kind === "cycle");
    expect(cycles).toHaveLength(1);
    expect((cycles[0] as { actions: string[] }).actions).toEqual(["A"]);
  });

  it("a linear chain stays clean (no false cycle)", () => {
    const g = compileGraph([act("A", ["START"], ["E1"]), act("B", ["E1"], ["DONE"])], { domainId: "d" });
    expect(verifyGraph(g).issues.filter((i) => i.kind === "cycle")).toHaveLength(0);
  });
});

describe("#IAL lintGeneratedToolCode unbounded-loop rules", () => {
  it("rejects while(true), for(;;), setInterval", () => {
    expect(lintGeneratedToolCode(`export async function h(){ while(true){ await step(); } }`).ok).toBe(false);
    expect(lintGeneratedToolCode(`export function h(){ for(;;){ tick(); } }`).ok).toBe(false);
    expect(lintGeneratedToolCode(`export function h(){ setInterval(() => poll(), 1000); }`).ok).toBe(false);
  });
  it("accepts bounded loops", () => {
    const r = lintGeneratedToolCode(`export function h(items: string[]){ for (const it of items) { use(it); } let i = 0; while (i < 10) i++; }`);
    expect(r.violations.filter((v) => v.includes("无界循环"))).toHaveLength(0);
  });
  it("unbounded rules fire on the AST path too (parseable code)", () => {
    const r = lintGeneratedToolCode(`const x = 1;\nwhile (true) { x; }`);
    expect(r.ok).toBe(false);
    expect(r.violations.join()).toContain("while(true)");
  });
});

// minimal ctx for prompt-isolation + checklist tests
const SECRET_CODE = `// ___GENERATED_CODE_CANARY___
export const agent = defineAgent({ async handler(input, ctx) {
  return ctx.tool("meta.ping", input);
}});`;
const SECRET_PROMPT = "___SYSTEM_PROMPT_CANARY___";
const SECRET_LOGIC = "___DECISION_LOGIC_CANARY___";
const spec = (over: Partial<GeneratedAgentSpec>): GeneratedAgentSpec =>
  ({
    slug: "s1", short: "S1", nameZh: "一号", actionName: "doThing", trigger: ["START"], emit: ["DONE"],
    tools: ["meta.ping"], unresolvedTools: [], objects: [], inputSchema: [{ field: "id", type: "string" }], outputSchema: [{ field: "ok", type: "boolean" }],
    toolPolicies: { "meta.ping": { operation: "read", effectScope: "none", sandboxPolicy: "pure" } },
    systemPrompt: SECRET_PROMPT, decisionLogic: SECRET_LOGIC, generatedCode: SECRET_CODE, codeExecuted: true,
    ...over,
  }) as unknown as GeneratedAgentSpec;

describe("#INDEPENDENT-TESTER buildTestAuthorPrompt sees contract only", () => {
  it("the assembled prompt NEVER contains generatedCode / systemPrompt / decisionLogic", () => {
    const ctx = {
      domain: "dom",
      specs: [spec({}), spec({ slug: "s2", short: "S2", actionName: "checkThing", trigger: ["DONE"], emit: ["FINAL"] })],
      ontology: { domainId: "dom", actions: [], events: [{ name: "START", payload: { event_data: [{ name: "id", type: "string" }] } }], objects: [], rules: [], workflow: [], source: "snapshot" },
    } as unknown as BrainCtx;
    const { sys, user } = buildTestAuthorPrompt(ctx);
    const all = sys + "\n" + user;
    expect(all).not.toContain(SECRET_CODE);
    expect(all).not.toContain(SECRET_PROMPT);
    expect(all).not.toContain(SECRET_LOGIC);
    // and it DOES carry the contract surface
    expect(user).toContain("START");
    expect(user).toContain("S1");
  });
});

describe("#CHECKLIST acceptanceReport perAgent (harness-owned)", () => {
  it("derives per-agent items from evidence; failing agent goes red, passing stays green", () => {
    const specs = [spec({}), spec({ slug: "s2", short: "S2", actionName: "checkThing", trigger: ["DONE"], emit: ["FINAL"] })];
    const report = acceptanceReport(specs, null, {
      simulated: false, functionsRegistered: 2, ran: 2, fullChainRan: true,
      codeRanAgents: ["S1"], degradedAgents: ["S2"], fidelityFailures: [],
      functionTester: specs.map((candidate) => ({
        short: candidate.short,
        pass: true,
        ran: true,
        reasons: [],
        tier: "external-container",
        qualification: "promotable",
      })),
    }, { blockingDefects: 1, blockingDefectSlugs: ["s2"] });
    expect(report.perAgent).toHaveLength(2);
    const a1 = report.perAgent.find((p) => p.slug === "s1")!;
    const a2 = report.perAgent.find((p) => p.slug === "s2")!;
    expect(a1.pass).toBe(true);
    expect(a2.pass).toBe(false);
    expect(a2.items.find((i) => i.key === "ran_no_degrade")!.pass).toBe(false);
    expect(a2.items.find((i) => i.key === "no_blocking_defects")!.pass).toBe(false);
    expect(a2.items.find((i) => i.key === "code_really_ran")!.pass).toBe(false); // S2 not in codeRanAgents
    expect(a1.items.find((i) => i.key === "code_really_ran")!.pass).toBe(true);
  });

  it("without sandbox evidence only static items apply (design-stage view)", () => {
    const report = acceptanceReport([spec({})], null, null);
    const items = report.perAgent[0]!.items.map((i) => i.key);
    expect(items).toContain("has_code");
    expect(items).not.toContain("ran_no_degrade");
    expect(items).not.toContain("code_really_ran");
  });
});
