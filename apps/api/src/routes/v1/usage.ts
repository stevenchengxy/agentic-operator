/** GET /v1/usage — exact provider-attempt usage and cost aggregation. */
import type { FastifyInstance } from "fastify";
import { and, desc, eq, gte, lt } from "drizzle-orm";
import { agents, getDb, llmCalls, runs, tenantBudgets } from "@agentic/db";
import { ensureCurrentBudgetPeriod } from "@agentic/llm-gateway";
import { requireAuth, requireTenantAdmin } from "../../plugins/auth";

const USD_NANOS_PER_CENT = 10_000_000;

interface QueryString {
  groupBy?: string;
  since?: string;
  until?: string;
  limit?: string;
  taskType?: string;
  gatewayInstanceId?: string;
  route?: string;
  actorId?: string;
  model?: string;
  functionName?: string;
  apiRoute?: string;
}

interface CallsQueryString {
  runId?: string;
  status?: "started" | "ok" | "failed";
  since?: string;
  until?: string;
  limit?: string;
  taskType?: string;
  gatewayInstanceId?: string;
  route?: string;
  actorId?: string;
  model?: string;
  functionName?: string;
  apiRoute?: string;
  interactionId?: string;
}

interface RawUsageRow {
  logicalCallId: string;
  attempt: number;
  status: "started" | "ok" | "failed";
  runId: string | null;
  agentName: string | null;
  agentTitle: string | null;
  billingAccountId: string | null;
  actorId: string | null;
  productSurface: string | null;
  productAction: string | null;
  functionName: string | null;
  apiRoute: string | null;
  httpMethod: string | null;
  provider: string;
  gatewayInstanceId: string | null;
  gatewayKind: string | null;
  effectiveRoute: string | null;
  taskType: string | null;
  matchedTaskType: string | null;
  routingProfileId: string | null;
  resolutionReason: string | null;
  fallbackIndex: number | null;
  requestedModel: string;
  responseModel: string | null;
  reasoningMode: string | null;
  reasoningEffort: string | null;
  reasoningSummary: string | null;
  reasoningContext: string | null;
  textVerbosity: string | null;
  storeResponse: boolean | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  reasoningTokens: number | null;
  costUsdNanos: number | null;
  latencyMs: number | null;
  errorCode: string | null;
  startedAt: Date;
}

interface UsageRow {
  key: string;
  runs: number;
  calls: number;
  tokensIn: number;
  tokensOut: number;
  cachedInputTokens: number;
  reasoningTokens: number;
  usdNanos: number;
  usdCents: number;
  unpricedCalls: number;
}

interface MutableUsageRow extends Omit<UsageRow, "runs" | "usdCents"> {
  runIds: Set<string>;
}

interface AttemptMetricRow {
  key: string;
  logicalCalls: number;
  attempts: number;
  succeeded: number;
  failed: number;
  inFlight: number;
  timeouts: number;
  retries: number;
  fallbacks: number;
  unpriced: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
  costUsdNanos: number;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
}

