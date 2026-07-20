/**
 * Unified observability read + stream surface.
 *
 * These endpoints intentionally aggregate the same durable rows that power
 * Runs, Events, Audit and Reasoning. There is no demo-only side channel:
 * summary charts, invocation edges and timeline backfill all reflect actual
 * runtime writes; `/observability/stream` carries the corresponding live
 * `RunStreamEvent` records.
 */

import type { FastifyInstance } from "fastify";
import { and, desc, eq, gte, inArray, isNull, lt, or } from "drizzle-orm";
import {
  agents,
  auditLog,
  events,
  getDb,
  llmCalls,
  runs,
  steps,
  workflows,
} from "@agentic/db";
import { subscribeStreamEvents } from "@agentic/runtime";
import type { RunStreamEvent } from "@agentic/contracts";
import { can, requirePermission } from "../../plugins/rbac";
import { getRecentActivity } from "../../queries/activity";
import { calculateTenantUsage } from "../../services/usage-accounting";

const DAY = 86_400_000;
const DEFAULT_WINDOW_MS = DAY;
const MAX_SUMMARY_WINDOW_MS = 90 * DAY;
const MAX_SUMMARY_SOURCE_ROWS = 100_000;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

interface WindowQuery {
  since?: string;
  until?: string;
  bucketMs?: string;
}

interface PageQuery extends WindowQuery {
  limit?: string;
  cursor?: string;
  types?: string;
  q?: string;
  backfill?: string;
}

interface ObservationItem {
  id: string;
  type: RunStreamEvent["type"];
  kind:
    | "run"
    | "step"
    | "event"
    | "task"
    | "deployment"
    | "log"
    | "audit"
    | "llm"
    | "tool";
  at: number;
  level: "debug" | "info" | "warn" | "error";
  runId: string | null;
  stepId: string | null;
  eventId: string | null;
  agentName: string | null;
  message: string;
  metadata: RunStreamEvent;
}

function numberParam(raw: string | undefined): number | null {
  if (!raw) return null;
  const direct = Number(raw);
  if (Number.isFinite(direct)) return direct;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function windowValidationError(q: WindowQuery): string | null {
  for (const [name, raw] of [
    ["since", q.since],
    ["until", q.until],
    ["bucketMs", q.bucketMs],
  ] as const) {
    if (raw == null) continue;
    const value = numberParam(raw);
    if (value == null || value < 0)
      return `${name} must be a non-negative unix timestamp or ISO date`;
    if (name === "bucketMs" && value === 0)
      return "bucketMs must be greater than zero";
  }
  const since = numberParam(q.since);
  const until = numberParam(q.until);
  if (since != null && until != null && since >= until)
    return "since must be earlier than until";
  return null;
}

function resolveWindow(q: WindowQuery): {
  since: number;
  until: number;
  bucketMs: number;
} {
  const now = Date.now();
  const until = numberParam(q.until) ?? now;
  const sinceRaw = numberParam(q.since) ?? until - DEFAULT_WINDOW_MS;
  const since = Math.min(sinceRaw, until);
  const span = Math.max(1, until - since);
  const requestedBucket = numberParam(q.bucketMs);
  const automatic =
    span <= 6 * 3_600_000
      ? 5 * 60_000
      : span <= 2 * DAY
        ? 3_600_000
        : span <= 14 * DAY
          ? 6 * 3_600_000
          : DAY;
  // At most ~1,000 chart points and never below one minute.
  const minBucket = Math.max(60_000, Math.ceil(span / 1_000));
  const bucketMs = Math.max(
    minBucket,
    Math.min(31 * DAY, requestedBucket ?? automatic),
  );
  return { since, until, bucketMs };
}

function pageLimit(raw: string | undefined): number {
  const n = Number(raw ?? DEFAULT_LIMIT);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.floor(n));
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.max(0, Math.ceil(sorted.length * p) - 1);
  return sorted[Math.min(idx, sorted.length - 1)] ?? null;
}

function shortHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function eventIdentity(ev: RunStreamEvent): string {
  switch (ev.type) {
    case "run.started":
      return `run-start:${ev.runId}`;
    case "run.completed":
    case "run.failed":
    case "run.cancelled":
      return `${ev.type}:${ev.runId}`;
    case "run.step.started":
    case "run.step.completed":
      return `${ev.type}:${ev.stepId}`;
    case "event.emitted":
      return `event:${ev.eventId}`;
    case "task.created":
    case "task.resolved":
      return `${ev.type}:${ev.taskId}`;
    case "deployment.created":
      return `deployment:${ev.deploymentId}`;
    case "log.line":
      return `log:${ev.runId}:${ev.at}:${ev.event}:${shortHash(ev.message)}`;
    case "audit.recorded":
      return `audit:${ev.auditId}`;
    case "llm.call.completed":
      return `llm:${ev.callId}`;
    case "tool.call.completed":
      return `tool:${ev.runId}:${ev.at}:${ev.toolName}:${shortHash(`${ev.correlationId}:${ev.stepName ?? ""}`)}`;
  }
}

