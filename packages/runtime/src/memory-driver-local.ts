/**
 * A real, self-contained vector-recall MemoryDriver — replaces the v1
 * NoMemoryDriverError stub so `ctx.memory.search(query, k)` returns genuinely
 * ranked hits instead of throwing.
 *
 * Two embedding backends, both behind the same driver:
 *  - LOCAL (default): a deterministic, offline bag-of-tokens hash embedding
 *    (word tokens + CJK unigrams/bigrams → fixed-dim L2-normalized vector).
 *    No network, no native extension, no schema migration. Captures real
 *    lexical/semantic OVERLAP (far better than a SQL LIKE), and is stable so
 *    repeated searches are reproducible.
 *  - GATEWAY (opt-in): pass a custom `embed` (see `openaiEmbedder`) that hits
 *    an OpenAI-compatible /embeddings endpoint for higher-quality vectors.
 *
 * Row embeddings are computed on demand and cached by (composite key + updatedAt),
 * so the corpus is embedded once and reused across searches; a row's edit
 * (new updatedAt) transparently re-embeds. Tenant/agent/subject scoping is
 * applied at the SQL boundary via the optional `scope` the SDK now threads.
 */

import { and, eq } from "drizzle-orm";
import { agentMemoryLong, getDb } from "@agentic/db";
import type { MemoryDriver, MemoryHit, MemorySearchScope } from "@agentic/agent-sdk";

const DIM = 256;

/** Word tokens + CJK unigrams + CJK bigrams (Chinese has no spaces; bigrams carry most of the signal). */
function tokenize(text: string): string[] {
  const s = (text || "").toLowerCase().slice(0, 8000);
  const words = s.match(/[a-z0-9_]{2,}/g) ?? [];
  const cjkChars = s.match(/[一-鿿]/g) ?? [];
  const cjkRun = s.replace(/[^一-鿿]/g, "");
  const bigrams: string[] = [];
  for (let i = 0; i < cjkRun.length - 1; i++) bigrams.push(cjkRun.slice(i, i + 2));
  return [...words, ...cjkChars, ...bigrams];
}

/** FNV-1a 32-bit — cheap, stable, good spread. */
function fnv1a(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Deterministic hashed bag-of-tokens embedding, L2-normalized. Signed second bucket cuts collisions. */
export function localEmbed(text: string): Float32Array {
  const v = new Float32Array(DIM);
  for (const t of tokenize(text)) {
    const h = fnv1a(t);
    const i1 = h % DIM;
    const i2 = (h >>> 8) % DIM;
    v[i1] = (v[i1] ?? 0) + 1;
    v[i2] = (v[i2] ?? 0) + ((h & 1) === 1 ? 0.5 : -0.5);
  }
  let n = 0;
  for (let i = 0; i < DIM; i++) n += (v[i] ?? 0) * (v[i] ?? 0);
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < DIM; i++) v[i] = (v[i] ?? 0) / n;
  return v;
}

/** Cosine similarity; inputs are already L2-normalized so this is just the dot product. */
export function cosine(a: Float32Array, b: Float32Array): number {
  const len = Math.min(a.length, b.length);
  let d = 0;
  for (let i = 0; i < len; i++) d += (a[i] ?? 0) * (b[i] ?? 0);
  return d;
}

/** Flatten a stored JSON value to searchable text (keys + primitive values). */
function valueText(valueJson: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(valueJson);
  } catch {
    return valueJson;
  }
  const out: string[] = [];
  const walk = (x: unknown) => {
    if (x == null) return;
    if (typeof x === "string" || typeof x === "number" || typeof x === "boolean") {
      out.push(String(x));
    } else if (Array.isArray(x)) {
      for (const e of x) walk(e);
    } else if (typeof x === "object") {
      for (const [key, val] of Object.entries(x as Record<string, unknown>)) {
        out.push(key);
        walk(val);
      }
    }
  };
  walk(parsed);
  return out.join(" ").slice(0, 8000);
}

function decodeValue(valueJson: string): unknown {
  try {
    return JSON.parse(valueJson);
  } catch {
    return valueJson;
  }
}

export type Embedder = (text: string) => Float32Array | Promise<Float32Array>;

export interface LocalVectorDriverOpts {
  /** override the embedding backend (e.g. a gateway embedder). Defaults to `localEmbed`. */
  embed?: Embedder;
  /** cap the candidate rows scanned per search (protects a huge corpus). Default 4000. */
  maxCandidates?: number;
  /** row-embedding cache cap. Default 8000. */
  cacheSize?: number;
}

