import { describe, it, expect } from "vitest";
import { FACTORY_TOOLS, specsFingerprint } from "./tools";
import type { BrainCtx } from "./brain-types";
import type { GeneratedAgentSpec } from "./spec-types";
import type { DomainOntology } from "./ontology-types";

// Phase 0(a): finish must enforce the documented acceptance bar (acceptance.ts), not just
// coverage + code + fullChainRan. An agent with an unresolved tool, or a chain that ran but
// degraded, must be REJECTED by finish — previously finish let these through.

const finish = FACTORY_TOOLS.find((t) => t.name === "finish")!;
const okIO = [{ field: "a", type: "string" }];

function spec(p: Partial<GeneratedAgentSpec> & { actionName: string }): GeneratedAgentSpec {
  return {
    key: p.actionName, actionName: p.actionName, slug: p.slug ?? `d-${p.actionName}`, short: p.short ?? p.actionName,
    domainId: "rec", nameZh: p.actionName, kind: "llm", trigger: p.trigger ?? [], emit: p.emit ?? [],
    tools: p.tools ?? ["x"], unresolvedTools: p.unresolvedTools ?? [], objects: [], systemPrompt: "do the thing",
    userPrompt: "", steps: [], ruleRefs: [], retries: 1, hitl: false, confidence: 1, promptSource: "llm",
    inputSchema: p.inputSchema ?? okIO, outputSchema: p.outputSchema, generatedCode: p.generatedCode ?? "export const x = 1;",
  } as GeneratedAgentSpec;
}

function ont(actionNames: string[]): DomainOntology {
  return { domainId: "rec", objects: [], rules: [], events: [], workflow: [], source: "allmeta", actions: actionNames.map((n) => ({ id: n, name: n, actor: ["Agent"], trigger: [], triggered_event: [], target_objects: [], tool_use: [], system_prompt: "", user_prompt: "" })) } as DomainOntology;
}

function mk(specs: GeneratedAgentSpec[], sandbox: Partial<NonNullable<BrainCtx["lastSandbox"]>>): BrainCtx {
  return {
    ontology: ont(specs.map((s) => s.actionName)),
    specs,
    emit: () => {},
    ports: { reflection: { record: async () => {} }, drafts: { save: async () => specs.length } },
    lastSandbox: { specsFingerprint: specsFingerprint(specs), deployed: specs.length, agentsRan: specs.length, ranAgents: specs.map((s) => s.slug), reachedSuccessTerminal: true, fullChainRan: true, degradedAgents: [], simulated: false, ts: 1, ...sandbox },
  } as unknown as BrainCtx;
}

describe("finish gate enforces the acceptance bar (Phase 0a)", () => {
  it("rejects delivery when an agent has an unresolved tool, even though the chain ran", async () => {
    const specs = [spec({ actionName: "createJD", unresolvedTools: ["ghostTool"] })];
    const r = await finish.execute({ summary: "ship it" }, mk(specs, {}));
    expect(r.ok).toBe(false);
    expect(r.summary).toContain("验收");
  });

  it("rejects delivery when the chain ran but an agent degraded", async () => {
    const specs = [spec({ actionName: "createJD" })];
    const r = await finish.execute({ summary: "ship it" }, mk(specs, { degradedAgents: ["createJD"] }));
    expect(r.ok).toBe(false);
  });

  it("passes delivery when coverage + code + sandbox + acceptance bar are all met", async () => {
    const specs = [spec({ actionName: "createJD" })];
    const r = await finish.execute({ summary: "ship it" }, mk(specs, {}));
    expect(r.ok).toBe(true);
  });
});
