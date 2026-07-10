// First-class Agent/Event CONTRACT artifact.
//
// The AI already authors, per agent, an inputSchema (the payload it consumes off
// its trigger event) and an outputSchema (the payload it puts on the events it
// emits). Those fields exist on GeneratedAgentSpec but were never assembled into
// a contract or checked against each other. This module does both:
//
//   1. ASSEMBLE — turn the specs into a queryable contract graph (AgentContract[]
//      + EventContract[]), the machine-readable artifact every runtime target
//      implements (spec-executor "A", Behavior.compute "B", or a CodeAct-style
//      code agent — they all honour the same contract).
//
//   2. RECONCILE PAYLOADS — for each event, do the fields a CONSUMER expects
//      actually get PROVIDED by a PRODUCER? graph.ts/verifyGraph only checks event
//      NAMES (structural closure); this checks the PAYLOAD contract, closing the
//      "agents pass free JSON that silently drifts" gap. A consumer that reads
//      `candidate_id` off an event whose producer never writes it is a real
//      runtime bug that name-level closure cannot catch.
//
// Pure + deterministic (no LLM, no IO) so it runs every validate pass and is
// trivially testable. Ported from the OLD repo's lib/agent-factory-v3/contract.ts.

import type { GeneratedAgentSpec, IoField } from "./spec-types";
import type { OntologyEvent } from "./ontology-types";

export type FieldSpec = {
  field: string;
  type: string;
  source?: string;
  /** presence requirement for the RUNTIME validator: true = must be present; false = type-checked
   *  only when present. Unset → the validator's requireAll option decides. */
  required?: boolean;
};

// ─────────────────────────────────────────────────────────────────────────────
// R2 — TYPE-LEVEL contract. The graph below reconciles field NAMES (presence);
// this adds field TYPES and a RUNTIME payload validator. Together they close the
// observed `output_parse_error: expected object, received undefined` class of
// failure — a downstream agent parsing an emit whose shape it can't accept.
// Pure + LENIENT: only the clearly-known JS shapes (string/number/boolean/object/
// array) are checked; any domain / empty / "unknown" declared type is skipped, so
// generation is never over-rejected (see risk "契约过严压制生成").
// ─────────────────────────────────────────────────────────────────────────────

const TYPE_SYNONYMS: Record<string, string> = {
  string: "string", str: "string", text: "string", varchar: "string", char: "string",
  number: "number", num: "number", int: "number", integer: "number", float: "number",
  double: "number", decimal: "number", numeric: "number", long: "number", bigint: "number",
  bool: "boolean", boolean: "boolean",
  object: "object", json: "object", map: "object", record: "object", dict: "object",
  dictionary: "object", struct: "object",
  array: "array", list: "array", arr: "array",
};

/** Normalize a declared type string to the known vocabulary, or "unknown" (→ skip check). */
export function normalizeDeclaredType(t: string | undefined | null): string {
  const s = String(t ?? "").trim().toLowerCase();
  if (!s) return "unknown";
  if (s.endsWith("[]") || s.startsWith("array")) return "array";
  return TYPE_SYNONYMS[s] ?? "unknown";
}

/** Classify a runtime JS value into the same vocabulary (+ null/undefined sentinels). */
export function runtimeType(v: unknown): string {
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  if (Array.isArray(v)) return "array";
  const t = typeof v;
  if (t === "object") return "object";
  if (t === "number") return "number";
  if (t === "boolean") return "boolean";
  if (t === "string") return "string";
  return "unknown";
}

/** Lenient compatibility: unknown on either side always passes; otherwise exact match. */
export function typesCompatible(declared: string, actual: string): boolean {
  if (declared === "unknown" || actual === "unknown") return true;
  return declared === actual;
}

export type PayloadError = {
  field: string;
  kind: "not_object" | "missing" | "type_mismatch";
  expectedType?: string;
  actualType?: string;
};
export type PayloadValidation = { ok: boolean; errors: PayloadError[] };

