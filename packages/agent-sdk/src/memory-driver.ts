/**
 * P3-RT-07 — Vector memory driver contract.
 *
 * No driver is selected implicitly: without one, `ctx.memory.search()` raises
 * a "no vector driver configured" error. The runtime ships a local driver and
 * can accept external implementations through `setMemoryDriver()`.
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
 * tenant / agent. Subject is normally left to ranking for cross-subject recall,
 * but `subjectExact` turns it into a mandatory partition for supervised stores.
 * A driver MUST honour `tenantId` and any requested exact-subject constraint.
 */
export interface MemorySearchScope {
  tenantId?: string;
  agentName?: string;
  subject?: string;
  /** When true, the driver MUST restrict candidates to the exact subject.
   * Omitted/false preserves normal cross-subject recall within an agent. */
  subjectExact?: boolean;
}

/**
 * Vector store contract. Implementations are expected to be tenant-scoped at
 * the boundary (the SDK passes the scope through). The interface stays neutral
 * so a single driver can serve multiple tenants by partitioning internally.
 */
export interface MemoryDriver {
  /** Optional write-time embedder. When provided, the authoritative SQLite
   * row stores vectors in the same space this driver's search() uses. */
  embed?(text: string): Promise<number[]>;

  /**
   * Return the top-`k` matches for `query`. The query is plain text; the
   * driver is responsible for whatever embedding model it uses. `scope` (when
   * provided) partitions the search — a tenant-scoped store must honour it.
   */
  search(query: string, k: number, scope?: MemorySearchScope): Promise<MemoryHit[]>;

  /** OPTIONAL write-through hook (#SCALE-PGVECTOR): a driver with its OWN store (pgvector/Qdrant)
   *  mirrors every long-scope KV write so its index stays in sync. SQLite remains the system of
   *  record, but the runtime awaits this hook and propagates failures so callers never receive a
   *  false "fully mirrored" success. `embedding` is the write-time L2-normalized vector (same
   *  space as search queries); null means the driver embeds the value itself. */
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
