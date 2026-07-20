// Production promotion safety over the EFFECTIVE fleet, not merely the selected
// draft specs. A candidate can close a feedback loop with an already-live agent,
// or change the payload contract consumed/produced by one. Neither risk is
// visible when the candidate set is checked in isolation.

import {
  compileGraph,
  normalizeDeclaredType,
  typesCompatible,
  verifyGraph,
  type OntologyAction,
} from "@agentic/agent-factory";

type ManifestRow = Record<string, unknown>;

type ContractField = {
  field: string;
  type: string;
  required: boolean;
};

export type PromotionSafetyIssue =
  | { kind: "unbounded_cycle"; agentIds: string[]; events: string[] }
  | {
      kind: "contract_schema_missing";
      event: string;
      agentId: string;
      side: "input" | "output";
      counterpartId: string;
    }
  | {
      kind: "contract_schema_invalid";
      event: string;
      agentId: string;
      side: "input" | "output";
      counterpartId: string;
    }
  | {
      kind: "payload_field_missing";
      event: string;
      producerId: string;
      consumerId: string;
      field: string;
    }
  | {
      kind: "payload_type_mismatch";
      event: string;
      producerId: string;
      consumerId: string;
      field: string;
      producerType: string;
      consumerType: string;
    };

export type PromotionSafetyResult = {
  ok: boolean;
  issues: PromotionSafetyIssue[];
};

function rowOf(value: unknown): ManifestRow | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as ManifestRow
    : undefined;
}

function agentId(row: ManifestRow): string | undefined {
  return typeof row.id === "string" && row.id.trim() ? row.id : undefined;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((entry): entry is string => typeof entry === "string" && !!entry.trim()))];
}

/** A manual action in a nested foreach/body is also a real human bound on a
 * feedback path. Traverse defensively because live manifests can span several
 * schema versions and may spell a nested action collection differently. */
function containsManualAction(value: unknown, seen = new Set<object>()): boolean {
  if (Array.isArray(value)) return value.some((entry) => containsManualAction(entry, seen));
  const row = rowOf(value);
  if (!row || seen.has(row)) return false;
  seen.add(row);
  if (row.type === "manual") return true;
  return [row.actions, row.foreach_actions, row.body].some((child) => containsManualAction(child, seen));
}

function hasHumanBound(row: ManifestRow): boolean {
  const actors = stringArray(row.actor).map((actor) => actor.toLowerCase());
  return actors.some((actor) => actor === "human" || actor === "hitl" || actor === "人工")
    || containsManualAction(row.actions);
}

function asGraphAction(row: ManifestRow): OntologyAction | undefined {
  const id = agentId(row);
  if (!id) return undefined;
  return {
    id,
    name: id,
    actor: hasHumanBound(row) ? ["Human"] : ["Agent"],
    trigger: stringArray(row.trigger),
    triggered_event: stringArray(row.triggered_event),
    target_objects: [],
    tool_use: [],
    system_prompt: "",
    user_prompt: "",
  };
}

type ParsedSchema =
  | { status: "missing" | "invalid"; fields: Map<string, ContractField> }
  | { status: "valid"; fields: Map<string, ContractField> };

function parseSchema(row: ManifestRow, key: "factory_input_schema" | "factory_output_schema"): ParsedSchema {
  if (!Object.prototype.hasOwnProperty.call(row, key)) return { status: "missing", fields: new Map() };
  const raw = row[key];
  if (!Array.isArray(raw)) return { status: "invalid", fields: new Map() };
  const fields = new Map<string, ContractField>();
  for (const value of raw) {
    const field = rowOf(value);
    if (!field || typeof field.field !== "string" || !field.field.trim() || typeof field.type !== "string" || !field.type.trim()) {
      return { status: "invalid", fields: new Map() };
    }
    // Duplicate declarations are ambiguous even when the current values happen
    // to agree; reject them rather than letting insertion order choose a schema.
    if (fields.has(field.field)) return { status: "invalid", fields: new Map() };
    fields.set(field.field, {
      field: field.field,
      type: normalizeDeclaredType(field.type),
      required: field.required !== false,
    });
  }
  return { status: "valid", fields };
}

function issueKey(issue: PromotionSafetyIssue): string {
  return JSON.stringify(issue);
}

