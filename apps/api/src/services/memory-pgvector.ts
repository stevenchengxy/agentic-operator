// #SCALE-PGVECTOR — Postgres/pgvector memory driver. Config-flip: set AGENTIC_PGVECTOR_URL to a
// pgvector-enabled Postgres (e.g. the `agentic-pgvector` docker container) and vector recall moves
// from the in-process SQLite scan to a real ANN index (HNSW, cosine). Architecture stays honest:
//
//   - SQLite remains the SYSTEM OF RECORD (put/get/delete untouched — no better-sqlite3 migration).
//   - Every long-scope KV write synchronously MIRRORS into Postgres (MemoryDriver.mirror hook);
//     callers do not receive success until the vector index acknowledges the write.
//   - search() runs `embedding <=> query` on the HNSW index. Once pgvector is configured, search,
//     mirror, and delete failures propagate explicitly; they never masquerade as local/empty results.
//   - Query and write embeddings share one validated 256-dimensional, L2-normalized embedder.
//
// `pg` is a small pure-JS dependency of apps/api (the composition root) — @agentic/runtime stays
// dependency-free (it only defines the mirror hooks).

import {
  setMemoryDriver,
  getMemoryDriver,
  localEmbed,
  openaiEmbedder,
} from "@agentic/runtime";
import type {
  MemoryDriver,
  MemoryHit,
  MemoryMirrorRow,
  MemorySearchScope,
} from "@agentic/agent-sdk";

const DIM = 256;
const TABLE = "agent_memory_vectors";

export interface PgPoolLike {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>> }>;
  end(): Promise<void>;
}

export type PgVectorEmbedder = (
  text: string,
) => Float32Array | number[] | Promise<Float32Array | number[]>;

let pool: PgPoolLike | null = null;
let activeDriver: MemoryDriver | null = null;
let previousDriver: MemoryDriver | null = null;
let embeddingProbeCache: {
  signature: string;
  checkedAt: number;
  result: MemoryEmbedderHealth;
} | null = null;

export interface MemoryEmbedderHealth {
  configured: boolean;
  ok: boolean;
  checkedAt?: number;
  dimensions?: number;
  note?: string;
}

export class ConfiguredMemoryEmbedderUnavailableError extends Error {
  override readonly cause: unknown;

  constructor(cause: unknown) {
    super(
      "MEMORY_EMBED_MODEL is configured but the embedding endpoint failed its readiness probe",
    );
    this.name = "ConfiguredMemoryEmbedderUnavailableError";
    this.cause = cause;
  }
}

/** A configured remote embedder is a hard runtime dependency even when the
 * vector index itself remains local. Probe it without exposing its URL/key. */
export async function configuredMemoryEmbedderHealth(
  opts: {
    force?: boolean;
    maxAgeMs?: number;
    embedder?: PgVectorEmbedder;
    env?: Record<string, string | undefined>;
  } = {},
): Promise<MemoryEmbedderHealth> {
  const env = opts.env ?? process.env;
  const model = env.MEMORY_EMBED_MODEL?.trim();
  if (!model) return { configured: false, ok: true };
  const signature = `${model}\u0000${env.MEMORY_EMBED_BASE_URL ?? env.LLM_GATEWAY_BASE_URL ?? env.OPENAI_BASE_URL ?? ""}\u0000${env.MEMORY_EMBED_DIMENSIONS ?? ""}`;
  const maxAgeMs = Math.max(0, opts.maxAgeMs ?? 60_000);
  if (
    !opts.force &&
    embeddingProbeCache?.signature === signature &&
    Date.now() - embeddingProbeCache.checkedAt <= maxAgeMs
  ) {
    return embeddingProbeCache.result;
  }
  const checkedAt = Date.now();
  try {
    const embedder = opts.embedder ?? openaiEmbedder(env);
    if (!embedder) throw new Error("configured embedder was not constructed");
    const vector = Array.from(
      await embedder("agentic memory embedding readiness probe"),
    );
    if (
      !vector.length ||
      vector.some((component) => !Number.isFinite(component))
    ) {
      throw new Error("embedding endpoint returned an invalid vector");
    }
    const result: MemoryEmbedderHealth = {
      configured: true,
      ok: true,
      checkedAt,
      dimensions: vector.length,
    };
    embeddingProbeCache = { signature, checkedAt, result };
    return result;
  } catch (error) {
    const result: MemoryEmbedderHealth = {
      configured: true,
      ok: false,
      checkedAt,
      note: "configured embedding endpoint is unreachable or returned an invalid vector",
    };
    embeddingProbeCache = { signature, checkedAt, result };
    return result;
  }
}

