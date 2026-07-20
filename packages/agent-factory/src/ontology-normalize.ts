// #ONTOLOGY-HEAL — deterministic Ontology normalization and read-only revision evaluation.
//
// A semantic ontology pulled from an upstream modeler (Allmeta) is authored for MEANING, not for the
// factory's EXECUTION-binding contract, so analyzeOntologyReadiness marks dozens of "blocking" gaps
// and design_agent used to hard-refuse with no in-loop repair tool — a dead-end for "分析+生成".
//
// This module supplies two pure, LLM-free, unit-testable helpers:
//   1. normalizeOntologySelfConsistency — deterministic fixes that cannot change business topology:
//      primary_key from an existing unambiguous id property, Event input bindings proven by one
//      same-name/alias leaf + compatible type on every declared source trigger, and multi-outcome
//      output destinations proven by emitted Event schemas. Producer/consumer and
//      trigger/emit disagreements are deliberately retained as blockers: choosing either side, or
//      taking their union, changes executable behaviour and therefore requires an explicit revision or
//      human decision. No business inference, no invented entities. Runs inside read_ontology.
//   2. applyOntologyRevision — applies BRAIN-supplied patches to an isolated clone so
//      `revise_ontology` can validate a proposal and calculate its readiness delta. The candidate is
//      never installed as the runtime working copy; only an authoritative re-read may reopen a gate.
//
// Neither helper writes the Ontology source. Automatic normalization is limited to facts already
// unique inside the same entity; proposed business/execution corrections remain inert until the
// authoritative source is updated through AllmetaOntology and re-read.

import { inputBindingTypesCompatible } from "./input-bindings";
import type { DomainOntology, OntologyAction, OntologyEvent, OntologyObject } from "./ontology-types";
import type { OntologyReadinessIssue } from "./ontology-readiness";

const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const refKey = (v: string): string => (v ?? "").normalize("NFKC").toLocaleLowerCase().replace(/[\s_-]+/g, "");
const leafField = (v: string): string => v.split(".").filter(Boolean).at(-1) ?? v;
const includesRef = (list: string[] | undefined, name: string): boolean =>
  (list ?? []).some((x) => refKey(x) === refKey(name));

export interface OntologyHealChange {
  code: string;
  detail: string;
}

export interface OntologyNormalizeResult {
  ontology: DomainOntology;
  changes: OntologyHealChange[];
}

/**
 * Deterministic SELF-CONSISTENCY normalization. Fixes only gaps whose answer is already unique inside
 * the same entity; makes NO business decision and invents NO entity. Returns a deep clone.
 *
 * In particular this function never reconciles Action.trigger/triggered_event with
 * Event.consumers/producers.  Those lists are two competing business assertions when they disagree.
 * Automatically copying either side (or taking their union) previously introduced duplicate/manual-
 * approval bypass paths while presenting them as harmless "self-heal" changes.
 */
