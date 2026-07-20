import type {
  DomainOntology,
  OntologyAction,
  OntologyEvent,
  OntologyLink,
  OntologyObject,
} from "./ontology-types";
import { inputBindingTypesCompatible } from "./input-bindings";

export type OntologyReadinessSeverity = "blocking" | "warning";

export interface OntologyReadinessIssue {
  severity: OntologyReadinessSeverity;
  /** Stable machine-readable code. Do not key UI or policy on the prose message. */
  code: string;
  message: string;
  domain?: string;
  action?: string;
  event?: string;
  object?: string;
  step?: string;
  rule?: string;
  link?: string;
  field?: string;
}

export interface OntologyReadinessReport {
  ready: boolean;
  blocking: OntologyReadinessIssue[];
  warnings: OntologyReadinessIssue[];
  issues: OntologyReadinessIssue[];
  counts: {
    objects: number;
    events: number;
    actions: number;
    actionSteps: number;
    rules: number;
    blocking: number;
    warnings: number;
  };
}

type Row = Record<string, unknown>;

const rows = (value: unknown): Row[] =>
  Array.isArray(value)
    ? value.filter((item): item is Row => !!item && typeof item === "object" && !Array.isArray(item))
    : [];

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

/** Reference matching is deliberately tolerant of display spelling, but never
 * invents an entity. It accepts case/space/dash/underscore differences only. */
const refKey = (value: string): string =>
  value.normalize("NFKC").toLocaleLowerCase().replace(/[\s_-]+/g, "");

const baseObjectRef = (value: unknown): string => text(value).split(".", 1)[0] ?? "";
const propertyRef = (value: unknown): string => {
  const raw = text(value);
  const dot = raw.indexOf(".");
  return dot >= 0 ? raw.slice(dot + 1) : "";
};
const leafField = (value: string): string => value.split(".").filter(Boolean).at(-1) ?? value;

const INPUT_BINDING_KINDS = new Set([
  "event",
  "object_lookup",
  "secret",
  "config",
  "human_input",
  "step_output",
]);
const SAFE_INPUT_PATH = /^[A-Za-z_$][A-Za-z0-9_$-]*(?:(?:\??\.)[A-Za-z_$][A-Za-z0-9_$-]*|\[['"][^'"\]]+['"]\])*$/;

function aliases(values: Array<string | undefined>): Set<string> {
  return new Set(values.map((value) => text(value)).filter(Boolean).map(refKey));
}

function hasAlias(set: Set<string>, value: unknown): boolean {
  const key = refKey(text(value));
  return !!key && set.has(key);
}

function duplicateValues(values: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values.filter(Boolean)) {
    // Identity uniqueness is stricter than reference lookup. `1-2` and `12`
    // are distinct action ids; removing separators here produced a false
    // duplicate that made valid RAAS ontologies impossible to promote.
    const key = value.normalize("NFKC").toLocaleLowerCase().trim();
    if (seen.has(key)) duplicates.add(value);
    seen.add(key);
  }
  return [...duplicates];
}

function objectForRef(objects: OntologyObject[], value: unknown): OntologyObject | undefined {
  const raw = baseObjectRef(value);
  const parenthesized = raw.match(/\(([^()]+)\)\s*$/u)?.[1]?.trim();
  const candidates = aliases([raw, parenthesized]);
  return candidates.size
    ? objects.find((object) => [...candidates].some((key) => aliases([object.id, object.name]).has(key)))
    : undefined;
}

function objectProperties(object: OntologyObject | undefined): Set<string> {
  return aliases((object?.properties ?? []).map((property) => property.name));
}

function ruleId(rule: Row): string {
  return text(rule.id ?? rule.rule_id ?? rule.ruleId ?? rule.uid);
}

function linkEndpointType(value: unknown): string {
  const normalized = refKey(text(value));
  if (["object", "dataobject", "allmetaobject", "ontologyobject"].includes(normalized)) return "object";
  if (normalized === "action") return "action";
  if (normalized === "event") return "event";
  if (normalized === "rule") return "rule";
  if (["actionstep", "step"].includes(normalized)) return "actionstep";
  if (["policyscope", "scope"].includes(normalized)) return "policyscope";
  if (normalized === "workflow") return "workflow";
  return normalized;
}

function linkEndpoint(link: OntologyLink, side: "from" | "to"): { type: string; id: string } {
  const endpoint = link[side] && typeof link[side] === "object" && !Array.isArray(link[side])
    ? link[side] as Row
    : {};
  return { type: linkEndpointType(endpoint.type), id: text(endpoint.id) };
}

function linkIsApproved(link: OntologyLink): boolean {
  return refKey(text(link.status)) === "approved";
}

interface StepIdentity {
  action: OntologyAction;
  row: Row;
  id: string;
  name: string;
}

function ontologyStepIdentities(actions: OntologyAction[]): StepIdentity[] {
  return actions.flatMap((action) => rows(action.action_steps).map((row, index) => {
    const name = text(row.name);
    const explicit = text(row.id ?? row.step_id ?? row.stepId);
    return {
      action,
      row,
      name,
      id: explicit || (name ? `${action.id}::${name}` : `${action.id}::#${index + 1}`),
    };
  }));
}

function findRule(rules: Row[], value: unknown): Row | undefined {
  const key = refKey(text(value));
  return key ? rules.find((rule) => refKey(ruleId(rule)) === key) : undefined;
}

function approvedLinkMatch(
  links: OntologyLink[],
  requirement: {
    kind: string;
    fromType: string;
    fromIds: string[];
    toType: string;
    toIds?: string[];
  },
): { any: boolean; approved: boolean } {
  const fromIds = aliases(requirement.fromIds);
  const toIds = requirement.toIds ? aliases(requirement.toIds) : undefined;
  let any = false;
  let approved = false;
  for (const link of links) {
    const from = linkEndpoint(link, "from");
    const to = linkEndpoint(link, "to");
    if (
      refKey(text(link.kind)) !== refKey(requirement.kind)
      || from.type !== requirement.fromType
      || to.type !== requirement.toType
      || !hasAlias(fromIds, from.id)
      || (toIds && !hasAlias(toIds, to.id))
    ) continue;
    any = true;
    if (linkIsApproved(link)) approved = true;
  }
  return { any, approved };
}

