import { describe, it, expect } from "vitest";
import { FACTORY_TOOLS } from "./tools";
import type { BrainCtx } from "./brain-types";
import type { GeneratedAgentSpec } from "./spec-types";

// #A — in-loop deliberation: refine budget (per-agent + global) forces the brain to step UP a
// level instead of grinding; review_agent still reports deterministic findings offline, but an
// unavailable semantic judge is an explicit unknown/blocking verdict rather than a fake pass.
const refineAgent = FACTORY_TOOLS.find((t) => t.name === "refine_agent")!;
const revertRefine = FACTORY_TOOLS.find((t) => t.name === "revert_refine")!;
const reviewAgent = FACTORY_TOOLS.find((t) => t.name === "review_agent")!;
const reviewCompleteness = FACTORY_TOOLS.find((t) => t.name === "review_completeness")!;

const mk = (specs: unknown[], attemptHistory: Record<string, unknown[]>): BrainCtx =>
  ({ specs, attemptHistory, ontology: { rules: [] }, toolCatalog: [], emit: () => undefined, lastSandbox: null }) as unknown as BrainCtx;

describe("refine_agent budget (#A)", () => {
  it("refuses + steers when a single agent hits the per-agent refine budget", async () => {
    const ctx = mk([{ actionName: "A", nameZh: "A", tools: [], systemPrompt: "x" }], { A: [{}, {}, {}, {}] }); // 4 == default budget
    const r = await refineAgent.execute({ action: "A", critique: "again", system_prompt: "new" }, ctx);
    expect(r.ok).toBe(false);
    expect(r.summary).toContain("重试上限");
    expect((r.output as { advice?: string }).advice).toBe("revert_or_verify_or_replan");
  });

  it("refuses cross-agent churn when the GLOBAL cap is hit", async () => {
    // 2 specs → globalCap = 3*2 = 6; A has 3 (< per-agent 4) but total = 6 == cap.
    const ctx = mk(
      [{ actionName: "A", nameZh: "A", tools: [], systemPrompt: "x" }, { actionName: "B", nameZh: "B", tools: [], systemPrompt: "y" }],
      { A: [{}, {}, {}], B: [{}, {}, {}] },
    );
    const r = await refineAgent.execute({ action: "A", critique: "again", system_prompt: "new" }, ctx);
    expect(r.ok).toBe(false);
    expect(r.summary).toContain("全域已累计");
    expect((r.output as { advice?: string }).advice).toBe("stop_churn_verify_or_analyze");
  });

  it("does not inject a rule tool just because the action name looks like a rule gate", async () => {
    const spec: GeneratedAgentSpec = {
      key: "ruleCheckWork",
      actionName: "ruleCheckWork",
      slug: "test-rule-check-work",
      short: "RuleCheckWorkAgent",
      domainId: "test",
      nameZh: "规则检查",
      kind: "llm",
      trigger: ["work.requested"],
      emit: ["work.checked"],
      tools: ["records.lookup"],
      unresolvedTools: [],
      objects: [],
      systemPrompt: "根据输入和明确配置的工具完成检查，并返回结构化结论。",
      userPrompt: "",
      steps: [],
      ruleRefs: [],
      retries: 1,
      hitl: false,
      confidence: 1,
      promptSource: "llm",
      codeSource: "ai",
      codeExecuted: false,
    };
    const ctx = mk([spec], {});

    const r = await refineAgent.execute(
      { action: "ruleCheckWork", critique: "补充说明", decision_logic: "只使用已明确选择的工具。" },
      ctx,
    );

    expect(r.ok).toBe(true);
    expect(spec.tools).toEqual(["records.lookup"]);
    expect(spec.tools).not.toContain("ontology.fetchActionRules");
  });

  it("allows a draft refinement while leaving missing safe-probe evidence for sandbox", async () => {
    const spec = {
      actionName: "A",
      nameZh: "A",
      tools: [],
      objects: [],
      systemPrompt: "before",
      decisionLogic: "before",
      codeSource: "ai",
    };
    const ctx = mk([spec], {});
    ctx.domain = "test";
    ctx.toolCatalog = ["vendor.write"];
    ctx.realTools = [{
      name: "vendor.write",
      sideEffect: "write",
      operation: "write",
      effectScope: "external",
      sandboxPolicy: "requires_attempt_grant",
      capabilities: [{ systems: ["Vendor"], kinds: ["external_api"], roles: ["write"], probeRequired: true }],
      probeStatus: "required",
      definitionHash: "sha256:unverified",
      verifiedDefinitionHashes: [],
    }];
    const result = await refineAgent.execute({
      action: "A",
      critique: "改成外部写入",
      tools: ["vendor.write"],
    }, ctx);

    expect(result.ok).toBe(true);
    expect(spec.tools).toEqual(["vendor.write"]);
    expect(ctx.attemptHistory.A).toHaveLength(1);
  });

  it("restores an authoring snapshot even when its tool still needs a later probe", async () => {
    const current = {
      actionName: "A",
      nameZh: "A",
      tools: [],
      objects: [],
      systemPrompt: "current",
      decisionLogic: "current",
      codeSource: "ai",
    };
    const staleSnapshot = {
      ...current,
      tools: ["vendor.write"],
      systemPrompt: "stale",
    };
    const ctx = mk([current], {
      A: [{
        attemptNumber: 1,
        priorSpecSnapshot: { systemPrompt: "stale", tools: ["vendor.write"], decisionLogic: "current" },
        fullSnapshot: staleSnapshot,
        critique: "",
        changes: "",
      }],
    });
    ctx.domain = "test";
    ctx.realTools = [{
      name: "vendor.write",
      sideEffect: "write",
      operation: "write",
      effectScope: "external",
      sandboxPolicy: "requires_attempt_grant",
      capabilities: [{ systems: ["Vendor"], kinds: ["external_api"], roles: ["write"], probeRequired: true }],
      probeStatus: "required",
      definitionHash: "sha256:unverified",
      verifiedDefinitionHashes: [],
    }];

    const result = await revertRefine.execute({ action: "A" }, ctx);

    expect(result.ok).toBe(true);
    expect(current.systemPrompt).toBe("stale");
    expect(current.tools).toEqual(["vendor.write"]);
    expect(ctx.attemptHistory.A).toHaveLength(0);
  });
});

