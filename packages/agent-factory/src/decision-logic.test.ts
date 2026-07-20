import { describe, it, expect } from "vitest";
import { FACTORY_TOOLS } from "./tools";
import type { BrainCtx } from "./brain-types";
import type { GeneratedAgentSpec } from "./spec-types";
import type { DomainOntology } from "./ontology-types";

// decision_logic completeness — the UI's agent cards (指令/代码/决策逻辑) and the triple
// review read spec.decisionLogic. Two paths used to ship it EMPTY: design_agent had it
// optional (the model skips optional fields while authoring plan[]), and design_subagent
// never authored it at all. Lock the fixed contract:
//   1. design_agent refuses an empty decision_logic with a resubmit steer (same pattern
//      as the empty-system_prompt guard).
//   2. design_subagent always yields a non-empty decisionLogic (authored or synthesized).

const design_agent = FACTORY_TOOLS.find((t) => t.name === "design_agent")!;
const design_subagent = FACTORY_TOOLS.find((t) => t.name === "design_subagent")!;

function ont(): DomainOntology {
  return {
    domainId: "rec",
    objects: [],
    rules: [],
    events: [],
    workflow: [],
    source: "allmeta",
    actions: [
      { id: "createJD", name: "createJD", actor: ["Agent"], trigger: ["REQ_LOGGED"], triggered_event: ["JD_GENERATED"], target_objects: [], tool_use: [], system_prompt: "", user_prompt: "" },
    ],
  } as DomainOntology;
}

function ctx(specs: GeneratedAgentSpec[] = []): BrainCtx {
  return {
    specs,
    emit: () => {},
    domain: "rec",
    ontology: ont(),
    toolCatalog: [],
    realTools: [],
    attemptHistory: {},
    createdSkills: [],
    rulesByAction: {},
    lastSandbox: null,
  } as unknown as BrainCtx;
}

function parentSpec(): GeneratedAgentSpec {
  return {
    key: "createJD", actionName: "createJD", slug: "rec-create-jd", short: "createJD", domainId: "rec",
    nameZh: "生成职位", kind: "llm", trigger: ["REQ_LOGGED"], emit: ["JD_GENERATED"], tools: [],
    unresolvedTools: [], objects: [], systemPrompt: "生成 JD", userPrompt: "", steps: [], ruleRefs: [], retries: 1,
    hitl: false, confidence: 1, promptSource: "llm", inputSchema: [{ field: "requisition_id", type: "string" }],
    outputSchema: [], generatedCode: "export const x = 1;",
  } as GeneratedAgentSpec;
}

describe("decision_logic is never empty on delivered specs", () => {
  it("design_agent REFUSES an empty decision_logic with a resubmit steer", async () => {
    const c = ctx();
    const r = await design_agent.execute({ action: "createJD", system_prompt: "你负责根据需求生成 JD。" }, c);
    expect(r.ok).toBe(false);
    expect(r.summary).toContain("decision_logic");
    expect(c.specs).toHaveLength(0); // nothing half-designed slipped through
  });

  it("design_agent accepts once decision_logic is authored, and the spec carries it", async () => {
    const c = ctx();
    const r = await design_agent.execute(
      { action: "createJD", system_prompt: "你负责根据需求生成 JD。", decision_logic: "解析成功 → emit JD_GENERATED；解析失败 → 记录错误并终止。" },
      c,
    );
    expect(r.ok).toBe(true);
    expect(c.specs[0]!.decisionLogic).toContain("JD_GENERATED");
  });

  it("design_agent blocks ontology-rich actions from collapsing to one opaque logic step", async () => {
    const c = ctx();
    const action = c.ontology!.actions[0]!;
    action.action_steps = [{ name: "generateJDContent", type: "logic" }, { name: "persistJD", type: "tool" }];
    action.integration = { systems: [{ name: "Partner PG", role: "writes" }] };
    const blocked = await design_agent.execute(
      { action: "createJD", system_prompt: "生成并持久化 JD。", decision_logic: "成功 emit JD_GENERATED；失败终止。" },
      c,
    );
    expect(blocked.ok).toBe(false);
    expect(blocked.summary).toMatch(/单步 logic|structured plan/i);
    expect(c.specs).toHaveLength(0);

    c.toolCatalog = ["records.upsert"];
    c.realTools = [{
      name: "records.upsert",
      operation: "write",
      effectScope: "external",
      sandboxPolicy: "requires_attempt_grant",
      probeStatus: "verified",
      capabilities: [{ systems: ["Partner PG"], kinds: ["database"], roles: ["write"] }],
    }];
    const accepted = await design_agent.execute(
      {
        action: "createJD",
        system_prompt: "生成并持久化 JD。",
        decision_logic: "成功 emit JD_GENERATED；失败终止。",
        tools: ["records.upsert"],
        plan: [
          { stepId: "generateJDContent", kind: "logic" },
          { stepId: "persistJD", kind: "tool", tool: "records.upsert", idempotencyKeyFrom: "entity_id", onError: "terminal" },
        ],
      },
      c,
    );
    expect(accepted.ok).toBe(true);
    expect(c.specs[0]!.plan?.map((step) => step.stepId)).toEqual(["generateJDContent", "persistJD"]);
  });

  it("design_agent schema marks decision_logic required (the model can't silently skip it)", () => {
    const params = design_agent.parameters as { required?: string[] };
    expect(params.required ?? []).toContain("decision_logic");
  });

  it("design_subagent synthesizes a truthful decisionLogic when the brain doesn't author one", async () => {
    const c = ctx([parentSpec()]);
    const r = await design_subagent.execute({ parent_action: "createJD", task: "dedup requisition" }, c);
    expect(r.ok).toBe(true);
    const sub = c.specs.find((s) => s.isSubAgent)!;
    expect(sub.decisionLogic).toBeTruthy();
    expect(sub.decisionLogic).toContain("invoke");
  });

  it("design_subagent prefers an authored decision_logic over the synthesized one", async () => {
    const c = ctx([parentSpec()]);
    await design_subagent.execute({ parent_action: "createJD", task: "dedup", decision_logic: "重复 → 返回 duplicate=true；否则 false。" }, c);
    const sub = c.specs.find((s) => s.isSubAgent)!;
    expect(sub.decisionLogic).toContain("duplicate=true");
  });
});
