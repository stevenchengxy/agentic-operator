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

import { open, stat } from "node:fs/promises";
import { and, desc, eq, isNotNull, isNull, or } from "drizzle-orm";
import {
  agents,
  auditLog,
  deployments,
  eventStore,
  events,
  getDb,
  llmCalls,
  runs,
  steps,
  tasks,
  tenants,
  workflowVersions,
  workflows,
} from "@agentic/db";
import type { RunStreamEvent } from "@agentic/contracts";
import { authorizedRunLogPath } from "@agentic/runtime";

const RUN_CAP = 600;
const STEP_CAP = 1000;
const EVENT_CAP = 600;
const TASK_CAP = 400;
const AUDIT_CAP = 400;
const LLM_CAP = 600;
const DEPLOYMENT_CAP = 200;
const LOG_RUN_CAP = 50;
const MAX_LOG_TAIL_BYTES = 128 * 1024;
const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 5000;

interface PersistedRunLog {
  id: string;
  correlationId: string;
  logPath: string;
}

/** Read a bounded tail so activity backfill cannot load an unbounded run log
 * into memory. If the tail starts mid-line, discard that first fragment. */
async function readLogTail(
  tenantSlug: string,
  filePath: string,
): Promise<string[]> {
  // `runs.log_path` is retained historical data, not filesystem authority.
  // A deployment may move AGENTIC_LOGS_DIR while old rows still point at the
  // previous root (and a poisoned row may deliberately point elsewhere). The
  // aggregate activity feed must neither read that path nor let one rejected
  // row deny service to the whole timeline. The dedicated per-run log route
  // still reports this condition explicitly as `invalid_log_path`.
  let safePath: string;
  try {
    safePath = authorizedRunLogPath(tenantSlug, filePath);
  } catch {
    return [];
  }

  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    const info = await stat(safePath);
    if (!info.isFile() || info.size === 0) return [];
    const start = Math.max(0, info.size - MAX_LOG_TAIL_BYTES);
    const length = info.size - start;
    handle = await open(safePath, "r");
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    const lines = buffer.toString("utf8", 0, bytesRead).split(/\r?\n/);
    if (start > 0) lines.shift();
    return lines.filter(Boolean);
  } catch (error) {
    // A retained database row may legitimately outlive its rotated/deleted
    // file. Only a genuinely missing file is an empty tail; permission/I/O
    // failures must surface so the terminal cannot look complete when it is not.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function toLogLineEvent(
  tenantId: string,
  run: PersistedRunLog,
  line: string,
): RunStreamEvent | null {
  const match = line.match(
    /^(\S+)\s+(DEBUG|INFO|WARN|ERROR)\s+(\S+)(?:\s+(.*))?$/,
  );
  if (!match) return null;
  const at = Date.parse(match[1]!);
  if (!Number.isFinite(at)) return null;
  const level = match[2] as "DEBUG" | "INFO" | "WARN" | "ERROR";
  const event = match[3]!;
  const rawFields = match[4] ?? "";
  const correlationId =
    rawFields.match(/(?:^|\s)correlation_id=([^\s]+)/)?.[1] ??
    run.correlationId;
  return {
    type: "log.line",
    tenantId,
    at,
    runId: run.id,
    correlationId,
    level,
    event,
    // This is the exact line that was durably written, matching the live
    // broadcast's message byte-for-byte after its trailing newline is removed.
    message: line,
    fields: {
      run_id: run.id,
      correlation_id: correlationId,
      persisted: true,
      raw: rawFields,
    },
  };
}

export function clampLimit(raw?: string | number): number {
  const n = typeof raw === "string" ? Number(raw) : raw;
  if (!n || !Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.floor(n));
}