export async function usageRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: QueryString }>("/usage", async (req, reply) => {
    const auth = requireAuth(req);
    const q = req.query;
    const limit = clampLimit(q.limit);
    const conditions = [eq(llmCalls.tenantId, auth.tenantId)];
    if (q.since != null) {
      const ms = Number(q.since);
      if (Number.isFinite(ms))
        conditions.push(gte(llmCalls.startedAt, new Date(ms)));
    }
    if (q.until != null) {
      const ms = Number(q.until);
      if (Number.isFinite(ms))
        conditions.push(lt(llmCalls.startedAt, new Date(ms)));
    }
    if (q.taskType) conditions.push(eq(llmCalls.taskType, q.taskType));
    if (q.gatewayInstanceId) {
      conditions.push(eq(llmCalls.gatewayInstanceId, q.gatewayInstanceId));
    }
    if (q.route) conditions.push(eq(llmCalls.effectiveRoute, q.route));
    if (q.actorId) conditions.push(eq(llmCalls.actorId, q.actorId));
    if (q.model) conditions.push(eq(llmCalls.requestedModel, q.model));
    if (q.functionName) {
      conditions.push(eq(llmCalls.functionName, q.functionName));
    }
    if (q.apiRoute) conditions.push(eq(llmCalls.apiRoute, q.apiRoute));

    const db = getDb();
    const rows = db
      .select({
        logicalCallId: llmCalls.logicalCallId,
        attempt: llmCalls.attempt,
        status: llmCalls.status,
        runId: llmCalls.runId,
        agentName: agents.name,
        agentTitle: agents.title,
        billingAccountId: llmCalls.billingAccountId,
        actorId: llmCalls.actorId,
        productSurface: llmCalls.productSurface,
        productAction: llmCalls.productAction,
        functionName: llmCalls.functionName,
        apiRoute: llmCalls.apiRoute,
        httpMethod: llmCalls.httpMethod,
        provider: llmCalls.provider,
        gatewayInstanceId: llmCalls.gatewayInstanceId,
        gatewayKind: llmCalls.gatewayKind,
        effectiveRoute: llmCalls.effectiveRoute,
        taskType: llmCalls.taskType,
        matchedTaskType: llmCalls.matchedTaskType,
        routingProfileId: llmCalls.routingProfileId,
        resolutionReason: llmCalls.resolutionReason,
        fallbackIndex: llmCalls.fallbackIndex,
        requestedModel: llmCalls.requestedModel,
        responseModel: llmCalls.responseModel,
        reasoningMode: llmCalls.reasoningMode,
        reasoningEffort: llmCalls.reasoningEffort,
        reasoningSummary: llmCalls.reasoningSummary,
        reasoningContext: llmCalls.reasoningContext,
        textVerbosity: llmCalls.textVerbosity,
        storeResponse: llmCalls.storeResponse,
        inputTokens: llmCalls.inputTokens,
        outputTokens: llmCalls.outputTokens,
        cachedInputTokens: llmCalls.cachedInputTokens,
        reasoningTokens: llmCalls.reasoningTokens,
        costUsdNanos: llmCalls.costUsdNanos,
        latencyMs: llmCalls.latencyMs,
        errorCode: llmCalls.errorCode,
        startedAt: llmCalls.startedAt,
      })
      .from(llmCalls)
      .leftJoin(runs, eq(runs.id, llmCalls.runId))
      .leftJoin(agents, eq(agents.id, runs.agentId))
      .where(and(...conditions))
      .all() as RawUsageRow[];

    const successfulRows = rows.filter((row) => row.status === "ok");

    const byAgent = aggregate(
      successfulRows,
      (row) => row.agentTitle ?? row.agentName ?? "unattributed",
    );
    const byModel = aggregate(
      successfulRows,
      (row) => row.responseModel ?? row.requestedModel,
    );
    const byProvider = aggregate(successfulRows, (row) => row.provider);
    const byAccount = aggregate(
      successfulRows,
      (row) => row.billingAccountId ?? auth.tenantId,
    );
    const byProductSurface = aggregate(
      successfulRows,
      (row) => row.productSurface ?? "unattributed",
    );
    const byProductAction = aggregate(
      successfulRows,
      (row) => row.productAction ?? "unattributed",
    );
    const byFunction = aggregate(
      successfulRows,
      (row) => row.functionName ?? "unattributed",
    );
    const byApiCall = aggregate(successfulRows, (row) =>
      row.apiRoute
        ? `${row.httpMethod ?? "CALL"} ${row.apiRoute}`
        : "background/no-api-route",
    );
    const byReasoning = aggregate(successfulRows, (row) =>
      [
        `mode=${row.reasoningMode ?? "default"}`,
        `effort=${row.reasoningEffort ?? "default"}`,
        `summary=${row.reasoningSummary ?? "default"}`,
        `context=${row.reasoningContext ?? "default"}`,
        `verbosity=${row.textVerbosity ?? "default"}`,
        `store=${row.storeResponse == null ? "default" : String(row.storeResponse)}`,
      ].join(" · "),
    );
    const byDay = aggregate(successfulRows, (row) => toDayKey(row.startedAt));
    const totals =
      aggregate(successfulRows, () => "total")[0] ?? emptyUsageRow("total");
    const attemptTotals =
      aggregateAttempts(rows, () => "total")[0] ?? emptyAttemptMetric("total");
    const byTask = aggregateAttempts(
      rows,
      (row) => row.taskType ?? "unattributed",
    );
    const byGateway = aggregateAttempts(
      rows,
      (row) => row.gatewayInstanceId ?? row.provider,
    );
    const byRoute = aggregateAttempts(
      rows,
      (row) => row.effectiveRoute ?? `${row.provider}/${row.requestedModel}`,
    );
    const byActor = aggregateAttempts(
      rows,
      (row) => row.actorId ?? "system/unattributed",
    );
    const byRoutingProfile = aggregateAttempts(
      rows,
      (row) => row.routingProfileId ?? "legacy/unattributed",
    );

    const sortDesc = (a: UsageRow, b: UsageRow) =>
      b.tokensIn + b.tokensOut - (a.tokensIn + a.tokensOut);
    const sortDayAsc = (a: UsageRow, b: UsageRow) => a.key.localeCompare(b.key);
    ensureCurrentBudgetPeriod(auth.tenantId);
    const budgetRow = db
      .select()
      .from(tenantBudgets)
      .where(eq(tenantBudgets.tenantId, auth.tenantId))
      .all()[0];

    return reply.ok({
      totals: { ...totals, key: undefined },
      attempts: { ...attemptTotals, key: undefined },
      byAgent: byAgent.sort(sortDesc).slice(0, limit),
      byModel: byModel.sort(sortDesc).slice(0, limit),
      byProvider: byProvider.sort(sortDesc).slice(0, limit),
      byAccount: byAccount.sort(sortDesc).slice(0, limit),
      byProductSurface: byProductSurface.sort(sortDesc).slice(0, limit),
      byProductAction: byProductAction.sort(sortDesc).slice(0, limit),
      byFunction: byFunction.sort(sortDesc).slice(0, limit),
      byApiCall: byApiCall.sort(sortDesc).slice(0, limit),
      byReasoning: byReasoning.sort(sortDesc).slice(0, limit),
      byDay: byDay.sort(sortDayAsc).slice(-limit),
      byTask: sortAttemptRows(byTask).slice(0, limit),
      byGateway: sortAttemptRows(byGateway).slice(0, limit),
      byRoute: sortAttemptRows(byRoute).slice(0, limit),
      byActor: sortAttemptRows(byActor).slice(0, limit),
      byRoutingProfile: sortAttemptRows(byRoutingProfile).slice(0, limit),
      budget: budgetRow
        ? {
            monthlyTokenCap: budgetRow.monthlyTokenCap,
            monthlyUsdCap: budgetRow.monthlyUsdCap,
            usedTokensMonth: budgetRow.usedTokensMonth,
            usedUsdMonth: budgetRow.usedUsdMonth,
            usedUsdNanos: budgetRow.usedUsdNanos,
            periodStart: budgetRow.periodStart.getTime(),
          }
        : null,
    });
  });

  /** Reconciliation surface: every provider attempt, including failures. */
  app.get<{ Querystring: CallsQueryString }>(
    "/usage/calls",
    async (req, reply) => {
      const auth = requireTenantAdmin(req);
      const q = req.query;
      const conditions = [eq(llmCalls.tenantId, auth.tenantId)];
      if (q.runId) conditions.push(eq(llmCalls.runId, q.runId));
      if (q.status && ["started", "ok", "failed"].includes(q.status)) {
        conditions.push(eq(llmCalls.status, q.status));
      }
      if (q.taskType) conditions.push(eq(llmCalls.taskType, q.taskType));
      if (q.gatewayInstanceId) {
        conditions.push(eq(llmCalls.gatewayInstanceId, q.gatewayInstanceId));
      }
      if (q.route) conditions.push(eq(llmCalls.effectiveRoute, q.route));
      if (q.actorId) conditions.push(eq(llmCalls.actorId, q.actorId));
      if (q.model) conditions.push(eq(llmCalls.requestedModel, q.model));
      if (q.functionName) {
        conditions.push(eq(llmCalls.functionName, q.functionName));
      }
      if (q.apiRoute) conditions.push(eq(llmCalls.apiRoute, q.apiRoute));
      if (q.interactionId) {
        conditions.push(eq(llmCalls.interactionId, q.interactionId));
      }
      if (q.since != null && Number.isFinite(Number(q.since))) {
        conditions.push(gte(llmCalls.startedAt, new Date(Number(q.since))));
      }
      if (q.until != null && Number.isFinite(Number(q.until))) {
        conditions.push(lt(llmCalls.startedAt, new Date(Number(q.until))));
      }
      const calls = getDb()
        .select()
        .from(llmCalls)
        .where(and(...conditions))
        .orderBy(desc(llmCalls.startedAt))
        .limit(clampLimit(q.limit))
        .all()
        .map((call) => ({
          ...call,
          startedAt: call.startedAt.getTime(),
          endedAt: call.endedAt?.getTime() ?? null,
          costUsd:
            call.costUsdNanos === null
              ? null
              : call.costUsdNanos / 1_000_000_000,
        }));
      return reply.ok(calls);
    },
  );
}

