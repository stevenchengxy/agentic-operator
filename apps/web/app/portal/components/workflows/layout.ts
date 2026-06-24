/**
 * Workflow canvas layout constants + the hand-tuned LAYOUT map.
 *
 * Ported verbatim from `agentic-operator_v1_1/views/workflows.jsx:5-37`.
 * **DO NOT** replace this with auto-packing for the RAAS workflow — every
 * value here was hand-tuned to match the design prototype (audit 01 §4.2
 * acceptance criterion). The auto-packer below is ONLY consulted as a
 * fallback for tenant kebab-ids that LAYOUT doesn't cover (e.g. robohire's
 * `matcher-agent` / `inviter-agent`); existing LAYOUT entries always win.
 */

export const NODE_W = 184;
export const NODE_H = 64;
export const COL_W = 220;
export const ROW_H = 90;
export const PAD_X = 30;
export const PAD_Y = 30;

/**
 * Maps node kebab-id → (stage column, lane row). Every node in the RAAS
 * workflow has an explicit position.
 */
export const LAYOUT: Record<string, { stage: number; lane: number }> = {
  "1-1": { stage: 0, lane: 0 },
  "1-2": { stage: 0, lane: 1 },
  "2": { stage: 1, lane: 0 },
  "3": { stage: 1, lane: 1 },
  "3-2": { stage: 1, lane: 2 },
  "4": { stage: 2, lane: 0 },
  "5": { stage: 2, lane: 1 },
  "6": { stage: 3, lane: 0 },
  "7-1": { stage: 3, lane: 1 },
  "7-2": { stage: 3, lane: 2 },
  "8": { stage: 4, lane: 0 },
  "9-1": { stage: 4, lane: 1 },
  "9-2": { stage: 4, lane: 2 },
  "10-1": { stage: 5, lane: 0 },
  "10-2": { stage: 5, lane: 1 },
  "11-1": { stage: 5, lane: 2 },
  "11-2": { stage: 5, lane: 3 },
  "12": { stage: 5, lane: 4 },
  "13": { stage: 6, lane: 0 },
  "14-1": { stage: 6, lane: 1 },
  "14-2": { stage: 6, lane: 2 },
  "15": { stage: 6, lane: 3 },
  "16": { stage: 7, lane: 1 },
};

/**
 * Auto-pack a set of agents into the (stage, lane) grid for tenants that
 * don't have a hand-tuned LAYOUT entry. Used as a fallback by `getLayout()`.
 *
 * Strategy — bucket by stage, then assign lanes within each bucket:
 *   1. If every agent shares the same stage (the api uses 99 as the
 *      "unknown stage" sentinel when a manifest doesn't declare staging),
 *      derive stages from the event topology instead: agents with no
 *      incoming triggers from this tenant land at stage 0; downstream
 *      listeners land at stage = 1 + max(stage of upstream emitters).
 *      This gives `matcher-agent → MATCH_COMPLETED → inviter-agent` the
 *      natural left-to-right layout (matcher in col 0, inviter in col 1).
 *   2. Otherwise pass the manifest-declared stage through unchanged so a
 *      tenant that DOES declare stages keeps them.
 *   3. Sort agent ids inside each bucket by string compare so the same
 *      input always produces the same lane assignment (deterministic).
 *
 * Stable: same input array → identical output. The function never mutates
 * input.
 */
export function autoPackLayout(
  agents: Array<{
    id: string;
    stage: number;
    triggers?: string[];
    emits?: string[];
  }>,
): Record<string, { stage: number; lane: number }> {
  if (agents.length === 0) return {};

  // Step 1: decide effective stage per agent.
  //   - Mixed manifest stages → pass through.
  //   - All-same stage (typical: every agent at stage 99) → topo-sort.
  const declared = new Set(agents.map((a) => a.stage));
  const effectiveStage = new Map<string, number>();

  if (declared.size === 1) {
    // Topo-sort: who emits an event that anyone else triggers on?
    const emitterOf = new Map<string, string[]>(); // event → agent ids that emit it
    for (const a of agents) {
      for (const e of a.emits ?? []) {
        const arr = emitterOf.get(e) ?? [];
        arr.push(a.id);
        emitterOf.set(e, arr);
      }
    }
    // Memoized depth — guard against accidental cycles by capping at agents.length.
    const depth = new Map<string, number>();
    const visiting = new Set<string>();
    function depthOf(id: string): number {
      const cached = depth.get(id);
      if (cached !== undefined) return cached;
      if (visiting.has(id)) return 0; // cycle break
      visiting.add(id);
      const agent = agents.find((a) => a.id === id);
      const triggers = agent?.triggers ?? [];
      let maxParent = -1;
      for (const t of triggers) {
        const parents = emitterOf.get(t) ?? [];
        for (const p of parents) {
          if (p === id) continue;
          maxParent = Math.max(maxParent, depthOf(p));
        }
      }
      const d = maxParent + 1; // 0 when no parents
      depth.set(id, d);
      visiting.delete(id);
      return d;
    }
    for (const a of agents) {
      effectiveStage.set(a.id, Math.min(depthOf(a.id), agents.length));
    }
  } else {
    for (const a of agents) effectiveStage.set(a.id, a.stage);
  }

  // Step 2: bucket by stage, sort ids stably, assign lanes.
  const byStage = new Map<number, string[]>();
  for (const a of agents) {
    const s = effectiveStage.get(a.id) ?? 0;
    const arr = byStage.get(s) ?? [];
    arr.push(a.id);
    byStage.set(s, arr);
  }
  const out: Record<string, { stage: number; lane: number }> = {};
  for (const [stage, ids] of byStage) {
    const sorted = [...ids].sort();
    sorted.forEach((id, lane) => {
      out[id] = { stage, lane };
    });
  }
  return out;
}

