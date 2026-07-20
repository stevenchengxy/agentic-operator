import { deriveIntegrationRequirements, type IntegrationRequirement } from "./integration-binding";
import type { OntologyAction } from "./ontology-types";
import type { GeneratedAgentSpec } from "./spec-types";
import type { RealTool, ToolCapabilityDescriptor } from "./tool-catalog";

const token = (value: string): string =>
  value.normalize("NFKC").toLocaleLowerCase().replace(/[\s_.:/()-]+/g, "");

const isRulebaseKind = (value: string): boolean => token(value) === "rulebase";

const stringValue = (value: unknown): string => typeof value === "string" ? value.trim() : "";
const recordValue = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const RULE_ID_FIELDS = ["id", "rule_id", "ruleId", "rule_ref", "ruleRef"] as const;
const RULE_NAME_FIELDS = ["name", "rule_name", "ruleName", "businessLogicRuleName", "title"] as const;

function valuesAt(record: Record<string, unknown>, fields: readonly string[]): string[] {
  return [...new Set(fields.map((field) => stringValue(record[field])).filter(Boolean))];
}

function ruleIdentity(rule: Record<string, unknown>): { id: string; names: string[] } {
  return { id: stringValue(rule.id), names: valuesAt(rule, RULE_NAME_FIELDS) };
}

export interface ActionRuleReference {
  stepIndex: number;
  stepName?: string;
  referenceIndex: number;
  value: unknown;
}

/** The presence of action_steps[].rules is explicit Ontology structure. Empty
 * arrays carry no rule evidence; malformed non-array values are retained as an
 * unresolved reference rather than silently ignored. */
export function actionStepRuleReferences(action: OntologyAction): ActionRuleReference[] {
  const references: ActionRuleReference[] = [];
  for (const [stepIndex, rawStep] of (action.action_steps ?? []).entries()) {
    const step = recordValue(rawStep);
    if (!step || !("rules" in step)) continue;
    const stepName = stringValue(step.name) || undefined;
    if (!Array.isArray(step.rules)) {
      if (step.rules !== undefined && step.rules !== null) {
        references.push({ stepIndex, stepName, referenceIndex: 0, value: step.rules });
      }
      continue;
    }
    step.rules.forEach((value, referenceIndex) => {
      references.push({ stepIndex, stepName, referenceIndex, value });
    });
  }
  return references;
}

export interface ResolvedActionRule {
  id: string;
  name: string;
  summary: string;
}

export interface UnresolvedActionRuleReference {
  stepIndex: number;
  stepName?: string;
  referenceIndex: number;
  reference: unknown;
  reason: "missing_identity" | "not_found" | "ambiguous" | "conflicting_identity";
  candidates?: Array<{ id: string; name: string }>;
}

export interface ActionRuleResolution {
  explicitReferenceCount: number;
  relevantRules: ResolvedActionRule[];
  unresolved: UnresolvedActionRuleReference[];
  needsUserInput: boolean;
  next?: "ask_user";
  question?: string;
}

function displayRule(rule: Record<string, unknown>): ResolvedActionRule {
  const identity = ruleIdentity(rule);
  const name = identity.names[0] ?? identity.id;
  return {
    id: identity.id,
    name,
    summary: (stringValue(rule.standardizedLogicRule)
      || stringValue(rule.description)
      || name).slice(0, 220),
  };
}

function candidateDescriptor(rule: Record<string, unknown>): { id: string; name: string } {
  const displayed = displayRule(rule);
  return { id: displayed.id, name: displayed.name };
}

/** Resolve only exact action-step rule IDs/names. There is deliberately no ID
 * prefix, target-object, action-name, description, or fuzzy text fallback. */
export function resolveActionRuleReferences(
  action: OntologyAction,
  rules: readonly Record<string, unknown>[],
): ActionRuleResolution {
  const references = actionStepRuleReferences(action);
  const resolved = new Map<string, ResolvedActionRule>();
  const unresolved: UnresolvedActionRuleReference[] = [];

  for (const reference of references) {
    const { value: referenceValue, ...location } = reference;
    const row = recordValue(reference.value);
    const scalar = stringValue(reference.value);
    const ids = row ? valuesAt(row, RULE_ID_FIELDS) : [];
    const names = row ? valuesAt(row, RULE_NAME_FIELDS) : [];

    const uniqueIds = [...new Set(ids)];
    const uniqueNames = [...new Set(names)];
    if (!scalar && !uniqueIds.length && !uniqueNames.length) {
      unresolved.push({ ...location, reference: referenceValue, reason: "missing_identity" });
      continue;
    }
    if (uniqueIds.length > 1 || uniqueNames.length > 1) {
      unresolved.push({ ...location, reference: referenceValue, reason: "conflicting_identity" });
      continue;
    }

    const matches = rules.filter((rule) => {
      const identity = ruleIdentity(rule);
      if (scalar) return identity.id === scalar || identity.names.includes(scalar);
      const idMatches = !uniqueIds.length || uniqueIds.includes(identity.id);
      const nameMatches = !uniqueNames.length || uniqueNames.some((name) => identity.names.includes(name));
      return idMatches && nameMatches;
    });

    if (matches.length !== 1) {
      unresolved.push({
        ...location,
        reference: referenceValue,
        reason: matches.length ? "ambiguous" : uniqueIds.length && uniqueNames.length ? "conflicting_identity" : "not_found",
        ...(matches.length ? { candidates: matches.map(candidateDescriptor) } : {}),
      });
      continue;
    }

    const displayed = displayRule(matches[0]!);
    const identityKey = displayed.id ? `id:${displayed.id}` : `name:${displayed.name}`;
    resolved.set(identityKey, displayed);
  }

  const needsUserInput = unresolved.length > 0;
  return {
    explicitReferenceCount: references.length,
    relevantRules: [...resolved.values()],
    unresolved,
    needsUserInput,
    ...(needsUserInput ? {
      next: "ask_user" as const,
      question: `动作「${action.name}」的 action_steps 中有 ${unresolved.length} 条规则引用无法唯一对应 Ontology 规则。请确认准确的 rule id 或唯一名称后再继续，工厂不会按前缀或文本相似度代选。`,
    } : {}),
  };
}