export function normalizeOntologySelfConsistency(input: DomainOntology): OntologyNormalizeResult {
  const ontology: DomainOntology = structuredClone(input);
  const changes: OntologyHealChange[] = [];

  // primary_key default — only when the object has an unambiguous id-like property already.
  for (const object of ontology.objects ?? []) {
    if (text(object.primary_key)) continue;
    const idProp = pickIdProperty(object);
    if (idProp) {
      object.primary_key = idProp;
      changes.push({ code: "object_primary_key_missing", detail: `DataObject ${object.id}.primary_key = ${idProp}（已有该属性）` });
    }
  }

  // Event input binding — only when the answer is already present and
  // unambiguous in every trigger Event. This is schema normalization, not a
  // business inference: the Action input and Event field must have the same
  // canonical name, one matching field per Event, a common path, and compatible
  // types. Any source/query/config/human intent keeps the input untouched.
  for (const action of ontology.actions ?? []) {
    const allTriggerEvents = (action.trigger ?? [])
      .map((eventName) => ontology.events.find((event) => refKey(event.name) === refKey(eventName)))
      .filter((event): event is OntologyEvent => !!event);
    if (!allTriggerEvents.length || allTriggerEvents.length !== (action.trigger ?? []).length) continue;

    for (const inputRow of action.inputs ?? []) {
      const field = text(inputRow.name);
      const inputType = text(inputRow.type);
      if (!field || !inputType || hasExplicitBindingIntent(inputRow)) continue;

      const sourceEventRefs = stringRefs(inputRow.source_event ?? inputRow.sourceEvent);
      const triggerEvents = sourceEventRefs.length
        ? sourceEventRefs
          .map((eventName) => allTriggerEvents.find((event) => refKey(event.name) === refKey(eventName)))
          .filter((event): event is OntologyEvent => !!event)
        : allTriggerEvents;
      if (!triggerEvents.length || triggerEvents.length !== sourceEventRefs.length && sourceEventRefs.length > 0) continue;

      const matches = triggerEvents.map((event) =>
        (event.payload?.event_data ?? []).filter((eventField) => {
          const eventName = text(eventField.name);
          const eventType = text(eventField.type);
          return !!eventName
            && (refKey(eventName) === refKey(field) || refKey(leafField(eventName)) === refKey(field))
            && !!eventType
            && inputBindingTypesCompatible(eventType, inputType);
        }),
      );
      if (matches.some((eventMatches) => eventMatches.length !== 1)) continue;
      const paths = matches.map((eventMatches) => text(eventMatches[0]?.name));
      if (!paths[0] || paths.some((path) => refKey(path) !== refKey(paths[0]!))) continue;

      inputRow.binding_kind = "event";
      inputRow.event_path = paths[0];
      changes.push({
        code: "action_input_event_binding_normalized",
        detail: `Action ${action.name}.${field} = event:${paths[0]}（所有 trigger Event 均有唯一同名、类型兼容字段）`,
      });
    }
  }

  for (const action of ontology.actions ?? []) {
    // Multi-outcome output routing — only when the emitted Event schemas make
    // the destination set mechanically provable. A matching Event must contain
    // exactly one same-name/alias-leaf, type-compatible field. We map to every
    // emitted Event that proves that contract and leave unmatched/ambiguous
    // outputs untouched for ask_user. This never adds or removes an Event edge.
    const emittedEvents = (action.triggered_event ?? [])
      .map((eventName) => ontology.events.find((event) => refKey(event.name) === refKey(eventName)))
      .filter((event): event is OntologyEvent => !!event);
    if (emittedEvents.length > 1 && emittedEvents.length === (action.triggered_event ?? []).length) {
      for (const outputRow of action.outputs ?? []) {
        const output = outputRow as Record<string, unknown>;
        const field = text(output.name);
        const outputType = text(output.type);
        if (!field || !outputType || hasExplicitOutputDelivery(output)) continue;

        let ambiguous = false;
        const destinations: string[] = [];
        for (const event of emittedEvents) {
          const matches = (event.payload?.event_data ?? []).filter((eventField) => {
            const eventName = text(eventField.name);
            const eventType = text(eventField.type);
            const eventAliases = stringRefs((eventField as Record<string, unknown>).aliases);
            const names = [eventName, leafField(eventName), ...eventAliases, ...eventAliases.map(leafField)];
            return names.some((name) => name && refKey(name) === refKey(field))
              && !!eventType
              && inputBindingTypesCompatible(eventType, outputType);
          });
          if (matches.length > 1) {
            ambiguous = true;
            break;
          }
          if (matches.length === 1) destinations.push(event.name);
        }
        if (ambiguous || !destinations.length) continue;

        output.emitted_on = destinations;
        changes.push({
          code: "action_output_event_mapping_normalized",
          detail: `Action ${action.name}.${field} → ${destinations.join(", ")}（Event schema 有唯一同名、类型兼容字段）`,
        });
      }
    }
  }

  return { ontology, changes };
}

function stringRefs(value: unknown): string[] {
  const values = Array.isArray(value) ? value : value == null || value === "" ? [] : [value];
  return values.map(text).filter(Boolean);
}

function hasExplicitBindingIntent(input: Record<string, unknown>): boolean {
  return [
    "binding_kind", "bindingKind",
    "event_path", "eventPath", "event_field", "eventField",
    "source_field", "sourceField",
    "lookup_args", "lookupArgs", "arguments", "result_path", "resultPath",
    "lookup_tool", "lookupTool", "binding_tool", "bindingTool", "tool_name", "toolName",
    "integration_ref", "integrationRef", "binding_ref", "bindingRef",
    "secret_ref", "secretRef", "config_ref", "configRef",
    "prompt", "source_step", "sourceStep", "source_output", "sourceOutput",
  ].some((key) => input[key] !== undefined && input[key] !== null && input[key] !== "");
}

function hasExplicitOutputDelivery(output: Record<string, unknown>): boolean {
  return ["emitted_on", "emittedOn", "events", "delivery"].some(
    (key) => output[key] !== undefined && output[key] !== null && output[key] !== "",
  );
}

/**
 * The subset of blocking readiness issues that actually affect ONE action's slice — its own name, or an
 * object/event it touches (target_objects, input source_objects, trigger/emitted events). Scope is
 * intentionally hierarchical: an event-scoped issue follows that event (and its explicitly named
 * action), while an action-scoped issue follows that action.  A secondary `object` field on either kind
 * is diagnostic context, not an independent reason to contaminate every other action that happens to
 * touch the same shared object.  Only an object-only issue is matched by object. An issue with no
 * action/object/event scoping is a GLOBAL structural blocker and affects every action. Powers
 * design_agent's per-action slicing: an action whose slice is clean generates even while the whole
 * ontology is not yet fully ready.
 */