export async function getRecentActivity(
  tenantSlug: string,
  rawLimit?: string | number,
  opts: {
    includeAudit?: boolean;
    includeFileLogs?: boolean;
    includeRuns?: boolean;
    includeTasks?: boolean;
    includeUsage?: boolean;
    includeDeployments?: boolean;
  } = {},
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
      logPath: runs.logPath,
      codeRan: runs.codeRan,
      codeExecuted: runs.codeExecuted,
      codeIsolation: runs.codeIsolation,
      codeSha256: runs.codeSha256,
      codeAttestation: runs.codeAttestation,
      codeExecutionFailure: runs.codeExecutionFailure,
    })
    .from(runs)
    .innerJoin(agents, eq(agents.id, runs.agentId))
    .leftJoin(events, eq(events.id, runs.triggerEventId))
    .where(and(eq(runs.tenantId, tid), isNull(runs.deletedAt)))
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
        durationMs: r.durationMs ?? null,
        tokensIn: r.tokensIn ?? null,
        tokensOut: r.tokensOut ?? null,
        emittedEventId: r.emittedEventId ?? null,
        codeRan: r.codeRan,
        codeExecuted: r.codeExecuted,
        codeIsolation: r.codeIsolation,
        codeSha256: r.codeSha256,
        codeAttestation: r.codeAttestation,
        codeExecutionFailure: r.codeExecutionFailure,
      });
    } else if (r.status === "failed") {
      out.push({
        type: "run.failed",
        tenantId: tid,
        at: endedAt ?? startedAt ?? 0,
        runId: r.id,
        errorMessage: r.errorMessage ?? "failed",
        codeRan: r.codeRan,
        codeExecuted: r.codeExecuted,
        codeIsolation: r.codeIsolation,
        codeSha256: r.codeSha256,
        codeAttestation: r.codeAttestation,
        codeExecutionFailure: r.codeExecutionFailure,
      });
    } else if (r.status === "cancelled") {
      out.push({
        type: "run.cancelled",
        tenantId: tid,
        at: endedAt ?? startedAt ?? 0,
        runId: r.id,
        reason: r.errorMessage ?? "cancelled",
      });
    }
  }

  // ── Exact persisted runtime lines → log.line ─────────────────────────────
  // Live delivery mirrors appendFile() only after the write succeeds. The
  // backfill must read those same files so a refresh/tab switch does not erase
  // the terminal's most authoritative records.
  if (opts.includeFileLogs === true) {
    const persistedRuns = runRows
      .filter((run): run is typeof run & { logPath: string } =>
        Boolean(run.logPath),
      )
      .slice(0, LOG_RUN_CAP)
      .map((run) => ({
        id: run.id,
        correlationId: run.correlationId,
        logPath: run.logPath,
      }));
    const fileLines = await Promise.all(
      persistedRuns.map(async (run) => ({
        run,
        lines: await readLogTail(tenantSlug, run.logPath),
      })),
    );
    for (const { run, lines } of fileLines) {
      for (const line of lines) {
        const event = toLogLineEvent(tid, run, line);
        if (event) out.push(event);
      }
    }
  }

  // ── Steps → run.step.completed ─────────────────────────────────────────────
  const stepRows = db
    .select({
      id: steps.id,
      runId: steps.runId,
      correlationId: runs.correlationId,
      agentName: agents.name,
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
      codeRan: steps.codeRan,
      codeExecuted: steps.codeExecuted,
      codeIsolation: steps.codeIsolation,
      codeSha256: steps.codeSha256,
      codeAttestation: steps.codeAttestation,
      codeExecutionFailure: steps.codeExecutionFailure,
    })
    .from(steps)
    .innerJoin(runs, eq(runs.id, steps.runId))
    .innerJoin(agents, eq(agents.id, runs.agentId))
    .where(
      and(
        eq(runs.tenantId, tid),
        isNull(runs.deletedAt),
        isNotNull(steps.endedAt),
      ),
    )
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
      durationMs: s.durationMs ?? null,
      provider: s.provider ?? null,
      model: s.model ?? null,
      tokensIn: s.tokensIn ?? null,
      tokensOut: s.tokensOut ?? null,
      error: s.error ?? null,
      codeRan: s.codeRan,
      codeExecuted: s.codeExecuted,
      codeIsolation: s.codeIsolation,
      codeSha256: s.codeSha256,
      codeAttestation: s.codeAttestation,
      codeExecutionFailure: s.codeExecutionFailure,
    });
    if (s.type === "tool") {
      out.push({
        type: "tool.call.completed",
        tenantId: tid,
        at: s.endedAt ? s.endedAt.getTime() : 0,
        runId: s.runId,
        correlationId: s.correlationId,
        agentName: s.agentName,
        stepName: s.name,
        toolName: s.name,
        durationMs: s.durationMs ?? null,
        ok: s.status === "ok",
        error: s.error ?? null,
      });
    }
  }

  // ── Events → event.emitted ─────────────────────────────────────────────────
  const eventRows = db
    .select({
      id: events.id,
      name: events.name,
      subject: events.subject,
      receivedAt: events.receivedAt,
      sourceRunId: eventStore.sourceRunId,
    })
    .from(events)
    .leftJoin(eventStore, eq(eventStore.id, events.id))
    .where(and(eq(events.tenantId, tid), isNull(events.deletedAt)))
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
      sourceRunId: e.sourceRunId ?? null,
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
    .where(and(eq(tasks.tenantId, tid), isNull(tasks.deletedAt)))
    .orderBy(desc(tasks.createdAt))
    .limit(TASK_CAP)
    .all();

  for (const tk of taskRows) {
    out.push({
      type: "task.created",
      tenantId: tid,
      at: tk.createdAt ? tk.createdAt.getTime() : 0,
      taskId: tk.id,
      runId: tk.runId ?? null,
      taskType: tk.type,
      title: tk.title,
    });
    if (tk.status === "resolved") {
      const decision =
        (tk.resolutionJson as { decision?: string } | null)?.decision ??
        "resolved";
      out.push({
        type: "task.resolved",
        tenantId: tid,
        at: tk.resolvedAt ? tk.resolvedAt.getTime() : 0,
        taskId: tk.id,
        decision,
      });
    }
  }

  // ── Audit → audit.recorded ────────────────────────────────────────────────
  if (opts.includeAudit === true) {
    const auditRows = db
      .select()
      .from(auditLog)
      .where(eq(auditLog.tenantId, tid))
      .orderBy(desc(auditLog.at))
      .limit(AUDIT_CAP)
      .all();
    for (const row of auditRows) {
      const decision = (row.metaJson as { decision?: unknown } | null)
        ?.decision;
      out.push({
        type: "audit.recorded",
        tenantId: tid,
        at: row.at.getTime(),
        auditId: row.id,
        action: row.action,
        actorUserId: row.actorUserId ?? null,
        targetType: row.targetType ?? null,
        targetId: row.targetId ?? null,
        decision: decision === "allow" || decision === "deny" ? decision : null,
      });
    }
  }

  // ── Provider telemetry → llm.call.completed ───────────────────────────────
  const llmRows = db
    .select()
    .from(llmCalls)
    .where(eq(llmCalls.tenantId, tid))
    .orderBy(desc(llmCalls.createdAt))
    .limit(LLM_CAP)
    .all();
  for (const row of llmRows) {
    out.push({
      type: "llm.call.completed",
      tenantId: tid,
      at: row.createdAt.getTime(),
      callId: row.id,
      runId: row.runId ?? null,
      purpose: row.purpose ?? null,
      provider: row.provider ?? null,
      requestedModel: row.requestedModel ?? null,
      servedModel: row.servedModel ?? null,
      tokensIn: row.approxTokensIn ?? null,
      tokensOut: row.approxTokensOut ?? null,
      tokenSource: row.tokenSource ?? null,
      latencyMs: row.latencyMs ?? null,
      fallback: row.fallback ?? null,
      ok: row.ok ?? null,
      failureReason: row.failureReason ?? null,
    });
  }

  // ── Deployments → deployment.created ─────────────────────────────────────
  const deploymentRows = db
    .select({
      id: deployments.id,
      target: deployments.target,
      status: deployments.status,
      deployedAt: deployments.deployedAt,
      version: workflowVersions.version,
      workflowSlug: workflows.slug,
    })
    .from(deployments)
    .innerJoin(workflowVersions, eq(workflowVersions.id, deployments.versionId))
    .innerJoin(workflows, eq(workflows.id, workflowVersions.workflowId))
    .where(
      and(
        eq(deployments.tenantId, tid),
        or(
          eq(deployments.target, "workflow"),
          eq(deployments.target, "tenant_code"),
        ),
      ),
    )
    .orderBy(desc(deployments.deployedAt))
    .limit(DEPLOYMENT_CAP)
    .all();
  for (const row of deploymentRows) {
    // A rolled_back row was live at `deployedAt`; keep that historical
    // deployment event in terminal backfill. Only pending rows never became
    // real activations.
    if (row.status === "pending") continue;
    out.push({
      type: "deployment.created",
      tenantId: tid,
      at: row.deployedAt.getTime(),
      deploymentId: row.id,
      kind: row.target === "tenant_code" ? "tenant_code" : "manifest",
      version: row.version,
      workflowSlug: row.target === "tenant_code" ? null : row.workflowSlug,
    });
  }

  // Chronological, newest last (terminal appends downward); keep the most
  // recent `limit` lines.
  const visible = out.filter((event) => {
    switch (event.type) {
      case "run.started":
      case "run.completed":
      case "run.failed":
      case "run.cancelled":
      case "run.step.started":
      case "run.step.completed":
      case "log.line":
      case "tool.call.completed":
        return opts.includeRuns !== false;
      case "task.created":
      case "task.resolved":
        return opts.includeTasks !== false;
      case "llm.call.completed":
        return opts.includeUsage !== false;
      case "deployment.created":
        return opts.includeDeployments !== false;
      case "audit.recorded":
        return opts.includeAudit === true;
      case "event.emitted":
        return true;
    }
  });
  visible.sort((a, b) => a.at - b.at);
  return visible.length > limit
    ? visible.slice(visible.length - limit)
    : visible;
}