export async function assertConfiguredMemoryEmbedderReady(
  embedder?: PgVectorEmbedder,
): Promise<MemoryEmbedderHealth> {
  const health = await configuredMemoryEmbedderHealth({
    force: true,
    maxAgeMs: 0,
    embedder,
  });
  if (!health.ok)
    throw new ConfiguredMemoryEmbedderUnavailableError(new Error(health.note));
  return health;
}

export class ConfiguredPgVectorUnavailableError extends Error {
  override readonly cause: unknown;

  constructor(cause: unknown) {
    super(
      `AGENTIC_PGVECTOR_URL is configured but pgvector could not be initialized: ${String(
        (cause as { message?: unknown } | null)?.message ?? cause,
      ).slice(0, 200)}`,
    );
    this.name = "ConfiguredPgVectorUnavailableError";
    this.cause = cause;
  }
}

export class PgVectorOperationError extends Error {
  readonly code = "pgvector_operation_failed";
  override readonly cause: unknown;

  constructor(
    readonly operation: "embed" | "search" | "mirror" | "delete",
    cause: unknown,
  ) {
    super(
      `pgvector ${operation} failed: ${String(
        (cause as { message?: unknown } | null)?.message ?? cause,
      ).slice(0, 200)}`,
    );
    this.name = "PgVectorOperationError";
    this.cause = cause;
  }
}

/** For /health: "pgvector" when live, else "local" (or "none" if no driver at all). */
export function memoryDriverStatus(): "pgvector" | "local" | "none" {
  if (pool && activeDriver && getMemoryDriver() === activeDriver)
    return "pgvector";
  return getMemoryDriver() ? "local" : "none";
}

/** Live readiness probe used by /health. A configured pgvector backend is not
 * considered healthy merely because a Pool object was constructed earlier. */
export async function memoryDriverHealth(): Promise<{
  configured: boolean;
  ok: boolean;
  driver: "pgvector" | "local" | "none";
  embeddingConfigured?: boolean;
  embeddingOk?: boolean;
  embeddingDimensions?: number;
  note?: string;
}> {
  const configured = Boolean(process.env.AGENTIC_PGVECTOR_URL?.trim());
  const driver = memoryDriverStatus();
  const embedding = await configuredMemoryEmbedderHealth();
  const embeddingFields = {
    embeddingConfigured: embedding.configured,
    embeddingOk: embedding.ok,
    ...(embedding.dimensions != null
      ? { embeddingDimensions: embedding.dimensions }
      : {}),
  };
  if (!embedding.ok) {
    return {
      configured,
      ok: false,
      driver,
      ...embeddingFields,
      note: embedding.note,
    };
  }
  if (!configured)
    return { configured: false, ok: true, driver, ...embeddingFields };
  if (!pool || driver !== "pgvector") {
    return {
      configured: true,
      ok: false,
      driver,
      ...embeddingFields,
      note: "configured pgvector driver is not wired",
    };
  }
  try {
    await pool.query("SELECT 1");
    return { configured: true, ok: true, driver, ...embeddingFields };
  } catch (err) {
    return {
      configured: true,
      ok: false,
      driver,
      ...embeddingFields,
      note: String((err as { message?: unknown } | null)?.message ?? err).slice(
        0,
        200,
      ),
    };
  }
}

const vecLiteral = (v: Float32Array | number[]): string =>
  `[${Array.from(v)
    .map((x) => Math.round(x * 1e6) / 1e6)
    .join(",")}]`;

