import { describe, expect, it } from "vitest";
import type { OntologyAction } from "./ontology-types";
import { analyzeExecutionPlanRequirement, validatePlanAgainstOntology } from "./ontology-execution";

function action(over: Partial<OntologyAction> = {}): OntologyAction {
  return {
    id: "9-1",
    name: "processResume",
    actor: ["Agent"],
    trigger: ["RESUME_DOWNLOADED"],
    triggered_event: ["RESUME_PROCESSED"],
    target_objects: [],
    tool_use: [],
    system_prompt: "",
    user_prompt: "",
    ...over,
  };
}

describe("ontology execution-plan readiness", () => {
  it("requires a plan from ontology facts, without domain/action allowlists", () => {
    const requirement = analyzeExecutionPlanRequirement(action({
      action_steps: [
        { name: "uploadResume", type: "tool" },
        { name: "parseResume", type: "tool" },
        { name: "validateCompleteness", type: "logic" },
      ],
      integration: { systems: [{ name: "RoboHire", role: "calls", capability: "POST /parse-resume" }] },
      side_effects: { data_changes: [{ object_type: "Resume", action: "CREATE" }] },
    }));
    expect(requirement.required).toBe(true);
    expect(requirement.ontologySteps.map((step) => step.stepId)).toEqual(["uploadResume", "parseResume", "validateCompleteness"]);
    expect(requirement.reasons.join(" ")).toMatch(/action_steps|integration|mutation/);
  });

  it("blocks an opaque plan and reports missing ontology operations", () => {
    const ontologyAction = action({ action_steps: [{ name: "parseResume" }, { name: "persistResume" }] });
    expect(validatePlanAgainstOntology(ontologyAction, [])[0]).toMatch(/structured plan required/);
    expect(validatePlanAgainstOntology(ontologyAction, [{ stepId: "parseResume", kind: "logic" }])[0]).toMatch(/persistResume/);
    expect(validatePlanAgainstOntology(ontologyAction, [
      { stepId: "parseResume", kind: "logic" },
      { stepId: "persistResume", kind: "logic" },
    ])).toEqual([]);
  });

  it("requires integration boundaries to remain separate replayable tool/invoke steps", () => {
    const ontologyAction = action({
      action_steps: [{ name: "evaluate", type: "logic" }],
      integration: { systems: [{ name: "Vendor", role: "calls" }, { name: "Primary DB", role: "writes" }] },
    });
    const tooFlat = validatePlanAgainstOntology(ontologyAction, [{ stepId: "evaluate", kind: "logic" }]);
    expect(tooFlat.join(" ")).toMatch(/2 integration system boundary/);
    expect(validatePlanAgainstOntology(ontologyAction, [
      { stepId: "callVendor", kind: "tool", tool: "vendor.call" },
      { stepId: "evaluate", kind: "logic" },
      { stepId: "persist", kind: "tool", tool: "records.upsert" },
    ])).toEqual([]);
  });

  it("normalizes unsafe ontology labels to addressable stable ids", () => {
    const requirement = analyzeExecutionPlanRequirement(action({ action_steps: [{ name: "解析简历" }, { name: "save resume" }] }));
    expect(requirement.ontologySteps.map((step) => step.stepId)).toEqual(["ontology-step-1", "ontology-step-2"]);
  });

  it("does not mistake an external trigger source for a handler-side tool boundary", () => {
    const requirement = analyzeExecutionPlanRequirement(action({ integration: { systems: [{ name: "HSM", role: "triggers" }] } }));
    expect(requirement.integrationSystems).toHaveLength(1);
    expect(requirement.replayableIntegrationCount).toBe(0);
    expect(requirement.required).toBe(false);
  });

  it("does not collapse a prose-only business procedure into an implicit single logic step", () => {
    const ontologyAction = action({
      instruction: "读取对象存储，调用外部解析服务，写入权威记录后发送结果事件。",
    });
    const requirement = analyzeExecutionPlanRequirement(ontologyAction);
    expect(requirement).toMatchObject({ required: true, unstructuredInstruction: true });
    expect(validatePlanAgainstOntology(ontologyAction, [])[0]).toMatch(/structured plan required/);
    expect(validatePlanAgainstOntology(ontologyAction, [{ stepId: "reviewed-procedure", kind: "logic" }])).toEqual([]);
  });
});