export function blockingIssuesForAction(blocking: OntologyReadinessIssue[], action: OntologyAction): OntologyReadinessIssue[] {
  const nameKey = refKey(action.name);
  const objs = new Set((action.target_objects ?? []).map(refKey));
  for (const input of action.inputs ?? []) {
    const so = text((input as Record<string, unknown>).source_object ?? (input as Record<string, unknown>).sourceObject);
    if (so) objs.add(refKey(so.split(".")[0] ?? so));
  }
  const evs = new Set([...(action.trigger ?? []), ...(action.triggered_event ?? [])].map(refKey));
  return blocking.filter((issue) => {
    const scoped = issue.action || issue.object || issue.event;
    if (!scoped) return true; // global structural blocker → blocks everyone
    // Event issues can name a producer/consumer/source action different from the
    // current consumer.  The event edge still belongs in every action slice that
    // actually triggers on or emits that event.  Do not additionally fan it out
    // through a shared target object.
    if (issue.event) {
      return evs.has(refKey(issue.event))
        || Boolean(issue.action && refKey(issue.action) === nameKey);
    }
    // Likewise, a side-effect issue commonly carries both action and object.
    // Its explicit action is authoritative; matching the object as well made one
    // action's bad side effect block an otherwise unrelated action.
    if (issue.action) return refKey(issue.action) === nameKey;
    return Boolean(issue.object && objs.has(refKey(issue.object)));
  });
}

function pickIdProperty(object: OntologyObject): string | undefined {
  const props = object.properties ?? [];
  const exact = props.find((p) => refKey(p.name) === "id");
  if (exact) return exact.name;
  const scoped = props.find((p) => refKey(p.name) === refKey(`${object.id}id`) || refKey(p.name) === refKey(`${object.id}_id`));
  if (scoped) return scoped.name;
  const suffixed = props.find((p) => /(^|[_\s-])id$/i.test(p.name));
  return suffixed?.name;
}

// ── brain-supplied revision proposal (revise_ontology) ────────────────────────────────────────────

/** Whitelisted keys the brain may merge onto an Action input — every field analyzeOntologyReadiness
 *  inspects for a binding. Anything else in `set` is ignored (never blindly merged). */
const INPUT_MERGE_KEYS = new Set([
  "binding_kind", "source_object", "event_field", "event_path", "lookup_args", "result_path",
  "lookup_tool", "integration_ref", "binding_ref", "secret_ref", "config_ref",
  "prompt", "source_step", "source_output", "type", "required",
]);

export interface OntologyRevisionPatch {
  /** Merge binding fields onto an Action input (the biggest source of blocking gaps). */
  inputs?: Array<{ action: string; field: string; set: Record<string, unknown> }>;
  /** Set an Action output's type (action_output_schema_incomplete). */
  outputs?: Array<{ action: string; field: string; type: string }>;
  /** Fix an object: default a primary_key and/or add real properties. */
  objects?: Array<{ object: string; primary_key?: string; add_properties?: Array<{ name: string; type?: string }> }>;
  /** Extend an emitted Event so an action output can bind to it (action_output_unbound), plus topology. */
  events?: Array<{ event: string; add_fields?: Array<{ name: string; type: string; target_object?: string | null; required?: boolean }>; add_producers?: string[]; add_consumers?: string[] }>;
}

export interface OntologyRevisionResult {
  ontology: DomainOntology;
  applied: OntologyHealChange[];
  rejected: Array<{ target: string; reason: string }>;
}

/**
 * Apply brain-supplied patches to a CLONE of the ontology. Every reference is validated against real
 * entities first; an unresolved reference is rejected (never invented). The caller re-runs
 * analyzeOntologyReadiness on the result so a bad value (e.g. an unsafe lookup path) still surfaces as
 * a residual blocking issue rather than being silently trusted.
 */
