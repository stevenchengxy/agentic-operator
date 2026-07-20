import { describe, expect, it } from "vitest";
import { __ruleTestHelpers } from "./tools";
import type { BrainCtx } from "./brain-types";
import type { OntologyAction } from "./ontology-types";

const {
  ruleIdentifiers,
  promptEmbedsRule,
  ontologyActionIsRuleGate,
  resolveActionRuleReferences,
} = __ruleTestHelpers;

function action(p: Partial<OntologyAction> = {}): OntologyAction {
  return {
    id: "action-1",
    name: "processSubmission",
    actor: ["Agent"],
    trigger: [],
    triggered_event: [],
    target_objects: [],
    tool_use: [],
    system_prompt: "",
    user_prompt: "",
    ...p,
  };
}

describe("exact action-step rule resolution", () => {
  const rules = [
    { id: "rule-1", businessLogicRuleName: "Submission policy", standardizedLogicRule: "first" },
    { id: "rule-2", businessLogicRuleName: "Retention policy", standardizedLogicRule: "second" },
    { id: "action-1-prefix-only", businessLogicRuleName: "Unreferenced prefix rule" },
    { id: "text-only", businessLogicRuleName: "processSubmission target similarity" },
  ];

  it("resolves explicit IDs and exact names, preserving action-step order", () => {
    const result = resolveActionRuleReferences(action({
      action_steps: [{
        name: "evaluate",
        rules: [{ rule_id: "rule-1" }, "Retention policy"],
      }],
    }), rules);

    expect(result.relevantRules.map((rule) => rule.id)).toEqual(["rule-1", "rule-2"]);
    expect(result.relevantRules[0]).toMatchObject({ name: "Submission policy", summary: "first" });
    expect(result.unresolved).toEqual([]);
    expect(result.needsUserInput).toBe(false);
  });

  it("never adds ID-prefix or text-similar rules that action_steps did not reference", () => {
    const result = resolveActionRuleReferences(action({
      action_steps: [{ rules: [{ id: "rule-1" }] }],
    }), rules);
    expect(result.relevantRules.map((rule) => rule.id)).toEqual(["rule-1"]);
  });

  it("returns ask_user evidence when an exact name is ambiguous", () => {
    const result = resolveActionRuleReferences(action({
      action_steps: [{ name: "evaluate", rules: ["Duplicate policy"] }],
    }), [
      { id: "a", name: "Duplicate policy" },
      { id: "b", businessLogicRuleName: "Duplicate policy" },
    ]);

    expect(result.relevantRules).toEqual([]);
    expect(result).toMatchObject({ needsUserInput: true, next: "ask_user" });
    expect(result.unresolved[0]).toMatchObject({ reason: "ambiguous", stepName: "evaluate" });
    expect(result.question).toContain("准确的 rule id 或唯一名称");
  });

  it("does not invent an identity for a rule object that has no id/name field", () => {
    const result = resolveActionRuleReferences(action({
      action_steps: [{ rules: [{ description: "looks similar to a rule" }] }],
    }), rules);
    expect(result).toMatchObject({ relevantRules: [], needsUserInput: true, next: "ask_user" });
    expect(result.unresolved[0]).toMatchObject({ reason: "missing_identity" });
  });
});

describe("Ontology rule-gate classification uses structure only", () => {
  it("does not infer from action name, description, category, or target text", () => {
    expect(ontologyActionIsRuleGate(action({
      name: "ruleCheckResume",
      description: "compliance gate blacklist check",
      category: "rule-gate",
      target_objects: ["Rule"],
    }))).toBe(false);
  });

  it("accepts explicit action_steps rule references", () => {
    expect(ontologyActionIsRuleGate(action({ action_steps: [{ rules: ["rule-1"] }] }))).toBe(true);
    expect(ontologyActionIsRuleGate(action({ action_steps: [{ rules: [] }] }))).toBe(false);
  });

  it("accepts a custom rulebase integration without relying on system/vendor names", () => {
    expect(ontologyActionIsRuleGate(action({
      integration: { systems: [{ name: "Custom Policy Service", kind: "rulebase", role: "reads" }] },
    }))).toBe(true);
  });
});

describe("ruleIdentifiers uses exact rule identity fields", () => {
  const ctx = (rules: unknown[]): BrainCtx =>
    ({ ontology: { objects: [], events: [], actions: [], rules, workflow: [], domainId: "D", source: "allmeta" } }) as unknown as BrainCtx;

  it("collects ids and declared names, but not rule descriptions/logic text", () => {
    const ids = ruleIdentifiers(ctx([{
      id: "2-1",
      businessLogicRuleName: "Candidate policy",
      standardizedLogicRule: "when X then Y",
      description: "descriptive prose",
    }]));
    expect(ids).toEqual(["2-1", "Candidate policy"]);
  });
});

describe("promptEmbedsRule — boundary-matched, no substring collisions", () => {
  it("flags a prompt that embeds an exact rule name", () => {
    expect(promptEmbedsRule("本 agent 负责执行 Candidate policy", ["Candidate policy"])).toBe(true);
  });
  it("does NOT flag a longer token that merely contains a rule id", () => {
    expect(promptEmbedsRule("see step 1-1-10 for details", ["1-1-1"])).toBe(false);
    expect(promptEmbedsRule("rule 1-1-1 applies here", ["1-1-1"])).toBe(true);
  });
});