/**
 * topoLayout — derive a (column, lane) grid PURELY from the live event
 * cascade, ignoring any manifest/kebab "stage" hint. This is what makes the
 * canvas render in real time from the agents for any tenant that ISN'T the
 * hand-tuned RAAS workflow (which keeps `LAYOUT`).
 *
 * Columns:
 *   - A "connected" agent (emits an event another agent triggers on, or vice
 *     versa) gets `column = longest predecessor chain` (forward topo depth),
 *     so `processResume → ruleCheck → matchResume` reads left → right.
 *   - An "island" agent (no intra-tenant edges — e.g. createJD, whose
 *     JD_GENERATED has no internal consumer, or inviteInternalInterview, whose
 *     trigger is an external-boundary event) carries no event-flow signal, so
 *     we order it by its kebab-id sequence (the author's intended business
 *     order): it lands one column right of the furthest connected agent whose
 *     kebab-id sorts before it. That puts createJD first and the invite step
 *     last instead of stranding both in column 0.
 *
 * Lanes: agents in a column are stacked in natural kebab order ("9-1" before
 * "10-1"), deterministic for a given input.
 */
export function topoLayout(
  agents: Array<{ id: string; triggers?: string[]; emits?: string[] }>,
): Record<string, { stage: number; lane: number }> {
  if (agents.length === 0) return {};
  const natCmp = (a: string, b: string) =>
    a.localeCompare(b, undefined, { numeric: true });

  // event → ids that emit it; and per-agent in/out edge presence.
  const emitterOf = new Map<string, string[]>();
  for (const a of agents) {
    for (const e of a.emits ?? []) {
      const arr = emitterOf.get(e) ?? [];
      arr.push(a.id);
      emitterOf.set(e, arr);
    }
  }
  const triggersOf = new Map<string, string[]>(
    agents.map((a) => [a.id, a.triggers ?? []]),
  );
  const hasEdge = new Map<string, boolean>();
  for (const a of agents) {
    const inEdge = (a.triggers ?? []).some(
      (t) => (emitterOf.get(t) ?? []).some((p) => p !== a.id),
    );
    const outEdge = (a.emits ?? []).some((e) =>
      agents.some((b) => b.id !== a.id && (b.triggers ?? []).includes(e)),
    );
    hasEdge.set(a.id, inEdge || outEdge);
  }

  // Forward topo depth (cycle-guarded), used for connected agents.
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  function depthOf(id: string): number {
    const cached = depth.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    let maxParent = -1;
    for (const t of triggersOf.get(id) ?? []) {
      for (const p of emitterOf.get(t) ?? []) {
        if (p !== id) maxParent = Math.max(maxParent, depthOf(p));
      }
    }
    const d = Math.min(maxParent + 1, agents.length);
    depth.set(id, d);
    visiting.delete(id);
    return d;
  }
  for (const a of agents) depthOf(a.id);

  // Column per agent: connected → topo depth; island → kebab-sequenced.
  const column = new Map<string, number>();
  for (const a of agents) {
    if (hasEdge.get(a.id)) {
      column.set(a.id, depth.get(a.id) ?? 0);
    } else {
      let maxBelow = -1;
      for (const b of agents) {
        if (b.id === a.id || !hasEdge.get(b.id)) continue;
        if (natCmp(b.id, a.id) < 0) {
          maxBelow = Math.max(maxBelow, depth.get(b.id) ?? 0);
        }
      }
      column.set(a.id, maxBelow + 1);
    }
  }

  // Bucket by column, assign lanes in natural kebab order.
  const byCol = new Map<number, string[]>();
  for (const a of agents) {
    const c = column.get(a.id) ?? 0;
    const arr = byCol.get(c) ?? [];
    arr.push(a.id);
    byCol.set(c, arr);
  }
  const out: Record<string, { stage: number; lane: number }> = {};
  for (const [col, ids] of byCol) {
    [...ids].sort(natCmp).forEach((id, lane) => {
      out[id] = { stage: col, lane };
    });
  }
  return out;
}

/**
 * Resolve a position for an agent. Hand-tuned LAYOUT entry wins; falls back
 * to the auto-packed map (typically the output of `autoPackLayout` for the
 * current tenant). Returns null when neither has an entry — caller decides
 * whether to skip rendering or render at origin.
 */
export function getLayout(
  id: string,
  fallback?: Record<string, { stage: number; lane: number }>,
): { stage: number; lane: number } | null {
  return LAYOUT[id] ?? fallback?.[id] ?? null;
}

export function nodePos(
  id: string,
  fallback?: Record<string, { stage: number; lane: number }>,
): { x: number; y: number } {
  const p = getLayout(id, fallback);
  if (!p) return { x: 0, y: 0 };
  return {
    x: PAD_X + p.stage * COL_W,
    y: PAD_Y + p.lane * ROW_H,
  };
}

export function colorVar(c: string | undefined | null): string {
  const map: Record<string, string> = {
    green: "var(--green)",
    blue: "var(--blue)",
    amber: "var(--amber)",
    red: "var(--red)",
    muted: "var(--text-3)",
  };
  return map[c ?? ""] ?? "var(--text-3)";
}

/** Maximum stage/lane in the LAYOUT map — drives canvas size. */
export const MAX_STAGE = 7;
export const MAX_LANE = 4;

export const CANVAS_W = PAD_X * 2 + (MAX_STAGE + 1) * COL_W;
export const CANVAS_H = PAD_Y * 2 + (MAX_LANE + 1) * ROW_H;
