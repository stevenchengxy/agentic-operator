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
  | { kind: "no_terminal" } // graph never reaches a terminal
  | { kind: "dead_end"; action: string } // #AUDIT-FIX(P2-02) reachable but can't reach any terminal (困在环/死路)
  // #IAL — UNBOUNDED event cycle: actions re-triggering each other through events with NO
  // human-in-the-loop node inside the cycle. At the fleet level such a cycle re-fires Inngest
  // functions indefinitely (per-function retries/concurrency do NOT bound cross-function
  // re-triggering). Evidence: arXiv 2607.01641 — of 68 confirmed infinite agentic loops, 100%
  // lacked a stopping bound ON THE FEEDBACK PATH itself; a HITL gate IS such a bound (a human
  // must act each iteration), so HITL-containing cycles are NOT flagged.
  | { kind: "cycle"; actions: string[]; events: string[] };

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

  // #AUDIT-FIX(P2-02) — 反向可达：只验"从入口可达"会漏掉"到不了任何终态"的分支（困在环里/死路）。
  // 从所有终态动作沿【反向边】BFS；任何 reachable 但反向到不了终态的节点 = dead_end。
  if (graph.terminalActions.length > 0) {
    const radj = new Map<string, string[]>();
    for (const e of graph.edges) { const arr = radj.get(e.to) ?? []; arr.push(e.from); radj.set(e.to, arr); }
    const canReachTerminal = new Set<string>(graph.terminalActions);
    const rq = [...graph.terminalActions];
    while (rq.length) {
      const cur = rq.shift()!;
      for (const prev of radj.get(cur) ?? []) if (!canReachTerminal.has(prev)) { canReachTerminal.add(prev); rq.push(prev); }
    }
    for (const n of graph.nodes) {
      if (reachable.has(n.action) && !canReachTerminal.has(n.action) && !graph.terminalActions.includes(n.action)) {
        issues.push({ kind: "dead_end", action: n.action });
      }
    }
  }

  // #IAL — unbounded event-cycle detection (Tarjan SCC, iterative — ontology graphs are small
  // but recursion depth must not depend on input). A cyclic SCC (size>1, or a self-loop) whose
  // member actions include NO HITL node has no stopping bound on the feedback path → flag it.
  // HITL inside the cycle = a human must act every iteration = a verified bound → not flagged.
  {
    const hitl = new Set(graph.hitlActions);
    const index = new Map<string, number>();
    const low = new Map<string, number>();
    const onStack = new Set<string>();
    const stack: string[] = [];
    let counter = 0;
    const sccs: string[][] = [];
    for (const start of graph.nodes.map((n) => n.action)) {
      if (index.has(start)) continue;
      // iterative Tarjan: frames of [node, childIdx]
      const frames: Array<[string, number]> = [[start, 0]];
      while (frames.length) {
        const frame = frames[frames.length - 1]!;
        const [v] = frame;
        if (frame[1] === 0) {
          index.set(v, counter);
          low.set(v, counter);
          counter++;
          stack.push(v);
          onStack.add(v);
        }
        const children = adj.get(v) ?? [];
        if (frame[1] < children.length) {
          const w = children[frame[1]]!;
          frame[1]++;
          if (!index.has(w)) frames.push([w, 0]);
          else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!));
        } else {
          if (low.get(v) === index.get(v)) {
            const comp: string[] = [];
            for (;;) {
              const w = stack.pop()!;
              onStack.delete(w);
              comp.push(w);
              if (w === v) break;
            }
            sccs.push(comp);
          }
          frames.pop();
          if (frames.length) {
            const parent = frames[frames.length - 1]![0];
            low.set(parent, Math.min(low.get(parent)!, low.get(v)!));
          }
        }
      }
    }
    const selfLoop = new Set(graph.edges.filter((e) => e.from === e.to).map((e) => e.from));
    for (const comp of sccs) {
      const cyclic = comp.length > 1 || (comp.length === 1 && selfLoop.has(comp[0]!));
      if (!cyclic) continue;
      if (comp.some((a) => hitl.has(a))) continue; // human gate bounds every iteration
      const inComp = new Set(comp);
      const cycleEvents = [...new Set(graph.edges.filter((e) => inComp.has(e.from) && inComp.has(e.to)).map((e) => e.event))].sort();
      issues.push({ kind: "cycle", actions: [...comp].sort(), events: cycleEvents });
    }
  }

  return { ok: issues.length === 0, issues, reachable: [...reachable].sort() };
}
