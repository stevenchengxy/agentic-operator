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

export type FieldSpec = { field: string; type: string; source?: string };

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
  | { kind: "untyped_event"; event: string; producers: string[] };

export type ContractGraph = {
  domain: string;
  agents: AgentContract[];
  events: EventContract[];
  issues: ContractIssue[];
  /** payload contract holds (no gaps / untyped internal events) */
  ok: boolean;
};

const FAILISH = /FAIL|REJECT|ERROR|CONFLICT|MISSING|DENIED/i;
const isFailure = (ev: string) => FAILISH.test(ev);
const ioToField = (io: IoField): FieldSpec => ({ field: io.field, type: io.type, source: io.source });

function dedupeFields(fs: FieldSpec[]): FieldSpec[] {
  const m = new Map<string, FieldSpec>();
  for (const f of fs) if (f.field && !m.has(f.field)) m.set(f.field, f);
  return [...m.values()];
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

  const events: EventContract[] = allEvents.map((name) => {
    const producers = agents.filter((a) => a.outputEvents.includes(name));
    const consumers = agents.filter((a) => a.triggerEvents.includes(name));
    // R1: canonical event_data fields are authoritatively provided by the event type itself.
    const canonical = eventFields?.get(name) ?? [];
    const providedFields = dedupeFields([...canonical, ...producers.flatMap((p) => p.outputFields)]);
    const expectedFields = dedupeFields(consumers.flatMap((c) => c.inputFields));
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

  const issues: ContractIssue[] = [];
  for (const e of events) {
    if (e.payloadGaps.length) {
      issues.push({ kind: "payload_gap", event: e.name, missingFields: e.payloadGaps, consumers: e.consumers, producers: e.producers });
    }
    // An internal (non-entry, non-failure) event whose producer declared NO output
    // fields is "free JSON" — the consumer is reading an untyped payload. Skip
    // failure events (often signal-only) and pure entry events (external shape).
    if (e.producers.length && e.consumers.length && e.providedFields.length === 0 && !e.isFailure) {
      issues.push({ kind: "untyped_event", event: e.name, producers: e.producers });
    }
  }

  // A payload_gap is a real contract violation (a consumer reads a field nobody
  // writes). An untyped_event is a softer warning (free JSON) that shouldn't by
  // itself fail the contract — so `ok` gates only on real gaps.
  return { domain, agents, events, issues, ok: !issues.some((i) => i.kind === "payload_gap") };
}

/** Human-readable issue lines (Chinese, business-language) for the brain + UI. */
export function contractIssueStrings(graph: ContractGraph): string[] {
  return graph.issues.map((i) =>
    i.kind === "payload_gap"
      ? `字段缺口：事件「${i.event}」的下游需要 [${i.missingFields.join("、")}] 字段，但上游(${i.producers.join("、") || "无"})没有产出`
      : `字段未约定：事件「${i.event}」的上游(${i.producers.join("、")})没说明会产出哪些字段`,
  );
}

/** Map each offending agent (producer of a gapped/untyped event) → its issues,
 *  so the brain can refine the exact offender (same shape as verifyGraph's). */
export function contractAgentIssueMap(graph: ContractGraph): Record<string, ContractIssue[]> {
  const map: Record<string, ContractIssue[]> = {};
  for (const issue of graph.issues) {
    for (const producer of issue.producers) {
      (map[producer] ??= []).push(issue);
    }
  }
  return map;
}