function aggregate(
  rows: RawUsageRow[],
  keyFn: (row: RawUsageRow) => string,
): UsageRow[] {
  const groups = new Map<string, MutableUsageRow>();
  for (const row of rows) {
    const key = keyFn(row);
    const current = groups.get(key) ?? {
      key,
      runIds: new Set<string>(),
      calls: 0,
      tokensIn: 0,
      tokensOut: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      usdNanos: 0,
      unpricedCalls: 0,
    };
    if (row.runId) current.runIds.add(row.runId);
    current.calls += 1;
    current.tokensIn += row.inputTokens ?? 0;
    current.tokensOut += row.outputTokens ?? 0;
    current.cachedInputTokens += row.cachedInputTokens ?? 0;
    current.reasoningTokens += row.reasoningTokens ?? 0;
    if (row.costUsdNanos === null) current.unpricedCalls += 1;
    else current.usdNanos += row.costUsdNanos;
    groups.set(key, current);
  }
  return Array.from(groups.values(), (row) => ({
    key: row.key,
    runs: row.runIds.size,
    calls: row.calls,
    tokensIn: row.tokensIn,
    tokensOut: row.tokensOut,
    cachedInputTokens: row.cachedInputTokens,
    reasoningTokens: row.reasoningTokens,
    usdNanos: row.usdNanos,
    usdCents: Math.ceil(row.usdNanos / USD_NANOS_PER_CENT),
    unpricedCalls: row.unpricedCalls,
  }));
}

