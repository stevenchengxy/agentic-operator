import { describe, expect, it } from "vitest";
import type { DomainOntology, OntologyAction, OntologyLink } from "./ontology-types";
import { analyzeOntologyReadiness } from "./ontology-readiness";

const action = (patch: Partial<OntologyAction> = {}): OntologyAction => ({
  id: "a1",
  name: "doWork",
  actor: ["Agent"],
  trigger: ["WORK_REQUESTED"],
  triggered_event: ["WORK_DONE"],
  target_objects: ["Work"],
  tool_use: [],
  system_prompt: "",
  user_prompt: "",
  inputs: [{ name: "work_id", type: "String", required: true, binding_kind: "event", source_object: "Work.work_id" }],
  outputs: [{ name: "result", type: "String" }],
  action_steps: [{ id: "step-1", name: "check", rules: [{ id: "r1" }] }],
  ...patch,
});

const ontology = (patch: Partial<DomainOntology> = {}): DomainOntology => ({
  domainId: "test",
  source: "allmeta",
  objects: [{ id: "Work", name: "Work", primary_key: "work_id", properties: [{ name: "work_id", type: "String" }, { name: "result", type: "String" }] }],
  rules: [{ id: "r1" }],
  actions: [action()],
  events: [
    { name: "WORK_REQUESTED", payload: { source_action: null, event_data: [{ name: "work_id", type: "String", target_object: "Work" }], state_mutations: [] } },
    { name: "WORK_DONE", payload: { source_action: "doWork", event_data: [{ name: "result", type: "String", target_object: "Work" }], state_mutations: [{ target_object: "Work", mutation_type: "MODIFY", impacted_properties: ["result"] }] } },
  ],
  workflow: [{ id: "flow" }],
  ...patch,
});

const link = (
  id: string,
  kind: string,
  fromType: string,
  fromId: string,
  toType: string,
  toId: string,
  status = "approved",
): OntologyLink => ({
  id,
  kind,
  status,
  from: { type: fromType, id: fromId },
  to: { type: toType, id: toId },
});

const completeLinks = (): OntologyLink[] => [
  link("trigger", "action-trigger", "Event", "WORK_REQUESTED", "Action", "a1"),
  link("emission", "action-emission", "Action", "a1", "Event", "WORK_DONE"),
  link("has-step", "action-includes-step", "Action", "a1", "ActionStep", "step-1"),
  link("governs", "rule-governs", "Rule", "r1", "ActionStep", "step-1"),
  link("requested-carries", "event-carries-object", "Event", "WORK_REQUESTED", "Object", "Work"),
  link("done-carries", "event-carries-object", "Event", "WORK_DONE", "Object", "Work"),
  link("done-mutates", "event-mutates-object", "Event", "WORK_DONE", "Object", "Work"),
];

