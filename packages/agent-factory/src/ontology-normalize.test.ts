import { describe, expect, it } from "vitest";
import { analyzeOntologyReadiness, type OntologyReadinessIssue } from "./ontology-readiness";
import { normalizeOntologySelfConsistency, applyOntologyRevision, blockingIssuesForAction } from "./ontology-normalize";
import type { DomainOntology, OntologyAction, OntologyEvent, OntologyObject } from "./ontology-types";

const obj = (id: string, properties: Array<{ name: string; type?: string }>): OntologyObject => ({ id, name: id, properties });
const ev = (name: string, over: Partial<OntologyEvent> = {}): OntologyEvent => ({
  name,
  payload: { source_action: null, event_data: [], state_mutations: [] },
  ...over,
});
const act = (name: string, over: Partial<OntologyAction> = {}): OntologyAction => ({
  id: name, name, actor: ["Agent"], trigger: [], triggered_event: [], target_objects: [], tool_use: [], system_prompt: "", user_prompt: "",
  ...over,
});
const ontology = (over: Partial<DomainOntology>): DomainOntology => ({
  domainId: "d", source: "snapshot", workflow: [], rules: [], objects: [], events: [], actions: [], ...over,
});
const codes = (report: { blocking: OntologyReadinessIssue[] }) => report.blocking.map((i) => i.code);