function emptyUsageRow(key: string): UsageRow {
  return {
    key,
    runs: 0,
    calls: 0,
    tokensIn: 0,
    tokensOut: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    usdNanos: 0,
    usdCents: 0,
    unpricedCalls: 0,
  };
}

function percentile(values: number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(
    0,
    Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1),
  );
  return sorted[index] ?? null;
}

function aggregateAttempts(
  rows: RawUsageRow[],
  keyFn: (row: RawUsageRow) => string,
): AttemptMetricRow[] {
  const groups = new Map<
    string,
    Omit<AttemptMetricRow, "logicalCalls" | "p50LatencyMs" | "p95LatencyMs"> & {
      logicalCallIds: Set<string>;
      latencies: number[];
    }
  >();
  for (const row of rows) {
    const key = keyFn(row);
    const current = groups.get(key) ?? {
      key,
      logicalCallIds: new Set<string>(),
      latencies: [],
      attempts: 0,
      succeeded: 0,
      failed: 0,
      inFlight: 0,
      timeouts: 0,
      retries: 0,
      fallbacks: 0,
      unpriced: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      costUsdNanos: 0,
    };
    current.logicalCallIds.add(row.logicalCallId);
    current.attempts += 1;
    if (row.status === "ok") current.succeeded += 1;
    else if (row.status === "failed") current.failed += 1;
    else current.inFlight += 1;
    if (row.errorCode === "timeout") current.timeouts += 1;
    if ((Math.max(row.attempt, 1) - 1) % 100 > 0) current.retries += 1;
    if ((row.fallbackIndex ?? 0) > 0) current.fallbacks += 1;
    if (row.status === "ok" && row.costUsdNanos === null) current.unpriced += 1;
    current.inputTokens += row.inputTokens ?? 0;
    current.outputTokens += row.outputTokens ?? 0;
    current.cachedInputTokens += row.cachedInputTokens ?? 0;
    current.reasoningTokens += row.reasoningTokens ?? 0;
    current.costUsdNanos += row.costUsdNanos ?? 0;
    if (row.latencyMs !== null) current.latencies.push(row.latencyMs);
    groups.set(key, current);
  }
  return Array.from(groups.values(), (row) => ({
    key: row.key,
    logicalCalls: row.logicalCallIds.size,
    attempts: row.attempts,
    succeeded: row.succeeded,
    failed: row.failed,
    inFlight: row.inFlight,
    timeouts: row.timeouts,
    retries: row.retries,
    fallbacks: row.fallbacks,
    unpriced: row.unpriced,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cachedInputTokens: row.cachedInputTokens,
    reasoningTokens: row.reasoningTokens,
    costUsdNanos: row.costUsdNanos,
    p50LatencyMs: percentile(row.latencies, 0.5),
    p95LatencyMs: percentile(row.latencies, 0.95),
  }));
}

function emptyAttemptMetric(key: string): AttemptMetricRow {
  return {
    key,
    logicalCalls: 0,
    attempts: 0,
    succeeded: 0,
    failed: 0,
    inFlight: 0,
    timeouts: 0,
    retries: 0,
    fallbacks: 0,
    unpriced: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    costUsdNanos: 0,
    p50LatencyMs: null,
    p95LatencyMs: null,
  };
}

function sortAttemptRows(rows: AttemptMetricRow[]): AttemptMetricRow[] {
  return rows.sort(
    (left, right) =>
      right.inputTokens + right.outputTokens -
        (left.inputTokens + left.outputTokens) ||
      right.attempts - left.attempts,
  );
}

function clampLimit(raw: string | undefined): number {
  if (!raw) return 60;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 60;
  return Math.min(500, Math.floor(n));
}

function toDayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}