function requireApprovedLink(
  links: OntologyLink[],
  issues: OntologyReadinessIssue[],
  requirement: Parameters<typeof approvedLinkMatch>[1],
  missingCode: string,
  message: string,
  context: Omit<OntologyReadinessIssue, "severity" | "code" | "message">,
): void {
  const match = approvedLinkMatch(links, requirement);
  if (match.approved) return;
  if (match.any) {
    add(
      issues,
      "blocking",
      "required_link_not_approved",
      `${message}；关系已存在但 status 不是 approved，不能作为运行证据`,
      context,
    );
    return;
  }
  add(issues, "blocking", missingCode, message, context);
}

/** Links are opt-in for backwards compatibility. Once a domain supplies a
 * links collection, however, it becomes executable evidence: required edges
 * must be approved and every approved endpoint must resolve in the same slice. */
function checkOntologyLinks(ontology: DomainOntology, issues: OntologyReadinessIssue[]): void {
  if (ontology.links === undefined) return;
  const links = ontology.links;
  const { actions, events, objects } = ontology;
  const rules = ontology.rules as Row[];
  const steps = ontologyStepIdentities(actions);

  for (const duplicate of duplicateValues(links.map((link) => text(link.id)))) {
    add(issues, "blocking", "duplicate_link_id", `Link id 重复：${duplicate}`, { link: duplicate });
  }
  for (const duplicate of duplicateValues(steps.map((step) => step.id))) {
    add(issues, "blocking", "duplicate_action_step_id", `ActionStep id 重复：${duplicate}`, { step: duplicate });
  }

  const workflowRefs = aliases(rows(ontology.workflow).flatMap((item) => [text(item.id), text(item.name)]));
  for (const link of links) {
    const linkId = text(link.id) || "<unnamed>";
    if (!text(link.id) || !text(link.kind)) {
      add(issues, "blocking", "link_identity_missing", `Link ${linkId} 缺少 id/kind`, { link: linkId });
      continue;
    }
    const endpoints = [["from", linkEndpoint(link, "from")], ["to", linkEndpoint(link, "to")]] as const;
    for (const [side, endpoint] of endpoints) {
      if (!endpoint.type || !endpoint.id) {
        add(issues, "blocking", "link_endpoint_incomplete", `Link ${linkId}.${side} 缺少 type/id`, { link: linkId });
        continue;
      }
      // Draft/rejected relationships are review artifacts, not executable
      // claims. Their endpoint drift must not block an unrelated Action slice;
      // required-edge checks below still reject them as non-approved evidence.
      if (!linkIsApproved(link)) continue;
      let exists = false;
      if (endpoint.type === "object") exists = !!objectForRef(objects, endpoint.id);
      else if (endpoint.type === "action") exists = actions.some((action) => hasAlias(actionAliases(action), endpoint.id));
      else if (endpoint.type === "event") exists = events.some((event) => refKey(event.name) === refKey(endpoint.id));
      else if (endpoint.type === "rule") exists = !!findRule(rules, endpoint.id);
      else if (endpoint.type === "actionstep") exists = steps.some((step) => refKey(step.id) === refKey(endpoint.id));
      else if (endpoint.type === "workflow") exists = hasAlias(workflowRefs, endpoint.id);
      else if (endpoint.type === "policyscope") {
        const descriptor = link.policyScope ?? link.policy_scope;
        const hasEmbeddedDescriptor = !!descriptor && typeof descriptor === "object" && !Array.isArray(descriptor);
        // A central Allmeta row was produced by matching both graph endpoints;
        // uploaded snapshots need to carry the PolicyScope descriptor because
        // they have no independent scope catalog for us to resolve against.
        exists = (ontology.source === "allmeta" && link.allmetaLink === true) || hasEmbeddedDescriptor;
      }
      else {
        add(issues, "blocking", "link_endpoint_type_unknown", `Link ${linkId}.${side} 的 endpoint type ${endpoint.type} 不受支持`, { link: linkId });
        continue;
      }
      if (!exists) {
        add(issues, "blocking", "link_endpoint_unknown", `Link ${linkId}.${side} 引用了不存在的 ${endpoint.type} ${endpoint.id}`, { link: linkId, field: side });
      }
    }
  }

  for (const object of objects) {
    for (const property of object.properties ?? []) {
      if (property.is_foreign_key !== true) continue;
      const referenced = objectForRef(objects, property.references);
      if (!referenced) {
        add(issues, "blocking", "object_foreign_key_object_unknown", `DataObject ${object.id}.${property.name} 的 references ${text(property.references) || "<missing>"} 无法解析`, { object: object.id, field: property.name });
        continue;
      }
      requireApprovedLink(links, issues, {
        kind: "object-fk", fromType: "object", fromIds: [object.id, object.name], toType: "object", toIds: [referenced.id, referenced.name],
      }, "object_fk_link_missing", `DataObject ${object.id}.${property.name} 缺少 approved object-fk → ${referenced.id}`, { object: object.id, field: property.name });
    }
  }

  for (const action of actions) {
    for (const eventName of action.trigger ?? []) {
      requireApprovedLink(links, issues, {
        kind: "action-trigger", fromType: "event", fromIds: [eventName], toType: "action", toIds: [action.id, action.name],
      }, "action_trigger_link_missing", `Event ${eventName} → Action ${action.name} 缺少 approved action-trigger link`, { action: action.name, event: eventName });
    }
    for (const eventName of action.triggered_event ?? []) {
      requireApprovedLink(links, issues, {
        kind: "action-emission", fromType: "action", fromIds: [action.id, action.name], toType: "event", toIds: [eventName],
      }, "action_emission_link_missing", `Action ${action.name} → Event ${eventName} 缺少 approved action-emission link`, { action: action.name, event: eventName });
    }
  }

  for (const step of steps) {
    requireApprovedLink(links, issues, {
      kind: "action-includes-step", fromType: "action", fromIds: [step.action.id, step.action.name], toType: "actionstep", toIds: [step.id],
    }, "action_step_link_missing", `Action ${step.action.name} → ActionStep ${step.id} 缺少 approved action-includes-step link`, { action: step.action.name, step: step.id });

    for (const ruleRef of rows(step.row.rules)) {
      const id = ruleId(ruleRef);
      const rule = findRule(rules, id);
      if (!id || !rule) continue; // the canonical rule-reference gate reports this separately
      requireApprovedLink(links, issues, {
        kind: "rule-governs", fromType: "rule", fromIds: [id], toType: "actionstep", toIds: [step.id],
      }, "rule_step_link_missing", `Rule ${id} → ActionStep ${step.id} 缺少 approved rule-governs link`, { action: step.action.name, step: step.id, rule: id });

      const relatedRefs = stringRefs(rule.relatedEntities ?? rule.related_entities);
      const relatedObjects = relatedRefs
        .map((ref) => ({ ref, object: objectForRef(objects, ref) }))
        .filter((entry): entry is { ref: string; object: OntologyObject } => !!entry.object);
      for (const related of relatedRefs) {
        if (!objectForRef(objects, related)) {
          add(issues, "blocking", "rule_related_object_unknown", `Rule ${id}.relatedEntities 的 ${related} 不是已知 DataObject`, { action: step.action.name, step: step.id, rule: id, object: baseObjectRef(related) });
        }
      }
      for (const { object } of relatedObjects) {
        requireApprovedLink(links, issues, {
          kind: "rule-references-object", fromType: "rule", fromIds: [id], toType: "object", toIds: [object.id, object.name],
        }, "rule_object_link_missing", `Rule ${id} → DataObject ${object.id} 缺少 approved rule-references-object/APPLIES_TO link`, { action: step.action.name, step: step.id, rule: id, object: object.id });
      }

      if (refKey(text(rule.enforcementLevel ?? rule.enforcement_level)) === "mandatory") {
        if (!relatedObjects.length) {
          add(issues, "blocking", "mandatory_rule_object_scope_missing", `Action ${step.action.name} 使用的 mandatory Rule ${id} 没有可解析的 relatedEntities，Rule/Object 闭环不完整`, { action: step.action.name, step: step.id, rule: id });
        }
        requireApprovedLink(links, issues, {
          kind: "rule-scoped-to", fromType: "rule", fromIds: [id], toType: "policyscope",
        }, "mandatory_rule_policy_scope_link_missing", `Action ${step.action.name} 使用的 mandatory Rule ${id} 缺少 approved SCOPED_TO PolicyScope link`, { action: step.action.name, step: step.id, rule: id });
      }
    }
  }

  for (const event of events) {
    const carried = new Map<string, OntologyObject>();
    for (const field of event.payload?.event_data ?? []) {
      const object = field.target_object ? objectForRef(objects, field.target_object) : undefined;
      if (object) carried.set(refKey(object.id), object);
    }
    for (const object of carried.values()) {
      requireApprovedLink(links, issues, {
        kind: "event-carries-object", fromType: "event", fromIds: [event.name], toType: "object", toIds: [object.id, object.name],
      }, "event_object_link_missing", `Event ${event.name} → DataObject ${object.id} 缺少 approved event-carries-object link`, { event: event.name, object: object.id });
    }
    const mutated = new Map<string, OntologyObject>();
    for (const mutation of event.payload?.state_mutations ?? []) {
      const object = objectForRef(objects, mutation.target_object);
      if (object) mutated.set(refKey(object.id), object);
    }
    for (const object of mutated.values()) {
      requireApprovedLink(links, issues, {
        kind: "event-mutates-object", fromType: "event", fromIds: [event.name], toType: "object", toIds: [object.id, object.name],
      }, "event_mutation_link_missing", `Event ${event.name} → DataObject ${object.id} 缺少 approved event-mutates-object link`, { event: event.name, object: object.id });
    }
  }
}