/** RUNTIME validator: does an ACTUAL emitted payload satisfy the downstream field
 *  contract? Intended call sites: the runtime emit path (register.ts) and sandbox
 *  verification (execution_fidelity).
 *  - a non-object payload → the exact observed `output_parse_error` (root field `$`).
 *  - a field the contract requires but the payload omits → `missing` (unless requireAll:false).
 *  - a present, non-null field whose runtime type conflicts with a KNOWN declared type → `type_mismatch`.
 *  null values and unknown declared types are treated leniently (never an error). */
export function validateEventPayload(
  payload: unknown,
  expected: FieldSpec[],
  opts?: { requireAll?: boolean },
): PayloadValidation {
  const requireAll = opts?.requireAll ?? true;
  if (payload === null || payload === undefined || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, errors: [{ field: "$", kind: "not_object", actualType: runtimeType(payload) }] };
  }
  const obj = payload as Record<string, unknown>;
  const errors: PayloadError[] = [];
  for (const f of expected) {
    if (!f?.field) continue;
    const declared = normalizeDeclaredType(f.type);
    const has = Object.prototype.hasOwnProperty.call(obj, f.field);
    const v = obj[f.field];
    if (!has || v === undefined) {
      // per-field `required` wins over the blanket requireAll (review fix: a consumer-invented
      // optional field must not hard-fail a legit producer — only authoritative fields are required).
      if (f.required ?? requireAll) errors.push({ field: f.field, kind: "missing", expectedType: declared });
      continue;
    }
    if (v === null) continue; // present-but-null is lenient (optional / not-yet-set)
    const actual = runtimeType(v);
    if (!typesCompatible(declared, actual)) {
      errors.push({ field: f.field, kind: "type_mismatch", expectedType: declared, actualType: actual });
    }
  }
  return { ok: errors.length === 0, errors };
}

/** Human-readable (zh) lines for payload-validation errors, for logs / brain / UI. */
export function payloadErrorStrings(event: string, errors: PayloadError[]): string[] {
  return errors.map((e) => {
    if (e.kind === "not_object") return `事件「${event}」的 payload 不是对象（实际 ${e.actualType}）——下游会 output_parse_error`;
    if (e.kind === "missing") return `事件「${event}」缺少契约字段「${e.field}」(应为 ${e.expectedType})`;
    return `事件「${event}」字段「${e.field}」类型不符：期望 ${e.expectedType}，实际 ${e.actualType}`;
  });
}

/** Build the per-event canonical FieldSpec map from ontology event_data (the AUTHORITATIVE
 *  payload contract). Exported so the runtime + sandbox verification share one source of
 *  truth with the design-time graph. */
export function canonicalEventFields(ont: { events?: OntologyEvent[] } | null | undefined): Map<string, FieldSpec[]> {
  const events = ont?.events ?? [];
  return new Map(
    events.map((e) => [
      e.name,
      (e.payload?.event_data ?? []).map((f) => ({ field: f.name, type: f.type || "unknown", source: f.target_object ?? undefined })),
    ]),
  );
}

export type AgentContract = {
  actionName: string;
  slug: string;
  nameZh: string;
  triggerEvents: string[];
  outputEvents: string[];
  /** payload fields this agent consumes off its trigger */
  inputFields: FieldSpec[];
  /** payload fields this agent writes onto the events it emits */
  outputFields: FieldSpec[];
  tools: string[];
};

export type EventContract = {
  name: string;
  domain: string;
  producers: string[]; // actionNames that emit it
  consumers: string[]; // actionNames that trigger on it
  isEntry: boolean; // consumed, produced by nobody here → external entry
  isTerminal: boolean; // produced, consumed by nobody here → workflow leaf
  isFailure: boolean;
  /** union of every producer's outputFields for this event */
  providedFields: FieldSpec[];
  /** union of every consumer's inputFields for this event */
  expectedFields: FieldSpec[];
  /** field names a consumer expects that NO producer provides (the payload gap) */
  payloadGaps: string[];
};

