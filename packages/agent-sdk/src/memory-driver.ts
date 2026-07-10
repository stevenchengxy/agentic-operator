/**
 * P3-RT-07 — Vector memory driver contract.
 *
 * Interface only. v1 ships no implementation; the default driver is `null`
 * and any call to `ctx.memory.search()` raises a "no vector driver
 * configured" error so authors get a clear signal that they need to plug a
 * driver in.
 *
 * v2 candidates: SQLite-VSS, pgvector, Qdrant, Pinecone. Each ships as its
 * own package that exports a `MemoryDriver` implementation; ops wires it
 * into the runtime via `setMemoryDriver()` (next phase).
 */

/**
 * A single hit returned by a vector search. The shape is deliberately small;
 * richer metadata can ride on `meta` so drivers don't have to converge on a
 * complex envelope upfront.
 */
export interface MemoryHit {
  /** Stored row id (driver-internal). */
  id: string;
  /** Original document/value, JSON-decoded if it was stashed via the KV side. */
  value: unknown;
  /** Similarity score in [0,1]; some drivers return distance — normalize at the boundary. */
  score: number;
  /** Free-form metadata: source agent, subject, etc. */
  meta?: Record<string, unknown>;
}

/**
 * Scope threaded from the SDK boundary so a driver can partition its search by
 * tenant / agent (subject is intentionally left to the driver's ranking, so
 * cross-subject semantic recall works). All fields optional — a driver may
 * ignore them, but a tenant-scoped store MUST honour `tenantId` for isolation.
 */
export interface MemorySearchScope {
  tenantId?: string;
  agentName?: string;
  subject?: string;
}

/**
 * Vector store contract. Implementations are expected to be tenant-scoped at
 * the boundary (the SDK passes the scope through). The interface stays neutral
 * so a single driver can serve multiple tenants by partitioning internally.
 */
export interface MemoryDriver {
  /**
   * Return the top-`k` matches for `query`. The query is plain text; the
   * driver is responsible for whatever embedding model it uses. `scope` (when
   * provided) partitions the search — a tenant-scoped store must honour it.
   */
  search(query: string, k: number, scope?: MemorySearchScope): Promise<MemoryHit[]>;

  /** OPTIONAL write-through hook (#SCALE-PGVECTOR): a driver with its OWN store (pgvector/Qdrant)
   *  mirrors every long-scope KV write so its index stays in sync. SQLite remains the system of
   *  record — the runtime calls this fire-and-forget after the KV upsert. `embedding` is the
   *  write-time L2-normalized vector (same space as search queries); null → driver embeds itself. */
  mirror?(row: MemoryMirrorRow): Promise<void>;

  /** OPTIONAL delete hook — keeps the mirror in sync with KV deletes. */
  deleteMirror?(row: { tenantId: string; agentName: string; subject: string; key: string }): Promise<void>;
}

/** One long-scope KV write, as handed to MemoryDriver.mirror(). */
export interface MemoryMirrorRow {
  tenantId: string;
  agentName: string;
  subject: string;
  key: string;
  valueJson: string;
  embedding?: number[] | null;
  expiresAt?: Date | null;
}

/**
 * Sentinel error raised when an agent calls `ctx.memory.search()` without a
 * driver registered. The api error surface converts this into a 501 so the
 * portal can show "configure a vector driver" rather than a 5xx.
 */
export class NoMemoryDriverError extends Error {
  readonly code = "no_memory_driver";
  constructor(message = "no vector driver configured") {
    super(message);
    this.name = "NoMemoryDriverError";
  }
}
