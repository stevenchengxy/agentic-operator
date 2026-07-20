import { describe, expect, it } from "vitest";
import { compileInputBindings, inputBindingTypesCompatible, type CompileInputBindingsOptions } from "./input-bindings";
import type { IntegrationToolBinding } from "./integration-binding";
import type { OntologyAction } from "./ontology-types";
import type { PlanStep } from "./spec-types";
import type { RealTool } from "./tool-catalog";

const readTool: RealTool = {
  name: "records.getWork",
  sideEffect: "read",
  capabilities: [{
    systems: ["records"],
    kinds: ["datastore"],
    roles: ["reads"],
    operations: ["get"],
    objectTypes: ["Work"],
  }],
};

const resolvedRead: IntegrationToolBinding = {
  requirement: {
    id: "work:integration:1",
    actionName: "doWork",
    system: "records",
    kind: "datastore",
    role: "reads",
    operations: ["get"],
    objectTypes: ["Work"],
    replayable: true,
  },
  bindingKind: "tool",
  bindingId: readTool.name,
  toolName: readTool.name,
  status: "resolved",
  reason: "verified",
};

function action(inputs: Array<Record<string, unknown>>): OntologyAction {
  return {
    id: "work",
    name: "doWork",
    actor: ["Agent"],
    trigger: ["WORK_REQUESTED"],
    triggered_event: ["WORK_DONE"],
    target_objects: ["Work"],
    tool_use: [readTool.name],
    system_prompt: "",
    user_prompt: "",
    inputs,
    action_steps: [{
      id: "calculate",
      name: "calculate",
      outputs: [{ name: "score", type: "Number" }],
    }],
  };
}

const plan: PlanStep[] = [{ stepId: "calculate", kind: "logic" }];

