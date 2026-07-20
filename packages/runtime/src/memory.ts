/**
 * P3-RT-06 — Memory backend.
 *
 * Implements the `MemoryHandle` SDK contract (see @agentic/agent-sdk/memory)
 * against the `agent_memory_short` + `agent_memory_long` tables (P3-DB-01).
 *
 * The runtime constructs one `MemoryHandle` per run via `createMemoryHandle`;
 * the run engine + step engine then pass it through `AgentContext.memory`
 * to both code agents (`BaseAgent.run`) and manifest steps (`ctx.memory`
 * inside tenant tools/prompts).
 *
 * Vector `search()` delegates to the optional `MemoryDriver` registered via
 * `setMemoryDriver(...)`. v1 ships with no default driver — callers receive
 * a `NoMemoryDriverError` until someone wires SQLite-VSS / pgvector / etc.
 */

import { localEmbed } from "./memory-driver-local";
import { and, eq, lt, sql } from "drizzle-orm";
import {
  agentMemoryLong,
  agentMemoryShort,
  getDb,
} from "@agentic/db";
import {
  type MemoryBinding,
  type MemoryDriver,
  type MemoryDriverRef,
  type MemoryHandle,
  type MemoryHit,
  type MemoryScope,
  NoMemoryDriverError,
} from "@agentic/agent-sdk";

const TENANT_SCOPE_SUBJECT = ""; // sentinel for tenant-wide rows

/**
 * Globally registered vector driver. Set by app bootstrap (api server).
 * v1 leaves this `null` so `search()` always errors with a clear signal.
 */
let driverRef: MemoryDriverRef = null;

export function setMemoryDriver(driver: MemoryDriver | null): void {
  driverRef = driver;
}

export function getMemoryDriver(): MemoryDriverRef {
  return driverRef;
}

/**
 * Build a `MemoryHandle` bound to a specific (tenant, agent, subject, run).
 * Called by the run engine + manifest step engine once per run.
 *
 * The handle is intentionally not cached anywhere — each run gets a fresh
 * one to avoid leaks of `runId`/`subject` between concurrent invocations.
 */