/** Inspect the exact merged workflow that will be persisted and registered.
 *
 * Cycles are checked across the whole effective fleet. Contract compatibility
 * is checked on every edge incident to a promoted id; this includes new↔new and
 * both directions of existing↔new, while not making an unrelated legacy edge a
 * permanent blocker for every future promotion.
 */
export function inspectMergedPromotionSafety(input: {
  merged: readonly unknown[];
  promotedIds: ReadonlySet<string>;
  domainId: string;
}): PromotionSafetyResult {
  const rows = input.merged.map(rowOf).filter((row): row is ManifestRow => !!row);
  const byId = new Map(rows.flatMap((row) => {
    const id = agentId(row);
    return id ? [[id, row] as const] : [];
  }));
  const graphActions = rows.map(asGraphAction).filter((action): action is OntologyAction => !!action);
  const graph = compileGraph(graphActions, { domainId: input.domainId });
  const graphIssues = verifyGraph(graph).issues.filter((issue) => issue.kind === "cycle");
  const issues: PromotionSafetyIssue[] = graphIssues.map((issue) => ({
    kind: "unbounded_cycle",
    agentIds: issue.actions,
    events: issue.events,
  }));

  const consumers = new Map<string, string[]>();
  for (const [id, row] of byId) {
    for (const event of stringArray(row.trigger)) {
      consumers.set(event, [...(consumers.get(event) ?? []), id]);
    }
  }

  for (const [producerId, producer] of byId) {
    for (const event of stringArray(producer.triggered_event)) {
      for (const consumerId of consumers.get(event) ?? []) {
        if (!input.promotedIds.has(producerId) && !input.promotedIds.has(consumerId)) continue;
        const consumer = byId.get(consumerId)!;
        const output = parseSchema(producer, "factory_output_schema");
        const expected = parseSchema(consumer, "factory_input_schema");

        if (output.status !== "valid") {
          issues.push({
            kind: output.status === "missing" ? "contract_schema_missing" : "contract_schema_invalid",
            event,
            agentId: producerId,
            side: "output",
            counterpartId: consumerId,
          });
        }
        if (expected.status !== "valid") {
          issues.push({
            kind: expected.status === "missing" ? "contract_schema_missing" : "contract_schema_invalid",
            event,
            agentId: consumerId,
            side: "input",
            counterpartId: producerId,
          });
        }
        if (output.status !== "valid" || expected.status !== "valid") continue;

        for (const consumerField of expected.fields.values()) {
          const producerField = output.fields.get(consumerField.field);
          if (!producerField) {
            if (consumerField.required) {
              issues.push({
                kind: "payload_field_missing",
                event,
                producerId,
                consumerId,
                field: consumerField.field,
              });
            }
            continue;
          }
          if (!typesCompatible(consumerField.type, producerField.type)) {
            issues.push({
              kind: "payload_type_mismatch",
              event,
              producerId,
              consumerId,
              field: consumerField.field,
              producerType: producerField.type,
              consumerType: consumerField.type,
            });
          }
        }
      }
    }
  }

  const unique = [...new Map(issues.map((issue) => [issueKey(issue), issue])).values()];
  return { ok: unique.length === 0, issues: unique };
}

export function promotionSafetyIssueMessage(issue: PromotionSafetyIssue): string {
  if (issue.kind === "unbounded_cycle") {
    return `无界事件环 ${issue.agentIds.join("→")}（经 ${issue.events.join("、")}）`;
  }
  if (issue.kind === "contract_schema_missing" || issue.kind === "contract_schema_invalid") {
    const state = issue.kind === "contract_schema_missing" ? "缺失" : "无效";
    return `事件「${issue.event}」的 ${issue.agentId}.${issue.side === "input" ? "factory_input_schema" : "factory_output_schema"} ${state}（对端 ${issue.counterpartId}）`;
  }
  if (issue.kind === "payload_field_missing") {
    return `事件「${issue.event}」payload 字段「${issue.field}」缺失（${issue.producerId} → ${issue.consumerId}）`;
  }
  if (issue.kind === "payload_type_mismatch") {
    return `事件「${issue.event}」payload 字段「${issue.field}」类型不兼容：${issue.producerId} 产出 ${issue.producerType}，${issue.consumerId} 需要 ${issue.consumerType}`;
  }
  const exhausted: never = issue;
  return String(exhausted);
}