export function applyOntologyRevision(input: DomainOntology, patch: OntologyRevisionPatch): OntologyRevisionResult {
  const ontology: DomainOntology = structuredClone(input);
  const applied: OntologyHealChange[] = [];
  const rejected: Array<{ target: string; reason: string }> = [];
  const actions = ontology.actions ?? [];
  const objects = ontology.objects ?? [];
  const events = ontology.events ?? [];
  const findAction = (ref: string) => actions.find((a) => refKey(a.name) === refKey(ref) || refKey(a.id) === refKey(ref));
  const findObject = (ref: string) => objects.find((o) => refKey(o.id) === refKey(ref) || refKey(o.name) === refKey(ref));
  const findEvent = (ref: string) => events.find((e) => refKey(e.name) === refKey(ref));

  for (const p of patch.inputs ?? []) {
    const label = `input ${p.action}.${p.field}`;
    const action = findAction(p.action);
    if (!action) { rejected.push({ target: label, reason: `Action ${p.action} 不存在` }); continue; }
    const inputs = (action.inputs ??= []);
    const input = inputs.find((i) => refKey(text(i.name)) === refKey(p.field));
    if (!input) { rejected.push({ target: label, reason: `Action ${p.action} 没有 input ${p.field}` }); continue; }
    const setKeys = Object.keys(p.set ?? {}).filter((k) => INPUT_MERGE_KEYS.has(k));
    if (!setKeys.length) { rejected.push({ target: label, reason: "set 里没有可合并的绑定字段" }); continue; }
    for (const k of setKeys) input[k] = p.set[k];
    applied.push({ code: "input_binding_revised", detail: `${label} ← {${setKeys.join(", ")}}` });
  }

  for (const p of patch.outputs ?? []) {
    const label = `output ${p.action}.${p.field}`;
    const action = findAction(p.action);
    if (!action) { rejected.push({ target: label, reason: `Action ${p.action} 不存在` }); continue; }
    const output = (action.outputs ??= []).find((o) => refKey(text(o.name)) === refKey(p.field));
    if (!output) { rejected.push({ target: label, reason: `Action ${p.action} 没有 output ${p.field}` }); continue; }
    if (!text(p.type)) { rejected.push({ target: label, reason: "type 不能为空" }); continue; }
    output.type = p.type;
    applied.push({ code: "output_schema_revised", detail: `${label}.type = ${p.type}` });
  }

  for (const p of patch.objects ?? []) {
    const label = `object ${p.object}`;
    const object = findObject(p.object);
    if (!object) { rejected.push({ target: label, reason: `DataObject ${p.object} 不存在` }); continue; }
    if (text(p.primary_key)) {
      const props = object.properties ?? [];
      if (!props.some((pr) => refKey(pr.name) === refKey(p.primary_key!))) {
        rejected.push({ target: label, reason: `primary_key ${p.primary_key} 不在 ${object.id} 的 properties 中` });
      } else {
        object.primary_key = p.primary_key;
        applied.push({ code: "object_primary_key_revised", detail: `${label}.primary_key = ${p.primary_key}` });
      }
    }
    for (const prop of p.add_properties ?? []) {
      if (!text(prop.name)) { rejected.push({ target: label, reason: "add_properties 里有属性缺 name" }); continue; }
      const props = (object.properties ??= []);
      const existing = props.find((pr) => refKey(pr.name) === refKey(prop.name));
      if (existing) { existing.type = prop.type ?? existing.type; }
      else props.push({ name: prop.name, type: prop.type });
      applied.push({ code: "object_property_added", detail: `${label} += ${prop.name}:${prop.type ?? "?"}` });
    }
  }

  for (const p of patch.events ?? []) {
    const label = `event ${p.event}`;
    const event = findEvent(p.event);
    if (!event) { rejected.push({ target: label, reason: `Event ${p.event} 不存在` }); continue; }
    for (const f of p.add_fields ?? []) {
      if (!text(f.name) || !text(f.type)) { rejected.push({ target: label, reason: "add_fields 里有字段缺 name/type" }); continue; }
      const fields = (event.payload.event_data ??= []);
      const existing = fields.find((x) => refKey(x.name) === refKey(f.name));
      if (existing) { existing.type = f.type; }
      else fields.push({ name: f.name, type: f.type, target_object: f.target_object ?? null, required: f.required });
      applied.push({ code: "event_field_added", detail: `${label}.event_data += ${f.name}:${f.type}` });
    }
    for (const producer of p.add_producers ?? []) {
      if (!findAction(producer)) { rejected.push({ target: label, reason: `producer ${producer} 不是已知 Action` }); continue; }
      if (!includesRef(event.producers, producer)) { (event.producers ??= []).push(producer); applied.push({ code: "event_producer_added", detail: `${label}.producers += ${producer}` }); }
    }
    for (const consumer of p.add_consumers ?? []) {
      if (!findAction(consumer)) { rejected.push({ target: label, reason: `consumer ${consumer} 不是已知 Action` }); continue; }
      if (!includesRef(event.consumers, consumer)) { (event.consumers ??= []).push(consumer); applied.push({ code: "event_consumer_added", detail: `${label}.consumers += ${consumer}` }); }
    }
  }

  return { ontology, applied, rejected };
}