export type ContractIssue =
  | { kind: "payload_gap"; event: string; missingFields: string[]; consumers: string[]; producers: string[] }
  // #COMMS — Hole 1: an untyped event now carries WHAT the consumers need, so the risk is legible
  // (before, an untyped producer with expecting consumers surfaced no field names at all).
  | { kind: "untyped_event"; event: string; producers: string[]; consumers: string[]; expectedFields: string[] }
  // #COMMS — Hole 2: a field used ACROSS an edge that the event's canonical event_data doesn't declare
  // (AI-invented / off-ontology). The runtime envelope now carries it, but it's a hygiene signal: either
  // the ontology under-declares the event, or the agent is off-contract. Soft (doesn't fail the graph).
  | { kind: "non_canonical_field"; event: string; fields: string[]; side: "producer" | "consumer"; agents: string[] }
  // #R2 — a field carried across an edge whose declared TYPE conflicts (producer/canonical emits
  // one JS shape, consumer expects another). This is the design-time twin of the runtime
  // `output_parse_error`: caught before deploy instead of at the failing downstream parse.
  | { kind: "type_mismatch"; event: string; field: string; expectedType: string; actualType: string; side: "producer" | "consumer"; agents: string[] }
  // #R2 review fix — two PRODUCERS (or two CONSUMERS) of the same event declare the same field with
  // DIVERGENT known types. Before, first-by-name dedupe silently kept whichever spec came first,
  // making the whole verdict order-dependent; now the conflict is its own hard issue and the merged
  // field degrades to type "unknown" so every downstream check is order-independent + lenient.
  | { kind: "type_conflict"; event: string; field: string; types: string[]; side: "producer" | "consumer"; agents: string[] };

export type ContractGraph = {
  domain: string;
  agents: AgentContract[];
  events: EventContract[];
  issues: ContractIssue[];
  /** payload contract holds (no gaps / untyped internal events) */
  ok: boolean;
};

/** #SIMPLIFY — 失败分支事件的命名启发（单一来源；business-flow 等消费方从这里导入，别复制）。 */
export const FAILISH = /FAIL|REJECT|ERROR|CONFLICT|MISSING|DENIED/i;
const isFailure = (ev: string) => FAILISH.test(ev);
const ioToField = (io: IoField): FieldSpec => ({ field: io.field, type: io.type, source: io.source });

function dedupeFields(fs: FieldSpec[]): FieldSpec[] {
  const m = new Map<string, FieldSpec>();
  for (const f of fs) if (f.field && !m.has(f.field)) m.set(f.field, f);
  return [...m.values()];
}

/** Conflict-aware merge (review fix for order-dependence): same field declared by several specs
 *  with DIVERGENT known types → the merged field degrades to type "unknown" (all downstream type
 *  checks skip it) and the conflict is reported. Order of the input array no longer changes any
 *  verdict. Unknown declared types never conflict with anything. */
function mergeFieldsDetectConflicts(fs: FieldSpec[]): { fields: FieldSpec[]; conflicts: Map<string, string[]> } {
  const byName = new Map<string, FieldSpec>();
  const knownTypes = new Map<string, Set<string>>();
  for (const f of fs) {
    if (!f.field) continue;
    if (!byName.has(f.field)) byName.set(f.field, { ...f });
    const t = normalizeDeclaredType(f.type);
    if (t !== "unknown") {
      if (!knownTypes.has(f.field)) knownTypes.set(f.field, new Set());
      knownTypes.get(f.field)!.add(t);
    }
  }
  const conflicts = new Map<string, string[]>();
  for (const [name, types] of knownTypes) {
    if (types.size > 1) {
      conflicts.set(name, [...types].sort());
      const merged = byName.get(name);
      if (merged) merged.type = "unknown"; // neutralize → order-independent + lenient downstream
    } else {
      // normalize the surviving type to the agreed known type regardless of which spec came first
      const merged = byName.get(name);
      if (merged) merged.type = [...types][0]!;
    }
  }
  return { fields: [...byName.values()], conflicts };
}

