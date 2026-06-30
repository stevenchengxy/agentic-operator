/**
 * Recent activity feed — backfill for the live terminal.
 *
 * The Logs → 实时终端 tab streams lifecycle events over SSE, but it starts
 * empty and only shows what arrives while you watch. Every lifecycle event is
 * already durably persisted (runs / steps / events / tasks), so instead of a
 * separate sink we RECONSTRUCT the recent timeline from those tables as
 * `RunStreamEvent[]` — the exact shape the terminal renders for live events.
 * The terminal seeds from this on mount, then appends live, giving a
 * persistent, scroll-back console of the last N (default 1000) lines.
 *
 * Bounded by per-source caps then trimmed to `limit`, ascending by `at`.
 */

import { and, desc, eq, isNotNull } from "drizzle-orm";
import {
  agents,
  events,
  getDb,
  runs,
  steps,
  tasks,
  tenants,
} from "@agentic/db";
import type { RunStreamEvent } from "@agentic/contracts";

const RUN_CAP = 600;
const STEP_CAP = 1000;
const EVENT_CAP = 600;
const TASK_CAP = 400;
const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 2000;

export function clampLimit(raw?: string | number): number {
  const n = typeof raw === "string" ? Number(raw) : raw;
  if (!n || !Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.floor(n));
}

export async function getRecentActivity(
  tenantSlug: string,
  rawLimit?: string | number,
): Promise<RunStreamEvent[]> {
  const limit = clampLimit(rawLimit);
  const db = getDb();
  const tenant = db
    .select()
    .from(tenants)
    .where(eq(tenants.slug, tenantSlug))
    .all()[0];
  if (!tenant) return [];
  const tid = tenant.id;

  const out: RunStreamEvent[] = [];

  // ── Runs → run.started (+ run.completed / run.failed) ──────────────────────
  const runRows = db
    .select({
      id: runs.id,
      agentName: agents.name,
      triggerEvent: events.name,
      subject: runs.subject,
      correlationId: runs.correlationId,
      isTest: runs.isTest,
      status: runs.status,
      startedAt: runs.startedAt,
      endedAt: runs.endedAt,
      durationMs: runs.durationMs,
      tokensIn: runs.tokensIn,
      tokensOut: runs.tokensOut,
      emittedEventId: runs.emittedEventId,
      errorMessage: runs.errorMessage,
    })
    .from(runs)
    .innerJoin(agents, eq(agents.id, runs.agentId))
    .leftJoin(events, eq(events.id, runs.triggerEventId))
    .where(eq(runs.tenantId, tid))
    .orderBy(desc(runs.startedAt))
    .limit(RUN_CAP)
    .all();

  for (const r of runRows) {
    const startedAt = r.startedAt ? r.startedAt.getTime() : null;
    if (startedAt != null) {
      out.push({
        type: "run.started",
        tenantId: tid,
        at: startedAt,
        runId: r.id,
        agentName: r.agentName,
        triggerEvent: r.triggerEvent ?? null,
        subject: r.subject ?? null,
        correlationId: r.correlationId,
        testRun: r.isTest === true,
      });
    }
    const endedAt = r.endedAt ? r.endedAt.getTime() : null;
    if (r.status === "ok") {
      out.push({
        type: "run.completed",
        tenantId: tid,
        at: endedAt ?? startedAt ?? 0,
        runId: r.id,
        durationMs: r.durationMs ?? 0,
        tokensIn: r.tokensIn ?? null,
        tokensOut: r.tokensOut ?? null,
        emittedEventId: r.emittedEventId ?? null,
      });
    } else if (r.status === "failed") {
      out.push({
        type: "run.failed",
        tenantId: tid,
        at: endedAt ?? startedAt ?? 0,
        runId: r.id,
        errorMessage: r.errorMessage ?? "failed",
      });
    }
  }

  // ── Steps → run.step.completed ─────────────────────────────────────────────
  const stepRows = db
    .select({
      id: steps.id,
      runId: steps.runId,
      ord: steps.ord,
      name: steps.name,
      type: steps.type,
      status: steps.status,
      durationMs: steps.durationMs,
      provider: steps.provider,
      model: steps.model,
      tokensIn: steps.tokensIn,
      tokensOut: steps.tokensOut,
      error: steps.error,
      endedAt: steps.endedAt,
    })
    .from(steps)
    .innerJoin(runs, eq(runs.id, steps.runId))
    .where(and(eq(runs.tenantId, tid), isNotNull(steps.endedAt)))
    .orderBy(desc(steps.endedAt))
    .limit(STEP_CAP)
    .all();

  for (const s of stepRows) {
    out.push({
      type: "run.step.completed",
      tenantId: tid,
      at: s.endedAt ? s.endedAt.getTime() : 0,
      runId: s.runId,
      stepId: s.id,
      ord: s.ord,
      name: s.name,
      stepType: s.type,
      status: s.status,
      durationMs: s.durationMs ?? 0,
      provider: s.provider ?? null,
      model: s.model ?? null,
      tokensIn: s.tokensIn ?? null,
      tokensOut: s.tokensOut ?? null,
      error: s.error ?? null,
    });
  }

  // ── Events → event.emitted ─────────────────────────────────────────────────
  const eventRows = db
    .select({
      id: events.id,
      name: events.name,
      subject: events.subject,
      receivedAt: events.receivedAt,
    })
    .from(events)
    .where(eq(events.tenantId, tid))
    .orderBy(desc(events.receivedAt))
    .limit(EVENT_CAP)
    .all();

  for (const e of eventRows) {
    out.push({
      type: "event.emitted",
      tenantId: tid,
      at: e.receivedAt ? e.receivedAt.getTime() : 0,
      eventId: e.id,
      name: e.name,
      subject: e.subject ?? null,
      // sourceRunId isn't stored on the event row; not used by the renderer.
      sourceRunId: "",
    });
  }

  // ── Tasks → task.created (+ task.resolved) ─────────────────────────────────
  const taskRows = db
    .select({
      id: tasks.id,
      runId: tasks.runId,
      type: tasks.type,
      title: tasks.title,
      status: tasks.status,
      createdAt: tasks.createdAt,
      resolvedAt: tasks.resolvedAt,
      resolutionJson: tasks.resolutionJson,
    })
    .from(tasks)
    .where(eq(tasks.tenantId, tid))
    .orderBy(desc(tasks.createdAt))
    .limit(TASK_CAP)
    .all();

  for (const tk of taskRows) {
    out.push({
      type: "task.created",
      tenantId: tid,
      at: tk.createdAt ? tk.createdAt.getTime() : 0,
      taskId: tk.id,
      runId: tk.runId ?? "",
      taskType: tk.type,
      title: tk.title,
    });
    if (tk.status === "resolved") {
      const decision =
        (tk.resolutionJson as { decision?: string } | null)?.decision ?? "resolved";
      out.push({
        type: "task.resolved",
        tenantId: tid,
        at: tk.resolvedAt ? tk.resolvedAt.getTime() : 0,
        taskId: tk.id,
        decision,
      });
    }
  }

  // Chronological, newest last (terminal appends downward); keep the most
  // recent `limit` lines.
  out.sort((a, b) => a.at - b.at);
  return out.length > limit ? out.slice(out.length - limit) : out;
}