export function createMemoryHandle(b: MemoryBinding): MemoryHandle {
  return {
    async get<T = unknown>(key: string, scope: MemoryScope = "subject"): Promise<T | null> {
      const db = getDb();
      if (scope === "run") {
        if (!b.runId) return null;
        const row = db
          .select()
          .from(agentMemoryShort)
          .where(
            and(eq(agentMemoryShort.runId, b.runId), eq(agentMemoryShort.key, key)),
          )
          .all()[0];
        if (!row) return null;
        return decode<T>(row.valueJson);
      }
      const subj = scope === "tenant" ? TENANT_SCOPE_SUBJECT : b.subject;
      const row = db
        .select()
        .from(agentMemoryLong)
        .where(
          and(
            eq(agentMemoryLong.tenantId, b.tenantId),
            eq(agentMemoryLong.agentName, b.agentName),
            eq(agentMemoryLong.subject, subj),
            eq(agentMemoryLong.key, key),
          ),
        )
        .all()[0];
      if (!row) return null;
      return decode<T>(row.valueJson);
    },

    async put<T = unknown>(key: string, value: T, scope: MemoryScope = "subject"): Promise<void> {
      const db = getDb();
      const encoded = encode(value);
      const now = new Date();
      if (scope === "run") {
        if (!b.runId) {
          throw new Error(
            "[memory] put(scope:'run') requires a runId; the handle was built outside a run",
          );
        }
        db.insert(agentMemoryShort)
          .values({
            runId: b.runId,
            key,
            valueJson: encoded,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [agentMemoryShort.runId, agentMemoryShort.key],
            set: { valueJson: encoded, updatedAt: now },
          })
          .run();
        return;
      }
      const subj = scope === "tenant" ? TENANT_SCOPE_SUBJECT : b.subject;
      // #SCALE-MEM — pre-compute the embedding ONCE at write time (search stops re-embedding static
      // values), and stamp a TTL when configured (MEMORY_TTL_DAYS; 0/unset = keep forever).
      // When a driver is configured, its embedding is part of the write contract: silently
      // storing NULL made a successful put invisible to semantic search.
      let embeddingJson: string | null = null;
      const drv = getMemoryDriver();
      if (drv) {
        const embeddingInput = `${key} ${
          typeof value === "string" ? value : JSON.stringify(value ?? "")
        }`.slice(0, 4000);
        const vec = drv.embed
          ? await drv.embed(embeddingInput)
          : Array.from(localEmbed(embeddingInput));
        if (vec.length === 0 || vec.some((component) => !Number.isFinite(component))) {
          throw new Error("memory driver returned an invalid write-time embedding");
        }
        embeddingJson = JSON.stringify(vec.map((x) => Math.round(x * 1e6) / 1e6));
      }
      const ttlDays = Number(process.env.MEMORY_TTL_DAYS);
      const expiresAt = Number.isFinite(ttlDays) && ttlDays > 0 ? new Date(Date.now() + ttlDays * 86_400_000) : null;
      db.insert(agentMemoryLong)
        .values({
          tenantId: b.tenantId,
          agentName: b.agentName,
          subject: subj,
          key,
          valueJson: encoded,
          embeddingJson,
          expiresAt,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            agentMemoryLong.tenantId,
            agentMemoryLong.agentName,
            agentMemoryLong.subject,
            agentMemoryLong.key,
          ],
          set: { valueJson: encoded, embeddingJson, expiresAt, updatedAt: now },
        })
        .run();
      // #SCALE-PGVECTOR — wait for the configured mirror. SQLite remains the
      // system of record and the operation is idempotent, so a caller can retry
      // after an explicit mirror failure without losing the authoritative value.
      if (drv?.mirror) {
        await drv.mirror({ tenantId: b.tenantId, agentName: b.agentName, subject: subj, key, valueJson: encoded, embedding: embeddingJson ? (JSON.parse(embeddingJson) as number[]) : null, expiresAt });
      }
      // #SCALE-MEM — lazy GC: cheap sweep of THIS tenant's expired rows on write (no cron needed).
      db.delete(agentMemoryLong).where(and(eq(agentMemoryLong.tenantId, b.tenantId), lt(agentMemoryLong.expiresAt, new Date()))).run();
    },

    async delete(key: string, scope: MemoryScope = "subject"): Promise<void> {
      const db = getDb();
      if (scope === "run") {
        if (!b.runId) {
          throw new Error(
            "[memory] delete(scope:'run') requires a runId; the handle was built outside a run",
          );
        }
        db.delete(agentMemoryShort)
          .where(
            and(eq(agentMemoryShort.runId, b.runId), eq(agentMemoryShort.key, key)),
          )
          .run();
        return;
      }
      const subj = scope === "tenant" ? TENANT_SCOPE_SUBJECT : b.subject;
      db.delete(agentMemoryLong)
        .where(
          and(
            eq(agentMemoryLong.tenantId, b.tenantId),
            eq(agentMemoryLong.agentName, b.agentName),
            eq(agentMemoryLong.subject, subj),
            eq(agentMemoryLong.key, key),
          ),
        )
        .run();
      // #SCALE-PGVECTOR — a configured mirror is part of the delete contract.
      const drv = getMemoryDriver();
      if (drv?.deleteMirror) {
        await drv.deleteMirror({ tenantId: b.tenantId, agentName: b.agentName, subject: subj, key });
      }
    },

    async search(query: string, k: number): Promise<MemoryHit[]> {
      const driver = getMemoryDriver();
      if (!driver) {
        throw new NoMemoryDriverError();
      }
      // Thread the binding as scope so the driver isolates by tenant/agent (subject is left to the
      // driver's ranking for cross-subject semantic recall).
      return driver.search(query, Math.max(1, k), {
        tenantId: b.tenantId,
        agentName: b.agentName,
        subject: b.subject,
      });
    },
  };
}

/**
 * Sweep all rows from `agent_memory_short` for the given run. Called by the
 * run engine on run finalize so the "run" scope behaves like a true
 * scratchpad. ON DELETE CASCADE on the FK to `runs` already handles hard
 * deletes; this explicit sweep covers the common case where the run row
 * stays around (typical) but its scratch memory shouldn't.
 */
export function clearRunMemory(runId: string): number {
  if (!runId) return 0;
  const db = getDb();
  const r = db
    .delete(agentMemoryShort)
    .where(eq(agentMemoryShort.runId, runId))
    .run();
  return Number(r.changes ?? 0);
}

/** Count rows in short/long scopes for diagnostics. */
export function memoryStats(opts: {
  runId?: string;
  tenantId?: string;
  agentName?: string;
  subject?: string;
}): { short: number; long: number } {
  const db = getDb();
  let short = 0;
  let long = 0;
  if (opts.runId) {
    const r = db
      .select({ c: sql<number>`count(*)` })
      .from(agentMemoryShort)
      .where(eq(agentMemoryShort.runId, opts.runId))
      .all()[0];
    short = Number(r?.c ?? 0);
  }
  if (opts.tenantId) {
    const conds = [eq(agentMemoryLong.tenantId, opts.tenantId)];
    if (opts.agentName) conds.push(eq(agentMemoryLong.agentName, opts.agentName));
    if (opts.subject !== undefined)
      conds.push(eq(agentMemoryLong.subject, opts.subject));
    const r = db
      .select({ c: sql<number>`count(*)` })
      .from(agentMemoryLong)
      .where(and(...conds))
      .all()[0];
    long = Number(r?.c ?? 0);
  }
  return { short, long };
}

function encode(v: unknown): string {
  return JSON.stringify(v ?? null);
}

function decode<T>(s: string): T | null {
  return JSON.parse(s) as T;
}
