import { describe, expect, it } from "vitest";
import { translate } from "@/lib/i18n";
import { buildFactoryGoalSuggestions } from "./factory-goals";

const t = (key: string, vars?: Record<string, string | number>) => translate("zh", key, vars);

describe("factory goal suggestions", () => {
  it("does not invent a goal without bound ontology action evidence", () => {
    expect(buildFactoryGoalSuggestions(t, null, [{ name: "doWork" }])).toEqual(
      [],
    );
    expect(
      buildFactoryGoalSuggestions(t, { id: "empty", name: "Empty" }, []),
    ).toEqual([]);
  });

  it("derives suggestions from the selected domain and its real actions", () => {
    const suggestions = buildFactoryGoalSuggestions(t,
      {
        id: "support",
        name: "客户支持",
        counts: { actions: 2, events: 1, objects: 1, rules: 4, workflow: 1 },
      },
      [{ name: "创建工单" }, { name: "升级工单" }],
    );

    expect(suggestions).toHaveLength(3);
    expect(suggestions.join("\n")).toContain("客户支持");
    expect(suggestions.join("\n")).toContain("创建工单");
    expect(suggestions.join("\n")).toContain("升级工单");
    expect(suggestions.join("\n")).toContain("4 条本体规则");
    expect(suggestions.join("\n")).not.toContain("简历");
  });

  it("does not claim rules when the ontology reports none", () => {
    const suggestions = buildFactoryGoalSuggestions(t,
      { id: "ops", name: "运维", counts: { actions: 1, events: 0, objects: 0, rules: 0, workflow: 0 } },
      [{ name: "重启服务" }],
    );

    expect(suggestions).toHaveLength(2);
    expect(suggestions.join("\n")).not.toContain("本体规则");
  });

  it("only suggests Agent-executed actions and excludes Human actions", () => {
    // Mirrors the real Agents-generation ontology: createJD is an Agent action;
    // approveInterviewInvitation / confirmRequirementClarification are Human.
    const suggestions = buildFactoryGoalSuggestions(t,
      { id: "hiring", name: "招聘", counts: { actions: 3, events: 0, objects: 0, rules: 0, workflow: 0 } },
      [
        { name: "createJD", actor: ["Agent"] },
        { name: "approveInterviewInvitation", actor: ["Human"] },
        { name: "confirmRequirementClarification", actor: ["Human"] },
      ],
    );
    const text = suggestions.join("\n");
    expect(text).toContain("createJD");
    expect(text).not.toContain("approveInterviewInvitation");
    expect(text).not.toContain("confirmRequirementClarification");
    // Count reflects the 1 Agent action, not all 3 ontology actions.
    expect(text).toContain("1 个 Agent 执行动作");
  });

  it("returns no suggestions when every bound action is Human", () => {
    expect(
      buildFactoryGoalSuggestions(t,
        { id: "manual", name: "人工域", counts: { actions: 1, events: 0, objects: 0, rules: 2, workflow: 0 } },
        [{ name: "manualEntry", actor: ["Human"] }],
      ),
    ).toEqual([]);
  });

  it("treats actions with no actor designation as automatable (back-compat)", () => {
    const suggestions = buildFactoryGoalSuggestions(t,
      { id: "legacy", name: "旧本体", counts: { actions: 1, events: 0, objects: 0, rules: 0, workflow: 0 } },
      [{ name: "doThing" }],
    );
    expect(suggestions.join("\n")).toContain("1 个 Agent 执行动作");
  });

  it("collapses a compounded uploaded marker in the domain label", () => {
    const suggestions = buildFactoryGoalSuggestions(t,
      {
        id: "up",
        name: "Agents Generation（上传）（上传）",
        counts: { actions: 1, events: 0, objects: 0, rules: 0, workflow: 0 },
      },
      [{ name: "createJD", actor: ["Agent"] }],
    );
    const text = suggestions.join("\n");
    expect(text).toContain("Agents Generation（上传）");
    expect(text).not.toContain("（上传）（上传）");
  });
});