describe("review_agent (#A — offline semantic verdict is unknown)", () => {
  it("blocks when there is no agent to review", async () => {
    const r = await reviewAgent.execute({}, mk([], {}));
    expect(r).toMatchObject({ ok: false, output: { verdict: "blocked", blocking: true } });
  });

  it("does not claim a clean agent passed when the LLM judge never ran", async () => {
    const ctx = mk([{ actionName: "ProcessThing", nameZh: "处理", systemPrompt: "做这件事，按职责处理事件。", tools: [], decisionLogic: "" }], {});
    const r = await reviewAgent.execute({}, ctx);
    expect(r.ok).toBe(false);
    expect(r.summary).toContain("unknown");
    expect((r.output as { judge?: string[] }).judge).toEqual([]);
    expect(r.output).toMatchObject({ verdict: "unknown", blocking: true });
  });
  it("flags an empty prompt deterministically", async () => {
    const ctx = mk([{ actionName: "Empty", nameZh: "空", systemPrompt: "   ", tools: [], decisionLogic: "" }], {});
    const r = await reviewAgent.execute({}, ctx);
    expect(r.ok).toBe(false);
    expect((r.output as { deterministic: string[] }).deterministic.some((f) => f.includes("prompt 为空"))).toBe(true);
  });

  it("accepts a custom selected rule reader from capability metadata in both review passes", async () => {
    const actionName = "evaluateSubmission";
    const readerName = "policy.current.read";
    const candidate = {
      actionName,
      nameZh: "评估提交内容",
      short: "EvaluateSubmissionAgent",
      tools: [readerName],
      ruleRefs: ["submission-policy"],
      decisionTables: [],
      integrationRequirements: [],
      integrationBindings: [],
      systemPrompt: "运行时读取当前规则，依据输入返回结构化评估结论。",
      decisionLogic: "",
      emit: ["submission.evaluated"],
      hitl: false,
    };
    const ctx = mk([candidate], {});
    ctx.realTools = [{
      name: readerName,
      capabilities: [{ systems: ["Policy Store"], kinds: ["rulebase"], roles: ["reads"] }],
    }];
    ctx.ontology = {
      domainId: "test",
      source: "snapshot",
      objects: [],
      rules: [],
      events: [],
      workflow: [],
      actions: [{
        id: actionName,
        name: actionName,
        actor: ["Agent"],
        trigger: [],
        triggered_event: ["submission.evaluated"],
        target_objects: [],
        tool_use: [readerName],
        system_prompt: "",
        user_prompt: "",
      }],
    };

    const designReview = await reviewAgent.execute({}, ctx);
    expect((designReview.output as { deterministic: string[] }).deterministic).toEqual([]);

    const completenessReview = await reviewCompleteness.execute({}, ctx);
    expect((completenessReview.output as { deterministic: string[] }).deterministic).toEqual([]);
  });
});
