import { describe, it, expect } from "vitest";
import { anchorDue, buildOntologyAnchor } from "./ontology-anchor";
import type { BrainCtx } from "./brain-types";

const ont = {
  domainId: "rec",
  actions: [
    { id: "a1", name: "processResume", actor: ["Agent"], trigger: [], triggered_event: [], target_objects: [], tool_use: [], system_prompt: "", user_prompt: "" },
    { id: "a2", name: "matchResume", actor: ["Agent"], trigger: [], triggered_event: [], target_objects: [], tool_use: [], system_prompt: "", user_prompt: "" },
    { id: "a3", name: "jdReview", actor: ["Human"], trigger: [], triggered_event: [], target_objects: [], tool_use: [], system_prompt: "", user_prompt: "" },
  ],
  events: [{ name: "E1" }, { name: "E2" }],
  rules: [{ id: "r1" }],
  objects: [],
  workflow: [],
  source: "snapshot",
} as unknown as BrainCtx["ontology"];

describe("anchorDue (#ANCHOR)", () => {
  it("fires on the beat, never on turn 0, disabled by everyN<=0", () => {
    expect(anchorDue(0, 8)).toBe(false);
    expect(anchorDue(8, 8)).toBe(true);
    expect(anchorDue(9, 8)).toBe(false);
    expect(anchorDue(16, 8)).toBe(true);
    expect(anchorDue(8, 0)).toBe(false);
  });
});

describe("buildOntologyAnchor", () => {
  it("null without an ontology (nothing to anchor)", () => {
    expect(buildOntologyAnchor({ ontology: null, ontologyUnderstanding: undefined, specs: [], policy: undefined } as unknown as BrainCtx, 8)).toBeNull();
  });

  it("states the facts + owed coverage + digested understanding + route", () => {
    const txt = buildOntologyAnchor(
      {
        ontology: ont,
        ontologyUnderstanding: "两个规则闸；RESUME_PROCESSED 是主链枢纽",
        specs: [{ actionName: "processResume" }] as BrainCtx["specs"],
        policy: { pipeline: "full", deepUnderstand: true, deepCritique: true, tierBias: null, reasons: [] },
      } as unknown as BrainCtx,
      8,
    )!;
    expect(txt).toContain("[本体锚点·第8轮]");
    expect(txt).toContain("2 个 Agent 动作"); // Human 动作不算欠
    expect(txt).toContain("范围内还没有 spec 的动作(1)：matchResume");
    expect(txt).toContain("消化结论");
    expect(txt).toContain("RESUME_PROCESSED 是主链枢纽");
    // #ANCHOR-FACTS：路线不再在锚点里复述（由 applyPolicyRoute 单点管理，避免推回过期路线）。
    expect(txt).not.toContain("本次推理路线");
  });

  // #SCOPE 回归 — 真实事故：用户在"路线A：只生成 createJD／路线B：补齐全部6个"里选了 A，
  // 大脑却一路被推着按 6 个走。锚点每 8 轮把整本体的未覆盖动作当"还欠"打回上下文，是其中
  // 一股周期性推力。partial 范围下，范围外的动作是【用户的本意】，不能再被宣告成欠账。
  it("partial scope: out-of-scope actions are the user's intent, never listed as owed", () => {
    const txt = buildOntologyAnchor(
      {
        ontology: ont,
        ontologyUnderstanding: "x",
        specs: [{ actionName: "processResume" }] as BrainCtx["specs"],
        policy: undefined,
        planScope: { kind: "partial", reason: "用户只要 processResume", missedActions: ["matchResume"] },
      } as unknown as BrainCtx,
      8,
    )!;
    expect(txt).toContain("本次范围(用户指定·部分)");
    expect(txt).toContain("范围外 1 个不做：matchResume");
    // 范围内已全覆盖 → 不得再把范围外的 matchResume 说成"还没有 spec / 还欠"
    expect(txt).toContain("范围内的 Agent 动作 spec 覆盖：1/1（全覆盖）");
    expect(txt).not.toContain("范围内还没有 spec 的动作");
    expect(txt).not.toContain("还欠");
    // #ANCHOR-FACTS：全覆盖是事实陈述，不带"别重复设计"这类祈使（该不该动某 agent 由大脑判断）。
    expect(txt).not.toContain("别重复设计");
  });

  it("full scope (no planScope) keeps the all-actions coverage semantics", () => {
    const txt = buildOntologyAnchor(
      { ontology: ont, ontologyUnderstanding: "x", specs: [{ actionName: "processResume" }] as BrainCtx["specs"], policy: undefined } as unknown as BrainCtx,
      8,
    )!;
    expect(txt).toContain("范围内还没有 spec 的动作(1)：matchResume");
    expect(txt).not.toContain("本次范围(用户指定·部分)");
  });

  it("when coverage is complete it says so instead of listing owed work", () => {
    const txt = buildOntologyAnchor(
      { ontology: ont, ontologyUnderstanding: "x", specs: [{ actionName: "processResume" }, { actionName: "matchResume" }] as BrainCtx["specs"], policy: undefined } as unknown as BrainCtx,
      16,
    )!;
    expect(txt).toContain("spec 覆盖：2/2（全覆盖）");
    expect(txt).not.toContain("还欠覆盖");
    expect(txt).not.toContain("别重复设计"); // 事实句，无祈使
  });

  it("states understand_ontology is not yet done (as a fact, not a command)", () => {
    const txt = buildOntologyAnchor({ ontology: ont, ontologyUnderstanding: undefined, specs: [], policy: undefined } as unknown as BrainCtx, 8)!;
    expect(txt).toContain("understand_ontology：尚未执行");
    expect(txt).not.toContain("先消化再动"); // 不指挥下一步
  });
});
