import { describe, it, expect } from "vitest";
import { getCausalityChain, getStoredEvent } from "@agentic/runtime";
import { getDb, eventStore } from "@agentic/db";

// #P1-1 — the durable event store makes cross-agent causality QUERYABLE (the NDJSON ledger can't).
// Seed a 3-hop chain (A → B → C) via causationId and assert the lineage reconstructs.

function put(id: string, name: string, causationId: string | null, subject = "req-es") {
  getDb().insert(eventStore).values({
    id, tenantId: "raas", name, subject, sourceRunId: `run-${id}`, sourceAgent: name,
    causationId, correlationId: "corr-es", payloadJson: JSON.stringify({ n: name }),
  }).run();
}

describe("#P1-1 event store — causality chain", () => {
  it("reconstructs ancestors + descendants across a 3-hop chain", () => {
    const sfx = String(Date.now() % 1e9);
    const a = `evt-a-${sfx}`, b = `evt-b-${sfx}`, c = `evt-c-${sfx}`;
    put(a, "JD_CREATED", null);
    put(b, "RESUME_PROCESSED", a);
    put(c, "MATCH_PASSED", b);

    expect(getStoredEvent(b)?.name).toBe("RESUME_PROCESSED");

    // from the middle event B: ancestor = A, descendant = C
    const mid = getCausalityChain(b);
    expect(mid.ancestors.map((e) => e.id)).toEqual([a]);
    expect(mid.seed?.id).toBe(b);
    expect(mid.descendants.map((e) => e.id)).toEqual([c]);

    // from the root A: no ancestors, descendants = B then C (BFS order)
    const root = getCausalityChain(a);
    expect(root.ancestors).toEqual([]);
    expect(root.descendants.map((e) => e.id)).toEqual([b, c]);
  });

  it("is cycle-safe + returns null seed for an unknown id", () => {
    const r = getCausalityChain("evt-does-not-exist");
    expect(r.seed).toBeNull();
    expect(r.ancestors).toEqual([]);
    expect(r.descendants).toEqual([]);
  });
});
