import { describe, it, expect } from "vitest";
import { designSelfCheck, internalDesignRefine, innerLoopEnabled, isReviewedToolExecutionPolicy, requiresAttemptGrantPolicy, type DesignDraft } from "./design-loop";

// design 内部循环（架构书 §5 内推演）：确定性自检把外层最常打回的点前移到设计当下；命中硬问题
// 跑一次内部精修，失败/无改进兜底原稿。全程零真实 LLM（refine 注入假实现）。

const base: DesignDraft = {
  actionName: "matchResume",
  emitEvents: ["MATCH_PASSED_NEED_INTERVIEW", "MATCH_FAILED"],
  systemPrompt: "你负责匹配简历与岗位，计算匹配分。",
  decisionLogic: "匹配分≥阈值且需面试时 emit MATCH_PASSED_NEED_INTERVIEW；否则 emit MATCH_FAILED。",
  toolCount: 1,
  hitl: false,
  isGate: false,
  ruleLeak: false,
  ungroundedEvents: [],
};

describe("designSelfCheck — 确定性自检", () => {
  it("分支全覆盖 + 无泄漏 → 无硬问题", () => {
    const r = designSelfCheck(base);
    expect(r.hardCount).toBe(0);
  });

  it("声明会 emit 的事件没在 decision_logic 里 → branch_uncovered（硬）", () => {
    const r = designSelfCheck({ ...base, decisionLogic: "匹配分≥阈值时通过。" }); // 两个 emit 都没提
    expect(r.hardCount).toBe(2);
    expect(r.issues.filter((i) => i.hard).every((i) => i.code === "branch_uncovered")).toBe(true);
  });

  it("规则泄漏 + 幻觉事件 → 两条硬问题", () => {
    const r = designSelfCheck({ ...base, ruleLeak: true, ungroundedEvents: ["FAKE_EVENT"] });
    expect(r.issues.some((i) => i.code === "rule_leak" && i.hard)).toBe(true);
    expect(r.issues.some((i) => i.code === "ungrounded_event" && i.hard)).toBe(true);
  });

  it("decision_logic 太薄是软问题；零工具纯逻辑不是问题", () => {
    // 单个短事件名，logic 覆盖它但整体 <40 字 → 触发 shallow，且不触发 branch_uncovered。
    const r = designSelfCheck({ ...base, emitEvents: ["DONE"], decisionLogic: "完成后 emit DONE", toolCount: 0 });
    expect(r.hardCount).toBe(0);
    expect(r.issues.some((i) => i.code === "shallow_logic" && !i.hard)).toBe(true);
    expect(r.issues.some((i) => i.code === "no_tool")).toBe(false);
  });

  // #SAGA ⑥ — 副作用工具却没声明补偿事件 → 软警告；声明了/纯读 agent → 无警告。
  it("外部副作用 + 无补偿事件 → side_effect_no_compensation（软）；声明补偿后消失", () => {
    const withSe = designSelfCheck({ ...base, sideEffectful: true, hasCompensation: false });
    expect(withSe.issues.some((i) => i.code === "side_effect_no_compensation" && !i.hard)).toBe(true);
    expect(withSe.hardCount).toBe(0); // 软警告不触发内部精修
    const declared = designSelfCheck({ ...base, sideEffectful: true, hasCompensation: true });
    expect(declared.issues.some((i) => i.code === "side_effect_no_compensation")).toBe(false);
    const readOnly = designSelfCheck({ ...base, sideEffectful: false });
    expect(readOnly.issues.some((i) => i.code === "side_effect_no_compensation")).toBe(false);
  });
});

describe("reviewed tool execution policy (#SAGA 判定)", () => {
  it("只把完整、合法的 policy 作为权限元数据", () => {
    const write = { operation: "write", effectScope: "external", sandboxPolicy: "requires_attempt_grant" };
    const read = { operation: "read", effectScope: "external", sandboxPolicy: "live_external" };
    expect(isReviewedToolExecutionPolicy(write)).toBe(true);
    expect(isReviewedToolExecutionPolicy(read)).toBe(true);
    expect(requiresAttemptGrantPolicy(write)).toBe(true);
    expect(requiresAttemptGrantPolicy(read)).toBe(false);
    expect(isReviewedToolExecutionPolicy(undefined)).toBe(false);
    expect(isReviewedToolExecutionPolicy("getCandidate")).toBe(false);
    expect(isReviewedToolExecutionPolicy({ ...write, effectScope: "none" })).toBe(false);
  });
});

describe("internalDesignRefine — 一次内部精修", () => {
  const broken: DesignDraft = { ...base, decisionLogic: "匹配后处理。" }; // 两个 emit 都没覆盖 → 2 硬
  const issues = designSelfCheck(broken).issues;

  it("LLM 返回改进版 → 采用；再自检硬问题清零", async () => {
    const refined = await internalDesignRefine(broken, issues, async () => ({
      system_prompt: broken.systemPrompt,
      decision_logic: "匹配分≥阈值且需面试 → emit MATCH_PASSED_NEED_INTERVIEW（含 candidate_id、job_id）；不达标 → emit MATCH_FAILED（含原因）。",
    }));
    expect(refined).not.toBeNull();
    const after = designSelfCheck({ ...broken, decisionLogic: refined!.decisionLogic });
    expect(after.hardCount).toBe(0);
  });

  it("LLM 失败 → 兜底原稿（返回 null，永不比现在差）", async () => {
    const refined = await internalDesignRefine(broken, issues, async () => { throw new Error("down"); });
    expect(refined).toBeNull();
  });

  it("无硬问题 → 不调用 LLM", async () => {
    let called = false;
    const refined = await internalDesignRefine(base, designSelfCheck(base).issues, async () => { called = true; return {}; });
    expect(called).toBe(false);
    expect(refined).toBeNull();
  });

  it("LLM 返回原样（无实质改动）→ null", async () => {
    const refined = await internalDesignRefine(broken, issues, async () => ({ system_prompt: broken.systemPrompt, decision_logic: broken.decisionLogic }));
    expect(refined).toBeNull();
  });
});

describe("innerLoopEnabled — env 开关", () => {
  it("默认开", () => expect(innerLoopEnabled({})).toBe(true));
  it("FACTORY_DESIGN_INNER_LOOP=0 关", () => expect(innerLoopEnabled({ FACTORY_DESIGN_INNER_LOOP: "0" })).toBe(false));
});
