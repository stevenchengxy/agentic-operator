import { describe, it, expect } from "vitest";
import { renderSkillMd, toSpecName, isValidSpecName, lintSkillExport } from "./skill-export";

// #P1-6 — Agent Skills 开放标准导出：name 规范、description=what+when 路由信号、lint 门。

const skill = {
  slug: "gate-fetch-rules-first",
  name: "闸口先取规则再判定",
  purpose: "规则闸 agent 的标准流程模式",
  promptFragment: "对任何规则闸 agent：第一步调用 {规则获取工具} 拉取该动作的业务规则，第二步逐条比对 {输入对象} 字段，第三步只 emit 明确的通过/拒绝事件。",
  tools: ["ontology.fetchActionRules"],
  decisionRule: "设计规则闸类 agent 时使用",
  domain: "zhaopin",
};

describe("toSpecName / isValidSpecName", () => {
  it("normalizes to spec-compliant names", () => {
    expect(toSpecName("Gate_Fetch Rules!!")).toBe("gate-fetch-rules");
    expect(toSpecName("闸口先取规则")).toBe("skill"); // all-CJK → fallback（规范只允许 a-z0-9-）
    expect(isValidSpecName("gate-fetch-rules")).toBe(true);
    expect(isValidSpecName("-bad")).toBe(false);
    expect(isValidSpecName("double--hyphen")).toBe(false);
  });
});

describe("renderSkillMd", () => {
  it("emits frontmatter with name matching dirName + what+when description", () => {
    const { dirName, skillMd } = renderSkillMd(skill);
    expect(dirName).toBe("gate-fetch-rules-first");
    expect(skillMd).toContain(`name: ${dirName}`);
    expect(skillMd).toContain("Use when:");
    expect(skillMd).toContain("规则闸 agent 的标准流程模式");
    expect(skillMd.startsWith("---\n")).toBe(true);
    expect(skillMd).toContain("## Instructions");
    expect(skillMd).toContain("ontology.fetchActionRules");
  });
});

describe("lintSkillExport", () => {
  it("passes a valid skill; rejects short fragments / empty description", () => {
    expect(lintSkillExport(skill)).toEqual([]);
    expect(lintSkillExport({ ...skill, promptFragment: "太短" }).join()).toContain("过短");
    expect(lintSkillExport({ ...skill, purpose: "", decisionRule: "" }).join()).toContain("description");
  });
});