async function embeddingVector(
  text: string,
  embedder: PgVectorEmbedder,
): Promise<number[]> {
  const vector = Array.from(await embedder(text));
  if (
    vector.length !== DIM ||
    vector.some((component) => !Number.isFinite(component))
  ) {
    throw new Error(
      `pgvector requires exactly ${DIM} finite embedding dimensions; received ${vector.length}`,
    );
  }
  let normSquared = 0;
  for (const component of vector) normSquared += component * component;
  const norm = Math.sqrt(normSquared);
  if (!Number.isFinite(norm) || norm === 0) {
    throw new Error("pgvector embedder returned a zero or invalid vector");
  }
  return vector.map((component) => component / norm);
}

async function ensureSchema(p: PgPoolLike): Promise<void> {
  await p.query("CREATE EXTENSION IF NOT EXISTS vector");
  await p.query(
    `CREATE TABLE IF NOT EXISTS ${TABLE} (
       tenant_id  text NOT NULL,
       agent_name text NOT NULL,
       subject    text NOT NULL DEFAULT '',
       key        text NOT NULL,
       value_json text NOT NULL,
       embedding  vector(${DIM}) NOT NULL,
       updated_at timestamptz NOT NULL DEFAULT now(),
       expires_at timestamptz,
       PRIMARY KEY (tenant_id, agent_name, subject, key)
     )`,
  );
  await p.query(
    `CREATE INDEX IF NOT EXISTS ${TABLE}_hnsw ON ${TABLE} USING hnsw (embedding vector_cosine_ops)`,
  );
}

/** Build the strict pgvector driver. Exported so failure behavior can be
 * exercised with an injected pool without requiring a live Postgres process. */
export function createPgVectorMemoryDriver(
  p: PgPoolLike,
  embedder: PgVectorEmbedder = localEmbed,
): MemoryDriver {
  const driver: MemoryDriver = {
    async embed(text: string): Promise<number[]> {
      try {
        return await embeddingVector(text, embedder);
      } catch (error) {
        throw new PgVectorOperationError("embed", error);
      }
    },

    async search(
      query: string,
      k: number,
      scope?: MemorySearchScope,
    ): Promise<MemoryHit[]> {
      try {
        const qv = vecLiteral(await embeddingVector(query, embedder));
        const conds: string[] = ["(expires_at IS NULL OR expires_at > now())"];
        const params: unknown[] = [qv, Math.max(1, Math.floor(k))];
        // Mirror the local driver's scoping exactly. Subject stays ranked
        // across by default; supervised stores can require an exact subject.
        if (scope?.tenantId) {
          params.push(scope.tenantId);
          conds.push(`tenant_id = $${params.length}`);
        }
        if (scope?.agentName) {
          params.push(scope.agentName);
          conds.push(`agent_name = $${params.length}`);
        }
        if (scope?.subjectExact && scope.subject !== undefined) {
          params.push(scope.subject);
          conds.push(`subject = $${params.length}`);
        }
        const res = await p.query(
          `SELECT tenant_id, agent_name, subject, key, value_json,
                  1 - (embedding <=> $1::vector) AS score
             FROM ${TABLE}
            WHERE ${conds.join(" AND ")}
            ORDER BY embedding <=> $1::vector
            LIMIT $2`,
          params,
        );
        return res.rows.map((row) => {
          const score = Number(row.score);
          if (!Number.isFinite(score)) {
            throw new Error(
              `pgvector returned an invalid score for key '${String(row.key)}'`,
            );
          }
          const value = JSON.parse(String(row.value_json)) as unknown;
          return {
            id: `${row.tenant_id}/${row.agent_name}/${row.subject}/${row.key}`,
            value,
            score: Math.max(0, Math.min(1, score)),
            meta: {
              key: String(row.key),
              subject: String(row.subject),
              agentName: String(row.agent_name),
            },
          };
        });
      } catch (error) {
        throw error instanceof PgVectorOperationError
          ? error
          : new PgVectorOperationError("search", error);
      }
    },

    async mirror(row: MemoryMirrorRow): Promise<void> {
      try {
        let vector: number[];
        if (row.embedding !== null && row.embedding !== undefined) {
          // Supplied vectors are part of the write contract. Reject an
          // incompatible embedding rather than silently indexing different text.
          vector = await embeddingVector("", async () => row.embedding!);
        } else {
          vector = await embeddingVector(
            `${row.key} ${row.valueJson}`.slice(0, 4000),
            embedder,
          );
        }
        await p.query(
          `INSERT INTO ${TABLE} (tenant_id, agent_name, subject, key, value_json, embedding, updated_at, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6::vector, now(), $7)
           ON CONFLICT (tenant_id, agent_name, subject, key)
           DO UPDATE SET value_json = EXCLUDED.value_json, embedding = EXCLUDED.embedding,
                         updated_at = now(), expires_at = EXCLUDED.expires_at`,
          [
            row.tenantId,
            row.agentName,
            row.subject,
            row.key,
            row.valueJson,
            vecLiteral(vector),
            row.expiresAt ?? null,
          ],
        );
      } catch (error) {
        throw error instanceof PgVectorOperationError
          ? error
          : new PgVectorOperationError("mirror", error);
      }
    },

    async deleteMirror(row: {
      tenantId: string;
      agentName: string;
      subject: string;
      key: string;
    }): Promise<void> {
      try {
        await p.query(
          `DELETE FROM ${TABLE} WHERE tenant_id=$1 AND agent_name=$2 AND subject=$3 AND key=$4`,
          [row.tenantId, row.agentName, row.subject, row.key],
        );
      } catch (error) {
        throw new PgVectorOperationError("delete", error);
      }
    },
  };
  return driver;
}