describe("normalizeOntologySelfConsistency — deterministic self-heal", () => {
  it("retains producer/consumer disagreements instead of changing executable action topology", () => {
    const ont = ontology({
      events: [ev("PROD", { producers: ["A"], consumers: ["B"] })],
      actions: [act("A"), act("B")], // A doesn't declare emit PROD; B doesn't declare trigger PROD
    });
    expect(codes(analyzeOntologyReadiness(ont))).toEqual(expect.arrayContaining(["event_not_declared_by_producer", "event_not_declared_by_consumer"]));

    const { ontology: healed, changes } = normalizeOntologySelfConsistency(ont);
    expect(changes).toEqual([]);
    const after = codes(analyzeOntologyReadiness(healed));
    expect(after).toEqual(expect.arrayContaining(["event_not_declared_by_producer", "event_not_declared_by_consumer"]));
    expect(ont.actions[0]!.triggered_event).toEqual([]);
    expect(ont.actions[1]!.trigger).toEqual([]);
    expect(healed.actions[0]!.triggered_event).toEqual([]);
    expect(healed.actions[1]!.trigger).toEqual([]);
  });

  it("does not hide an Action/Event producer disagreement by extending Event.producers", () => {
    const ont = ontology({
      events: [ev("PROD", { producers: ["A"] })],
      actions: [act("A", { triggered_event: ["PROD"] }), act("B", { triggered_event: ["PROD"] })], // B emits but isn't listed
    });
    expect(codes(analyzeOntologyReadiness(ont))).toContain("event_producer_missing");
    const { ontology: healed, changes } = normalizeOntologySelfConsistency(ont);
    expect(changes).toEqual([]);
    expect(healed.events[0]!.producers).toEqual(["A"]);
    expect(codes(analyzeOntologyReadiness(healed))).toContain("event_producer_missing");
  });

  it("defaults a missing primary_key from an existing id property, and leaves objects without one alone", () => {
    const ont = ontology({ objects: [obj("Candidate", [{ name: "id", type: "string" }, { name: "score", type: "number" }]), obj("Blob", [{ name: "data", type: "string" }])] });
    expect(codes(analyzeOntologyReadiness(ont))).toContain("object_primary_key_missing");
    const { ontology: healed } = normalizeOntologySelfConsistency(ont);
    expect(healed.objects[0]!.primary_key).toBe("id");
    expect(healed.objects[1]!.primary_key).toBeUndefined(); // no id-like property → not invented
  });

  it("normalizes an unambiguous same-name Event input binding without changing the source ontology", () => {
    const ont = ontology({
      events: [
        ev("IN_A", { payload: { source_action: null, event_data: [{ name: "data.upload_id", type: "String", target_object: null }], state_mutations: [] } }),
        ev("IN_B", { payload: { source_action: null, event_data: [{ name: "data.upload_id", type: "Text", target_object: null }], state_mutations: [] } }),
      ],
      actions: [act("A", {
        trigger: ["IN_A", "IN_B"],
        inputs: [{ name: "upload_id", type: "String", required: true }],
      })],
    });

    const { ontology: healed, changes } = normalizeOntologySelfConsistency(ont);
    expect(healed.actions[0]!.inputs![0]).toMatchObject({
      binding_kind: "event",
      event_path: "data.upload_id",
    });
    expect(changes).toContainEqual(expect.objectContaining({ code: "action_input_event_binding_normalized" }));
    expect(ont.actions[0]!.inputs![0]!.binding_kind).toBeUndefined();
    expect(codes(analyzeOntologyReadiness(healed))).not.toContain("action_input_binding_kind_missing");
  });

  it("does not infer Event bindings when one trigger is missing the field, the type differs, or another binding intent exists", () => {
    const ont = ontology({
      objects: [obj("Candidate", [{ name: "candidate_id", type: "String" }])],
      events: [
        ev("IN_A", { payload: { source_action: null, event_data: [
          { name: "missing_somewhere", type: "String", target_object: null },
          { name: "bad_type", type: "Object", target_object: null },
          { name: "candidate_id", type: "String", target_object: null },
        ], state_mutations: [] } }),
        ev("IN_B", { payload: { source_action: null, event_data: [
          { name: "bad_type", type: "String", target_object: null },
          { name: "candidate_id", type: "String", target_object: null },
        ], state_mutations: [] } }),
      ],
      actions: [act("A", {
        trigger: ["IN_A", "IN_B"],
        inputs: [
          { name: "missing_somewhere", type: "String", required: true },
          { name: "bad_type", type: "String", required: true },
          { name: "candidate_id", type: "String", required: true, source_object: "Candidate.candidate_id", lookup_args: { id: "event.candidate_id" } },
        ],
      })],
    });

    const { ontology: healed, changes } = normalizeOntologySelfConsistency(ont);
    expect(changes.filter((change) => change.code === "action_input_event_binding_normalized")).toEqual([]);
    for (const input of healed.actions[0]!.inputs ?? []) expect(input.binding_kind).toBeUndefined();
  });

  it("uses an explicit source_event to normalize a trigger-specific input", () => {
    const ont = ontology({
      events: [
        ev("CREATED", { payload: { source_action: null, event_data: [{ name: "data.created_id", type: "String", target_object: null }], state_mutations: [] } }),
        ev("UPDATED", { payload: { source_action: null, event_data: [{ name: "data.reason", type: "String", target_object: null }], state_mutations: [] } }),
      ],
      actions: [act("A", {
        trigger: ["CREATED", "UPDATED"],
        inputs: [{ name: "reason", type: "String", required: true, source_event: "UPDATED" }],
      })],
    });

    const { ontology: healed } = normalizeOntologySelfConsistency(ont);
    expect(healed.actions[0]!.inputs![0]).toMatchObject({
      binding_kind: "event",
      source_event: "UPDATED",
      event_path: "data.reason",
    });
    expect(codes(analyzeOntologyReadiness(healed))).not.toContain("action_required_input_unbound");
  });

  it("normalizes only output destinations proven by multi-outcome Event schemas", () => {
    const ont = ontology({
      events: [
        ev("DONE", { payload: { source_action: "A", event_data: [
          { name: "payload.result", type: "String", target_object: null },
          { name: "shared_id", type: "String", target_object: null },
          { name: "internal_note", type: "String", target_object: null },
        ], state_mutations: [] } }),
        ev("FAILED", { payload: { source_action: "A", event_data: [
          { name: "payload.error_code", type: "Enum", target_object: null },
          { name: "shared_id", type: "String", target_object: null },
          { name: "wrong_type", type: "Object", target_object: null },
        ], state_mutations: [] } }),
      ],
      actions: [act("A", {
        triggered_event: ["DONE", "FAILED"],
        outputs: [
          { name: "result", type: "String" },
          { name: "error_code", type: "Enum" },
          { name: "shared_id", type: "String" },
          { name: "missing", type: "String" },
          { name: "wrong_type", type: "String" },
          { name: "internal_note", type: "String", delivery: "internal" },
        ],
      })],
    });

    const { ontology: healed, changes } = normalizeOntologySelfConsistency(ont);
    const outputs = Object.fromEntries((healed.actions[0]!.outputs ?? []).map((output) => [output.name, output]));
    expect(outputs.result).toMatchObject({ emitted_on: ["DONE"] });
    expect(outputs.error_code).toMatchObject({ emitted_on: ["FAILED"] });
    expect(outputs.shared_id).toMatchObject({ emitted_on: ["DONE", "FAILED"] });
    expect(outputs.missing.emitted_on).toBeUndefined();
    expect(outputs.wrong_type.emitted_on).toBeUndefined();
    expect(outputs.internal_note).toMatchObject({ delivery: "internal" });
    expect(outputs.internal_note.emitted_on).toBeUndefined();
    expect(changes.filter((change) => change.code === "action_output_event_mapping_normalized")).toHaveLength(3);
    expect(ont.actions[0]!.outputs![0]!.emitted_on).toBeUndefined();
  });
});