function eventKind(ev: RunStreamEvent): ObservationItem["kind"] {
  if (ev.type.startsWith("run.step.")) return "step";
  if (ev.type.startsWith("run.")) return "run";
  if (ev.type.startsWith("event.")) return "event";
  if (ev.type.startsWith("task.")) return "task";
  if (ev.type.startsWith("deployment.")) return "deployment";
  if (ev.type === "log.line") return "log";
  if (ev.type === "audit.recorded") return "audit";
  if (ev.type === "llm.call.completed") return "llm";
  return "tool";
}

function eventLevel(ev: RunStreamEvent): ObservationItem["level"] {
  if (ev.type === "run.failed") return "error";
  if (ev.type === "run.cancelled") return "warn";
  if (ev.type === "run.step.completed" && ev.status === "failed")
    return "error";
  if (ev.type === "log.line")
    return ev.level.toLowerCase() as ObservationItem["level"];
  if (ev.type === "audit.recorded" && ev.decision === "deny") return "warn";
  if (ev.type === "llm.call.completed" && ev.ok === false) return "error";
  if (ev.type === "tool.call.completed" && !ev.ok) return "error";
  return "info";
}

function eventMessage(ev: RunStreamEvent): string {
  switch (ev.type) {
    case "run.started":
      return `${ev.agentName} started${ev.triggerEvent ? ` from ${ev.triggerEvent}` : ""}`;
    case "run.step.started":
      return `${ev.name} started`;
    case "run.step.completed":
      return `${ev.name} ${ev.status}${ev.durationMs == null ? "" : ` in ${ev.durationMs}ms`}`;
    case "run.completed":
      return `run completed${ev.durationMs == null ? "" : ` in ${ev.durationMs}ms`}`;
    case "run.failed":
      return `run failed: ${ev.errorMessage}`;
    case "run.cancelled":
      return `run cancelled: ${ev.reason}`;
    case "event.emitted":
      return `${ev.name}${ev.subject ? ` · ${ev.subject}` : ""}`;
    case "task.created":
      return `task created: ${ev.title}`;
    case "task.resolved":
      return `task resolved: ${ev.decision}`;
    case "deployment.created":
      return `${ev.kind} deployment ${ev.version}`;
    case "log.line":
      return ev.message;
    case "audit.recorded":
      return `${ev.action}${ev.targetId ? ` · ${ev.targetId}` : ""}`;
    case "llm.call.completed":
      return `${ev.provider ?? "unknown"}/${ev.servedModel ?? ev.requestedModel ?? "unknown"} ${ev.ok === true ? "completed" : ev.ok === false ? "failed" : "status unknown"}`;
    case "tool.call.completed":
      return `${ev.toolName} ${ev.ok ? "completed" : "failed"}`;
  }
}

function toObservation(
  ev: RunStreamEvent,
  agentByRun: Map<string, string> = new Map(),
): ObservationItem {
  const runId =
    "runId" in ev
      ? (ev.runId ?? null)
      : "sourceRunId" in ev
        ? (ev.sourceRunId ?? null)
        : null;
  const stepId = "stepId" in ev ? ev.stepId : null;
  const eventId = "eventId" in ev ? ev.eventId : null;
  const directAgent =
    "agentName" in ev && typeof ev.agentName === "string" ? ev.agentName : null;
  return {
    id: eventIdentity(ev),
    type: ev.type,
    kind: eventKind(ev),
    at: ev.at,
    level: eventLevel(ev),
    runId,
    stepId,
    eventId,
    agentName: directAgent ?? (runId ? (agentByRun.get(runId) ?? null) : null),
    message: eventMessage(ev),
    metadata: ev,
  };
}

function typeFilter(raw: string | undefined): Set<string> | null {
  if (!raw) return null;
  const values = raw
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  return values.length ? new Set(values) : null;
}

function matchesType(item: ObservationItem, filter: Set<string> | null) {
  return !filter || filter.has(item.type) || filter.has(item.kind);
}

function parseCursor(
  raw: string | undefined,
): { at: number; id: string } | null {
  if (!raw) return null;
  const split = raw.indexOf(":");
  const at = Number(split === -1 ? raw : raw.slice(0, split));
  if (!Number.isFinite(at)) return null;
  return { at, id: split === -1 ? "" : raw.slice(split + 1) };
}

function cursorFor(item: { at: number; id: string }): string {
  return `${item.at}:${item.id}`;
}

