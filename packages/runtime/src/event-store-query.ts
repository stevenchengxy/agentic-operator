// #P1-1 — queries over the durable event store. The NDJSON ledger can't answer "what did this event
// cause?" or "why did this run fire?"; the event_store table (full payload + causationId) can. This
// reconstructs a causality chain: ancestors (walk causationId up) + descendants (BFS on causationId).

import { getDb, eventStore, eq, inArray, and } from "@agentic/db";

export interface StoredEvent {
  id: string;
  name: string;
  subject: string | null;
  sourceRunId: string | null;
  sourceAgent: string | null;
  causationId: string | null;
  correlationId: string | null;
}

function row(r: Record<string, unknown> | undefined): StoredEvent | null {
  if (!r) return null;
  return {
    id: String(r.id),
    name: String(r.name),
    subject: (r.subject as string) ?? null,
    sourceRunId: (r.sourceRunId as string) ?? null,
    sourceAgent: (r.sourceAgent as string) ?? null,
    causationId: (r.causationId as string) ?? null,
    correlationId: (r.correlationId as string) ?? null,
  };
}

export function getStoredEvent(id: string): StoredEvent | null {
  return row(getDb().select().from(eventStore).where(eq(eventStore.id, id)).all()[0] as Record<string, unknown> | undefined);
}

/** Reconstruct the causality chain around a seed event: ancestors (its causes, oldest→newest) and
 *  descendants (what it caused, BFS). Cycle-safe + depth-capped. */
export function getCausalityChain(seedId: string, opts: { maxDepth?: number; tenantId?: string } = {}): { ancestors: StoredEvent[]; seed: StoredEvent | null; descendants: StoredEvent[] } {
  const db = getDb();
  const maxDepth = opts.maxDepth ?? 50;
  const seed = getStoredEvent(seedId);

  // Ancestors: follow causationId up the chain.
  const ancestors: StoredEvent[] = [];
  const seenA = new Set<string>([seedId]);
  let cur = seed?.causationId ?? null;
  for (let d = 0; cur && d < maxDepth && !seenA.has(cur); d++) {
    const a = getStoredEvent(cur);
    if (!a) break;
    seenA.add(a.id);
    ancestors.unshift(a); // oldest first
    cur = a.causationId;
  }

  // Descendants: BFS on causationId == current id.
  const descendants: StoredEvent[] = [];
  const seenD = new Set<string>([seedId]);
  let frontier = [seedId];
  for (let d = 0; d < maxDepth && frontier.length; d++) {
    // #W1-7 — ONE batched query per BFS level (was one per parent = N+1; a deep chain cost 100+
    // queries). Optional tenant scope keeps chains from crossing tenant boundaries at the API layer.
    const where = opts.tenantId
      ? and(inArray(eventStore.causationId, frontier), eq(eventStore.tenantId, opts.tenantId))
      : inArray(eventStore.causationId, frontier);
    const kids = db.select().from(eventStore).where(where).all() as Record<string, unknown>[];
    const next: string[] = [];
    for (const k of kids) {
      const ev = row(k)!;
      if (seenD.has(ev.id)) continue;
      seenD.add(ev.id);
      descendants.push(ev);
      next.push(ev.id);
    }
    frontier = next;
  }

  return { ancestors, seed, descendants };
}