describe("applyOntologyRevision — brain-supplied, validated patches", () => {
  const base = () => ontology({
    objects: [obj("Cand", [{ name: "id", type: "string" }])],
    events: [ev("IN", { consumers: ["A"], payload: { source_action: null, event_data: [{ name: "candId", type: "string", target_object: null }], state_mutations: [] } })],
    actions: [act("A", { trigger: ["IN"], inputs: [{ name: "candId", type: "string", required: true }] })],
  });

  it("applies an input binding patch and clears the corresponding blocking codes", () => {
    const ont = base();
    expect(codes(analyzeOntologyReadiness(ont))).toContain("action_input_binding_kind_missing");
    const { ontology: revised, applied, rejected } = applyOntologyRevision(ont, {
      inputs: [{ action: "A", field: "candId", set: { binding_kind: "event", event_field: "candId" } }],
    });
    expect(applied).toHaveLength(1);
    expect(rejected).toEqual([]);
    const after = codes(analyzeOntologyReadiness(revised));
    expect(after).not.toContain("action_input_binding_kind_missing");
    expect(after).not.toContain("action_required_input_source_missing");
    // the original is untouched
    expect((ont.actions[0]!.inputs![0] as Record<string, unknown>).binding_kind).toBeUndefined();
  });

  it("rejects patches that reference non-existent entities or invalid primary keys — never invents", () => {
    const ont = base();
    const { applied, rejected } = applyOntologyRevision(ont, {
      inputs: [{ action: "Nonexistent", field: "x", set: { binding_kind: "event" } }],
      objects: [{ object: "Cand", primary_key: "not_a_prop" }],
    });
    expect(applied).toHaveLength(0);
    expect(rejected).toHaveLength(2);
    expect(rejected.map((r) => r.reason).join(" ")).toMatch(/不存在|不在/);
  });

  it("adds a missing event field so an action output can bind (action_output_unbound)", () => {
    const ont = ontology({
      objects: [],
      events: [ev("DONE", { producers: ["A"] })],
      actions: [act("A", { triggered_event: ["DONE"], outputs: [{ name: "result", type: "string" }] })],
    });
    expect(codes(analyzeOntologyReadiness(ont))).toContain("action_output_unbound");
    const { ontology: revised } = applyOntologyRevision(ont, { events: [{ event: "DONE", add_fields: [{ name: "result", type: "string" }] }] });
    expect(codes(analyzeOntologyReadiness(revised))).not.toContain("action_output_unbound");
  });
});

describe("blockingIssuesForAction — per-action slicing", () => {
  it("returns issues scoped to the action's own name / touched objects / touched events, plus global blockers", () => {
    const a = act("A", { target_objects: ["O"], trigger: ["E1"], triggered_event: ["E2"] });
    const issues: OntologyReadinessIssue[] = [
      { severity: "blocking", code: "x_action", action: "A", message: "" },
      { severity: "blocking", code: "x_object", object: "O", message: "" },
      { severity: "blocking", code: "x_event_touched", event: "E2", message: "" },
      { severity: "blocking", code: "x_event_untouched", event: "E9", message: "" },
      { severity: "blocking", code: "x_global", message: "" },
      { severity: "blocking", code: "x_other_action", action: "B", message: "" },
    ];
    const mine = blockingIssuesForAction(issues, a).map((i) => i.code);
    expect(mine).toEqual(expect.arrayContaining(["x_action", "x_object", "x_event_touched", "x_global"]));
    expect(mine).not.toContain("x_event_untouched");
    expect(mine).not.toContain("x_other_action");
  });

  it("does not spread an action/event-scoped issue through its secondary shared object", () => {
    const a = act("A", { target_objects: ["Shared"], trigger: ["A_IN"] });
    const issues: OntologyReadinessIssue[] = [
      { severity: "blocking", code: "other_side_effect", action: "B", object: "Shared", message: "" },
      { severity: "blocking", code: "other_event_mutation", event: "B_OUT", object: "Shared", message: "" },
      { severity: "blocking", code: "object_only", object: "Shared", message: "" },
    ];

    expect(blockingIssuesForAction(issues, a).map((issue) => issue.code)).toEqual(["object_only"]);
  });

  it("keeps a touched event issue even when its named source action is external to the slice", () => {
    const consumer = act("Consumer", { trigger: ["EXTERNAL_READY"] });
    const issue: OntologyReadinessIssue = {
      severity: "blocking",
      code: "event_source_action_unknown",
      event: "EXTERNAL_READY",
      action: "ManualApproval",
      domain: "external-domain",
      message: "",
    };

    expect(blockingIssuesForAction([issue], consumer)).toEqual([issue]);
  });
});