describe("analyzeOntologyReadiness", () => {
  it("passes a referentially complete executable contract", () => {
    const report = analyzeOntologyReadiness(ontology());
    expect(report.ready).toBe(true);
    expect(report.blocking).toEqual([]);
    expect(report.counts.actionSteps).toBe(1);
  });

  it("validates approved modern links when the optional collection is present", () => {
    const report = analyzeOntologyReadiness(ontology({ links: completeLinks() }));
    expect(report.ready).toBe(true);
    expect(report.blocking).toEqual([]);
  });

  it("keeps old no-links domains compatible but blocks an explicit under-covered link graph", () => {
    expect(analyzeOntologyReadiness(ontology()).blocking.map((issue) => issue.code))
      .not.toContain("action_trigger_link_missing");

    const report = analyzeOntologyReadiness(ontology({ links: [] }));
    expect(report.blocking.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "action_trigger_link_missing",
      "action_emission_link_missing",
      "action_step_link_missing",
      "rule_step_link_missing",
      "event_object_link_missing",
      "event_mutation_link_missing",
    ]));
  });

  it("requires approved required links and resolvable approved endpoints", () => {
    const links = completeLinks().map((row) => row.id === "governs" ? { ...row, status: "draft" } : row);
    links.push(link("dangling", "event-carries-object", "Event", "WORK_DONE", "Object", "Ghost"));
    links.push(link("dangling", "event-carries-object", "Event", "WORK_DONE", "Object", "Work"));
    const report = analyzeOntologyReadiness(ontology({ links }));
    expect(report.blocking).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "required_link_not_approved", rule: "r1" }),
      expect.objectContaining({ code: "link_endpoint_unknown", link: "dangling" }),
      expect.objectContaining({ code: "duplicate_link_id", link: "dangling" }),
    ]));
  });

  it("checks mandatory Rule scope only for rules used by the current Action slice", () => {
    const baseLinks = [
      ...completeLinks(),
      link("r1-work", "rule-references-object", "Rule", "r1", "Object", "Work"),
    ];
    const scoped = analyzeOntologyReadiness(ontology({
      rules: [
        { id: "r1", enforcementLevel: "mandatory", relatedEntities: ["工作记录 (Work)"] },
        { id: "unused", enforcementLevel: "mandatory", relatedEntities: ["Work"] },
      ],
      links: baseLinks,
    }));
    expect(scoped.blocking).toContainEqual(expect.objectContaining({
      code: "mandatory_rule_policy_scope_link_missing",
      action: "doWork",
      rule: "r1",
    }));
    expect(scoped.blocking).not.toContainEqual(expect.objectContaining({
      code: "mandatory_rule_policy_scope_link_missing",
      rule: "unused",
    }));

    const complete = analyzeOntologyReadiness(ontology({
      rules: [{ id: "r1", enforcementLevel: "mandatory", relatedEntities: ["工作记录 (Work)"] }],
      links: [
        ...baseLinks,
        link("r1-scope", "rule-scoped-to", "Rule", "r1", "PolicyScope", "client:any"),
      ],
    }));
    expect(complete.blocking.map((issue) => issue.code)).not.toEqual(expect.arrayContaining([
      "mandatory_rule_policy_scope_link_missing",
      "rule_object_link_missing",
    ]));
  });

  it("requires an approved object-fk link for declared foreign keys", () => {
    const withParent = ontology({
      objects: [
        {
          id: "Work",
          name: "Work",
          primary_key: "work_id",
          properties: [
            { name: "work_id", type: "String" },
            { name: "result", type: "String" },
            { name: "parent_id", type: "String", is_foreign_key: true, references: "Parent" },
          ],
        },
        { id: "Parent", name: "Parent", primary_key: "id", properties: [{ name: "id", type: "String" }] },
      ],
      links: completeLinks(),
    });
    expect(analyzeOntologyReadiness(withParent).blocking.map((issue) => issue.code))
      .toContain("object_fk_link_missing");

    const linked = analyzeOntologyReadiness({
      ...withParent,
      links: [
        ...completeLinks(),
        link("work-parent", "object-fk", "Object", "Work", "Object", "Parent"),
      ],
    });
    expect(linked.blocking.map((issue) => issue.code)).not.toContain("object_fk_link_missing");
  });

  it("blocks missing emitted events and source-action declaration drift", () => {
    const base = ontology();
    const report = analyzeOntologyReadiness({
      ...base,
      actions: [action({ triggered_event: ["MISSING_EVENT"] })],
    });
    expect(report.ready).toBe(false);
    expect(report.blocking.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "action_emitted_event_unknown",
      "event_not_declared_by_source_action",
    ]));
  });

  it("accepts an unmodeled manual/platform source only when the consumer explicitly declares it", () => {
    const base = ontology();
    const report = analyzeOntologyReadiness({
      ...base,
      actions: [action({
        integration: {
          event_sources: {
            WORK_REQUESTED: "External Portal (manual approval)",
          },
        },
      })],
      events: base.events.map((event) => event.name === "WORK_REQUESTED"
        ? { ...event, producers: ["manualRequestWork"], payload: { ...event.payload, source_action: "manualRequestWork" } }
        : event),
    });

    expect(report.blocking.map((issue) => issue.code)).not.toContain("event_source_action_unknown");
    expect(report.blocking.map((issue) => issue.code)).not.toContain("event_producer_unknown");
    expect(report.warnings).toContainEqual(expect.objectContaining({
      code: "event_external_source_action_unmodeled",
      event: "WORK_REQUESTED",
      action: "manualRequestWork",
    }));
  });

  it("does not infer an external boundary from an unknown source action or prose alone", () => {
    const base = ontology();
    const report = analyzeOntologyReadiness({
      ...base,
      events: base.events.map((event) => event.name === "WORK_REQUESTED"
        ? {
            ...event,
            description: "A person may submit this event",
            payload: { ...event.payload, source_action: "manualRequestWork" },
          }
        : event),
    });

    expect(report.blocking.map((issue) => issue.code)).toContain("event_source_action_unknown");
    expect(report.warnings.map((issue) => issue.code)).not.toContain("event_external_source_action_unmodeled");
  });

  it("does not collapse punctuation when checking identity uniqueness", () => {
    const base = ontology();
    const report = analyzeOntologyReadiness({
      ...base,
      actions: [
        base.actions[0]!,
        action({ id: "1-2", name: "manualWork", trigger: [], triggered_event: [], inputs: [], outputs: [], action_steps: [] }),
        action({ id: "12", name: "evaluateWork", trigger: [], triggered_event: [], inputs: [], outputs: [], action_steps: [] }),
      ],
    });
    expect(report.blocking.map((issue) => issue.code)).not.toContain("duplicate_action_id");
  });

  it("blocks missing object, property and rule references", () => {
    const base = ontology();
    const report = analyzeOntologyReadiness({
      ...base,
      actions: [action({
        target_objects: ["Ghost"],
        action_steps: [{ id: "step-1", name: "check", rules: [{ id: "missing-rule" }] }],
        side_effects: { data_changes: [{ object_type: "Work", property_impacted: ["ghost_field"] }] },
      })],
    });
    expect(report.blocking.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "action_target_object_unknown",
      "action_step_rule_unknown",
      "side_effect_property_unknown",
    ]));
  });

  it("blocks required input/output fields that have no event binding", () => {
    const base = ontology();
    const report = analyzeOntologyReadiness({
      ...base,
      actions: [action({
        inputs: [{ name: "unbound_id", type: "String", required: true, binding_kind: "event", source_object: "Work.result" }],
        outputs: [{ name: "unbound_result", type: "String" }],
      })],
    });
    expect(report.blocking.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "action_required_input_unbound",
      "action_output_unbound",
    ]));
  });

  it("honors source_event for trigger-specific required inputs", () => {
    const base = ontology();
    const report = analyzeOntologyReadiness({
      ...base,
      actions: [action({
        trigger: ["WORK_REQUESTED", "WORK_UPDATED"],
        inputs: [{
          name: "reason",
          type: "String",
          required: true,
          binding_kind: "event",
          event_path: "data.reason",
          source_event: "WORK_UPDATED",
        }],
      })],
      events: [
        ...base.events,
        { name: "WORK_UPDATED", payload: { source_action: null, event_data: [{ name: "data.reason", type: "String", target_object: null }], state_mutations: [] } },
      ],
    });
    expect(report.blocking.map((issue) => issue.code)).not.toContain("action_required_input_unbound");

    const unknown = analyzeOntologyReadiness({
      ...base,
      actions: [action({ inputs: [{ name: "work_id", type: "String", required: true, binding_kind: "event", source_event: "GHOST" }] })],
    });
    expect(unknown.blocking).toContainEqual(expect.objectContaining({ code: "action_input_source_event_unknown" }));
  });

  it("requires explicit emitted_on mapping for multi-outcome outputs", () => {
    const base = ontology();
    const failed = { name: "WORK_FAILED", payload: { source_action: "doWork", event_data: [{ name: "error", type: "String", target_object: null }], state_mutations: [] } };
    const missing = analyzeOntologyReadiness({
      ...base,
      actions: [action({
        triggered_event: ["WORK_DONE", "WORK_FAILED"],
        outputs: [{ name: "result", type: "String" }, { name: "error", type: "String" }],
      })],
      events: [...base.events, failed],
    });
    expect(missing.blocking.map((issue) => issue.code)).toContain("action_output_event_mapping_missing");

    const mapped = analyzeOntologyReadiness({
      ...base,
      actions: [action({
        triggered_event: ["WORK_DONE", "WORK_FAILED"],
        outputs: [
          { name: "result", type: "String", emitted_on: "WORK_DONE" },
          { name: "error", type: "String", events: ["WORK_FAILED"] },
          { name: "debug", type: "Object", delivery: "internal" },
        ],
      })],
      events: [...base.events, failed],
    });
    expect(mapped.blocking.map((issue) => issue.code)).not.toEqual(expect.arrayContaining([
      "action_output_event_mapping_missing",
      "action_output_unbound",
    ]));
  });

  it("strictly verifies a source_action in its declared external domain", () => {
    const base = ontology();
    const externalSource = action({
      id: "external-1",
      name: "requestWork",
      trigger: [],
      triggered_event: ["WORK_REQUESTED"],
      target_objects: [],
      inputs: [],
      outputs: [],
      action_steps: [],
    });
    const report = analyzeOntologyReadiness({
      ...base,
      referencedDomains: [{ domainId: "upstream", source: "allmeta", resolved: true, actions: [externalSource] }],
      events: base.events.map((event) => event.name === "WORK_REQUESTED"
        ? { ...event, producers: ["requestWork"], payload: { ...event.payload, source_action: "requestWork", source_domain: "upstream" } }
        : event),
    });
    expect(report.blocking.map((issue) => issue.code)).not.toEqual(expect.arrayContaining([
      "event_source_domain_unresolved",
      "event_source_action_unknown",
      "event_not_declared_by_source_action",
      "event_producer_unknown",
      "event_not_declared_by_producer",
    ]));
  });

  it("blocks unresolved, missing and emit-drifting external source actions", () => {
    const base = ontology();
    const externalEvent = (sourceAction: string, sourceDomain = "upstream") => base.events.map((event) => event.name === "WORK_REQUESTED"
      ? { ...event, payload: { ...event.payload, source_action: sourceAction, source_domain: sourceDomain } }
      : event);

    const unresolved = analyzeOntologyReadiness({
      ...base,
      referencedDomains: [{ domainId: "upstream", source: "allmeta", resolved: false, actions: [], error: "offline" }],
      events: externalEvent("requestWork"),
    });
    expect(unresolved.blocking.map((issue) => issue.code)).toContain("event_source_domain_unresolved");

    const missing = analyzeOntologyReadiness({
      ...base,
      referencedDomains: [{ domainId: "upstream", source: "allmeta", resolved: true, actions: [] }],
      events: externalEvent("requestWork"),
    });
    expect(missing.blocking.map((issue) => issue.code)).toContain("event_source_action_unknown");

    const drift = analyzeOntologyReadiness({
      ...base,
      referencedDomains: [{
        domainId: "upstream",
        source: "allmeta",
        resolved: true,
        actions: [action({ id: "external-1", name: "requestWork", trigger: [], triggered_event: [], target_objects: [], inputs: [], outputs: [], action_steps: [] })],
      }],
      events: externalEvent("requestWork"),
    });
    expect(drift.blocking.map((issue) => issue.code)).toContain("event_not_declared_by_source_action");
  });

  it("blocks source_domain without source_action", () => {
    const base = ontology();
    const report = analyzeOntologyReadiness({
      ...base,
      events: base.events.map((event) => event.name === "WORK_REQUESTED"
        ? { ...event, payload: { ...event.payload, source_domain: "upstream" } }
        : event),
    });
    expect(report.blocking.map((issue) => issue.code)).toContain("event_source_domain_without_action");
  });

  it("distinguishes event and object_lookup input bindings", () => {
    const base = ontology();
    const report = analyzeOntologyReadiness({
      ...base,
      actions: [action({
        inputs: [
          { name: "work_id", type: "String", required: true, binding_kind: "event", event_field: "work_id", source_object: "Work.work_id" },
          { name: "stored_result", type: "String", required: true, binding_kind: "object_lookup", source_object: "Work.result", lookup_tool: "records.getWork", lookup_args: { work_id: "work_id" }, result_path: "result" },
        ],
      })],
    });
    expect(report.blocking.map((issue) => issue.code)).not.toEqual(expect.arrayContaining([
      "action_required_input_unbound",
      "action_input_object_unknown",
      "action_input_property_unknown",
    ]));
  });

  it("treats source_object as lineage, not an implicit runtime lookup", () => {
    const base = ontology();
    const report = analyzeOntologyReadiness({
      ...base,
      actions: [action({
        inputs: [{ name: "stored_result", type: "String", required: true, source_object: "Work.result" }],
      })],
    });
    expect(report.ready).toBe(false);
    expect(report.blocking.map((issue) => issue.code)).toContain("action_input_binding_kind_missing");
    expect(report.warnings.map((issue) => issue.code)).not.toContain("action_input_binding_inferred");
  });

  it("does not turn a bare Object lineage reference into an executable query", () => {
    const base = ontology();
    const report = analyzeOntologyReadiness({
      ...base,
      actions: [action({
        inputs: [{ name: "work_id", type: "String", required: true, source_object: "Work" }],
      })],
    });
    expect(report.ready).toBe(false);
    expect(report.blocking.map((issue) => issue.code)).toContain("action_input_binding_kind_missing");
  });

  it("fails closed for required legacy inputs whose binding cannot be determined", () => {
    const base = ontology();
    const report = analyzeOntologyReadiness({
      ...base,
      actions: [action({
        inputs: [{ name: "operator_choice", type: "String", required: true }],
      })],
    });
    expect(report.blocking.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "action_input_binding_kind_missing",
      "action_required_input_source_missing",
    ]));
  });

  it("validates non-event binding contracts without forcing them into trigger payloads", () => {
    const base = ontology();
    const report = analyzeOntologyReadiness({
      ...base,
      actions: [action({
        action_steps: [
          { id: "step-1", name: "check", outputs: [{ name: "checked_id", type: "String" }], rules: [{ id: "r1" }] },
        ],
        inputs: [
          { name: "api_key", type: "String", required: true, binding_kind: "secret", binding_ref: "PARTNER_API_KEY" },
          { name: "region", type: "String", required: true, binding_kind: "config", binding_ref: "PARTNER_REGION" },
          { name: "approval", type: "String", required: true, binding_kind: "human_input", description: "请确认是否继续" },
          { name: "checked_id", type: "String", required: true, binding_kind: "step_output", source_step: "step-1", source_output: "checked_id" },
        ],
      })],
    });
    expect(report.blocking.map((issue) => issue.code)).not.toContain("action_required_input_unbound");
  });

  it("blocks incomplete or unsupported explicit binding contracts", () => {
    const base = ontology();
    const report = analyzeOntologyReadiness({
      ...base,
      actions: [action({
        inputs: [
          { name: "missing_secret", type: "String", required: true, binding_kind: "secret" },
          { name: "missing_config", type: "String", required: true, binding_kind: "config" },
          { name: "missing_step", type: "String", required: true, binding_kind: "step_output", source_step: "ghost", source_output: "x" },
          { name: "mystery", type: "String", required: true, binding_kind: "magic" },
        ],
      })],
    });
    expect(report.blocking.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "action_input_binding_ref_missing",
      "action_input_step_unknown",
      "action_input_binding_kind_unknown",
    ]));
  });

  it("reports descriptive integrations and natural-language conditions as resolvable warnings", () => {
    const base = ontology();
    const report = analyzeOntologyReadiness({
      ...base,
      actions: [action({
        action_steps: [{ id: "step-1", name: "check", condition: "收到请求后执行", rules: [{ id: "r1" }] }],
        integration: { systems: [{ name: "Partner PG", kind: "datastore", role: "writes", objects: ["Work"] }] },
      })],
    });
    expect(report.ready).toBe(true);
    expect(report.warnings.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "action_step_condition_requires_compilation",
      "integration_binding_required",
    ]));
  });

  it("allows prose-only Actions into design while requiring a reviewed structured plan later", () => {
    const base = ontology();
    const report = analyzeOntologyReadiness({
      ...base,
      actions: [action({
        instruction: "调用外部系统处理请求，再写入结果。",
        action_steps: [],
        integration: undefined,
        side_effects: undefined,
        tool_use: [],
      })],
    });

    expect(report.ready).toBe(true);
    expect(report.blocking).toEqual([]);
    expect(report.warnings).toContainEqual(expect.objectContaining({
      code: "action_execution_contract_undeclared",
      action: "doWork",
    }));
  });

  it("accepts complete multi-producer topology without choosing a fake singular source", () => {
    const base = ontology();
    const repair = action({
      id: "a2",
      name: "repairWork",
      trigger: ["WORK_REQUESTED"],
      triggered_event: ["WORK_DONE"],
    });
    const report = analyzeOntologyReadiness({
      ...base,
      actions: [base.actions[0]!, repair],
      events: base.events.map((event) => event.name === "WORK_DONE"
        ? { ...event, producers: ["doWork", "repairWork"], consumers: [], payload: { ...event.payload, source_action: null } }
        : { ...event, consumers: ["doWork", "repairWork"] }),
    });
    expect(report.blocking.map((issue) => issue.code)).not.toEqual(expect.arrayContaining([
      "event_producer_unknown",
      "event_producer_missing",
      "event_consumer_missing",
    ]));
  });

  it("blocks producer and consumer topology that drifts from Actions", () => {
    const base = ontology();
    const report = analyzeOntologyReadiness({
      ...base,
      events: base.events.map((event) => event.name === "WORK_DONE"
        ? { ...event, producers: ["ghostProducer"], consumers: ["doWork"] }
        : event),
    });
    expect(report.blocking.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "event_producer_unknown",
      "event_producer_missing",
      "event_not_declared_by_consumer",
    ]));
  });

  it("does not reject a minimal in-memory ontology that has no references", () => {
    const report = analyzeOntologyReadiness({
      domainId: "minimal",
      source: "snapshot",
      objects: [],
      rules: [],
      events: [],
      workflow: [],
      actions: [action({ trigger: [], triggered_event: [], target_objects: [], inputs: [], outputs: [], action_steps: [] })],
    });
    expect(report.ready).toBe(true);
    expect(report.warnings.map((issue) => issue.code)).toContain("workflow_not_declared");
  });
});