/** Assemble the contract graph from the specs and reconcile payloads. `eventFields` (R1) is
 *  the CANONICAL payload contract per event, read from the ontology's typed event_data — when
 *  supplied, those fields count as authoritatively provided, so a consumer reading a field the
 *  event genuinely carries is satisfied (no false gap from an under-typed producer), while a
 *  consumer reading a field the canonical event does NOT define surfaces as a real gap. */
export function deriveContractGraph(specs: GeneratedAgentSpec[], domain: string, eventFields?: Map<string, FieldSpec[]>): ContractGraph {
  const agents: AgentContract[] = specs.map((s) => ({
    actionName: s.actionName,
    slug: s.slug,
    nameZh: s.nameZh,
    triggerEvents: (s.trigger ?? []).filter(Boolean),
    outputEvents: (s.emit ?? []).filter((e) => e && e !== "—"),
    inputFields: (s.inputSchema ?? []).map(ioToField),
    outputFields: (s.outputSchema ?? []).map(ioToField),
    tools: s.tools ?? [],
  }));

  const allEmits = new Set<string>();
  const allTriggers = new Set<string>();
  for (const a of agents) {
    a.outputEvents.forEach((e) => allEmits.add(e));
    a.triggerEvents.forEach((e) => allTriggers.add(e));
  }
  const allEvents = [...new Set([...allEmits, ...allTriggers])];

  // review fix: field-type conflicts detected during assembly, reported per event afterwards.
  const conflictByEvent = new Map<string, { producer: Map<string, string[]>; consumer: Map<string, string[]> }>();

  const events: EventContract[] = allEvents.map((name) => {
    const producers = agents.filter((a) => a.outputEvents.includes(name));
    const consumers = agents.filter((a) => a.triggerEvents.includes(name));
    // R1: canonical event_data fields are authoritatively provided by the event type itself.
    const canonical = eventFields?.get(name) ?? [];
    // Producer-vs-producer / consumer-vs-consumer type divergence is a REAL contract violation that
    // used to be silently resolved by array order; now it degrades the field to unknown (order-
    // independent) and is surfaced as a type_conflict issue below. Canonical stays first-wins
    // authoritative (canonical-vs-producer divergence is the producer-side type_mismatch check).
    const producerMerge = mergeFieldsDetectConflicts(producers.flatMap((p) => p.outputFields));
    const consumerMerge = mergeFieldsDetectConflicts(consumers.flatMap((c) => c.inputFields));
    conflictByEvent.set(name, { producer: producerMerge.conflicts, consumer: consumerMerge.conflicts });
    const providedFields = dedupeFields([...canonical, ...producerMerge.fields]);
    const expectedFields = consumerMerge.fields;
    const provided = new Set(providedFields.map((f) => f.field));
    // A payload gap is only meaningful when there IS a producer that declared
    // SOME output fields — otherwise the producer is "untyped" (a separate issue)
    // and we don't want to double-report every expected field as missing.
    const payloadGaps =
      producers.length && providedFields.length
        ? expectedFields.map((f) => f.field).filter((f) => !provided.has(f))
        : [];
    return {
      name,
      domain,
      producers: producers.map((p) => p.actionName),
      consumers: consumers.map((c) => c.actionName),
      isEntry: !allEmits.has(name),
      isTerminal: !allTriggers.has(name),
      isFailure: isFailure(name),
      providedFields,
      expectedFields,
      payloadGaps,
    };
  });

  const uniq = (xs: string[]): string[] => [...new Set(xs.filter(Boolean))];
  const issues: ContractIssue[] = [];
  for (const e of events) {
    const expectedNames = uniq(e.expectedFields.map((f) => f.field));
    if (e.payloadGaps.length) {
      issues.push({ kind: "payload_gap", event: e.name, missingFields: e.payloadGaps, consumers: e.consumers, producers: e.producers });
    }
    // An internal (non-entry, non-failure) event whose producer declared NO output
    // fields is "free JSON" — the consumer is reading an untyped payload. Skip
    // failure events (often signal-only) and pure entry events (external shape).
    // #COMMS Hole 1: attach WHAT the consumers expect so the untyped risk is legible.
    if (e.producers.length && e.consumers.length && e.providedFields.length === 0 && !e.isFailure) {
      issues.push({ kind: "untyped_event", event: e.name, producers: e.producers, consumers: e.consumers, expectedFields: expectedNames });
    }
    // #COMMS Hole 2: fields used across the edge that the event's CANONICAL event_data doesn't declare.
    // Only meaningful when a canonical contract exists for the event (else there's nothing to be off).
    const canonical = eventFields?.get(e.name);
    if (canonical && canonical.length) {
      const canonicalNames = new Set(canonical.map((f) => f.field));
      // providedFields = canonical ∪ producer outputs → filtering out canonical leaves producer-only fields.
      const prodOff = uniq(e.providedFields.map((f) => f.field).filter((f) => f && !canonicalNames.has(f)));
      const consOff = uniq(expectedNames.filter((f) => !canonicalNames.has(f)));
      if (prodOff.length) issues.push({ kind: "non_canonical_field", event: e.name, fields: prodOff, side: "producer", agents: e.producers });
      if (consOff.length) issues.push({ kind: "non_canonical_field", event: e.name, fields: consOff, side: "consumer", agents: e.consumers });
    }

    // #R2 review fix — surface intra-side type divergence (was silently order-resolved before).
    const conf = conflictByEvent.get(e.name);
    for (const [field, types] of conf?.producer ?? []) {
      issues.push({ kind: "type_conflict", event: e.name, field, types, side: "producer", agents: e.producers });
    }
    for (const [field, types] of conf?.consumer ?? []) {
      issues.push({ kind: "type_conflict", event: e.name, field, types, side: "consumer", agents: e.consumers });
    }

    // #R2 — TYPE mismatch across the edge. Two independent checks, both lenient (unknown types skip):
    //  (a) PRODUCER emits a field whose type conflicts with the ontology's canonical event_data;
    //  (b) CONSUMER expects a type different from what the event actually provides.
    const canonForType = eventFields?.get(e.name);
    if (canonForType && canonForType.length) {
      const canonType = new Map(canonForType.map((f) => [f.field, normalizeDeclaredType(f.type)]));
      for (const prodName of e.producers) {
        const prod = agents.find((a) => a.actionName === prodName);
        for (const of of prod?.outputFields ?? []) {
          const ct = canonType.get(of.field);
          if (ct === undefined) continue;
          const pt = normalizeDeclaredType(of.type);
          if (ct !== "unknown" && pt !== "unknown" && ct !== pt) {
            issues.push({ kind: "type_mismatch", event: e.name, field: of.field, expectedType: ct, actualType: pt, side: "producer", agents: [prodName] });
          }
        }
      }
    }
    const providedType = new Map(e.providedFields.map((f) => [f.field, normalizeDeclaredType(f.type)]));
    for (const ef of e.expectedFields) {
      const pt = providedType.get(ef.field);
      if (pt === undefined) continue; // not provided → already a payload_gap, not a type issue
      const et = normalizeDeclaredType(ef.type);
      if (pt !== "unknown" && et !== "unknown" && pt !== et) {
        issues.push({ kind: "type_mismatch", event: e.name, field: ef.field, expectedType: et, actualType: pt, side: "consumer", agents: e.consumers });
      }
    }
  }

  // A payload_gap (consumer reads a field nobody writes), a type_mismatch (fields wired across
  // an edge with conflicting types) and a type_conflict (two producers/consumers disagree on a
  // known type) are real contract violations that would break the runtime parse.
  // untyped_event / non_canonical_field are softer warnings that don't fail the contract.
  return { domain, agents, events, issues, ok: !issues.some((i) => i.kind === "payload_gap" || i.kind === "type_mismatch" || i.kind === "type_conflict") };
}

