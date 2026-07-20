import { describe, expect, it } from "vitest";
import { FACTORY_TOOLS } from "./tools";
import type { BrainCtx } from "./brain-types";
import type { GeneratedAgentSpec } from "./spec-types";
import type { DomainOntology } from "./ontology-types";

// #SCOPE 部分交付 — the user asked for ONE action's function: create_plan(scope:"partial") must
// not warn about the deliberately-uncovered actions, finish must route the delivery to save_draft,
// and save_draft must persist the designed specs into the durable draft library WITHOUT any
// regression evidence (promotion stays fail-closed on such drafts).

const save_draft = FACTORY_TOOLS.find((t) => t.name === "save_draft")!;
const create_plan = FACTORY_TOOLS.find((t) => t.name === "create_plan")!;
const finish = FACTORY_TOOLS.find((t) => t.name === "finish")!;

function spec(actionName: string, p: Partial<GeneratedAgentSpec> = {}): GeneratedAgentSpec {
  return {
    key: actionName, actionName, slug: `d-${actionName}`, short: actionName,
    domainId: "rec", nameZh: actionName, kind: "llm", trigger: [], emit: [],
    tools: [], unresolvedTools: [], objects: [], systemPrompt: "do it",
    toolPolicies: {}, userPrompt: "", steps: [], ruleRefs: [], retries: 1, hitl: false,
    confidence: 1, promptSource: "llm", inputSchema: [{ field: "a", type: "string" }],
    generatedCode: "export const x = 1;",
    integrationRequirements: [], integrationBindings: [],
    ...p,
  } as GeneratedAgentSpec;
}

function ont(actionNames: string[]): DomainOntology {
  return {
    domainId: "rec", objects: [], rules: [], events: [], workflow: [], source: "allmeta",
    actions: actionNames.map((n) => ({ id: n, name: n, actor: ["Agent"], trigger: [], triggered_event: [], target_objects: [], tool_use: [], system_prompt: "", user_prompt: "" })),
  } as DomainOntology;
}

function mk(specs: GeneratedAgentSpec[], opts: { drafts?: boolean; saveResult?: number } = {}): { ctx: BrainCtx; saved: Array<{ domain: string; specs: GeneratedAgentSpec[]; regression: unknown }> } {
  const saved: Array<{ domain: string; specs: GeneratedAgentSpec[]; regression: unknown }> = [];
  const ctx = {
    domain: "rec",
    ontology: ont(["createJD", "matchResume", "inviteInterview"]),
    specs,
    emit: () => {},
    conversationId: "save-draft-run",
    currentPlan: null,
    ports: {
      ...(opts.drafts === false ? {} : {
        drafts: {
          async save(domain: string, s: GeneratedAgentSpec[], regression?: unknown) {
            saved.push({ domain, specs: s, regression });
            return opts.saveResult ?? s.length;
          },
          async list() { return []; },
        },
      }),
    },
  } as unknown as BrainCtx;
  return { ctx, saved };
}

describe("create_plan scope (#SCOPE 确定性范围信号)", () => {
  it("partial scope suppresses the missed-actions WARNING and records planScope", async () => {
    const { ctx } = mk([]);
    const res = await create_plan.execute(
      { summary: "只做 createJD", agents: [{ actionName: "createJD", role: "JD 生成" }], scope: "partial", scope_reason: "用户原话：只生成 createJD 的 function" },
      ctx,
    );
    expect(res.ok).toBe(true);
    expect((res.output as { warnings: string[] }).warnings.join("")).not.toContain("还没规划");
    expect(res.summary).toContain("部分范围");
    expect(ctx.planScope).toMatchObject({ kind: "partial", missedActions: ["matchResume", "inviteInterview"] });
  });

  it("partial scope WITHOUT a user-quoted reason is refused (scope must trace to intent)", async () => {
    const { ctx } = mk([]);
    const res = await create_plan.execute({ summary: "s", agents: [{ actionName: "createJD", role: "r" }], scope: "partial" }, ctx);
    expect(res.ok).toBe(false);
    expect(res.summary).toContain("scope_reason");
  });

  it("default/full scope keeps the missed-actions warning (a genuine omission signal)", async () => {
    const { ctx } = mk([]);
    const res = await create_plan.execute({ summary: "s", agents: [{ actionName: "createJD", role: "r" }] }, ctx);
    expect(res.ok).toBe(true);
    expect((res.output as { warnings: string[] }).warnings.join("")).toContain("还没规划的 Agent 动作");
    expect(ctx.planScope?.kind).toBe("full");
  });
});

describe("save_draft (#SCOPE 部分交付)", () => {
  it("refuses when nothing is designed yet", async () => {
    const { ctx, saved } = mk([]);
    const res = await save_draft.execute({}, ctx);
    expect(res.ok).toBe(false);
    expect(saved).toHaveLength(0);
  });

  it("refuses when a spec has no generated code (a draft means the function exists)", async () => {
    const { ctx, saved } = mk([spec("createJD", { generatedCode: undefined })]);
    const res = await save_draft.execute({}, ctx);
    expect(res.ok).toBe(false);
    expect(res.summary).toContain("还没有代码");
    expect(saved).toHaveLength(0);
  });

  it("persists the designed specs WITHOUT regression evidence and reports the partial scope honestly", async () => {
    const { ctx, saved } = mk([spec("createJD")]);
    ctx.planScope = { kind: "partial", reason: "只生成 createJD 的 function", missedActions: ["matchResume", "inviteInterview"] };
    const res = await save_draft.execute({ note: "用户只要 createJD" }, ctx);
    expect(res.ok).toBe(true);
    expect(saved).toHaveLength(1);
    expect(saved[0]!.domain).toBe("rec");
    expect(saved[0]!.regression).toBeUndefined(); // no fabricated evidence — promotion stays fail-closed
    expect(res.summary).toContain("部分交付");
    expect(res.summary).toContain("1/3");
    expect(res.summary).toContain("晋升门会拒绝" /* honest boundary */);
  });

  it("treats a zero-count store write as failure (never advertise an unpersisted draft)", async () => {
    const { ctx } = mk([spec("createJD")], { saveResult: 0 });
    const res = await save_draft.execute({}, ctx);
    expect(res.ok).toBe(false);
  });

  it("refuses when the drafts port is unwired", async () => {
    const { ctx } = mk([spec("createJD")], { drafts: false });
    const res = await save_draft.execute({}, ctx);
    expect(res.ok).toBe(false);
    expect(res.summary).toContain("草稿存储未接入");
  });
});

describe("finish routes partial-scope deliveries to save_draft (semantics untouched)", () => {
  it("coverage-gap refusal points to save_draft when the plan scope is partial", async () => {
    const { ctx } = mk([spec("createJD")]);
    ctx.planScope = { kind: "partial", reason: "只生成 createJD", missedActions: ["matchResume", "inviteInterview"] };
    const res = await finish.execute({ summary: "s" }, ctx);
    expect(res.ok).toBe(false);
    expect(res.summary).toContain("save_draft");
    expect(res.summary).toContain("部分范围");
  });

  it("full-scope coverage gap keeps the original push to continue designing", async () => {
    const { ctx } = mk([spec("createJD")]);
    const res = await finish.execute({ summary: "s" }, ctx);
    expect(res.ok).toBe(false);
    expect(res.summary).toContain("继续 design_agent");
    expect(res.summary).not.toContain("save_draft");
  });
});