/** Wire the pgvector driver when AGENTIC_PGVECTOR_URL is set + reachable.
 * Configuration is a hard contract: initialization and live operations fail
 * closed, while the prior local driver is restored only during an explicit stop. */
export async function wirePgVectorMemory(
  embedder: PgVectorEmbedder = localEmbed,
): Promise<boolean> {
  const url = process.env.AGENTIC_PGVECTOR_URL?.trim();
  if (!url) return false;
  if (pool) {
    if (activeDriver && getMemoryDriver() === activeDriver) return true;
    throw new ConfiguredPgVectorUnavailableError(
      new Error(
        "a pgvector pool exists but is not the registered memory driver",
      ),
    );
  }
  let candidate: PgPoolLike | null = null;
  try {
    const mod = (await import("pg")) as unknown as {
      default?: { Pool: new (o: Record<string, unknown>) => PgPoolLike };
      Pool?: new (o: Record<string, unknown>) => PgPoolLike;
    };
    const Pool = mod.Pool ?? mod.default?.Pool;
    if (!Pool) throw new Error("pg module has no Pool export");
    const p = new Pool({
      connectionString: url,
      max: 5,
      connectionTimeoutMillis: 3_000,
      idleTimeoutMillis: 30_000,
    });
    candidate = p;
    await ensureSchema(p); // also the reachability probe
    const driver = createPgVectorMemoryDriver(p, embedder);
    // Probe the configured embedding backend too. This catches a dead remote
    // embedding API or a dimension mismatch before the process reports ready.
    const readinessVector = await driver.embed!(
      "agentic pgvector readiness probe",
    );
    await p.query("SELECT $1::vector", [vecLiteral(readinessVector)]);

    previousDriver = getMemoryDriver();
    activeDriver = driver;
    pool = p;
    candidate = null;
    setMemoryDriver(driver);
    console.log(
      `[memory-pgvector] live — vector recall on ${TABLE} (HNSW cosine, dim ${DIM}); SQLite remains system of record`,
    );
    return true;
  } catch (err) {
    if (candidate) await candidate.end().catch(() => {});
    throw new ConfiguredPgVectorUnavailableError(err);
  }
}

/** Close the pool and restore the exact driver that was active before wiring. */
export async function stopPgVectorMemory(): Promise<void> {
  const p = pool;
  const driver = activeDriver;
  const restore = previousDriver;
  pool = null;
  activeDriver = null;
  previousDriver = null;
  if (driver && getMemoryDriver() === driver) setMemoryDriver(restore);
  if (!p) return;
  try {
    await p.end();
  } catch {
    /* draining */
  }
}
