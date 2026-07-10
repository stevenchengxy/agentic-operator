// #SCALE-PGVECTOR — Postgres/pgvector memory driver. Config-flip: set AGENTIC_PGVECTOR_URL to a
// pgvector-enabled Postgres (e.g. the `agentic-pgvector` docker container) and vector recall moves
// from the in-process SQLite scan to a real ANN index (HNSW, cosine). Architecture stays honest:
//
//   - SQLite remains the SYSTEM OF RECORD (put/get/delete untouched — no better-sqlite3 migration).
//   - Every long-scope KV write MIRRORS into Postgres fire-and-forget (MemoryDriver.mirror hook);
//     content lives in both, the vector INDEX lives here.
//   - search() runs `embedding <=> query` on the HNSW index; on ANY pg failure it degrades to the
//     previous (local SQLite-scan) driver — recall quality drops, nothing breaks.
//   - Embeddings: the SAME localEmbed space as the write path (dim 256, L2-normalized), so query
//     and rows always agree regardless of which side computed the vector.
//
// `pg` is a small pure-JS dependency of apps/api (the composition root) — @agentic/runtime stays
// dependency-free (it only defines the mirror hooks).

import { setMemoryDriver, getMemoryDriver, localEmbed } from "@agentic/runtime";
import type { MemoryDriver, MemoryHit, MemoryMirrorRow, MemorySearchScope } from "@agentic/agent-sdk";

const DIM = 256;
const TABLE = "agent_memory_vectors";

interface PgPoolLike {
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  end(): Promise<void>;
}

let pool: PgPoolLike | null = null;

/** For /health: "pgvector" when live, else "local" (or "none" if no driver at all). */
export function memoryDriverStatus(): "pgvector" | "local" | "none" {
  if (pool) return "pgvector";
  return getMemoryDriver() ? "local" : "none";
}

const vecLiteral = (v: Float32Array | number[]): string => `[${Array.from(v).map((x) => Math.round(x * 1e6) / 1e6).join(",")}]`;

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
  await p.query(`CREATE INDEX IF NOT EXISTS ${TABLE}_hnsw ON ${TABLE} USING hnsw (embedding vector_cosine_ops)`);
}

/** Wire the pgvector driver when AGENTIC_PGVECTOR_URL is set + reachable. Keeps the previously
 *  registered driver as the degradation target. Returns true when live. */
export async function wirePgVectorMemory(): Promise<boolean> {
  const url = process.env.AGENTIC_PGVECTOR_URL;
  if (!url) return false;
  try {
    const mod = (await import("pg")) as unknown as { default?: { Pool: new (o: Record<string, unknown>) => PgPoolLike }; Pool?: new (o: Record<string, unknown>) => PgPoolLike };
    const Pool = mod.Pool ?? mod.default?.Pool;
    if (!Pool) throw new Error("pg module has no Pool export");
    const p = new Pool({ connectionString: url, max: 5, connectionTimeoutMillis: 3_000, idleTimeoutMillis: 30_000 });
    await ensureSchema(p); // also the reachability probe

    const fallback = getMemoryDriver(); // the local SQLite-scan driver bootstrap wired first

    const driver: MemoryDriver = {
      async search(query: string, k: number, scope?: MemorySearchScope): Promise<MemoryHit[]> {
        try {
          const qv = vecLiteral(await localEmbed(query));
          const conds: string[] = ["(expires_at IS NULL OR expires_at > now())"];
          const params: unknown[] = [qv, k];
          // Mirror the local driver's scoping EXACTLY: tenant + agent isolate; subject is NOT
          // filtered — cross-subject recall within (tenant, agent) is the point of semantic search.
          if (scope?.tenantId) { params.push(scope.tenantId); conds.push(`tenant_id = $${params.length}`); }
          if (scope?.agentName) { params.push(scope.agentName); conds.push(`agent_name = $${params.length}`); }
          const res = await p.query(
            `SELECT tenant_id, agent_name, subject, key, value_json,
                    1 - (embedding <=> $1::vector) AS score
               FROM ${TABLE}
              WHERE ${conds.join(" AND ")}
              ORDER BY embedding <=> $1::vector
              LIMIT $2`,
            params,
          );
          return res.rows.map((r) => {
            let value: unknown = r.value_json;
            try { value = JSON.parse(String(r.value_json)); } catch { /* keep raw */ }
            return {
              id: `${r.tenant_id}/${r.agent_name}/${r.subject}/${r.key}`,
              value,
              score: Math.max(0, Math.min(1, Number(r.score))),
              meta: { key: String(r.key), subject: String(r.subject), agentName: String(r.agent_name) },
            };
          });
        } catch (err) {
          // pg away → degrade to the local scan driver (recall quality drops; nothing breaks).
          console.warn("[memory-pgvector] search failed — degrading to local driver:", String((err as Error).message).slice(0, 100));
          return fallback && fallback !== driver ? fallback.search(query, k, scope) : [];
        }
      },

      async mirror(row: MemoryMirrorRow): Promise<void> {
        const vec = row.embedding && row.embedding.length === DIM
          ? vecLiteral(row.embedding)
          : vecLiteral(await localEmbed(`${row.key} ${row.valueJson}`.slice(0, 4000)));
        await p.query(
          `INSERT INTO ${TABLE} (tenant_id, agent_name, subject, key, value_json, embedding, updated_at, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6::vector, now(), $7)
           ON CONFLICT (tenant_id, agent_name, subject, key)
           DO UPDATE SET value_json = EXCLUDED.value_json, embedding = EXCLUDED.embedding,
                         updated_at = now(), expires_at = EXCLUDED.expires_at`,
          [row.tenantId, row.agentName, row.subject, row.key, row.valueJson, vec, row.expiresAt ?? null],
        );
      },

      async deleteMirror(row: { tenantId: string; agentName: string; subject: string; key: string }): Promise<void> {
        await p.query(`DELETE FROM ${TABLE} WHERE tenant_id=$1 AND agent_name=$2 AND subject=$3 AND key=$4`, [row.tenantId, row.agentName, row.subject, row.key]);
      },
    };

    pool = p;
    setMemoryDriver(driver);
    console.log(`[memory-pgvector] live — vector recall on ${TABLE} (HNSW cosine, dim ${DIM}); SQLite remains system of record`);
    return true;
  } catch (err) {
    console.warn("[memory-pgvector] AGENTIC_PGVECTOR_URL set but unreachable — staying on local driver:", String((err as Error).message).slice(0, 120));
    return false;
  }
}

/** Close the pool + fall back to whatever driver bootstrap wired. Idempotent; wired into onClose. */
export async function stopPgVectorMemory(): Promise<void> {
  const p = pool;
  pool = null;
  if (!p) return;
  try { await p.end(); } catch { /* draining */ }
}
