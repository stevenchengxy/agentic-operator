// ConversationStore + ReflectionWriter ports, backed by @agentic/db (Drizzle/SQLite).
//
// Replaces the OLD repo's Postgres factory_conversation + FailureReflection. The
// conversation store is what lets a follow-up message resume a build mid-flight (and
// survive a server restart); the reflection writer makes each run start wiser.
// better-sqlite3 is synchronous — no `await` on the drizzle calls.

import { getDb, factoryConversations, factoryReflections, factoryRuns, factorySkills, factoryTools, acceptanceScores, toolStats, eq, and, or, desc, sql } from "@agentic/db";
import { isNull, isNotNull } from "drizzle-orm";
import { makeId } from "@agentic/shared";
import type { ConversationStore, ReflectionWriter, SkillStore, LibrarySkill, ToolStore, DeclarativeTool, AcceptanceRecorder } from "@agentic/agent-factory";
import { drainHumanMessages as drainMailbox } from "./mailbox";

// #P1-6 — persist per-criterion acceptance verdicts (one row per criterion per run) for trend
// dashboards. Fail-safe: never throws back into the finish gate.
export class DrizzleAcceptanceRecorder implements AcceptanceRecorder {
  async record(runId: string, domain: string, tenantId: string | undefined, criteria: Array<{ key: string; label: string; pass: boolean; detail: string }>): Promise<void> {
    try {
      const db = getDb();
      for (const c of criteria) {
        db.insert(acceptanceScores).values({
          id: makeId("art"),
          runId,
          tenantId: tenantId ?? null,
          domain,
          criterionKey: c.key,
          label: c.label,
          pass: c.pass,
          detail: c.detail,
        }).run();
      }
    } catch {
      /* acceptance telemetry best-effort */
    }
  }
}

/** Persistent AI-authored tool library (Tool-Smith create_tool). */
export class DrizzleToolStore implements ToolStore {
  async list(domain: string): Promise<DeclarativeTool[]> {
    try {
      return getDb()
        .select()
        .from(factoryTools)
        .where(or(eq(factoryTools.domain, domain), isNull(factoryTools.domain)))
        .all()
        .map((r) => ({ name: r.name, description: r.description, method: r.method, urlTemplate: r.urlTemplate, headers: (r.headers as Record<string, string>) ?? undefined, bodyTemplate: r.bodyTemplate ?? undefined, sideEffect: r.sideEffect, domain: r.domain, paramsSchema: (r.paramsSchema as Record<string, unknown>) ?? undefined, returnsSchema: (r.returnsSchema as Record<string, unknown>) ?? undefined }));
    } catch {
      return [];
    }
  }

  async save(tool: DeclarativeTool): Promise<void> {
    try {
      const now = new Date();
      const cols = { description: tool.description, method: tool.method, urlTemplate: tool.urlTemplate, headers: tool.headers ?? null, bodyTemplate: tool.bodyTemplate ?? null, sideEffect: tool.sideEffect, domain: tool.domain, paramsSchema: tool.paramsSchema ?? null, returnsSchema: tool.returnsSchema ?? null };
      getDb()
        .insert(factoryTools)
        .values({ name: tool.name, ...cols, createdAt: now, updatedAt: now })
        .onConflictDoUpdate({ target: factoryTools.name, set: { ...cols, updatedAt: now } })
        .run();
    } catch {
      /* best-effort */
    }
  }
}

export class DrizzleConversationStore implements ConversationStore {
  async has(id: string): Promise<boolean> {
    const row = getDb().select({ id: factoryConversations.id }).from(factoryConversations).where(eq(factoryConversations.id, id)).all()[0];
    return !!row;
  }

  async load(id: string): Promise<{ messages: unknown[]; ctx: Record<string, unknown> } | null> {
    const row = getDb().select().from(factoryConversations).where(eq(factoryConversations.id, id)).all()[0];
    if (!row) return null;
    return {
      messages: (row.messagesJson as unknown[]) ?? [],
      ctx: (row.ctxJson as Record<string, unknown>) ?? {},
    };
  }

