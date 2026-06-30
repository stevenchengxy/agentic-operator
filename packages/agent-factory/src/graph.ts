// Agent Factory — orchestration graph compiler + verifier.
//
// The discipline a naive pipeline lacks: COMPILE the event-orchestration graph
// from the ontology and statically VERIFY its closure BEFORE generating any code.
//
// Data model (verified against recruit-gen-v1):
//   - actions emit via `triggered_event[]` (NOT `emit`, which is null)
//   - `triggered_event` is multi-value / conditional (e.g. parseResume emits
//     ["RESUME_PROCESSED","RESUME_LOCKED_CONFLICT"]) → each emit is a branch edge
//   - actions consume via `trigger[]`
//
// An edge A --e--> B exists when event `e` is in A.triggered_event AND in
// B.trigger. The event name on the edge IS the business branch predicate.
// Ported from the OLD repo's lib/agent-factory-v3/graph.ts (pure, no IO/LLM).

import type { OntologyAction } from "./ontology-types";

/** One action as a graph node. */
export type GraphNode = {
  action: string; // action.name (camelCase, the make-agent behavior key)
  actor: string[];
  triggers: string[]; // consumed events
  emits: string[]; // triggered_event (emitted)
  tools: string[]; // tool_use
  isEntry: boolean; // consumes an entry event (not produced by any node)
  isTerminal: boolean; // emits a terminal event (consumed by no node)
  isHitl: boolean; // human-in-the-loop (actor includes Human, or a gate side-effect)
  isBranch: boolean; // emits >1 event → conditional branch
};

/** A directed, event-labeled edge — the label is the branch condition. */
export type GraphEdge = {
  from: string; // producer action.name
  to: string; // consumer action.name
  event: string; // the connecting event (branch predicate)
};

export type DomainGraph = {
  domainId: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  entryEvents: string[]; // consumed but emitted by no node (external entry points)
  terminalEvents: string[]; // emitted but consumed by no node (workflow leaves)
  branchActions: string[]; // node.action where emits.length > 1
  terminalActions: string[]; // node.action that is terminal
  hitlActions: string[]; // node.action where isHitl
};

export type GraphIssue =
  | { kind: "orphan_emit"; action: string; event: string } // emits a non-catalog, non-terminal event
  | { kind: "missing_producer"; action: string; event: string } // consumes an event nobody emits (not an entry)
  | { kind: "unreachable_node"; action: string } // not reachable from any entry node
  | { kind: "no_entry" } // graph has no entry node at all
  | { kind: "no_terminal" }; // graph never reaches a terminal

export type VerifyResult = {
  ok: boolean;
  issues: GraphIssue[];
  reachable: string[]; // action names reachable from entry
};

const HUMAN_ACTORS = new Set(["Human", "human", "人工", "HITL"]);

function isHitlAction(a: OntologyAction): boolean {
  if (a.actor.some((x) => HUMAN_ACTORS.has(x))) return true;
  // gate side-effect heuristic: a side_effect that mentions a gate / waitForEvent / human decision
  const se = JSON.stringify(a.side_effects ?? {}).toLowerCase();
  return se.includes("gate") || se.includes("waitforevent") || se.includes("human_decision");
}

/**
 * Compile a domain's actions into an event-orchestration graph.
 *
 * @param actions  the ontology actions (nodes)
 * @param opts.domainId  label
 * @param opts.knownEvents  optional authoritative event catalog (names). When
 *   provided, an emit to a name NOT in the catalog and consumed by nobody is an
 *   `orphan_emit`; otherwise leaves are treated as legitimate terminals.
 */
export function compileGraph(
  actions: OntologyAction[],
  opts: { domainId: string; knownEvents?: string[] },
): DomainGraph {
  const consumed = new Set<string>();
  const emitted = new Set<string>();
  for (const a of actions) {
    a.trigger.forEach((e) => consumed.add(e));
    a.triggered_event.forEach((e) => emitted.add(e));
  }

  const entryEvents = [...consumed].filter((e) => !emitted.has(e)).sort();
  const terminalEvents = [...emitted].filter((e) => !consumed.has(e)).sort();
  const entrySet = new Set(entryEvents);
  const terminalSet = new Set(terminalEvents);

  // index: event -> consumer action names
  const consumersOf = new Map<string, string[]>();
  for (const a of actions) {
    for (const e of a.trigger) {
      const arr = consumersOf.get(e) ?? [];
      arr.push(a.name);
      consumersOf.set(e, arr);
    }
  }

  const nodes: GraphNode[] = actions.map((a) => ({
    action: a.name,
    actor: a.actor,
    triggers: a.trigger,
    emits: a.triggered_event,
    tools: a.tool_use,
    isEntry: a.trigger.some((e) => entrySet.has(e)),
    isTerminal: a.triggered_event.some((e) => terminalSet.has(e)),
    isHitl: isHitlAction(a),
    isBranch: a.triggered_event.length > 1,
  }));

  const edges: GraphEdge[] = [];
  for (const a of actions) {
    for (const e of a.triggered_event) {
      for (const to of consumersOf.get(e) ?? []) {
        edges.push({ from: a.name, to, event: e });
      }
    }
  }

  return {
    domainId: opts.domainId,
    nodes,
    edges,
    entryEvents,
    terminalEvents,
    branchActions: nodes.filter((n) => n.isBranch).map((n) => n.action),
    terminalActions: nodes.filter((n) => n.isTerminal).map((n) => n.action),
    hitlActions: nodes.filter((n) => n.isHitl).map((n) => n.action),
  };
}