export function ontologyActionHasRulebaseRequirement(action: OntologyAction): boolean {
  return deriveIntegrationRequirements(action).some((requirement) => isRulebaseKind(requirement.kind));
}

export function ontologyActionIsRuleGate(action: OntologyAction): boolean {
  return actionStepRuleReferences(action).length > 0 || ontologyActionHasRulebaseRequirement(action);
}

const isReadRole = (value: string): boolean => {
  const role = token(value);
  return role === "read" || role === "reads" || role === "fetch" || role === "query";
};

/** A rule reader is declared by capability metadata, never inferred from its
 * name, vendor, summary, category, or the action that selected it. */
export function capabilityReadsRulebase(capability: ToolCapabilityDescriptor): boolean {
  return capability.kinds.some(isRulebaseKind) && capability.roles.some(isReadRole);
}

export function toolReadsRulebase(tool: RealTool): boolean {
  return (tool.capabilities ?? []).some(capabilityReadsRulebase);
}

function selectedRuleReaders(spec: GeneratedAgentSpec, tools: readonly RealTool[]): string[] {
  const selected = new Set(spec.tools);
  return tools
    .filter((tool) => selected.has(tool.name) || (tool.aliases ?? []).some((alias) => selected.has(alias)))
    .filter(toolReadsRulebase)
    .map((tool) => tool.name);
}

function uniqueRequirements(
  spec: GeneratedAgentSpec,
  ontologyAction: OntologyAction | undefined,
): IntegrationRequirement[] {
  const byId = new Map<string, IntegrationRequirement>();
  for (const requirement of ontologyAction ? deriveIntegrationRequirements(ontologyAction) : []) {
    byId.set(requirement.id, requirement);
  }
  for (const requirement of spec.integrationRequirements ?? []) byId.set(requirement.id, requirement);
  for (const binding of spec.integrationBindings ?? []) byId.set(binding.requirement.id, binding.requirement);
  return [...byId.values()];
}

function resolvedRulebaseBindings(spec: GeneratedAgentSpec): string[] {
  const selected = new Set(spec.tools);
  return (spec.integrationBindings ?? []).flatMap((binding) => {
    if (!isRulebaseKind(binding.requirement.kind) || binding.status !== "resolved") return [];
    const kind = binding.bindingKind ?? (binding.toolName ? "tool" : undefined);
    if (kind === "tool" && binding.toolName && selected.has(binding.toolName)) {
      return [binding.toolName];
    }
    if (kind === "runtime" && binding.bindingId?.trim()) return [binding.bindingId.trim()];
    return [];
  });
}

export interface RuleGateAssessment {
  isRuleGate: boolean;
  readerBound: boolean;
  evidence: Array<"action_step_rules" | "rule_refs" | "decision_tables" | "rulebase_requirement" | "rule_reader_capability">;
  readers: string[];
}

/**
 * Classify rule gates only from persisted, machine-readable evidence. In
 * particular, an action or tool name that merely sounds rule-related is not
 * evidence and remains an ordinary agent until the Ontology/spec says more.
 */
export function assessRuleGate(
  spec: GeneratedAgentSpec,
  opts: { ontologyAction?: OntologyAction; registeredTools?: readonly RealTool[] } = {},
): RuleGateAssessment {
  const evidence = new Set<RuleGateAssessment["evidence"][number]>();
  if (opts.ontologyAction && actionStepRuleReferences(opts.ontologyAction).length > 0) evidence.add("action_step_rules");
  if ((spec.ruleRefs ?? []).some((ref) => ref.trim().length > 0)) evidence.add("rule_refs");
  if ((spec.decisionTables ?? []).length > 0) evidence.add("decision_tables");

  const requirements = uniqueRequirements(spec, opts.ontologyAction);
  if (requirements.some((requirement) => isRulebaseKind(requirement.kind))) {
    evidence.add("rulebase_requirement");
  }

  const capabilityReaders = selectedRuleReaders(spec, opts.registeredTools ?? []);
  if (capabilityReaders.length) evidence.add("rule_reader_capability");
  const readers = [...new Set([...capabilityReaders, ...resolvedRulebaseBindings(spec)])];

  return {
    isRuleGate: evidence.size > 0,
    readerBound: readers.length > 0,
    evidence: [...evidence],
    readers,
  };
}
