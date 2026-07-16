/** GET /v1/usage — exact provider-attempt usage and cost aggregation. */
import type { FastifyInstance } from "fastify";
import { and, desc, eq, gte, lt } from "drizzle-orm";
import { agents, getDb, llmCalls, runs, tenantBudgets } from "@agentic/db";
import { requireAuth } from "../../plugins/auth";

const USD_NANOS_PER_CENT = 10_000_000;

interface QueryString {
  groupBy?: string;
  since?: string;
  until?: string;
  limit?: string;
}

interface CallsQueryString {
  runId?: string;
  status?: "started" | "ok" | "failed";
  since?: string;
  until?: string;
  limit?: string;
}

interface RawUsageRow {
  logicalCallId: string;
  runId: string | null;
  agentName: string | null;
  agentTitle: string | null;
  provider: string;
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

export async function usageRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: QueryString }>("/usage", async (req, reply) => {
    const auth = requireAuth(req);
    const q = req.query;
    const limit = clampLimit(q.limit);
    const conditions = [
      eq(llmCalls.tenantId, auth.tenantId),
      eq(llmCalls.status, "ok"),
    ];
    if (q.since != null) {
      const ms = Number(q.since);
      if (Number.isFinite(ms)) conditions.push(gte(llmCalls.startedAt, new Date(ms)));
    }
    if (q.until != null) {
      const ms = Number(q.until);
      if (Number.isFinite(ms)) conditions.push(lt(llmCalls.startedAt, new Date(ms)));
    }

    const db = getDb();
    const rows = db
      .select({
        logicalCallId: llmCalls.logicalCallId,
        runId: llmCalls.runId,
        agentName: agents.name,
        agentTitle: agents.title,
        provider: llmCalls.provider,
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
        startedAt: llmCalls.startedAt,
      })
      .from(llmCalls)
      .leftJoin(runs, eq(runs.id, llmCalls.runId))
      .leftJoin(agents, eq(agents.id, runs.agentId))
      .where(and(...conditions))
      .all() as RawUsageRow[];

    const byAgent = aggregate(rows, (row) => row.agentTitle ?? row.agentName ?? "unattributed");
    const byModel = aggregate(rows, (row) => row.responseModel ?? row.requestedModel);
    const byProvider = aggregate(rows, (row) => row.provider);
    const byReasoning = aggregate(rows, (row) =>
      [
        `mode=${row.reasoningMode ?? "default"}`,
        `effort=${row.reasoningEffort ?? "default"}`,
        `summary=${row.reasoningSummary ?? "default"}`,
        `context=${row.reasoningContext ?? "default"}`,
        `verbosity=${row.textVerbosity ?? "default"}`,
        `store=${row.storeResponse == null ? "default" : String(row.storeResponse)}`,
      ].join(" · "),
    );
    const byDay = aggregate(rows, (row) => toDayKey(row.startedAt));
    const totals = aggregate(rows, () => "total")[0] ?? emptyUsageRow("total");

    const sortDesc = (a: UsageRow, b: UsageRow) =>
      b.tokensIn + b.tokensOut - (a.tokensIn + a.tokensOut);
    const sortDayAsc = (a: UsageRow, b: UsageRow) => a.key.localeCompare(b.key);
    const budgetRow = db
      .select()
      .from(tenantBudgets)
      .where(eq(tenantBudgets.tenantId, auth.tenantId))
      .all()[0];

    return reply.ok({
      totals: { ...totals, key: undefined },
      byAgent: byAgent.sort(sortDesc).slice(0, limit),
      byModel: byModel.sort(sortDesc).slice(0, limit),
      byProvider: byProvider.sort(sortDesc).slice(0, limit),
      byReasoning: byReasoning.sort(sortDesc).slice(0, limit),
      byDay: byDay.sort(sortDayAsc).slice(-limit),
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
  app.get<{ Querystring: CallsQueryString }>("/usage/calls", async (req, reply) => {
    const auth = requireAuth(req);
    const q = req.query;
    const conditions = [eq(llmCalls.tenantId, auth.tenantId)];
    if (q.runId) conditions.push(eq(llmCalls.runId, q.runId));
    if (q.status && ["started", "ok", "failed"].includes(q.status)) {
      conditions.push(eq(llmCalls.status, q.status));
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
        costUsd: call.costUsdNanos === null ? null : call.costUsdNanos / 1_000_000_000,
      }));
    return reply.ok(calls);
  });
}

function aggregate(rows: RawUsageRow[], keyFn: (row: RawUsageRow) => string): UsageRow[] {
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

function clampLimit(raw: string | undefined): number {
  if (!raw) return 60;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 60;
  return Math.min(500, Math.floor(n));
}

function toDayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}
