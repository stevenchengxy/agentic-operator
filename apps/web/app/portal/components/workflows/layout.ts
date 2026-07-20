/** Geometry shared by the workflow canvas and its live DAG layout. */

export const NODE_W = 184;
export const NODE_H = 64;
export const COL_W = 220;
export const ROW_H = 90;
export const PAD_X = 30;
export const PAD_Y = 30;

/**
 * Derive a (column, lane) grid purely from the live event cascade. No tenant
 * identifiers or hand-authored node positions participate in the result.
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