function actionAliases(action: OntologyAction): Set<string> {
  return aliases([action.id, action.name]);
}

/**
 * An inbound event may name the human/platform operation that produced it even
 * when that operation is intentionally outside this domain's Action catalog.
 * That is only a verified external boundary when a real consumer Action also
 * declares the same event under `integration.event_sources`.  Descriptions or
 * an unknown `source_action` alone are not enough evidence and remain blocking.
 */
function declaredExternalEventSources(
  actions: OntologyAction[],
  eventName: string,
): Array<{ consumer: string; source: string }> {
  const eventKey = refKey(eventName);
  const declared: Array<{ consumer: string; source: string }> = [];
  for (const action of actions) {
    if (!(action.trigger ?? []).some((name) => refKey(name) === eventKey)) continue;
    const raw = action.integration?.event_sources;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
      if (refKey(name) !== eventKey) continue;
      const source = text(value);
      if (source) declared.push({ consumer: action.name, source });
    }
  }
  return declared;
}

function uniqueRefs(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const ref = text(value);
    const key = refKey(ref);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

function eventFields(event: OntologyEvent | undefined): Set<string> {
  const out = new Set<string>();
  for (const field of event?.payload?.event_data ?? []) {
    const full = text(field.name);
    if (!full) continue;
    out.add(refKey(full));
    out.add(refKey(leafField(full)));
    const fieldAliases = (field as Row).aliases;
    if (Array.isArray(fieldAliases)) {
      for (const alias of fieldAliases) {
        const value = text(alias);
        if (!value) continue;
        out.add(refKey(value));
        out.add(refKey(leafField(value)));
      }
    }
  }
  return out;
}

function stringRefs(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : value == null || value === "" ? [] : [value];
  return raw.map(text).filter(Boolean);
}

function matchingEventFieldRows(event: OntologyEvent, candidates: Set<string>): OntologyEvent["payload"]["event_data"] {
  return (event.payload?.event_data ?? []).filter((field) => {
    const names = [text(field.name), leafField(text(field.name)), ...stringRefs((field as Row).aliases)];
    return names.some((name) => name && candidates.has(refKey(name)));
  });
}

function add(
  issues: OntologyReadinessIssue[],
  severity: OntologyReadinessSeverity,
  code: string,
  message: string,
  context: Omit<OntologyReadinessIssue, "severity" | "code" | "message"> = {},
): void {
  issues.push({ severity, code, message, ...context });
}

function checkObjectSchema(objects: OntologyObject[], issues: OntologyReadinessIssue[]): void {
  for (const object of objects) {
    const label = object.id || object.name || "<unnamed>";
    if (!object.id || !object.name) {
      add(issues, "blocking", "object_identity_missing", `DataObject ${label} 缺少 id 或 name`, { object: label });
    }
    if (!text(object.primary_key)) {
      add(issues, "blocking", "object_primary_key_missing", `DataObject ${label} 未声明 primary_key`, { object: label });
    }
    const properties = object.properties ?? [];
    const propertyNames = aliases(properties.map((property) => property.name));
    if (object.primary_key && !hasAlias(propertyNames, object.primary_key)) {
      add(issues, "blocking", "object_primary_key_unknown", `DataObject ${label} 的 primary_key ${object.primary_key} 不在 properties 中`, { object: label, field: object.primary_key });
    }
    const malformed = properties.filter((property) => !text(property.name) || !text(property.type));
    if (malformed.length) {
      add(issues, "blocking", "object_property_schema_incomplete", `DataObject ${label} 有 ${malformed.length} 个 property 缺少 name/type`, { object: label });
    }
    const unconstrained = properties.filter((property) => {
      const row = property as Row;
      return row.required === undefined && row.nullable === undefined;
    });
    if (properties.length && unconstrained.length === properties.length) {
      add(issues, "warning", "object_requiredness_unspecified", `DataObject ${label} 的 properties 均未声明 required/nullable`, { object: label });
    }
  }
}

function checkObjectAndProperties(
  objects: OntologyObject[],
  issues: OntologyReadinessIssue[],
  objectRef: unknown,
  propertyRefs: unknown,
  context: Omit<OntologyReadinessIssue, "severity" | "code" | "message">,
  codePrefix: string,
): void {
  const rawObject = baseObjectRef(objectRef);
  if (!rawObject) {
    add(issues, "blocking", `${codePrefix}_object_missing`, "声明缺少 target object", context);
    return;
  }
  const object = objectForRef(objects, rawObject);
  if (!object) {
    add(issues, "blocking", `${codePrefix}_object_unknown`, `引用了不存在的 DataObject ${rawObject}`, { ...context, object: rawObject });
    return;
  }
  const knownProperties = objectProperties(object);
  const requested = Array.isArray(propertyRefs) ? propertyRefs : [];
  for (const property of requested) {
    const field = text(property);
    if (field && !hasAlias(knownProperties, field)) {
      add(issues, "blocking", `${codePrefix}_property_unknown`, `DataObject ${object.id} 不存在 property ${field}`, { ...context, object: object.id, field });
    }
  }
}

/** Generic, domain-independent referential and execution-contract gate. It does
 * not guess missing mappings or silently repair the ontology: a generated agent
 * may only progress once every referenced event/object/rule/property is real. */
export function analyzeOntologyReadiness(ontology: DomainOntology): OntologyReadinessReport {
  const issues: OntologyReadinessIssue[] = [];
  const { actions, events, objects, rules } = ontology;
  const eventNames = aliases(events.map((event) => event.name));
  const ruleIds = aliases(rules.map(ruleId));

  for (const duplicate of duplicateValues(actions.map((action) => action.id))) {
    add(issues, "blocking", "duplicate_action_id", `Action id 重复：${duplicate}`, { action: duplicate });
  }
  for (const duplicate of duplicateValues(actions.map((action) => action.name))) {
    add(issues, "blocking", "duplicate_action_name", `Action name 重复：${duplicate}`, { action: duplicate });
  }
  for (const duplicate of duplicateValues(events.map((event) => event.name))) {
    add(issues, "blocking", "duplicate_event_name", `Event name 重复：${duplicate}`, { event: duplicate });
  }
  for (const duplicate of duplicateValues(objects.map((object) => object.id))) {
    add(issues, "blocking", "duplicate_object_id", `DataObject id 重复：${duplicate}`, { object: duplicate });
  }

  checkObjectSchema(objects, issues);
  checkOntologyLinks(ontology, issues);

  for (const event of events) {
    const eventName = event.name || "<unnamed>";
    if (!event.name) add(issues, "blocking", "event_name_missing", "Event 缺少 name");
    const sourceRef = text(event.payload?.source_action);
    const sourceDomain = text(event.payload?.source_domain);
    const externalSource = !!sourceDomain && refKey(sourceDomain) !== refKey(ontology.domainId);
    const declaredExternalSources = declaredExternalEventSources(actions, eventName);
    const sourceDomainReference = externalSource
      ? ontology.referencedDomains?.find((domain) => refKey(domain.domainId) === refKey(sourceDomain))
      : undefined;
    if (sourceDomain && !sourceRef) {
      add(issues, "blocking", "event_source_domain_without_action", `Event ${eventName} 声明了 source_domain ${sourceDomain}，但没有 source_action`, { event: eventName, domain: sourceDomain });
    }
    if (sourceRef) {
      if (externalSource && (!sourceDomainReference || !sourceDomainReference.resolved)) {
        const reason = sourceDomainReference?.error ? `：${sourceDomainReference.error}` : "";
        add(issues, "blocking", "event_source_domain_unresolved", `Event ${eventName} 的外部 source_domain ${sourceDomain} 未完成严格解析${reason}`, { event: eventName, action: sourceRef, domain: sourceDomain });
      } else {
        const sourceActions = externalSource ? sourceDomainReference!.actions : actions;
        const source = sourceActions.find((action) => hasAlias(actionAliases(action), sourceRef));
        if (!source) {
          if (!externalSource && declaredExternalSources.length) {
            add(
              issues,
              "warning",
              "event_external_source_action_unmodeled",
              `Event ${eventName} 的 source_action ${sourceRef} 未建模为本域 Action，但消费方 ${declaredExternalSources.map((entry) => entry.consumer).join("、")} 已在 integration.event_sources 明确声明外部/人工来源（${declaredExternalSources.map((entry) => entry.source).join("；")}）`,
              { event: eventName, action: sourceRef, domain: ontology.domainId },
            );
          } else {
            add(issues, "blocking", "event_source_action_unknown", `Event ${eventName} 的 source_action ${sourceRef} 在 domain ${sourceDomain || ontology.domainId} 中不存在`, { event: eventName, action: sourceRef, domain: sourceDomain || ontology.domainId });
          }
        } else if (!source.triggered_event.some((name) => refKey(name) === refKey(eventName))) {
          add(issues, "blocking", "event_not_declared_by_source_action", `Event ${eventName} 指向 ${sourceDomain ? `${sourceDomain}/` : ""}${source.name}，但该 Action 未声明 emit`, { event: eventName, action: source.name, domain: sourceDomain || ontology.domainId });
        }
      }
    }
    const producers = uniqueRefs(event.producers);
    if (producers.length) {
      for (const producerRef of producers) {
        const producerIsExternalSource = externalSource && !!sourceRef && hasAlias(aliases([sourceRef]), producerRef);
        const producerIsDeclaredUnmodeledBoundary = !externalSource
          && !!sourceRef
          && hasAlias(aliases([sourceRef]), producerRef)
          && declaredExternalSources.length > 0;
        if (producerIsExternalSource && (!sourceDomainReference || !sourceDomainReference.resolved)) {
          // event_source_domain_unresolved above is the single authoritative
          // blocker; do not mislabel a failed domain read as a missing Action.
          continue;
        }
        const producerActions = producerIsExternalSource ? sourceDomainReference!.actions : actions;
        const producer = producerActions.find((action) => hasAlias(actionAliases(action), producerRef));
        if (!producer) {
          // The source_action check above already recorded this exact,
          // explicitly-declared manual/platform boundary as a warning. Do not
          // re-introduce the same fact as a producer blocker merely because the
          // Event also carries a redundant producers[] entry.
          if (!producerIsDeclaredUnmodeledBoundary) {
            add(issues, "blocking", "event_producer_unknown", `Event ${eventName} 的 producer ${producerRef} 在 domain ${producerIsExternalSource ? sourceDomain : ontology.domainId} 中不存在`, { event: eventName, action: producerRef, domain: producerIsExternalSource ? sourceDomain : ontology.domainId });
          }
        } else if (!producer.triggered_event.some((name) => refKey(name) === refKey(eventName))) {
          add(issues, "blocking", "event_not_declared_by_producer", `Event ${eventName} 声明 producer ${producer.name}，但该 Action 未声明 emit`, { event: eventName, action: producer.name });
        }
      }
      for (const action of actions) {
        const emits = action.triggered_event.some((name) => refKey(name) === refKey(eventName));
        if (emits && !producers.some((producer) => hasAlias(actionAliases(action), producer))) {
          add(issues, "blocking", "event_producer_missing", `Action ${action.name} 声明 emit ${eventName}，但 Event.producers 未包含该 Action`, { event: eventName, action: action.name });
        }
      }
      if (producers.length > 1 && sourceRef) {
        add(issues, "warning", "event_source_action_is_partial", `Event ${eventName} 有多个 producer；source_action 只能表达一个，运行时以 producers 为准`, { event: eventName, action: sourceRef });
      }
    }
    const consumers = uniqueRefs(event.consumers);
    if (consumers.length) {
      for (const consumerRef of consumers) {
        const consumer = actions.find((action) => hasAlias(actionAliases(action), consumerRef));
        if (!consumer) {
          add(issues, "blocking", "event_consumer_unknown", `Event ${eventName} 的 consumer ${consumerRef} 不存在`, { event: eventName, action: consumerRef });
        } else if (!consumer.trigger.some((name) => refKey(name) === refKey(eventName))) {
          add(issues, "blocking", "event_not_declared_by_consumer", `Event ${eventName} 声明 consumer ${consumer.name}，但该 Action 未订阅该 Event`, { event: eventName, action: consumer.name });
        }
      }
      for (const action of actions) {
        const consumes = action.trigger.some((name) => refKey(name) === refKey(eventName));
        if (consumes && !consumers.some((consumer) => hasAlias(actionAliases(action), consumer))) {
          add(issues, "blocking", "event_consumer_missing", `Action ${action.name} 订阅 ${eventName}，但 Event.consumers 未包含该 Action`, { event: eventName, action: action.name });
        }
      }
    }
    for (const field of event.payload?.event_data ?? []) {
      if (!text(field.name) || !text(field.type)) {
        add(issues, "blocking", "event_field_schema_incomplete", `Event ${eventName} 有 payload field 缺少 name/type`, { event: eventName, field: field.name });
      }
      if (field.target_object) {
        const object = objectForRef(objects, field.target_object);
        if (!object) {
          add(issues, "blocking", "event_field_object_unknown", `Event ${eventName}.${field.name} 引用了不存在的 DataObject ${field.target_object}`, { event: eventName, object: field.target_object, field: field.name });
        }
      }
    }
    for (const mutation of event.payload?.state_mutations ?? []) {
      checkObjectAndProperties(objects, issues, mutation.target_object, mutation.impacted_properties, { event: eventName }, "event_mutation");
    }
  }

  for (const action of actions) {
    const actionName = action.name || action.id || "<unnamed>";
    if (!action.id || !action.name) {
      add(issues, "blocking", "action_identity_missing", `Action ${actionName} 缺少 id 或 name`, { action: actionName });
    }
    for (const trigger of action.trigger ?? []) {
      if (!hasAlias(eventNames, trigger)) {
        add(issues, "blocking", "action_trigger_event_unknown", `Action ${actionName} trigger 引用了不存在的 Event ${trigger}`, { action: actionName, event: trigger });
      }
    }
    for (const emitted of action.triggered_event ?? []) {
      if (!hasAlias(eventNames, emitted)) {
        add(issues, "blocking", "action_emitted_event_unknown", `Action ${actionName} emit 引用了不存在的 Event ${emitted}`, { action: actionName, event: emitted });
      }
    }
    for (const objectRef of action.target_objects ?? []) {
      if (!objectForRef(objects, objectRef)) {
        add(issues, "blocking", "action_target_object_unknown", `Action ${actionName} 引用了不存在的 DataObject ${objectRef}`, { action: actionName, object: objectRef });
      }
    }

    const triggerEvents = (action.trigger ?? [])
      .map((name) => events.find((event) => refKey(event.name) === refKey(name)))
      .filter((event): event is OntologyEvent => !!event);
    const steps = rows(action.action_steps);
    for (const input of rows(action.inputs)) {
      const field = text(input.name);
      const sourceObject = text(input.source_object ?? input.sourceObject);
      const explicitBindingKind = text(input.binding_kind ?? input.bindingKind);
      let bindingKind = explicitBindingKind;
      let sourceProperty = propertyRef(sourceObject);
      const sourceEventRefs = stringRefs(input.source_event ?? input.sourceEvent);
      if (!field || !text(input.type)) {
        add(issues, "blocking", "action_input_schema_incomplete", `Action ${actionName} 有 input 缺少 name/type`, { action: actionName, field });
      }

      if (!bindingKind) {
        if (input.required === true) {
          add(issues, "blocking", "action_input_binding_kind_missing", `Action ${actionName}.${field} 是 required，但无法确定 binding_kind`, { action: actionName, field });
          if (!sourceObject) {
            add(issues, "blocking", "action_required_input_source_missing", `Action ${actionName}.${field} 是 required，但没有 source_object/input binding`, { action: actionName, field });
          }
        } else {
          add(issues, "warning", "action_input_binding_kind_missing", `Action ${actionName}.${field} 未声明 binding_kind；可选输入不会被自动塞入 Event`, { action: actionName, field });
        }
      } else if (!INPUT_BINDING_KINDS.has(bindingKind)) {
        add(issues, "blocking", "action_input_binding_kind_unknown", `Action ${actionName}.${field} 的 binding_kind ${bindingKind} 不受支持`, { action: actionName, field });
        bindingKind = "";
      }


      if (sourceEventRefs.length && bindingKind && bindingKind !== "event") {
        add(issues, "blocking", "action_input_source_event_conflict", `Action ${actionName}.${field} 声明了 source_event，但 binding_kind 是 ${bindingKind}`, { action: actionName, field });
      }
      const unknownSourceEvents = sourceEventRefs.filter(
        (sourceEvent) => !(action.trigger ?? []).some((trigger) => refKey(trigger) === refKey(sourceEvent)),
      );
      if (unknownSourceEvents.length) {
        add(issues, "blocking", "action_input_source_event_unknown", `Action ${actionName}.${field} 的 source_event ${unknownSourceEvents.join("、")} 不在 Action.trigger 中`, { action: actionName, event: unknownSourceEvents[0], field });
      }

      if (bindingKind === "event" || bindingKind === "object_lookup") {
        if (bindingKind === "object_lookup" && !sourceObject) {
          add(issues, "blocking", "action_input_object_source_missing", `Action ${actionName}.${field} 的 object_lookup 缺少 source_object=Object.property`, { action: actionName, field });
        }
        if (bindingKind === "object_lookup" && sourceObject && !sourceProperty) {
          add(issues, "blocking", "action_input_property_source_missing", `Action ${actionName}.${field} 的 object_lookup 必须指向具体的 Object.property`, { action: actionName, object: baseObjectRef(sourceObject), field });
        }
      }

      if ((bindingKind === "event" || bindingKind === "object_lookup") && sourceObject) {
        const object = objectForRef(objects, sourceObject);
        if (!object) {
          add(issues, "blocking", "action_input_object_unknown", `Action ${actionName}.${field} 引用了不存在的 DataObject ${baseObjectRef(sourceObject)}`, { action: actionName, object: baseObjectRef(sourceObject), field });
        } else {
          const property = sourceProperty;
          if (property && !hasAlias(objectProperties(object), property)) {
            add(issues, "blocking", "action_input_property_unknown", `Action ${actionName}.${field} 引用了不存在的 property ${object.id}.${property}`, { action: actionName, object: object.id, field: property });
          }
        }
      }

      if (bindingKind === "event" && input.required === true) {
        const eventField = text(input.event_field ?? input.eventField ?? input.source_field ?? input.sourceField);
        const candidates = aliases([eventField, field, propertyRef(sourceObject)]);
        const boundTriggerEvents = sourceEventRefs.length
          ? sourceEventRefs
            .map((sourceEvent) => triggerEvents.find((event) => refKey(event.name) === refKey(sourceEvent)))
            .filter((event): event is OntologyEvent => !!event)
          : triggerEvents;
        if (!boundTriggerEvents.length) {
          add(issues, "blocking", "action_event_binding_trigger_missing", `Action ${actionName}.${field} 绑定到 event，但 Action 没有可验证的 trigger Event`, { action: actionName, field });
        }
        for (const triggerEvent of boundTriggerEvents) {
          const matches = matchingEventFieldRows(triggerEvent, candidates);
          if (!matches.length) {
            add(issues, "blocking", "action_required_input_unbound", `Action ${actionName}.${field} 无法从 trigger ${triggerEvent.name} 的 event_data 绑定`, { action: actionName, event: triggerEvent.name, field });
          } else if (!matches.some((candidate) => inputBindingTypesCompatible(text(candidate.type), text(input.type)))) {
            add(issues, "blocking", "action_input_event_type_mismatch", `Action ${actionName}.${field}:${text(input.type)} 与 trigger ${triggerEvent.name} 的同名字段类型不兼容`, { action: actionName, event: triggerEvent.name, field });
          }
        }
      }

      if (bindingKind === "event") {
        const eventPath = text(input.event_path ?? input.eventPath ?? input.event_field ?? input.eventField ?? input.source_field ?? input.sourceField) || field;
        if (eventPath && !SAFE_INPUT_PATH.test(eventPath)) {
          add(issues, "blocking", "action_event_binding_path_invalid", `Action ${actionName}.${field} 的 event path ${eventPath} 不是安全数据路径`, { action: actionName, field });
        }
      }

      if (bindingKind === "object_lookup") {
        const lookupArgs = input.lookup_args ?? input.lookupArgs ?? input.arguments;
        if (!lookupArgs || typeof lookupArgs !== "object" || Array.isArray(lookupArgs) || !Object.keys(lookupArgs as Row).length) {
          add(issues, "blocking", "action_input_lookup_args_missing", `Action ${actionName}.${field} 的 object_lookup 缺少 lookup_args（工具参数名 → event/input 路径）`, { action: actionName, field });
        } else {
          for (const [argName, rawPath] of Object.entries(lookupArgs as Row)) {
            const path = text(rawPath);
            if (!argName.trim() || !path || !SAFE_INPUT_PATH.test(path)) {
              add(issues, "blocking", "action_input_lookup_arg_invalid", `Action ${actionName}.${field} 的 lookup_args.${argName || "<unnamed>"} 必须是安全路径字符串，不能内联常量/凭证`, { action: actionName, field });
            }
          }
        }
        const resultPath = text(input.result_path ?? input.resultPath ?? input.lookup_result_path ?? input.lookupResultPath);
        if (!resultPath || !SAFE_INPUT_PATH.test(resultPath)) {
          add(issues, "blocking", "action_input_lookup_result_path_missing", `Action ${actionName}.${field} 的 object_lookup 缺少安全 result_path；工具响应字段不能靠猜`, { action: actionName, field });
        }
        const explicitTool = text(input.lookup_tool ?? input.lookupTool ?? input.binding_tool ?? input.bindingTool ?? input.tool_name ?? input.toolName);
        const integrationRef = text(input.integration_ref ?? input.integrationRef);
        const sourceBase = baseObjectRef(sourceObject);
        const declaredReadIntegration = rows(
          action.integration && typeof action.integration === "object"
            ? (action.integration as Row).systems
            : undefined,
        ).some((system) => {
          const role = refKey(text(system.role));
          const readRole = ["read", "reads", "fetch", "query", "lookup", "get"].includes(role);
          const covered = (Array.isArray(system.objects) ? system.objects : []).some((object) => text(object) === "*" || refKey(text(object)) === refKey(sourceBase));
          return readRole && covered;
        });
        if (!explicitTool && !integrationRef && !declaredReadIntegration) {
          add(issues, "blocking", "action_input_lookup_integration_missing", `Action ${actionName}.${field} 的 object_lookup 没有 lookup_tool/integration_ref，也没有覆盖 ${sourceBase} 的 read integration`, { action: actionName, object: sourceBase, field });
        }
      }

      if (bindingKind === "secret" || bindingKind === "config") {
        const bindingRef = text(input.binding_ref ?? input.bindingRef ?? (bindingKind === "secret" ? input.secret_ref ?? input.secretRef : input.config_ref ?? input.configRef));
        if (!bindingRef) {
          add(issues, "blocking", "action_input_binding_ref_missing", `Action ${actionName}.${field} 的 ${bindingKind} binding 缺少 binding_ref`, { action: actionName, field });
        }
      }

      if (bindingKind === "human_input") {
        const prompt = text(input.prompt ?? input.description);
        if (!prompt) {
          add(issues, "blocking", "action_input_human_prompt_missing", `Action ${actionName}.${field} 的 human_input 缺少给用户看的 prompt/description`, { action: actionName, field });
        }
      }

      if (bindingKind === "step_output") {
        const stepRef = text(input.source_step ?? input.sourceStep ?? input.step_id ?? input.stepId);
        const outputRef = text(input.source_output ?? input.sourceOutput ?? input.output_name ?? input.outputName);
        const step = steps.find((candidate) => hasAlias(aliases([text(candidate.id), text(candidate.name)]), stepRef));
        if (!stepRef || !step) {
          add(issues, "blocking", "action_input_step_unknown", `Action ${actionName}.${field} 的 step_output 引用了不存在的 step ${stepRef || "<missing>"}`, { action: actionName, step: stepRef || undefined, field });
        } else if (!outputRef) {
          add(issues, "blocking", "action_input_step_output_missing", `Action ${actionName}.${field} 的 step_output 缺少 source_output`, { action: actionName, step: stepRef, field });
        } else {
          const outputNames = aliases(rows(step.outputs).map((output) => text(output.name)));
          if (!hasAlias(outputNames, outputRef)) {
            add(issues, "blocking", "action_input_step_output_unknown", `Action ${actionName}.${field} 引用了 step ${stepRef} 不存在的 output ${outputRef}`, { action: actionName, step: stepRef, field: outputRef });
          } else {
            const output = rows(step.outputs).find((candidate) => hasAlias(aliases([text(candidate.name)]), outputRef));
            const sourceType = text(output?.type);
            const targetType = text(input.type);
            if (!sourceType) {
              add(issues, "blocking", "action_input_step_output_type_missing", `Action ${actionName}.${field} 引用的 ${stepRef}.${outputRef} 没有 type`, { action: actionName, step: stepRef, field: outputRef });
            } else if (targetType && !inputBindingTypesCompatible(sourceType, targetType)) {
              add(issues, "blocking", "action_input_step_output_type_mismatch", `Action ${actionName}.${field}:${targetType} 与 step ${stepRef}.${outputRef}:${sourceType} 类型不兼容`, { action: actionName, step: stepRef, field });
            }
          }
        }
      }

      if (["secret", "config", "human_input", "step_output"].includes(bindingKind) && sourceObject) {
        add(issues, "blocking", "action_input_binding_source_conflict", `Action ${actionName}.${field} 的 ${bindingKind} binding 不应同时声明 source_object`, { action: actionName, object: baseObjectRef(sourceObject), field });
      }
    }

    const emittedFields = new Set<string>();
    for (const emitted of action.triggered_event ?? []) {
      const event = events.find((candidate) => refKey(candidate.name) === refKey(emitted));
      for (const key of eventFields(event)) emittedFields.add(key);
    }
    if ((action.triggered_event ?? []).length) {
      for (const output of rows(action.outputs)) {
        const field = text(output.name);
        const delivery = stringRefs(output.delivery);
        const emittedOn = stringRefs(output.emitted_on ?? output.emittedOn ?? output.events);
        const unknownDelivery = delivery.filter((value) => !["event", "invoke_return", "internal"].includes(value));
        if (unknownDelivery.length) {
          add(issues, "blocking", "action_output_delivery_unknown", `Action ${actionName}.${field} 的 delivery ${unknownDelivery.join("、")} 不受支持`, { action: actionName, field });
        }
        const deliversEvent = delivery.length === 0 || delivery.includes("event");
        if (!field || !text(output.type)) {
          add(issues, "blocking", "action_output_schema_incomplete", `Action ${actionName} 有 output 缺少 name/type`, { action: actionName, field });
        } else if (!deliversEvent) {
          continue;
        } else if ((action.triggered_event ?? []).length > 1 && !emittedOn.length) {
          add(issues, "blocking", "action_output_event_mapping_missing", `Action ${actionName}.${field} 面向多个 outcome Event，但未声明 emitted_on/events；工厂不会猜它属于成功还是失败分支`, { action: actionName, field });
        } else if (emittedOn.length) {
          const unknownEvents = emittedOn.filter((eventName) => !(action.triggered_event ?? []).some((candidate) => refKey(candidate) === refKey(eventName)));
          if (unknownEvents.length) {
            add(issues, "blocking", "action_output_event_mapping_unknown", `Action ${actionName}.${field} 的 emitted_on 引用了未声明的 outcome Event ${unknownEvents.join("、")}`, { action: actionName, event: unknownEvents[0], field });
          }
          for (const eventName of emittedOn) {
            const event = events.find((candidate) => refKey(candidate.name) === refKey(eventName));
            if (!event) continue;
            const matches = matchingEventFieldRows(event, aliases([field, text(output.event_field ?? output.eventField)]));
            if (!matches.length) {
              add(issues, "blocking", "action_output_unbound", `Action ${actionName}.${field} 未映射到 emitted Event ${event.name} 的字段`, { action: actionName, event: event.name, field });
            } else if (!matches.some((candidate) => inputBindingTypesCompatible(text(output.type), text(candidate.type)))) {
              add(issues, "blocking", "action_output_event_type_mismatch", `Action ${actionName}.${field}:${text(output.type)} 与 emitted Event ${event.name} 的同名字段类型不兼容`, { action: actionName, event: event.name, field });
            }
          }
        } else if (!emittedFields.has(refKey(field))) {
          add(issues, "blocking", "action_output_unbound", `Action ${actionName}.${field} 未映射到任何 emitted Event field`, { action: actionName, field });
        }
      }
    }

    const sideEffects = action.side_effects && typeof action.side_effects === "object" ? action.side_effects as Row : {};
    const integration = action.integration && typeof action.integration === "object" ? action.integration as Row : {};
    if (
      action.actor.includes("Agent")
      && !!action.instruction?.trim()
      && !steps.length
      && !rows(sideEffects.data_changes).length
      && !rows(sideEffects.notifications).length
      && !rows(integration.systems).length
      && !(action.tool_use ?? []).length
    ) {
      add(issues, "warning", "action_execution_contract_undeclared", `Action ${actionName} 有业务 instruction，但没有 action_steps/integration/side_effects/tool_use；允许先生成结构化 plan 草稿，但进入 sandbox/promotion 前必须完成人工审查，计划里的外部调用和写操作还必须具备 integration profile 与安全探针`, { action: actionName });
    }
    if (!steps.length && (rows(sideEffects.data_changes).length || rows(sideEffects.notifications).length || rows(integration.systems).length)) {
      add(issues, "warning", "action_steps_missing", `Action ${actionName} 有 integration/side effects，但没有 action_steps`, { action: actionName });
    }
    for (const [index, step] of steps.entries()) {
      const stepName = text(step.id ?? step.step_id ?? step.stepId ?? step.name) || `#${index + 1}`;
      if (!text(step.name) && !text(step.id)) {
        add(issues, "blocking", "action_step_identity_missing", `Action ${actionName} 的第 ${index + 1} 个 step 缺少 id/name`, { action: actionName, step: stepName });
      }
      const condition = text(step.condition);
      if (condition && /[\p{Script=Han}]/u.test(condition)) {
        add(issues, "warning", "action_step_condition_requires_compilation", `Action ${actionName} step ${stepName} 的自然语言 condition 必须编译为安全 DSL`, { action: actionName, step: stepName });
      }
      for (const rule of rows(step.rules)) {
        const id = ruleId(rule);
        if (!id) {
          add(issues, "blocking", "action_step_rule_id_missing", `Action ${actionName} step ${stepName} 有 rule 缺少 id`, { action: actionName, step: stepName });
        } else if (!hasAlias(ruleIds, id)) {
          add(issues, "blocking", "action_step_rule_unknown", `Action ${actionName} step ${stepName} 引用了不存在的 Rule ${id}`, { action: actionName, step: stepName, rule: id });
        }
      }
    }

    for (const change of rows(sideEffects.data_changes)) {
      checkObjectAndProperties(objects, issues, change.object_type ?? change.target_object, change.property_impacted ?? change.impacted_properties, { action: actionName }, "side_effect");
    }
    for (const notification of rows(sideEffects.notifications)) {
      const emitted = text(notification.triggered_event);
      if (!emitted) {
        add(issues, "warning", "notification_event_missing", `Action ${actionName} 有 notification 未声明 triggered_event`, { action: actionName });
      } else if (!hasAlias(eventNames, emitted)) {
        add(issues, "blocking", "notification_event_unknown", `Action ${actionName} notification 引用了不存在的 Event ${emitted}`, { action: actionName, event: emitted });
      }
    }
    for (const system of rows(integration.systems)) {
      const name = text(system.name ?? system.system);
      if (!name || !text(system.role) || !text(system.kind)) {
        add(issues, "blocking", "integration_identity_incomplete", `Action ${actionName} 有 integration system 缺少 name/kind/role`, { action: actionName });
      }
      for (const objectRef of Array.isArray(system.objects) ? system.objects : []) {
        if (!objectForRef(objects, objectRef)) {
          add(issues, "blocking", "integration_object_unknown", `Action ${actionName} integration ${name || "<unnamed>"} 引用了不存在的 DataObject ${String(objectRef)}`, { action: actionName, object: String(objectRef) });
        }
      }
      const hasExecutableBinding = !!text(system.tool ?? system.endpoint ?? system.operation ?? system.adapter);
      if (!hasExecutableBinding) {
        add(issues, "warning", "integration_binding_required", `Action ${actionName} integration ${name || "<unnamed>"} 仍需绑定可执行 tool/endpoint`, { action: actionName });
      }
    }
  }

  if (!ontology.workflow.length) {
    add(issues, "warning", "workflow_not_declared", "Ontology 未声明 workflow；事件拓扑将由 Agent Factory 生成");
  }

  const blocking = issues.filter((issue) => issue.severity === "blocking");
  const warnings = issues.filter((issue) => issue.severity === "warning");
  const actionSteps = actions.reduce((count, action) => count + rows(action.action_steps).length, 0);
  return {
    ready: blocking.length === 0,
    blocking,
    warnings,
    issues,
    counts: {
      objects: objects.length,
      events: events.length,
      actions: actions.length,
      actionSteps,
      rules: rules.length,
      blocking: blocking.length,
      warnings: warnings.length,
    },
  };
}