  async save(id: string, snap: { domain: string; messages: unknown[]; ctx: Record<string, unknown> }): Promise<void> {
    const now = new Date();
    getDb()
      .insert(factoryConversations)
      .values({ id, domain: snap.domain, messagesJson: snap.messages, ctxJson: snap.ctx, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({ target: factoryConversations.id, set: { messagesJson: snap.messages, ctxJson: snap.ctx, updatedAt: now } })
      .run();
  }

  // HITL: drain any messages a human injected via POST /v1/agent-factory/inject.
  async drainHumanMessages(id: string): Promise<string[]> {
    return drainMailbox(id);
  }
}

export class DrizzleReflectionWriter implements ReflectionWriter {
  async record(domain: string, r: { summary: string; lesson: string; failedStep?: string; kind?: "failure" | "success" | "caveat" }): Promise<void> {
    try {
      getDb()
        .insert(factoryReflections)
        .values({
          id: makeId("rfl"),
          domain,
          // Phase 5 — persist the caller's real kind (was hardcoded "caveat", losing the signal).
          kind: r.kind ?? "caveat",
          summary: r.summary,
          rootCause: r.failedStep ?? null,
          lesson: r.lesson,
          createdAt: new Date(),
        })
        .run();
    } catch {
      /* fail-safe: a reflection write must never throw back into the loop */
    }
  }

  async list(domain: string) {
    try {
      return getDb()
        .select()
        .from(factoryReflections)
        .where(eq(factoryReflections.domain, domain))
        .orderBy(desc(factoryReflections.createdAt))
        .limit(20)
        .all()
        .map((r) => ({
          kind: (r.kind as "failure" | "success" | "caveat") ?? "caveat",
          summary: r.summary,
          rootCause: r.rootCause ?? undefined,
          lesson: r.lesson,
          createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
        }));
    } catch {
      return [];
    }
  }
}

/** Persistent skills library — backs create_skill / use_skill + effectiveness ranking. */
export class DrizzleSkillStore implements SkillStore {
  async list(domain: string): Promise<LibrarySkill[]> {
    try {
      const rows = getDb()
        .select()
        .from(factorySkills)
        .where(or(eq(factorySkills.domain, domain), isNull(factorySkills.domain)))
        .all();
      const eff = (r: { successCount: number; evalCount: number }) => (r.successCount + 1) / (r.evalCount + 2);
      return rows
        .map((r) => ({ slug: r.slug, name: r.name, purpose: r.purpose, promptFragment: r.promptFragment, tools: (r.tools as string[]) ?? [], decisionRule: r.decisionRule, domain: r.domain, useCount: r.useCount, evalCount: r.evalCount, successCount: r.successCount }))
        .sort((a, b) => eff(b) - eff(a) || b.useCount - a.useCount);
    } catch {
      return [];
    }
  }

  async save(skill: Omit<LibrarySkill, "useCount" | "evalCount" | "successCount">): Promise<void> {
    try {
      const now = new Date();
      getDb()
        .insert(factorySkills)
        .values({ slug: skill.slug, name: skill.name, purpose: skill.purpose, promptFragment: skill.promptFragment, tools: skill.tools, decisionRule: skill.decisionRule, domain: skill.domain, createdAt: now, updatedAt: now })
        .onConflictDoUpdate({ target: factorySkills.slug, set: { name: skill.name, purpose: skill.purpose, promptFragment: skill.promptFragment, tools: skill.tools, decisionRule: skill.decisionRule, domain: skill.domain, updatedAt: now } })
        .run();
    } catch {
      /* skill persistence is best-effort */
    }
  }

  async bumpUse(slug: string): Promise<void> {
    try {
      getDb().update(factorySkills).set({ useCount: sql`${factorySkills.useCount} + 1`, updatedAt: new Date() }).where(eq(factorySkills.slug, slug)).run();
    } catch {
      /* best-effort */
    }
  }

  async recordEval(slug: string, ok: boolean): Promise<void> {
    try {
      getDb()
        .update(factorySkills)
        .set({ evalCount: sql`${factorySkills.evalCount} + 1`, successCount: sql`${factorySkills.successCount} + ${ok ? 1 : 0}`, updatedAt: new Date() })
        .where(eq(factorySkills.slug, slug))
        .run();
    } catch {
      /* best-effort */
    }
  }
}

// ── run history (历史运行) ──────────────────────────────────────────────────────
export interface RunRecord {
  id: string;
  domain: string;
  goal: string;
  status: string;
  tokensUsed: number;
  turns: number;
  agentsCount: number;
  reachedTerminal: boolean;
  createdAt: string;
}

/** Open a run row at stream start; returns its id. Pass `id` to control it (the
 *  run-registry uses the same id as the registry key + conversation id). tenant_id is
 *  NOT NULL (0021) — an unscoped run is never persisted (the stream route guarantees a
 *  tenant via requirePermission, so this only guards the degenerate no-auth path). */
export function recordRunStart(domain: string, goal: string, tenantId: string | undefined, id: string = makeId("frn")): string {
  if (!tenantId) {
    // tenant_id is NOT NULL so we can't persist — but don't fail SILENTLY: a run with no durable row
    // loses its transcript on restart, and recordRunFinish then UPDATEs a row that never existed.
    console.warn(`[factory] recordRunStart 无 tenantId — 本次运行不会持久化(transcript 仅在内存，重启即丢) id=${id} domain=${domain}`);
    return id;
  }
  try {
    const now = new Date();
    // #CRASH-CKPT — UPSERT, not insert-and-swallow: a FOLLOW-UP message reuses the conversation's
    // run id, and the old silent PK-conflict left the row on its previous terminal status ("done").
    // autoResumeCrashedRuns() only re-attaches rows stuck "running", so a follow-up killed mid-run
    // was INVISIBLE to crash-resume (and the history list lied). Flipping the row back to running
    // makes resume + UI truthful; recordRunFinish overwrites with the new verdict as before.
    getDb()
      .insert(factoryRuns)
      .values({ id, tenantId, domain, goal, status: "running", createdAt: now, updatedAt: now })
      .onConflictDoUpdate({ target: factoryRuns.id, set: { status: "running", goal, errorMessage: null, deletedAt: null, updatedAt: now } })
      .run();
  } catch {
    /* best-effort */
  }
  return id;
}

/** Finalize a run row with the terminal verdict + the full transcript for replay. */
export function recordRunFinish(id: string, fields: { status: string; tokensUsed: number; turns: number; agentsCount: number; reachedTerminal: boolean; errorMessage?: string; transcript: unknown[] }): void {
  try {
    getDb()
      .update(factoryRuns)
      .set({ status: fields.status, tokensUsed: fields.tokensUsed, turns: fields.turns, agentsCount: fields.agentsCount, reachedTerminal: fields.reachedTerminal, errorMessage: fields.errorMessage ?? null, transcriptJson: fields.transcript, updatedAt: new Date() })
      .where(eq(factoryRuns.id, id))
      .run();
  } catch {
    /* best-effort */
  }
}

const toISO = (d: unknown): string => (d instanceof Date ? d.toISOString() : String(d));

/** History list. Scoped to a tenant (0021 — was unfiltered, leaking runs across tenants) and
 *  hides soft-deleted rows. `tenantId` is optional only so internal callers without an auth
 *  context still work; the route always passes it. */
export function listRuns(domain: string | null, tenantId?: string, limit = 30, opts?: { deleted?: boolean }): RunRecord[] {
  try {
    // `deleted` lists the recycle bin (soft-deleted rows) so the UI can offer restore; default hides them.
    const conds = [opts?.deleted ? isNotNull(factoryRuns.deletedAt) : isNull(factoryRuns.deletedAt)];
    if (domain) conds.push(eq(factoryRuns.domain, domain));
    if (tenantId) conds.push(eq(factoryRuns.tenantId, tenantId));
    const rows = getDb().select().from(factoryRuns).where(and(...conds)).orderBy(desc(factoryRuns.createdAt)).limit(limit).all();
    return rows.map((r) => ({ id: r.id, domain: r.domain, goal: r.goal, status: r.status, tokensUsed: r.tokensUsed, turns: r.turns, agentsCount: r.agentsCount, reachedTerminal: r.reachedTerminal, createdAt: toISO(r.createdAt) }));
  } catch {
    return [];
  }
}

/** Single run incl. transcript for replay. Tenant-scoped when an id is given a tenant; returns
 *  soft-deleted rows too (with `deletedAt` set) so a reconnect can replay a tombstone and a
 *  restore flow can preview — list callers exclude them, so the only path here is by-id. */
export function getRun(id: string, tenantId?: string): (RunRecord & { transcript: unknown[]; deletedAt: string | null }) | null {
  try {
    const conds = [eq(factoryRuns.id, id)];
    if (tenantId) conds.push(eq(factoryRuns.tenantId, tenantId));
    const r = getDb().select().from(factoryRuns).where(and(...conds)).all()[0];
    if (!r) return null;
    return { id: r.id, domain: r.domain, goal: r.goal, status: r.status, tokensUsed: r.tokensUsed, turns: r.turns, agentsCount: r.agentsCount, reachedTerminal: r.reachedTerminal, createdAt: toISO(r.createdAt), deletedAt: r.deletedAt ? toISO(r.deletedAt) : null, transcript: (r.transcriptJson as unknown[]) ?? [] };
  } catch {
    return null;
  }
}

/** Soft-delete a run (历史运行 trash). Guards: tenant match, not already deleted, and never a
 *  live 'running' row (can't delete a run mid-flight). Recoverable via restoreRun. */
export function deleteRun(id: string, tenantId?: string): boolean {
  try {
    const conds = [eq(factoryRuns.id, id), isNull(factoryRuns.deletedAt), sql`${factoryRuns.status} != 'running'`];
    if (tenantId) conds.push(eq(factoryRuns.tenantId, tenantId));
    const res = getDb().update(factoryRuns).set({ deletedAt: new Date(), updatedAt: new Date() }).where(and(...conds)).run() as { changes?: number };
    return (res?.changes ?? 0) > 0;
  } catch {
    return false;
  }
}

/** Un-delete a soft-deleted run. */
export function restoreRun(id: string, tenantId?: string): boolean {
  try {
    const conds = [eq(factoryRuns.id, id), sql`${factoryRuns.deletedAt} IS NOT NULL`];
    if (tenantId) conds.push(eq(factoryRuns.tenantId, tenantId));
    const res = getDb().update(factoryRuns).set({ deletedAt: null, updatedAt: new Date() }).where(and(...conds)).run() as { changes?: number };
    return (res?.changes ?? 0) > 0;
  } catch {
    return false;
  }
}

/** Bulk soft-delete every finished run for a domain (清空已完成). Never touches a live
 *  'running' row. Returns how many were cleared. */
export function deleteRunsByDomain(domain: string, tenantId?: string): number {
  try {
    const conds = [eq(factoryRuns.domain, domain), isNull(factoryRuns.deletedAt), sql`${factoryRuns.status} != 'running'`];
    if (tenantId) conds.push(eq(factoryRuns.tenantId, tenantId));
    const res = getDb().update(factoryRuns).set({ deletedAt: new Date(), updatedAt: new Date() }).where(and(...conds)).run() as { changes?: number };
    return res?.changes ?? 0;
  } catch {
    return 0;
  }
}

/** Flip a single durable run row 'running' → 'aborted' (orphan cleanup / hard stop of a
 *  run no longer in the live registry). Returns true iff a running row was actually changed. */
export function markRunAborted(id: string, errorMessage?: string): boolean {
  try {
    const res = getDb()
      .update(factoryRuns)
      .set({ status: "aborted", errorMessage: errorMessage ?? null, updatedAt: new Date() })
      .where(and(eq(factoryRuns.id, id), eq(factoryRuns.status, "running")))
      .run() as { changes?: number };
    return (res?.changes ?? 0) > 0;
  } catch {
    return false;
  }
}

/** Durable rows still marked 'running' (optionally for one domain/tenant), with their createdAt
 *  in unix-ms — the zombie sweep cross-checks these against the live run registry. Skips
 *  soft-deleted rows. */
export function listRunningRuns(domain: string | null, tenantId?: string): Array<{ id: string; createdAt: number }> {
  try {
    const conds = [eq(factoryRuns.status, "running"), isNull(factoryRuns.deletedAt)];
    if (domain) conds.push(eq(factoryRuns.domain, domain));
    if (tenantId) conds.push(eq(factoryRuns.tenantId, tenantId));
    const rows = getDb().select({ id: factoryRuns.id, createdAt: factoryRuns.createdAt }).from(factoryRuns).where(and(...conds)).all();
    return rows.map((r) => ({ id: r.id, createdAt: r.createdAt instanceof Date ? r.createdAt.getTime() : new Date(r.createdAt as unknown as string).getTime() }));
  } catch {
    return [];
  }
}

// #SCALE-TOOLS — per-tool sandbox effectiveness store (upsert counts; ranking demotes empirically).
export class DrizzleToolStatsStore {
  async record(toolName: string, ok: boolean): Promise<void> {
    try {
      getDb()
        .insert(toolStats)
        .values({ toolName, invoked: 1, succeeded: ok ? 1 : 0 })
        .onConflictDoUpdate({ target: toolStats.toolName, set: { invoked: sql`${toolStats.invoked} + 1`, succeeded: sql`${toolStats.succeeded} + ${ok ? 1 : 0}`, updatedAt: new Date() } })
        .run();
    } catch { /* best-effort */ }
  }
  async successRates(): Promise<Record<string, { invoked: number; succeeded: number }>> {
    try {
      const rows = getDb().select().from(toolStats).all();
      return Object.fromEntries(rows.map((r) => [r.toolName, { invoked: r.invoked, succeeded: r.succeeded }]));
    } catch { return {}; }
  }
}