/** Human-readable issue lines (Chinese, business-language) for the brain + UI. */
/** #SIMPLIFY — 契约问题的【结构化】分级：硬问题 = 会造成运行期解析爆炸（payload_gap /
 *  type_mismatch / type_conflict，与 graph.ok 的判据一致）；其余是软提示。调用方据此分流，
 *  不再靠 summary 字符串包含判断（旧的 includes("字段缺口") 写法既脆又漏了类型两类硬问题）。 */
export function isHardContractIssue(i: ContractIssue): boolean {
  return i.kind === "payload_gap" || i.kind === "type_mismatch" || i.kind === "type_conflict";
}

/** 按严重度分好组的中文问题描述（validate_graph 的唯一消费入口）。 */
export function contractIssueStringsBySeverity(graph: ContractGraph): { hard: string[]; soft: string[] } {
  const strings = contractIssueStrings(graph);
  const hard: string[] = [];
  const soft: string[] = [];
  graph.issues.forEach((i, idx) => {
    (isHardContractIssue(i) ? hard : soft).push(strings[idx]!);
  });
  return { hard, soft };
}

export function contractIssueStrings(graph: ContractGraph): string[] {
  return graph.issues.map((i) => {
    if (i.kind === "payload_gap") {
      return `字段缺口：事件「${i.event}」的下游需要 [${i.missingFields.join("、")}] 字段，但上游(${i.producers.join("、") || "无"})没有产出`;
    }
    if (i.kind === "untyped_event") {
      const need = i.expectedFields.length ? `，但下游(${i.consumers.join("、")})要读 [${i.expectedFields.join("、")}]` : "";
      return `字段未约定：事件「${i.event}」的上游(${i.producers.join("、")})没说明会产出哪些字段${need}`;
    }
    if (i.kind === "type_mismatch") {
      const who = i.side === "producer" ? "上游产出" : "下游期望";
      return `类型不匹配：事件「${i.event}」的字段「${i.field}」${who} ${i.side === "producer" ? i.actualType : i.expectedType}，与契约类型 ${i.side === "producer" ? i.expectedType : i.actualType} 不一致（会导致下游解析失败 output_parse_error，请对齐类型）`;
    }
    if (i.kind === "type_conflict") {
      const who = i.side === "producer" ? "多个上游" : "多个下游";
      return `类型冲突：事件「${i.event}」的字段「${i.field}」被${who}(${i.agents.join("、")})声明为不同类型 [${i.types.join(" vs ")}]——必须统一，否则总有一方在运行时解析失败`;
    }
    // non_canonical_field
    const who = i.side === "producer" ? "上游" : "下游";
    return `字段超出本体约定：事件「${i.event}」的${who}(${i.agents.join("、")})用到了本体 event_data 未声明的字段 [${i.fields.join("、")}]（运行时靠 envelope 携带；建议补进本体或核对是否写错字段名）`;
  });
}

/** Map each offending agent → its issues, so the brain can refine the exact offender (same shape as
 *  verifyGraph's). Covers producers (gap/untyped) and the agents on either side of a non-canonical field. */
export function contractAgentIssueMap(graph: ContractGraph): Record<string, ContractIssue[]> {
  const map: Record<string, ContractIssue[]> = {};
  for (const issue of graph.issues) {
    const owners = "agents" in issue ? issue.agents : issue.producers;
    for (const owner of owners) {
      (map[owner] ??= []).push(issue);
    }
  }
  return map;
}
