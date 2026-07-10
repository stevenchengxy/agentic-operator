import { describe, it, expect } from "vitest";
import { classifyIntentKind, estimateDifficulty, selectPolicy, shouldSuggestSplit } from "./reasoning-policy";
import type { DomainOntology } from "./ontology-types";

function ont(nAgents: number, nRules: number, opts?: { branchy?: number; nObjects?: number }): DomainOntology {
  const actions = Array.from({ length: nAgents }, (_, i) => ({
    id: `a${i}`,
    name: `action${i}`,
    actor: ["Agent"],
    trigger: [`E${i}`],
    triggered_event: i < (opts?.branchy ?? 0) ? ["OK", "FAIL", "PARK"] : ["OK"],
    target_objects: [],
    tool_use: [],
    system_prompt: "",
    user_prompt: "",
  }));
  return {
    domainId: "d",
    actions,
    rules: Array.from({ length: nRules }, (_, i) => ({ id: `r${i}` })),
    objects: Array.from({ length: opts?.nObjects ?? 0 }, (_, i) => ({ id: `o${i}` })),
    events: [],
    workflow: [],
    source: "snapshot",
  } as unknown as DomainOntology;
}

describe("classifyIntentKind", () => {
  it("reads the LAST intent line's type tag", () => {
    expect(classifyIntentKind("[生成] 造招聘链 ｜ 约束: 无 ｜ 期望产物: workflow")).toBe("generate");
    expect(classifyIntentKind("[生成] 旧的\n[提问] 这个字段是什么意思")).toBe("question");
    expect(classifyIntentKind("[修改] 调整 matchResume 的阈值")).toBe("modify");
    expect(classifyIntentKind(undefined)).toBe("other");
  });
});

describe("estimateDifficulty", () => {
  it("small domain → simple; big rule-heavy branchy domain → complex", () => {
    expect(estimateDifficulty(ont(3, 5)).band).toBe("simple");
    const hard = estimateDifficulty(ont(10, 80, { branchy: 3, nObjects: 25 }));
    expect(hard.band).toBe("complex");
    expect(hard.reasons.join()).toContain("规则 80");
  });
  it("no ontology → standard (never blocks)", () => {
    expect(estimateDifficulty(null).band).toBe("standard");
  });
});

describe("selectPolicy", () => {
  const simple = estimateDifficulty(ont(3, 5));
  const complex = estimateDifficulty(ont(10, 80, { branchy: 3, nObjects: 25 }));

  it("question/analyze → analyze pipeline + fast tier bias", () => {
    const p = selectPolicy({ intentKind: "question", difficulty: simple, hasSpecs: false });
    expect(p).toMatchObject({ pipeline: "analyze", tierBias: "fast", deepUnderstand: false });
  });

  it("generate + complex → full pipeline; #NATIVE 深读/深评不再被规模强制（事实进 reasons，AI 自决）", () => {
    const p = selectPolicy({ intentKind: "generate", difficulty: complex, hasSpecs: false });
    expect(p).toMatchObject({ pipeline: "full", deepUnderstand: false, deepCritique: false, tierBias: null });
    expect(p.reasons.join()).toContain("规则 80"); // 规模【事实】仍然带给 AI 参考
    expect(p.reasons.join()).toContain("由你决定"); // 决定权归 AI
  });

  it("generate + simple → full but no forced deep (size heuristic still guards independently)", () => {
    const p = selectPolicy({ intentKind: "generate", difficulty: simple, hasSpecs: false });
    expect(p).toMatchObject({ pipeline: "full", deepUnderstand: false, deepCritique: false });
  });

  it("modify with existing specs → skinny path", () => {
    const p = selectPolicy({ intentKind: "modify", difficulty: simple, hasSpecs: true });
    expect(p.pipeline).toBe("skinny");
  });

  it("ambiguous generate → ask_first", () => {
    const p = selectPolicy({ intentKind: "generate", difficulty: complex, hasSpecs: false, ambiguityCount: 3 });
    expect(p.pipeline).toBe("ask_first");
    expect(p.reasons.join()).toContain("歧义 3 处");
  });

  it("reasons always explain the decision", () => {
    const p = selectPolicy({ intentKind: "generate", difficulty: complex, hasSpecs: false });
    expect(p.reasons.length).toBeGreaterThanOrEqual(3);
  });
});

describe("#OPEN-VOCAB open intent vocabulary", () => {
  it("a novel bracketed intent tag passes through verbatim instead of collapsing to other", () => {
    expect(classifyIntentKind("[对比] 比较两个方案的规则覆盖")).toBe("对比");
  });
  it("selectPolicy handles a novel intent with the safe full default and names it in reasons", () => {
    const p = selectPolicy({ intentKind: "对比", difficulty: estimateDifficulty(null), hasSpecs: false });
    expect(p.pipeline).toBe("full");
    expect(p.reasons.join()).toContain("新意图类型「对比」");
  });
});

describe("shouldSuggestSplit (#ADAPT 卡住才拆)", () => {
  it("complex agents (≥4 tools or ≥6 plan steps) qualify; simple ones don't", () => {
    expect(shouldSuggestSplit({ tools: ["a", "b", "c", "d"] })).toBe(true);
    expect(shouldSuggestSplit({ tools: ["a"], plan: new Array(6).fill({}) })).toBe(true);
    expect(shouldSuggestSplit({ tools: ["a", "b"], plan: new Array(3).fill({}) })).toBe(false);
    expect(shouldSuggestSplit(null)).toBe(false);
  });
});