describe("compileInputBindings", () => {
  it("compiles all six binding kinds without materialising config or secrets", () => {
    const result = compileInputBindings(action([
      { name: "work_id", type: "String", required: true, binding_kind: "event", event_field: "work_id", source_object: "Work.work_id" },
      { name: "stored_result", type: "String", required: true, binding_kind: "object_lookup", source_object: "Work.result", lookup_tool: readTool.name, lookup_args: { id: "bindings.work_id" }, result_path: "result.value" },
      { name: "api_key", type: "String", required: true, binding_kind: "secret", binding_ref: "records.getWork.api_key_env" },
      { name: "region", type: "String", required: true, binding_kind: "config", binding_ref: "records.getWork.region" },
      { name: "approval", type: "Boolean", required: true, binding_kind: "human_input", prompt: "是否继续处理这条记录？" },
      { name: "score", type: "Number", required: true, binding_kind: "step_output", source_step: "calculate", source_output: "score" },
    ]), {
      plan,
      selectedTools: [readTool.name],
      registeredTools: [readTool],
      integrationBindings: [resolvedRead],
      toolConfigs: { "records.getWork": { api_key_env: "PARTNER_API_KEY", region: "cn-east" } },
      toolProfileRefs: { "records.getWork": "profile-1" },
      env: { PARTNER_API_KEY: "actual-secret" },
    });

    expect(result).toMatchObject({ ok: true, errors: [], warnings: [] });
    expect(result.bindings.map((binding) => binding.kind).sort()).toEqual([
      "config", "event", "human_input", "object_lookup", "secret", "step_output",
    ]);
    expect(result.bindings.find((binding) => binding.kind === "object_lookup")).toMatchObject({
      tool: readTool.name,
      arguments: { id: "bindings.work_id" },
      resultPath: "result.value",
      dependsOn: ["work_id"],
    });
    const serialized = JSON.stringify(result.bindings);
    expect(serialized).toContain("tool:records.getWork:api_key_env");
    expect(serialized).not.toContain("actual-secret");
  });

  it("blocks fake refs, missing env, literal secrets, and unconfirmed config profiles", () => {
    const baseOptions: CompileInputBindingsOptions = {
      plan,
      selectedTools: [readTool.name],
      registeredTools: [readTool],
      integrationBindings: [resolvedRead],
      toolConfigs: { [readTool.name]: { api_key_env: "PARTNER_API_KEY", region: "cn-east" } },
      toolProfileRefs: { [readTool.name]: "profile-1" },
    };
    const one = (binding: Record<string, unknown>, options = baseOptions) => compileInputBindings(action([binding]), options);
    expect(one({ name: "key", type: "String", required: true, binding_kind: "secret", binding_ref: "env:FAKE" }, { ...baseOptions, env: { PARTNER_API_KEY: "set" } }).errors[0]?.code).toBe("input_binding_reference_unresolved");
    expect(one({ name: "key", type: "String", required: true, binding_kind: "secret", binding_ref: `${readTool.name}.api_key_env` }, { ...baseOptions, env: {} }).errors[0]?.code).toBe("input_binding_secret_env_missing");
    expect(one({ name: "key", type: "String", required: true, binding_kind: "secret", binding_ref: "sk-live-literal-secret" }, { ...baseOptions, env: { PARTNER_API_KEY: "set" } }).errors[0]?.code).toBe("input_binding_reference_unresolved");
    expect(one({ name: "region", type: "String", required: true, binding_kind: "config", binding_ref: `${readTool.name}.region` }, { ...baseOptions, toolProfileRefs: {}, env: { PARTNER_API_KEY: "set" } }).errors[0]?.code).toBe("input_binding_profile_unconfirmed");
    expect(one({ name: "region", type: "String", required: true, binding_kind: "config", binding_ref: `${readTool.name}.region` }, { ...baseOptions, env: { PARTNER_API_KEY: "set" } })).toMatchObject({ ok: true, errors: [] });
  });

  it("authoring validates symbolic config and lookup contracts without requiring runtime profiles or probes", () => {
    const authoringTool: RealTool = {
      ...readTool,
      configKeys: ["api_key_env", "region"],
    };
    const pendingBinding: IntegrationToolBinding = {
      ...resolvedRead,
      status: "needs_probe",
      reason: "probe belongs to sandbox readiness",
    };
    const result = compileInputBindings(action([
      { name: "work_id", type: "String", required: true, binding_kind: "event", event_field: "work_id" },
      { name: "stored_result", type: "String", required: true, binding_kind: "object_lookup", source_object: "Work.result", lookup_tool: readTool.name, lookup_args: { id: "bindings.work_id" }, result_path: "result.value" },
      { name: "api_key", type: "String", required: true, binding_kind: "secret", binding_ref: "records.getWork.api_key_env" },
      { name: "region", type: "String", required: true, binding_kind: "config", binding_ref: "records.getWork.region" },
    ]), {
      mode: "authoring",
      plan,
      selectedTools: [authoringTool.name],
      registeredTools: [authoringTool],
      integrationBindings: [pendingBinding],
    });

    expect(result).toMatchObject({ ok: true, errors: [] });
    expect(JSON.stringify(result.bindings)).toContain("tool:records.getWork:api_key_env");
    expect(result.bindings.find((binding) => binding.kind === "object_lookup")).toMatchObject({
      tool: readTool.name,
    });

    const unrelatedTool: RealTool = {
      name: "other.lookup",
      configKeys: ["api_key_env"],
    };
    const crossToolReference = compileInputBindings(action([
      { name: "api_key", type: "String", required: true, binding_kind: "secret", binding_ref: "other.lookup.api_key_env" },
    ]), {
      mode: "authoring",
      selectedTools: [authoringTool.name],
      registeredTools: [authoringTool, unrelatedTool],
    });
    expect(crossToolReference.errors).toContainEqual(expect.objectContaining({
      code: "input_binding_reference_tool_not_selected",
      field: "api_key",
    }));
  });

  it("fails closed when lookup execution metadata or an exact ready tool is missing", () => {
    const missingMetadata = compileInputBindings(action([
      { name: "stored_result", type: "String", required: true, binding_kind: "object_lookup", source_object: "Work.result" },
    ]), { plan, selectedTools: [readTool.name], registeredTools: [readTool], integrationBindings: [resolvedRead] });
    expect(missingMetadata.ok).toBe(false);
    expect(missingMetadata.errors.map((entry) => entry.code)).toContain("input_binding_lookup_arguments_missing");

    const noReceipt = compileInputBindings(action([
      { name: "stored_result", type: "String", required: true, binding_kind: "object_lookup", source_object: "Work.result", lookup_args: { id: "work_id" }, result_path: "result" },
    ]), { plan, selectedTools: [readTool.name], registeredTools: [readTool], integrationBindings: [] });
    expect(noReceipt.errors.map((entry) => entry.code)).toContain("input_binding_lookup_tool_unresolved");
  });

  it("rejects forward step references and incompatible step-output types", () => {
    const missingPlanStep = compileInputBindings(action([
      { name: "score", type: "Number", required: true, binding_kind: "step_output", source_step: "calculate", source_output: "score" },
    ]), { plan: [] });
    expect(missingPlanStep.errors.map((entry) => entry.code)).toContain("input_binding_step_not_in_plan");

    const mismatchAction = action([
      { name: "score", type: "Boolean", required: true, binding_kind: "step_output", source_step: "calculate", source_output: "score" },
    ]);
    const mismatch = compileInputBindings(mismatchAction, { plan });
    expect(mismatch.errors.map((entry) => entry.code)).toContain("input_binding_step_output_type_mismatch");
  });

  it("does not guess a missing required kind, while an optional legacy hole remains reviewable", () => {
    const result = compileInputBindings(action([
      { name: "required_value", type: "String", required: true },
      { name: "optional_value", type: "String", required: false },
    ]));
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([expect.objectContaining({ field: "required_value", code: "input_binding_kind_missing" })]);
    expect(result.warnings).toEqual([expect.objectContaining({ field: "optional_value", code: "input_binding_kind_missing" })]);
  });

  it("rejects prototype-control input field names at design time", () => {
    const result = compileInputBindings(action([
      { name: "__proto__", type: "Object", required: true, binding_kind: "event", event_field: "payload" },
    ]));
    expect(result.errors).toEqual([
      expect.objectContaining({ code: "input_binding_field_invalid", field: "__proto__" }),
    ]);
  });

  it("compiles source_event into a trigger-scoped runtime binding", () => {
    const result = compileInputBindings(action([
      { name: "work_id", type: "String", required: true, binding_kind: "event", event_path: "payload.work_id", source_event: "WORK_REQUESTED" },
    ]));
    expect(result).toMatchObject({ ok: true, errors: [] });
    expect(result.bindings[0]).toMatchObject({
      kind: "event",
      eventPath: "payload.work_id",
      sourceEvents: ["WORK_REQUESTED"],
    });

    const unknown = compileInputBindings(action([
      { name: "work_id", type: "String", required: true, binding_kind: "event", source_event: "GHOST" },
    ]));
    expect(unknown.errors).toContainEqual(expect.objectContaining({ code: "input_binding_source_event_unknown" }));
  });
});

describe("inputBindingTypesCompatible", () => {
  it("allows numeric widening but rejects semantic mismatches", () => {
    expect(inputBindingTypesCompatible("Integer", "Number")).toBe(true);
    expect(inputBindingTypesCompatible("String[]", "Array<String>")).toBe(true);
    expect(inputBindingTypesCompatible("String", "Boolean")).toBe(false);
  });
});
