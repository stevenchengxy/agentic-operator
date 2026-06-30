import { describe, it, expect } from "vitest";
import { __ruleTestHelpers } from "./tools";
import type { BrainCtx } from "./brain-types";

const { ruleIdentifiers, promptEmbedsRule, looksLikeRuleGate, rulesForAction } = __ruleTestHelpers;

describe("rulesForAction (#B design-time rule grounding)", () => {
  const action = { id: "10", name: "ruleCheckForClientResume", target_objects: ["Resume"], actor: ["Agent"], trigger: [], triggered_event: [], tool_use: [], system_prompt: "", user_prompt: "" };
  it("matches rules by id-prefix (RAAS/Allmeta hierarchy) and surfaces the human name", () => {
    const rules = [
      { id: "10-1", businessLogicRuleName: "客户简历去重", standardizedLogicRule: "若已存在则拒绝" },
      { id: "10-2", businessLogicRuleName: "客户简历竞对回避" },
      { id: "99-1", businessLogicRuleName: "无关规则" },
    ];
    const got = rulesForAction(action as never, rules);
    expect(got.map((r) => r.id)).toEqual(["10-1", "10-2"]); // 99-1 excluded (different action)
    expect(got[0]!.name).toBe("客户简历去重");
    expect(got[0]!.summary).toContain("若已存在则拒绝");
  });
  it("falls back to text match when ids don't use the prefix scheme", () => {
    const rules = [{ id: "r_x", name: "Resume dedup policy", description: "dedupe Resume records" }];
    const got = rulesForAction(action as never, rules);
    expect(got.map((r) => r.id)).toContain("r_x"); // matched on "Resume" target object
  });
});

// #9 (review fixes): rule-gate + rule-leak detection must be domain-agnostic and precise.
describe("looksLikeRuleGate — `lock` no longer matches as a bare substring", () => {
  it("does NOT misclassify block/unlock/clock actions as rule gates", () => {
    expect(looksLikeRuleGate({ name: "blockShipment" })).toBe(false);
    expect(looksLikeRuleGate({ name: "unlockAccount" })).toBe(false);
    expect(looksLikeRuleGate({ name: "clockIn" })).toBe(false);
    expect(looksLikeRuleGate({ name: "allocateBlock" })).toBe(false);
  });
  it("still classifies genuine rule gates (bilingual)", () => {
    expect(looksLikeRuleGate({ name: "ruleCheckResume" })).toBe(true);
    expect(looksLikeRuleGate({ name: "校验简历" })).toBe(true);
    expect(looksLikeRuleGate({ name: "anything", category: "compliance-gate" })).toBe(true);
    // a standalone / hyphenated "lock" word still matches; only the substring-inside-a-word case is dropped.
    expect(looksLikeRuleGate({ name: "account-lock-check" })).toBe(true);
    expect(looksLikeRuleGate({ name: "lock", description: "freeze the record" })).toBe(true);
  });
});

describe("ruleIdentifiers — reads the REAL rule-name fields (e.g. RAAS businessLogicRuleName)", () => {
  const ctx = (rules: unknown[]): BrainCtx =>
    ({ ontology: { objects: [], events: [], actions: [], rules, workflow: [], domainId: "D", source: "allmeta" } }) as unknown as BrainCtx;

  it("collects businessLogicRuleName + standardizedLogicRule, not just the numeric id", () => {
    const ids = ruleIdentifiers(ctx([{ id: "1-1-1", businessLogicRuleName: "客户需求系统数据自动采集", standardizedLogicRule: "当 X 则 Y", specificScenarioStage: "采集" }]));
    expect(ids).toContain("客户需求系统数据自动采集");
    expect(ids).toContain("1-1-1");
    // a non-rule field is NOT collected
    expect(ids).not.toContain("采集");
  });

  it("drops collision-prone short ids (length < 4) like '2-1'", () => {
    const ids = ruleIdentifiers(ctx([{ id: "2-1", businessLogicRuleName: "竞对客户回避" }]));
    expect(ids).not.toContain("2-1");
    expect(ids).toContain("竞对客户回避");
  });
});

describe("promptEmbedsRule — boundary-matched, no substring collisions", () => {
  it("flags a prompt that embeds a real rule name", () => {
    expect(promptEmbedsRule("本 agent 负责执行 客户需求系统数据自动采集 这条规则", ["客户需求系统数据自动采集"])).toBe(true);
  });
  it("does NOT flag a longer token that merely contains a rule id", () => {
    expect(promptEmbedsRule("see step 1-1-10 for details", ["1-1-1"])).toBe(false);
    expect(promptEmbedsRule("rule 1-1-1 applies here", ["1-1-1"])).toBe(true);
  });
});
