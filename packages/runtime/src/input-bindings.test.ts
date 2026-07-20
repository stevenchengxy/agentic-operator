import { describe, expect, it } from "vitest";
import type { FactoryInputBinding } from "./manifest";
import {
  applyHumanInputResult,
  applyObjectLookupResult,
  initializeInputBindings,
  prepareObjectLookupArguments,
  readInputBindingPath,
  resolveAvailableStepOutputBindings,
  unresolvedRequiredInputBindings,
} from "./input-bindings";

const bindings: FactoryInputBinding[] = [
  { field: "work_id", type: "String", required: true, kind: "event", event_path: "payload.work_id", source_object: "Work.work_id" },
  { field: "api_key", type: "String", required: true, kind: "secret", reference: "tool:records.getWork:api_key_env" },
  { field: "region", type: "String", required: true, kind: "config", reference: "tool:records.getWork:region" },
  { field: "approval", type: "Boolean", required: true, kind: "human_input", prompt: "是否继续？" },
  { field: "stored_result", type: "String", required: true, kind: "object_lookup", source_object: "Work.result", tool: "records.getWork", arguments: { id: "bindings.work_id" }, result_path: "result.value", depends_on: ["work_id"] },
  { field: "score", type: "Number", required: true, kind: "step_output", source_step: "calculate", source_output: "score" },
];
const referenceContext = {
  toolConfigs: { "records.getWork": { api_key_env: "PARTNER_API_KEY", region: "cn-east" } },
  toolProfileRefs: { "records.getWork": "profile-1" },
  env: { PARTNER_API_KEY: "actual-secret" },
};

describe("runtime input binding executor", () => {
  it("resolves event and reference bindings without exposing secret/config values", () => {
    const { state, issues } = initializeInputBindings(
      bindings,
      { payload: { work_id: "W-1" }, unrelated: true, undeclared_secret: "must-not-cross-the-contract" },
      referenceContext,
    );
    expect(issues).toEqual([]);
    expect(state.data).toEqual({ work_id: "W-1" });
    expect(state.data).not.toHaveProperty("api_key");
    expect(state.data).not.toHaveProperty("region");
    expect(state.references).toEqual({
      api_key: { kind: "secret", reference: "tool:records.getWork:api_key_env" },
      region: { kind: "config", reference: "tool:records.getWork:region" },
    });
  });

  it("preserves the historical event-data view when a hand-written agent declares no factory bindings", () => {
    const { state, issues } = initializeInputBindings([], { legacy_field: "still-visible" });
    expect(issues).toEqual([]);
    expect(state.data).toEqual({ legacy_field: "still-visible" });
  });

  it("activates a source_events binding only for its matching tenant-qualified trigger", () => {
    const scoped: FactoryInputBinding[] = [{
      field: "reason",
      type: "String",
      required: true,
      kind: "event",
      event_path: "payload.reason",
      source_events: ["UPDATED"],
    }];
    const active = initializeInputBindings(scoped, { payload: { reason: "changed" } }, {
      toolConfigs: {}, toolProfileRefs: {}, eventName: "tenant/UPDATED",
    });
    expect(active.issues).toEqual([]);
    expect(active.state.data).toEqual({ reason: "changed" });

    const inactive = initializeInputBindings(scoped, {}, {
      toolConfigs: {}, toolProfileRefs: {}, eventName: "tenant/CREATED",
    });
    expect(inactive.issues).toEqual([]);
    expect(inactive.state.inactive.has("reason")).toBe(true);
    expect(unresolvedRequiredInputBindings(inactive.state, scoped)).toEqual([]);
  });

  it("prepares lookup args from resolved bindings and applies only the declared result path", () => {
    const { state } = initializeInputBindings(bindings, { payload: { work_id: "W-2" } }, referenceContext);
    const lookup = bindings.find((binding): binding is Extract<FactoryInputBinding, { kind: "object_lookup" }> => binding.kind === "object_lookup")!;
    expect(prepareObjectLookupArguments(state, lookup)).toEqual({ ok: true, arguments: { id: "W-2" } });
    expect(applyObjectLookupResult(state, lookup, { result: { value: "stored", ignored: "x" } })).toEqual([]);
    expect(state.data.stored_result).toBe("stored");
  });

  it("requires explicit human payload and never supplies a recommended/default answer", () => {
    const { state } = initializeInputBindings(bindings, { payload: { work_id: "W-3" } }, referenceContext);
    const human = bindings.find((binding): binding is Extract<FactoryInputBinding, { kind: "human_input" }> => binding.kind === "human_input")!;
    expect(applyHumanInputResult(state, human, undefined)).toEqual([
      expect.objectContaining({ code: "required_input_missing", field: "approval" }),
    ]);
    expect(state.data).not.toHaveProperty("approval");
    expect(applyHumanInputResult(state, human, { value: false })).toEqual([]);
    expect(state.data.approval).toBe(false);
  });

  it("resolves step output after its source step and enforces runtime type", () => {
    const { state } = initializeInputBindings(bindings, { payload: { work_id: "W-4" } }, referenceContext);
    expect(resolveAvailableStepOutputBindings(state, bindings, {})).toEqual([]);
    expect(resolveAvailableStepOutputBindings(state, bindings, { calculate: { score: "not-a-number" } })).toEqual([
      expect.objectContaining({ code: "input_type_mismatch", field: "score" }),
    ]);
    expect(resolveAvailableStepOutputBindings(state, bindings, { calculate: { score: 42 } })).toEqual([]);
    expect(state.data.score).toBe(42);
  });

  it("reports every required binding still unresolved at finalization", () => {
    const { state } = initializeInputBindings(bindings, { payload: { work_id: "W-5" } }, referenceContext);
    expect(unresolvedRequiredInputBindings(state, bindings).map((entry) => entry.field).sort()).toEqual([
      "approval", "score", "stored_result",
    ]);
  });

  it("fails fake refs, missing env, and profile-less references instead of marking them resolved", () => {
    const fake: FactoryInputBinding[] = [{ field: "token", type: "String", required: true, kind: "secret", reference: "tool:records.getWork:ghost_env" }];
    expect(initializeInputBindings(fake, {}, referenceContext).issues[0]?.code).toBe("input_reference_unresolved");
    expect(initializeInputBindings(bindings, { payload: { work_id: "W" } }, { ...referenceContext, env: {} }).issues.map((entry) => entry.code)).toContain("input_secret_env_missing");
    expect(initializeInputBindings(bindings, { payload: { work_id: "W" } }, { ...referenceContext, toolProfileRefs: {} }).issues.map((entry) => entry.code)).toEqual(expect.arrayContaining(["input_reference_profile_unconfirmed"]));
  });

  it("rejects prototype traversal even if a malformed manifest bypasses schema validation", () => {
    expect(readInputBindingPath({ safe: 1 }, "__proto__.polluted")).toEqual({ found: false });
    expect(readInputBindingPath({ constructor: { value: 1 } }, "constructor.value")).toEqual({ found: false });
    const malformed = [{ field: "__proto__", type: "Object", required: true, kind: "event", event_path: "payload" }] as FactoryInputBinding[];
    const initialized = initializeInputBindings(malformed, { payload: { polluted: true } });
    expect(initialized.issues).toEqual([expect.objectContaining({ code: "input_binding_field_invalid" })]);
    expect(Object.getPrototypeOf(initialized.state.data)).toBeNull();
  });
});