/**
 * Deterministic completeness. The set of actor=Agent action names that have NO
 * covering spec yet. The "checklist" is re-derived from the live ontology, so it
 * is ADAPTIVE (varies per domain) — never a hardcoded agent list. It matches the
 * exact universe read_ontology exposes to the brain: actions whose actor includes
 * "Agent" (a pure Human / System action is not an agent the factory must build).
 *
 * This is an ACCEPTANCE CRITERION, not a fallback: a non-empty gap means the run
 * has not produced a working agent for every action — the finish tool fails on it
 * (no force-allow, no degraded shells). Fully-AI: the brain must cover the spec.
 */
export function coverageGap(
  actions: ReadonlyArray<{ name: string; actor: string[] }>,
  coveredActionNames: Iterable<string>,
): string[] {
  const covered = new Set(coveredActionNames);
  return actions
    .filter((a) => a.actor.includes("Agent"))
    .map((a) => a.name)
    .filter((name) => !covered.has(name));
}

/**
 * Statically verify graph closure. A healthy graph has: every consumed event is
 * produced or is an entry event; every emitted event is consumed or is a
 * terminal event; at least one entry and one terminal; every node reachable.
 *
 * Pass `knownEntries` / `knownTerminals` (the AUTHORITATIVE sets from the
 * ground-truth ontology) when verifying a *generated/proposed* graph — then a
 * dangling emit the generator invented is caught, because it won't be in the
 * authoritative terminal set. Omit them to verify a self-contained graph against
 * its own intrinsic leaves.
 */
export function verifyGraph(
  graph: DomainGraph,
  opts: { knownEntries?: string[]; knownTerminals?: string[]; boundaryEvents?: string[] } = {},
): VerifyResult {
  const issues: GraphIssue[] = [];
  // Events the USER classified as legitimate boundary events (external handoff / terminal):
  // consumer-less ON PURPOSE, so they must NOT be flagged as orphan/broken.
  const boundarySet = new Set(opts.boundaryEvents ?? []);

  const emitted = new Set<string>();
  const consumed = new Set<string>();
  for (const n of graph.nodes) {
    n.emits.forEach((e) => emitted.add(e));
    n.triggers.forEach((e) => consumed.add(e));
  }
  const entrySet = new Set(opts.knownEntries ?? graph.entryEvents);
  const terminalSet = new Set(opts.knownTerminals ?? graph.terminalEvents);

  // missing producer: consumes e, but nobody emits e and e is not an entry event
  for (const n of graph.nodes) {
    for (const e of n.triggers) {
      if (!emitted.has(e) && !entrySet.has(e)) {
        issues.push({ kind: "missing_producer", action: n.action, event: e });
      }
    }
  }
  // orphan emit: emits e, nobody consumes e, e is not a (known) terminal event, and the
  // user has not classified it as a boundary event (external handoff / terminal).
  for (const n of graph.nodes) {
    for (const e of n.emits) {
      if (!consumed.has(e) && !terminalSet.has(e) && !boundarySet.has(e)) {
        issues.push({ kind: "orphan_emit", action: n.action, event: e });
      }
    }
  }

  // reachability from entry nodes
  const entryNodes = graph.nodes.filter((n) => n.isEntry).map((n) => n.action);
  if (entryNodes.length === 0) issues.push({ kind: "no_entry" });
  if (graph.terminalActions.length === 0) issues.push({ kind: "no_terminal" });

  const adj = new Map<string, string[]>();
  for (const e of graph.edges) {
    const arr = adj.get(e.from) ?? [];
    arr.push(e.to);
    adj.set(e.from, arr);
  }
  const reachable = new Set<string>();
  const queue = [...entryNodes];
  while (queue.length) {
    const cur = queue.shift()!;
    if (reachable.has(cur)) continue;
    reachable.add(cur);
    for (const nxt of adj.get(cur) ?? []) if (!reachable.has(nxt)) queue.push(nxt);
  }
  for (const n of graph.nodes) {
    if (!reachable.has(n.action)) {
      issues.push({ kind: "unreachable_node", action: n.action });
    }
  }

  return { ok: issues.length === 0, issues, reachable: [...reachable].sort() };
}