export async function observabilityRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: WindowQuery }>(
    "/observability/summary",
    async (req, reply) => {
      const auth = requirePermission(req, "usage.read");
      const validationError = windowValidationError(req.query);
      if (validationError)
        return reply.fail("bad_request", validationError, 400);
      const window = resolveWindow(req.query);
      if (window.until - window.since > MAX_SUMMARY_WINDOW_MS) {
        return reply.fail(
          "window_too_large",
          "observability summary supports windows up to 90 days; narrow the requested range",
          422,
        );
      }
      const db = getDb();
      const betweenRuns = and(
        eq(runs.tenantId, auth.tenantId),
        isNull(runs.deletedAt),
        gte(runs.startedAt, new Date(window.since)),
        lt(runs.startedAt, new Date(window.until)),
      );

      const runRows = db
        .select({
          id: runs.id,
          status: runs.status,
          startedAt: runs.startedAt,
          durationMs: runs.durationMs,
          tokensIn: runs.tokensIn,
          tokensOut: runs.tokensOut,
          isTest: runs.isTest,
          model: runs.model,
          agentId: agents.id,
          agentName: agents.name,
          agentTitle: agents.title,
          agentKind: agents.kind,
        })
        .from(runs)
        .innerJoin(agents, eq(agents.id, runs.agentId))
        .where(betweenRuns)
        .limit(MAX_SUMMARY_SOURCE_ROWS + 1)
        .all();

      const eventRows = db
        .select({ at: events.receivedAt })
        .from(events)
        .where(
          and(
            eq(events.tenantId, auth.tenantId),
            isNull(events.deletedAt),
            gte(events.receivedAt, new Date(window.since)),
            lt(events.receivedAt, new Date(window.until)),
          ),
        )
        .limit(MAX_SUMMARY_SOURCE_ROWS + 1)
        .all();

      const auditAuthorized = can(auth, "audit.read");
      const auditRows = auditAuthorized
        ? db
            .select({ at: auditLog.at })
            .from(auditLog)
            .where(
              and(
                eq(auditLog.tenantId, auth.tenantId),
                gte(auditLog.at, new Date(window.since)),
                lt(auditLog.at, new Date(window.until)),
              ),
            )
            .limit(MAX_SUMMARY_SOURCE_ROWS + 1)
            .all()
        : [];

      const llmRows = db
        .select()
        .from(llmCalls)
        .where(
          and(
            eq(llmCalls.tenantId, auth.tenantId),
            gte(llmCalls.createdAt, new Date(window.since)),
            lt(llmCalls.createdAt, new Date(window.until)),
          ),
        )
        .limit(MAX_SUMMARY_SOURCE_ROWS + 1)
        .all();

      const stepRows = db
        .select({
          id: steps.id,
          runId: steps.runId,
          name: steps.name,
          type: steps.type,
          status: steps.status,
          durationMs: steps.durationMs,
          endedAt: steps.endedAt,
          agentName: agents.name,
        })
        .from(steps)
        .innerJoin(runs, eq(runs.id, steps.runId))
        .innerJoin(agents, eq(agents.id, runs.agentId))
        .where(betweenRuns)
        .limit(MAX_SUMMARY_SOURCE_ROWS + 1)
        .all();

      const oversizedSource = [
        ["runs", runRows.length],
        ["events", eventRows.length],
        ["audit", auditRows.length],
        ["llm_calls", llmRows.length],
        ["steps", stepRows.length],
      ].find(([, count]) => Number(count) > MAX_SUMMARY_SOURCE_ROWS);
      if (oversizedSource) {
        return reply.fail(
          "observability_result_too_large",
          `${oversizedSource[0]} exceeded ${MAX_SUMMARY_SOURCE_ROWS} rows; narrow the requested range`,
          422,
        );
      }

      const accountedUsage = calculateTenantUsage(
        auth.tenantId,
        new Date(window.since),
        new Date(window.until),
      );
      const completed = runRows.filter((r) => r.status === "ok").length;
      const failed = runRows.filter((r) => r.status === "failed").length;
      const cancelled = runRows.filter((r) => r.status === "cancelled").length;
      const active = runRows.filter(
        (r) =>
          r.status === "running" ||
          r.status === "queued" ||
          r.status === "waiting",
      ).length;
      const durations = runRows
        .map((r) => r.durationMs)
        .filter((v): v is number => typeof v === "number" && v >= 0);

      const agentMap = new Map<
        string,
        {
          agentId: string;
          agentName: string;
          agentTitle: string | null;
          kind: string;
          runs: number;
          successful: number;
          failed: number;
          active: number;
          tokensIn: number;
          tokensOut: number;
          durationValues: number[];
          lastRunAt: number | null;
        }
      >();
      const attributedTokensByRun = new Map<
        string,
        { tokensIn: number; tokensOut: number }
      >();
      for (const call of llmRows) {
        if (!call.runId) continue;
        const current = attributedTokensByRun.get(call.runId) ?? {
          tokensIn: 0,
          tokensOut: 0,
        };
        current.tokensIn += call.approxTokensIn ?? 0;
        current.tokensOut += call.approxTokensOut ?? 0;
        attributedTokensByRun.set(call.runId, current);
      }
      for (const row of runRows) {
        const cur = agentMap.get(row.agentId) ?? {
          agentId: row.agentId,
          agentName: row.agentName,
          agentTitle: row.agentTitle ?? null,
          kind: row.agentKind,
          runs: 0,
          successful: 0,
          failed: 0,
          active: 0,
          tokensIn: 0,
          tokensOut: 0,
          durationValues: [],
          lastRunAt: null,
        };
        cur.runs += 1;
        if (row.status === "ok") cur.successful += 1;
        if (row.status === "failed") cur.failed += 1;
        if (["running", "queued", "waiting"].includes(row.status))
          cur.active += 1;
        const attributed = attributedTokensByRun.get(row.id);
        cur.tokensIn += attributed?.tokensIn ?? row.tokensIn ?? 0;
        cur.tokensOut += attributed?.tokensOut ?? row.tokensOut ?? 0;
        if (row.durationMs != null) cur.durationValues.push(row.durationMs);
        const at = row.startedAt?.getTime() ?? null;
        if (at != null && (cur.lastRunAt == null || at > cur.lastRunAt))
          cur.lastRunAt = at;
        agentMap.set(row.agentId, cur);
      }
      const byAgent = [...agentMap.values()]
        .map(({ durationValues, ...row }) => ({
          ...row,
          successRate: row.runs ? row.successful / row.runs : 0,
          avgDurationMs: durationValues.length
            ? Math.round(
                durationValues.reduce((a, b) => a + b, 0) /
                  durationValues.length,
              )
            : null,
          p95DurationMs: percentile(durationValues, 0.95),
        }))
        .sort((a, b) => b.runs - a.runs);

      const modelMap = new Map<
        string,
        {
          model: string;
          provider: string | null;
          calls: number;
          runIds: Set<string>;
          tokensIn: number;
          tokensOut: number;
          failures: number;
          fallbacks: number;
          exactProviderTokens: number;
          estimatedTokens: number;
          legacyRunTokens: number;
          unknownSourceTokens: number;
          latencyValues: number[];
        }
      >();
      for (const row of llmRows) {
        const model = row.servedModel ?? row.requestedModel ?? "unknown";
        const key = `${row.provider ?? "unknown"}:${model}`;
        const cur = modelMap.get(key) ?? {
          model,
          provider: row.provider ?? null,
          calls: 0,
          runIds: new Set<string>(),
          tokensIn: 0,
          tokensOut: 0,
          failures: 0,
          fallbacks: 0,
          exactProviderTokens: 0,
          estimatedTokens: 0,
          legacyRunTokens: 0,
          unknownSourceTokens: 0,
          latencyValues: [],
        };
        cur.calls += 1;
        const callTokens =
          (row.approxTokensIn ?? 0) + (row.approxTokensOut ?? 0);
        // Anonymous legacy runtime calls are visible as call evidence but are
        // excluded from token totals because they cannot be de-duplicated
        // against run aggregates.
        const tokenCounted =
          row.conversationId !== "runtime" || Boolean(row.runId);
        if (tokenCounted) {
          cur.tokensIn += row.approxTokensIn ?? 0;
          cur.tokensOut += row.approxTokensOut ?? 0;
          if (row.tokenSource === "provider")
            cur.exactProviderTokens += callTokens;
          else if (
            row.tokenSource === "estimated_chars" ||
            row.conversationId !== "runtime"
          )
            cur.estimatedTokens += callTokens;
          else cur.unknownSourceTokens += callTokens;
        }
        if (row.ok === false) cur.failures += 1;
        if (row.fallback === true) cur.fallbacks += 1;
        if (row.runId) cur.runIds.add(row.runId);
        if (row.latencyMs != null) cur.latencyValues.push(row.latencyMs);
        modelMap.set(key, cur);
      }
      const attributedRunIds = new Set(
        llmRows.flatMap((row) => (row.runId ? [row.runId] : [])),
      );
      for (const row of runRows) {
        if (attributedRunIds.has(row.id)) continue;
        const model = row.model ?? "unknown";
        const key = `legacy-run:${model}`;
        const cur = modelMap.get(key) ?? {
          model,
          provider: null,
          calls: 0,
          runIds: new Set<string>(),
          tokensIn: 0,
          tokensOut: 0,
          failures: 0,
          fallbacks: 0,
          exactProviderTokens: 0,
          estimatedTokens: 0,
          legacyRunTokens: 0,
          unknownSourceTokens: 0,
          latencyValues: [],
        };
        cur.runIds.add(row.id);
        cur.tokensIn += row.tokensIn ?? 0;
        cur.tokensOut += row.tokensOut ?? 0;
        cur.legacyRunTokens += (row.tokensIn ?? 0) + (row.tokensOut ?? 0);
        modelMap.set(key, cur);
      }
      const byModel = [...modelMap.values()]
        .map(({ latencyValues, runIds, ...row }) => ({
          ...row,
          runs: runIds.size,
          avgLatencyMs: latencyValues.length
            ? Math.round(
                latencyValues.reduce((a, b) => a + b, 0) / latencyValues.length,
              )
            : null,
          p95LatencyMs: percentile(latencyValues, 0.95),
        }))
        .sort((a, b) => b.calls - a.calls || b.runs - a.runs);

      type ToolAggregate = {
        name: string;
        calls: number;
        successful: number;
        failed: number;
        durationValues: number[];
        agents: Set<string>;
        lastCalledAt: number | null;
      };
      const toolMap = new Map<string, ToolAggregate>();
      const addTool = (
        name: string,
        ok: boolean,
        agentName: string,
        durationMs: number | null,
        at: number | null,
      ) => {
        const cur = toolMap.get(name) ?? {
          name,
          calls: 0,
          successful: 0,
          failed: 0,
          durationValues: [],
          agents: new Set<string>(),
          lastCalledAt: null,
        };
        cur.calls += 1;
        ok ? (cur.successful += 1) : (cur.failed += 1);
        if (durationMs != null) cur.durationValues.push(durationMs);
        cur.agents.add(agentName);
        if (at != null && (cur.lastCalledAt == null || at > cur.lastCalledAt))
          cur.lastCalledAt = at;
        toolMap.set(name, cur);
      };
      for (const row of stepRows) {
        if (row.type !== "tool") continue;
        addTool(
          row.name,
          row.status === "ok",
          row.agentName,
          row.durationMs ?? null,
          row.endedAt?.getTime() ?? null,
        );
      }
      const byTool = [...toolMap.values()]
        .map(({ durationValues, agents: agentSet, ...row }) => ({
          ...row,
          successRate: row.calls ? row.successful / row.calls : 0,
          avgDurationMs: durationValues.length
            ? Math.round(
                durationValues.reduce((a, b) => a + b, 0) /
                  durationValues.length,
              )
            : null,
          p95DurationMs: percentile(durationValues, 0.95),
          agents: [...agentSet].sort(),
        }))
        .sort((a, b) => b.calls - a.calls);

      const statusOrder = [
        "queued",
        "running",
        "waiting",
        "ok",
        "failed",
        "cancelled",
      ];
      const byStatus = statusOrder.map((status) => ({
        status,
        runs: runRows.filter((r) => r.status === status).length,
      }));

      const buckets = new Map<
        number,
        {
          start: number;
          end: number;
          runs: number;
          events: number;
          errors: number;
          tokensIn: number;
          tokensOut: number;
          llmCalls: number;
          toolCalls: number;
        }
      >();
      for (
        let start = window.since;
        start < window.until;
        start += window.bucketMs
      ) {
        buckets.set(start, {
          start,
          end: Math.min(window.until, start + window.bucketMs),
          runs: 0,
          events: 0,
          errors: 0,
          tokensIn: 0,
          tokensOut: 0,
          llmCalls: 0,
          toolCalls: 0,
        });
      }
      const bucketFor = (at: number) => {
        const idx = Math.floor((at - window.since) / window.bucketMs);
        return buckets.get(window.since + idx * window.bucketMs);
      };
      for (const row of runRows) {
        const b = row.startedAt ? bucketFor(row.startedAt.getTime()) : null;
        if (!b) continue;
        b.runs += 1;
        if (!attributedRunIds.has(row.id)) {
          b.tokensIn += row.tokensIn ?? 0;
          b.tokensOut += row.tokensOut ?? 0;
        }
        if (row.status === "failed") b.errors += 1;
      }
      for (const row of eventRows) {
        const b = bucketFor(row.at.getTime());
        if (b) b.events += 1;
      }
      for (const row of llmRows) {
        const b = bucketFor(row.createdAt.getTime());
        if (b) {
          b.llmCalls += 1;
          if (row.conversationId !== "runtime" || row.runId) {
            b.tokensIn += row.approxTokensIn ?? 0;
            b.tokensOut += row.approxTokensOut ?? 0;
          }
        }
      }
      for (const row of stepRows) {
        if (row.type !== "tool" || !row.endedAt) continue;
        const b = bucketFor(row.endedAt.getTime());
        if (b) b.toolCalls += 1;
      }

      const terminal = completed + failed + cancelled;
      return reply.ok({
        window,
        totals: {
          runs: runRows.length,
          agentInvocations: runRows.length,
          events: eventRows.length,
          auditOperations: auditAuthorized ? auditRows.length : null,
          llmCalls: llmRows.length,
          toolCalls: byTool.reduce((n, t) => n + t.calls, 0),
          tokensIn: accountedUsage.tokensIn,
          tokensOut: accountedUsage.tokensOut,
          tokens: accountedUsage.tokens,
          costUsdCents: accountedUsage.usdCents,
          unpricedTokens: accountedUsage.unpricedTokens,
          costComplete: accountedUsage.costComplete,
          errors: failed,
          active,
          activeAgents: new Set(
            runRows
              .filter((r) =>
                ["running", "queued", "waiting"].includes(r.status),
              )
              .map((r) => r.agentId),
          ).size,
          agentsObserved: new Set(runRows.map((r) => r.agentId)).size,
          testRuns: runRows.filter((r) => r.isTest === true).length,
        },
        rates: {
          success: terminal ? completed / terminal : 0,
          error: terminal ? failed / terminal : 0,
          cancellation: terminal ? cancelled / terminal : 0,
        },
        latency: {
          avgMs: durations.length
            ? Math.round(
                durations.reduce((a, b) => a + b, 0) / durations.length,
              )
            : null,
          p50Ms: percentile(durations, 0.5),
          p95Ms: percentile(durations, 0.95),
        },
        byAgent,
        byModel,
        byStatus,
        byTool,
        timeSeries: [...buckets.values()],
        coverage: {
          auditAuthorized,
          toolCalls: "persisted_steps_only",
          tokens: {
            complete: accountedUsage.tokenCoverageComplete,
            exactProviderTokens: accountedUsage.exactProviderTokens,
            estimatedTokens: accountedUsage.estimatedTokens,
            legacyRunTokens: accountedUsage.legacyRunTokens,
            ambiguousRuntimeCallTokens:
              accountedUsage.ambiguousRuntimeCallTokens,
            unknownSourceTokens: accountedUsage.unknownSourceTokens,
            ambiguousRuntimeCalls: accountedUsage.ambiguousRuntimeCalls,
            unknownSourceCalls: accountedUsage.unknownSourceCalls,
            unmeasuredRuntimeCalls: accountedUsage.unmeasuredRuntimeCalls,
          },
        },
      });
    },
  );

  app.get<{ Querystring: PageQuery }>(
    "/observability/timeline",
    async (req, reply) => {
      const auth = requirePermission(req, "events.read");
      const validationError = windowValidationError(req.query);
      if (validationError)
        return reply.fail("bad_request", validationError, 400);
      const limit = pageLimit(req.query.limit);
      const window = resolveWindow(req.query);
      const filter = typeFilter(req.query.types);
      const cursor = parseCursor(req.query.cursor);
      const needle = req.query.q?.trim().toLowerCase() ?? "";
      const activity = await getRecentActivity(auth.tenantSlug, 5_000, {
        includeAudit: can(auth, "audit.read"),
        includeFileLogs: can(auth, "runs.read"),
        includeRuns: can(auth, "runs.read"),
        includeTasks: can(auth, "tasks.read"),
        includeUsage: can(auth, "usage.read"),
        includeDeployments: can(auth, "deployments.read"),
      });
      const agentByRun = new Map<string, string>();
      for (const ev of activity) {
        if (ev.type === "run.started") agentByRun.set(ev.runId, ev.agentName);
      }
      let items = activity
        .map((ev) => toObservation(ev, agentByRun))
        .filter((item) => item.at >= window.since && item.at < window.until)
        .filter((item) => matchesType(item, filter))
        .filter(
          (item) =>
            !needle ||
            item.message.toLowerCase().includes(needle) ||
            item.agentName?.toLowerCase().includes(needle) ||
            item.runId?.toLowerCase().includes(needle) ||
            JSON.stringify(item.metadata).toLowerCase().includes(needle),
        )
        .sort((a, b) => b.at - a.at || b.id.localeCompare(a.id));
      if (cursor) {
        items = items.filter(
          (item) =>
            item.at < cursor.at ||
            (item.at === cursor.at && item.id < cursor.id),
        );
      }
      const page = items.slice(0, limit);
      return reply.ok({
        items: page,
        nextCursor:
          items.length > limit && page.length
            ? cursorFor(page[page.length - 1]!)
            : null,
        count: page.length,
        window,
      });
    },
  );

  app.get<{ Querystring: PageQuery }>(
    "/observability/invocations",
    async (req, reply) => {
      const auth = requirePermission(req, "runs.read");
      const validationError = windowValidationError(req.query);
      if (validationError)
        return reply.fail("bad_request", validationError, 400);
      const limit = pageLimit(req.query.limit);
      const window = resolveWindow(req.query);
      const cursor = parseCursor(req.query.cursor);
      const db = getDb();
      const runProjection = {
        id: runs.id,
        parentRunId: runs.parentRunId,
        triggerEventId: runs.triggerEventId,
        emittedEventId: runs.emittedEventId,
        correlationId: runs.correlationId,
        status: runs.status,
        startedAt: runs.startedAt,
        durationMs: runs.durationMs,
        tokensIn: runs.tokensIn,
        tokensOut: runs.tokensOut,
        agentId: agents.id,
        agentName: agents.name,
        agentTitle: agents.title,
      } as const;
      const cursorRunId = cursor?.id.startsWith("invoke:")
        ? cursor.id.slice("invoke:".length)
        : cursor?.id;
      const calleeConditions = [
        eq(runs.tenantId, auth.tenantId),
        isNull(runs.deletedAt),
        gte(runs.startedAt, new Date(window.since)),
        lt(runs.startedAt, new Date(window.until)),
      ];
      if (cursor && cursorRunId) {
        calleeConditions.push(
          or(
            lt(runs.startedAt, new Date(cursor.at)),
            and(
              eq(runs.startedAt, new Date(cursor.at)),
              lt(runs.id, cursorRunId),
            ),
          )!,
        );
      }
      const fetchedCallees = db
        .select(runProjection)
        .from(runs)
        .innerJoin(agents, eq(agents.id, runs.agentId))
        .where(and(...calleeConditions))
        .orderBy(desc(runs.startedAt), desc(runs.id))
        .limit(limit + 1)
        .all();
      const hasMore = fetchedCallees.length > limit;
      const calleeRows = fetchedCallees.slice(0, limit);
      const parentIds = [
        ...new Set(
          calleeRows.flatMap((row) =>
            row.parentRunId ? [row.parentRunId] : [],
          ),
        ),
      ];
      const triggerIds = [
        ...new Set(
          calleeRows.flatMap((row) =>
            row.triggerEventId ? [row.triggerEventId] : [],
          ),
        ),
      ];
      const parentRows = parentIds.length
        ? db
            .select(runProjection)
            .from(runs)
            .innerJoin(agents, eq(agents.id, runs.agentId))
            .where(
              and(
                eq(runs.tenantId, auth.tenantId),
                inArray(runs.id, parentIds),
              ),
            )
            .all()
        : [];
      const emittingRows = triggerIds.length
        ? db
            .select(runProjection)
            .from(runs)
            .innerJoin(agents, eq(agents.id, runs.agentId))
            .where(
              and(
                eq(runs.tenantId, auth.tenantId),
                inArray(runs.emittedEventId, triggerIds),
              ),
            )
            .all()
        : [];

      const eventRows = triggerIds.length
        ? db
            .select({
              id: events.id,
              name: events.name,
              sourceAgentId: events.sourceAgentId,
            })
            .from(events)
            .where(
              and(
                eq(events.tenantId, auth.tenantId),
                inArray(events.id, triggerIds),
              ),
            )
            .all()
        : [];
      const eventById = new Map(eventRows.map((e) => [e.id, e]));
      const allRunRows = [
        ...new Map(
          [...calleeRows, ...parentRows, ...emittingRows].map((row) => [
            row.id,
            row,
          ]),
        ).values(),
      ];
      const runById = new Map(allRunRows.map((r) => [r.id, r]));
      const emittedByEvent = new Map(
        emittingRows
          .filter((r) => r.emittedEventId)
          .map((r) => [r.emittedEventId as string, r]),
      );
      const sourceAgentIds = [
        ...new Set(
          eventRows.flatMap((event) =>
            event.sourceAgentId ? [event.sourceAgentId] : [],
          ),
        ),
      ];
      const sourceAgentById = new Map(
        sourceAgentIds.length
          ? db
              .select({ id: agents.id, name: agents.name, title: agents.title })
              .from(agents)
              .innerJoin(workflows, eq(workflows.id, agents.workflowId))
              .where(
                and(
                  eq(workflows.tenantId, auth.tenantId),
                  inArray(agents.id, sourceAgentIds),
                ),
              )
              .all()
              .map((agent) => [agent.id, agent] as const)
          : [],
      );
      const page = calleeRows
        .map((callee) => {
          const trigger = callee.triggerEventId
            ? eventById.get(callee.triggerEventId)
            : undefined;
          let caller = callee.parentRunId
            ? runById.get(callee.parentRunId)
            : undefined;
          let callType = caller ? "parent" : "external";
          if (!caller && callee.triggerEventId) {
            caller = emittedByEvent.get(callee.triggerEventId);
            if (caller) callType = "event";
          }
          const sourceAgent = trigger?.sourceAgentId
            ? (sourceAgentById.get(trigger.sourceAgentId) ?? null)
            : null;
          if (!caller && sourceAgent) callType = "event_agent";
          const startedAt = callee.startedAt?.getTime() ?? 0;
          return {
            id: `invoke:${callee.id}`,
            callerRunId: caller?.id ?? null,
            callerAgentId:
              caller?.agentId ?? (sourceAgent ? sourceAgent.id : null),
            callerAgent: caller?.agentName ?? sourceAgent?.name ?? null,
            callerAgentTitle:
              caller?.agentTitle ??
              sourceAgent?.title ??
              sourceAgent?.name ??
              null,
            calleeRunId: callee.id,
            calleeAgentId: callee.agentId,
            calleeAgent: callee.agentName,
            calleeAgentTitle: callee.agentTitle ?? null,
            viaEvent: trigger?.name ?? null,
            callType,
            correlationId: callee.correlationId,
            startedAt,
            durationMs: callee.durationMs ?? null,
            status: callee.status,
            tokensIn: callee.tokensIn ?? null,
            tokensOut: callee.tokensOut ?? null,
            at: startedAt,
          };
        })
        .sort((a, b) => b.startedAt - a.startedAt || b.id.localeCompare(a.id));
      const nodeIds = new Set(
        page.flatMap((e) => [e.callerRunId, e.calleeRunId]).filter(Boolean),
      );
      const nodes = allRunRows
        .filter((r) => nodeIds.has(r.id))
        .map((r) => ({
          runId: r.id,
          agentId: r.agentId,
          agentName: r.agentName,
          agentTitle: r.agentTitle ?? null,
          correlationId: r.correlationId,
          status: r.status,
          startedAt: r.startedAt?.getTime() ?? null,
          durationMs: r.durationMs ?? null,
          tokensIn: r.tokensIn ?? null,
          tokensOut: r.tokensOut ?? null,
        }));
      return reply.ok({
        items: page,
        edges: page,
        nodes,
        nextCursor:
          hasMore && page.length ? cursorFor(page[page.length - 1]!) : null,
        count: page.length,
        window,
        coverage: {
          complete: !hasMore,
          relations: "persisted_parent_or_event_evidence_only",
        },
      });
    },
  );

  app.get<{ Querystring: PageQuery }>(
    "/observability/stream",
    async (req, reply) => {
      const auth = requirePermission(req, "events.read");
      const includeAudit = can(auth, "audit.read");
      const includeRuns = can(auth, "runs.read");
      const includeTasks = can(auth, "tasks.read");
      const includeUsage = can(auth, "usage.read");
      const includeDeployments = can(auth, "deployments.read");
      const filter = typeFilter(req.query.types);
      const headerLastEventId = req.headers["last-event-id"];
      const resumeId = (
        Array.isArray(headerLastEventId)
          ? headerLastEventId[0]
          : headerLastEventId
      )?.trim();
      const rawBackfill = Number(req.query.backfill ?? 100);
      if (!Number.isSafeInteger(rawBackfill) || rawBackfill < 0)
        return reply.fail(
          "bad_request",
          "backfill must be a non-negative integer",
          400,
        );
      const backfill = Math.min(500, rawBackfill);
      reply.hijack();
      const raw = reply.raw;
      raw.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      let closed = false;
      let bootstrapping = true;
      let blocked = false;
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      let unsub: () => void = () => undefined;
      const queued: RunStreamEvent[] = [];
      const pendingFrames: string[] = [];
      const sent = new Set<string>();
      const sentOrder: string[] = [];
      const agentByRun = new Map<string, string>();
      const close = () => {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        heartbeat = null;
        queued.length = 0;
        pendingFrames.length = 0;
        raw.off("drain", flush);
        unsub();
        try {
          raw.end();
        } catch {
          /* socket already closed */
        }
      };
      function flush() {
        if (closed || !blocked) return;
        blocked = false;
        while (!closed && pendingFrames.length > 0) {
          if (!raw.write(pendingFrames.shift()!)) {
            blocked = true;
            return;
          }
        }
      }
      const write = (frame: string): boolean => {
        if (closed || raw.destroyed || raw.writableEnded) return false;
        if (blocked) {
          if (pendingFrames.length >= 2_048) {
            req.log.warn(
              { tenantId: auth.tenantId },
              "[observability.stream] backpressure queue exhausted",
            );
            queueMicrotask(close);
            return false;
          }
          pendingFrames.push(frame);
          return true;
        }
        try {
          blocked = !raw.write(frame);
          return true;
        } catch (error) {
          req.log.warn({ error }, "[observability.stream] write failed");
          queueMicrotask(close);
          return false;
        }
      };
      raw.on("drain", flush);
      raw.on("close", close);
      raw.on("error", close);
      req.raw.on("close", close);
      req.raw.on("error", close);
      write("retry: 1000\n\n");

      const eventAllowed = (event: RunStreamEvent): boolean => {
        switch (event.type) {
          case "run.started":
          case "run.completed":
          case "run.failed":
          case "run.cancelled":
          case "run.step.started":
          case "run.step.completed":
          case "log.line":
          case "tool.call.completed":
            return includeRuns;
          case "task.created":
          case "task.resolved":
            return includeTasks;
          case "deployment.created":
            return includeDeployments;
          case "llm.call.completed":
            return includeUsage;
          case "audit.recorded":
            return includeAudit;
          case "event.emitted":
            return true;
        }
      };

      const send = (event: RunStreamEvent) => {
        if (closed) return;
        if (!eventAllowed(event)) return;
        if (event.type === "run.started")
          agentByRun.set(event.runId, event.agentName);
        const item = toObservation(event, agentByRun);
        if (!matchesType(item, filter) || sent.has(item.id)) return;
        sent.add(item.id);
        sentOrder.push(item.id);
        if (sentOrder.length > 4_096) {
          const expired = sentOrder.shift();
          if (expired) sent.delete(expired);
        }
        write(
          `id: ${item.id}\nevent: observation\ndata: ${JSON.stringify(item)}\n\n`,
        );
      };
      unsub = subscribeStreamEvents(auth.tenantId, (event) => {
        if (bootstrapping) {
          if (queued.length >= 2_048) {
            req.log.warn(
              { tenantId: auth.tenantId },
              "[observability.stream] bootstrap queue exhausted",
            );
            close();
            return;
          }
          queued.push(event);
        } else send(event);
      });

      try {
        if (backfill > 0) {
          const history = await getRecentActivity(auth.tenantSlug, backfill, {
            includeAudit,
            includeFileLogs: includeRuns,
            includeRuns,
            includeTasks,
            includeUsage,
            includeDeployments,
          });
          if (closed) return reply;
          for (const event of history) {
            if (event.type === "run.started")
              agentByRun.set(event.runId, event.agentName);
          }
          let replay = history;
          if (resumeId) {
            const resumeIndex = replay.findIndex(
              (event) => eventIdentity(event) === resumeId,
            );
            sent.add(resumeId);
            sentOrder.push(resumeId);
            if (resumeIndex >= 0) replay = replay.slice(resumeIndex + 1);
            else {
              write(
                `event: stream.reset\ndata: ${JSON.stringify({ code: "resume_cursor_not_in_backfill", lastEventId: resumeId, backfill })}\n\n`,
              );
            }
          }
          for (const event of replay) send(event);
        }
      } catch (error) {
        req.log.error(
          { error },
          "[observability.stream] durable backfill failed",
        );
        write(
          `event: stream.error\ndata: ${JSON.stringify({ code: "backfill_failed" })}\n\n`,
        );
        close();
        return reply;
      }
      bootstrapping = false;
      for (const event of queued) send(event);
      queued.length = 0;
      write(
        `event: ready\ndata: ${JSON.stringify({ ok: true, tenantSlug: auth.tenantSlug, backfill, at: Date.now() })}\n\n`,
      );

      heartbeat = setInterval(() => {
        if (!closed && !blocked) write(`: keepalive ${Date.now()}\n\n`);
      }, 15_000);
      heartbeat.unref?.();
      return reply;
    },
  );
}