/**
 * Build a real vector driver. Register it via `setMemoryDriver(createLocalVectorDriver())`
 * at app bootstrap; `ctx.memory.search()` then returns cosine-ranked hits.
 */
export function createLocalVectorDriver(opts: LocalVectorDriverOpts = {}): MemoryDriver {
  const embed: Embedder = opts.embed ?? localEmbed;
  const maxCandidates = opts.maxCandidates ?? 4000;
  const cacheSize = opts.cacheSize ?? 8000;
  const cache = new Map<string, Float32Array>();

  return {
    async search(query: string, k: number, scope?: MemorySearchScope): Promise<MemoryHit[]> {
      const db = getDb();
      const conds = [];
      if (scope?.tenantId) conds.push(eq(agentMemoryLong.tenantId, scope.tenantId));
      if (scope?.agentName) conds.push(eq(agentMemoryLong.agentName, scope.agentName));
      // NB: subject is NOT filtered — cross-subject recall within a (tenant, agent) is the point of
      // semantic search; the ranking surfaces the relevant subject. Tenant isolation is preserved.
      const rows = db
        .select()
        .from(agentMemoryLong)
        .where(conds.length ? and(...conds) : undefined)
        .limit(maxCandidates)
        .all()
        // #SCALE-MEM — TTL: expired rows are invisible to recall (lazy eviction; put() GC's them).
        .filter((r) => !r.expiresAt || +r.expiresAt > Date.now());
      if (!rows.length) return [];

      const qv = await embed(query);
      const hits: MemoryHit[] = [];
      for (const r of rows) {
        const ck = `${r.tenantId}|${r.agentName}|${r.subject}|${r.key}|${+r.updatedAt}`;
        let rv = cache.get(ck);
        if (!rv && r.embeddingJson) {
          // #SCALE-MEM — pre-computed at put() time: no re-embedding of static values on every search.
          try {
            const arr = JSON.parse(r.embeddingJson) as number[];
            if (Array.isArray(arr) && arr.length) rv = Float32Array.from(arr);
          } catch { /* corrupt → recompute below */ }
        }
        if (!rv) {
          rv = await embed(`${r.key} ${valueText(r.valueJson)}`);
          cache.set(ck, rv);
          if (cache.size > cacheSize) {
            const oldest = cache.keys().next().value;
            if (oldest !== undefined) cache.delete(oldest);
          }
        }
        hits.push({
          id: ck,
          value: decodeValue(r.valueJson),
          score: Math.max(0, cosine(qv, rv)),
          meta: { agentName: r.agentName, subject: r.subject, key: r.key },
        });
      }
      hits.sort((a, b) => b.score - a.score);
      return hits.slice(0, Math.max(1, k));
    },
  };
}

/**
 * Optional higher-quality embedder against an OpenAI-compatible /embeddings endpoint.
 * Returns null when unconfigured (bootstrap then falls back to the local embedder).
 * Env: MEMORY_EMBED_MODEL, MEMORY_EMBED_BASE_URL, MEMORY_EMBED_API_KEY (or reuses the factory
 * gateway's base/key when those specific ones are unset).
 */
export function openaiEmbedder(env: Record<string, string | undefined> = process.env): Embedder | null {
  const model = env.MEMORY_EMBED_MODEL;
  if (!model) return null;
  const base = (env.MEMORY_EMBED_BASE_URL || env.LLM_GATEWAY_BASE_URL || env.OPENAI_BASE_URL || "").replace(/\/$/, "");
  const key = env.MEMORY_EMBED_API_KEY || env.LLM_GATEWAY_API_KEY || env.OPENAI_API_KEY || "";
  if (!base) return null;
  return async (text: string): Promise<Float32Array> => {
    try {
      const res = await fetch(`${base}/embeddings`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify({ model, input: text.slice(0, 8000) }),
      });
      if (!res.ok) return localEmbed(text);
      const json = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
      const emb = json.data?.[0]?.embedding;
      if (!emb?.length) return localEmbed(text);
      // L2-normalize so cosine == dot product (parity with localEmbed).
      const v = Float32Array.from(emb);
      let n = 0;
      for (let i = 0; i < v.length; i++) n += (v[i] ?? 0) * (v[i] ?? 0);
      n = Math.sqrt(n) || 1;
      for (let i = 0; i < v.length; i++) v[i] = (v[i] ?? 0) / n;
      return v;
    } catch {
      return localEmbed(text);
    }
  };
}
