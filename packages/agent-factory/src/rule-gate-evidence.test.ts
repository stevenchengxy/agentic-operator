import { describe, expect, it } from "vitest";
import { assessRuleGate } from "./rule-gate-evidence";
import type { OntologyAction } from "./ontology-types";
import type { GeneratedAgentSpec } from "./spec-types";

function spec(p: Partial<GeneratedAgentSpec> = {}): GeneratedAgentSpec {
  return {
    key: "candidate",
    actionName: "candidate",
    slug: "test-candidate",
    short: "CandidateAgent",
    domainId: "test",
    nameZh: "candidate",
    kind: "llm",
    trigger: [],
    emit: [],
    tools: [],
    unresolvedTools: [],
    objects: [],
    systemPrompt: "x",
    userPrompt: "",
    steps: [],
    ruleRefs: [],
    retries: 1,
    hitl: false,
    confidence: 1,
    promptSource: "llm",
    ...p,
  };
}

function action(p: Partial<OntologyAction> = {}): OntologyAction {
  return {
    id: "candidate",
    name: "candidate",
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

describe("structured rule-gate evidence", () => {
  it("does not infer a rule gate from an action name", () => {
    expect(assessRuleGate(spec({ actionName: "ruleCheckLookingName" }))).toMatchObject({
      isRuleGate: false,
      readerBound: false,
      evidence: [],
    });
  });

  it("recognizes ruleRefs and decision tables as structured gate evidence", () => {
    expect(assessRuleGate(spec({ ruleRefs: ["policy-1"] }))).toMatchObject({
      isRuleGate: true,
      readerBound: false,
      evidence: ["rule_refs"],
    });
    const table = {
      id: "policy-table",
      rows: [],
      missing: { outcome: "review" },
      default: { outcome: "review" },
    };
    expect(assessRuleGate(spec({ decisionTables: [table] }))).toMatchObject({
      isRuleGate: true,
      readerBound: false,
      evidence: ["decision_tables"],
    });
  });

  it("recognizes an Ontology rulebase requirement without using system or vendor names", () => {
    const ontologyAction = action({
      integration: { systems: [{ name: "Policy Store", kind: "rulebase", role: "reads" }] },
    });
    expect(assessRuleGate(spec(), { ontologyAction })).toMatchObject({
      isRuleGate: true,
      readerBound: false,
      evidence: ["rulebase_requirement"],
    });
  });

  it("accepts any selected reader whose capability declares rulebase/read", () => {
    const readerName = "policy.current.read";
    expect(assessRuleGate(spec({ tools: [readerName] }), {
      registeredTools: [{
        name: readerName,
        capabilities: [{ systems: ["Policy Store"], kinds: ["rulebase"], roles: ["reads"] }],
      }],
    })).toMatchObject({
      isRuleGate: true,
      readerBound: true,
      evidence: ["rule_reader_capability"],
      readers: [readerName],
    });
  });
});
