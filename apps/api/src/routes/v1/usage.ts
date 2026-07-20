/**
 * GET /v1/usage — aggregated token + cost usage per agent / model / day
 * (P3-FE-03). Powers the operator cost dashboard.
 *
 * Query params:
 *
 *   groupBy=agent|model|day   one or more; defaults to "day"
 *   since=<unix-ms>           inclusive lower bound on runs.started_at
 *   until=<unix-ms>           exclusive upper bound on runs.started_at
 *   limit=<number>            max series rows (default 60, max 500)
 *
 * Response shape (success envelope):
 *
 *   {
 *     totals: { runs, tokensIn, tokensOut, usdCents },
 *     byAgent:  Array<{ key, runs, tokensIn, tokensOut, usdCents }>,
 *     byModel:  Array<{ key, runs, tokensIn, tokensOut, usdCents }>,
 *     byDay:    Array<{ key, runs, tokensIn, tokensOut, usdCents }>,
 *     budget:   { monthlyTokenCap, monthlyUsdCap, usedTokensMonth, usedUsdMonth, periodStart }
 *   }
 *
 * Pricing and monthly-budget reconciliation share
 * services/usage-accounting.ts, so dashboard totals and cap progress cannot
 * drift onto separate counters.
 */

import type { FastifyInstance } from "fastify";
import { and, eq, gte, lt } from "drizzle-orm";
import { agents, getDb, llmCalls, runs, tenantBudgets } from "@agentic/db";
import { getActiveBudgetReservations } from "@agentic/llm-gateway";
import { requirePermission } from "../../plugins/rbac";
import {
  estimateCostCents,
  calculateTenantUsage,
  ensureBudgetRow,
  reconcileBudgetUsage,
} from "../../services/usage-accounting";

interface QueryString {
  groupBy?: string;
  since?: string;
  until?: string;
  limit?: string;
}

interface UsageRow {
  key: string;
  runs: number;
  tokensIn: number;
  tokensOut: number;
  usdCents: number;
  unpricedTokens: number;
  costComplete: boolean;
}

interface RawRunRow {
  id: string;
  agentName: string;
  agentTitle: string | null;
  model: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  startedAt: Date | null;
  isTest: boolean;
}

interface RawCallRow {
  runId: string | null;
  conversationId: string | null;
  domain: string | null;
  purpose: string | null;
  provider: string | null;
  model: string | null;
  requestedModel: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  tokenSource: "provider" | "estimated_chars" | null;
  createdAt: Date;
  agentName: string | null;
  agentTitle: string | null;
}

export async function usageRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: QueryString }>("/usage", async (req, reply) => {
    const auth = requirePermission(req, "usage.read");
    const q = req.query;

    const limit = clampLimit(q.limit);
    const conds = [eq(runs.tenantId, auth.tenantId)];
    const callConds = [eq(llmCalls.tenantId, auth.tenantId)];
    let since = new Date(0);
    let until = new Date();
    if (q.since != null) {
      const ms = Number(q.since);
      if (!Number.isFinite(ms) || ms < 0)
        return reply.fail(
          "bad_request",
          "since must be a non-negative unix timestamp",
          400,
        );
      since = new Date(ms);
      conds.push(gte(runs.startedAt, since));
      callConds.push(gte(llmCalls.createdAt, since));
    }
    if (q.until != null) {
      const ms = Number(q.until);
      if (!Number.isFinite(ms) || ms < 0)
        return reply.fail(
          "bad_request",
          "until must be a non-negative unix timestamp",
          400,
        );
      until = new Date(ms);
      conds.push(lt(runs.startedAt, until));
      callConds.push(lt(llmCalls.createdAt, until));
    }
    if (since.getTime() >= until.getTime())
      return reply.fail("bad_request", "since must be earlier than until", 400);

    const db = getDb();
    const rows: RawRunRow[] = db
      .select({
        id: runs.id,
        agentName: agents.name,
        agentTitle: agents.title,
        model: runs.model,
        tokensIn: runs.tokensIn,
        tokensOut: runs.tokensOut,
        startedAt: runs.startedAt,
        isTest: runs.isTest,
      })
      .from(runs)
      .innerJoin(agents, eq(agents.id, runs.agentId))
      .where(and(...conds))
      .all() as RawRunRow[];

    // Join provider calls to their durable run attribution. A runtime call
    // without run_id is legacy/ambiguous and is exposed in coverage but not
    // added to a run aggregate (which would silently double count it).
    const callRows: RawCallRow[] = db
      .select({
        runId: llmCalls.runId,
        conversationId: llmCalls.conversationId,
        domain: llmCalls.domain,
        purpose: llmCalls.purpose,
        provider: llmCalls.provider,
        model: llmCalls.servedModel,
        requestedModel: llmCalls.requestedModel,
        tokensIn: llmCalls.approxTokensIn,
        tokensOut: llmCalls.approxTokensOut,
        tokenSource: llmCalls.tokenSource,
        createdAt: llmCalls.createdAt,
        agentName: agents.name,
        agentTitle: agents.title,
      })
      .from(llmCalls)
      .leftJoin(
        runs,
        and(eq(runs.id, llmCalls.runId), eq(runs.tenantId, auth.tenantId)),
      )
      .leftJoin(agents, eq(agents.id, runs.agentId))
      .where(and(...callConds))
      .all() as RawCallRow[];
    const linkedRunIds = new Set(
      callRows.flatMap((row) =>
        row.conversationId === "runtime" && row.runId ? [row.runId] : [],
      ),
    );
    const usageRuns = rows.filter((row) => !linkedRunIds.has(row.id));
    const accountedCalls = callRows.filter(
      (row) => row.conversationId !== "runtime" || Boolean(row.runId),
    );

    const byAgent = mergeUsageRows(
      aggregate(usageRuns, (r) => r.agentTitle ?? r.agentName),
      aggregateCalls(accountedCalls, (r) =>
        r.conversationId === "runtime"
          ? (r.agentTitle ?? r.agentName ?? `Run ${r.runId ?? "unattributed"}`)
          : r.domain
            ? `Agent Factory · ${r.domain}`
            : (r.purpose ?? "Auxiliary LLM"),
      ),
    );
    const byModel = mergeUsageRows(
      aggregate(usageRuns, (r) => r.model ?? "unknown"),
      aggregateCalls(
        accountedCalls,
        (r) => r.model ?? r.requestedModel ?? "unknown",
      ),
    );
    const byDay = mergeUsageRows(
      aggregate(usageRuns, (r) =>
        r.startedAt ? toDayKey(r.startedAt) : "unknown",
      ),
      aggregateCalls(accountedCalls, (r) => toDayKey(r.createdAt)),
    );

    // Stable, capped lists.
    const sortDesc = (a: UsageRow, b: UsageRow) =>
      b.tokensIn + b.tokensOut - (a.tokensIn + a.tokensOut);
    const sortDayAsc = (a: UsageRow, b: UsageRow) => a.key.localeCompare(b.key);

    const accountedRange = calculateTenantUsage(auth.tenantId, since, until);
    const totals = {
      runs: rows.length,
      tokensIn: accountedRange.tokensIn,
      tokensOut: accountedRange.tokensOut,
      usdCents: accountedRange.usdCents,
      testRuns: rows.filter((row) => row.isTest).length,
    };

    // Pull current budget row (lazily creating one to mirror the budgets
    // route's behaviour).
    let budgetRow = ensureBudgetRow(auth.tenantId);
    const activeReservations = getActiveBudgetReservations(auth.tenantId);
    budgetRow =
      getDb()
        .select()
        .from(tenantBudgets)
        .where(eq(tenantBudgets.tenantId, auth.tenantId))
        .all()[0] ?? budgetRow;
    const accountedBudget = reconcileBudgetUsage(budgetRow);

    return reply.ok({
      totals,
      coverage: {
        runTokens: accountedRange.runTokens,
        runtimeCallTokens: accountedRange.runtimeCallTokens,
        linkedRuntimeCallTokens: accountedRange.linkedRuntimeCallTokens,
        ambiguousRuntimeCallTokens: accountedRange.ambiguousRuntimeCallTokens,
        ambiguousRuntimeCalls: accountedRange.ambiguousRuntimeCalls,
        auxiliaryCallTokens: accountedRange.auxiliaryCallTokens,
        legacyRunTokens: accountedRange.legacyRunTokens,
        exactProviderTokens: accountedRange.exactProviderTokens,
        estimatedTokens: accountedRange.estimatedTokens,
        unknownSourceTokens: accountedRange.unknownSourceTokens,
        unknownSourceCalls: accountedRange.unknownSourceCalls,
        unmeasuredRuntimeCalls: accountedRange.unmeasuredRuntimeCalls,
        tokenCoverageComplete: accountedRange.tokenCoverageComplete,
        unpricedTokens: accountedRange.unpricedTokens,
        costComplete: accountedRange.costComplete,
        costEstimated: accountedRange.costEstimated,
      },
      byAgent: byAgent.sort(sortDesc).slice(0, limit),
      byModel: byModel.sort(sortDesc).slice(0, limit),
      byDay: byDay.sort(sortDayAsc).slice(-limit),
      budget: {
        monthlyTokenCap: budgetRow.monthlyTokenCap,
        monthlyUsdCap: budgetRow.monthlyUsdCap,
        usedTokensMonth: accountedBudget.tokens,
        usedUsdMonth: accountedBudget.usdCents,
        unpricedTokens: accountedBudget.unpricedTokens,
        costComplete: accountedBudget.costComplete,
        activeReservations: activeReservations.count,
        reservedTokens: activeReservations.reservedTokens,
        reservedUsdCents: activeReservations.reservedUsdCents,
        periodStart: budgetRow.periodStart.getTime(),
      },
    });
  });
}

function aggregateCalls(
  rows: RawCallRow[],
  keyFn: (row: RawCallRow) => string,
): UsageRow[] {
  const map = new Map<string, UsageRow & { runIds: Set<string> }>();
  for (const row of rows) {
    const key = keyFn(row);
    const input = row.tokensIn ?? 0;
    const output = row.tokensOut ?? 0;
    const model = row.model ?? row.requestedModel;
    const current = map.get(key) ?? {
      key,
      // `runs` remains a run count. Auxiliary provider calls have no run row.
      runs: 0,
      tokensIn: 0,
      tokensOut: 0,
      usdCents: 0,
      unpricedTokens: 0,
      costComplete: true,
      runIds: new Set<string>(),
    };
    current.tokensIn += input;
    current.tokensOut += output;
    const cost = estimateCostCents(model, input, output, row.provider);
    if (cost === null) {
      current.unpricedTokens += input + output;
      current.costComplete = false;
    } else {
      current.usdCents += cost;
    }
    if (row.runId) current.runIds.add(row.runId);
    current.runs = current.runIds.size;
    map.set(key, current);
  }
  return [...map.values()].map(({ runIds: _runIds, ...row }) => row);
}

function mergeUsageRows(...groups: UsageRow[][]): UsageRow[] {
  const map = new Map<string, UsageRow>();
  for (const row of groups.flat()) {
    const current = map.get(row.key) ?? {
      key: row.key,
      runs: 0,
      tokensIn: 0,
      tokensOut: 0,
      usdCents: 0,
      unpricedTokens: 0,
      costComplete: true,
    };
    current.runs += row.runs;
    current.tokensIn += row.tokensIn;
    current.tokensOut += row.tokensOut;
    current.usdCents += row.usdCents;
    current.unpricedTokens += row.unpricedTokens;
    current.costComplete = current.costComplete && row.costComplete;
    map.set(row.key, current);
  }
  return [...map.values()];
}

function aggregate(
  rows: RawRunRow[],
  keyFn: (r: RawRunRow) => string,
): UsageRow[] {
  const m = new Map<string, UsageRow>();
  for (const r of rows) {
    const k = keyFn(r);
    const tIn = r.tokensIn ?? 0;
    const tOut = r.tokensOut ?? 0;
    const cents = estimateCostCents(r.model, tIn, tOut);
    const unpricedTokens = cents === null ? tIn + tOut : 0;
    const cur = m.get(k);
    if (cur) {
      cur.runs += 1;
      cur.tokensIn += tIn;
      cur.tokensOut += tOut;
      cur.usdCents += cents ?? 0;
      cur.unpricedTokens += unpricedTokens;
      cur.costComplete = cur.costComplete && cents !== null;
    } else {
      m.set(k, {
        key: k,
        runs: 1,
        tokensIn: tIn,
        tokensOut: tOut,
        usdCents: cents ?? 0,
        unpricedTokens,
        costComplete: cents !== null,
      });
    }
  }
  return Array.from(m.values());
}

function clampLimit(raw: string | undefined): number {
  if (!raw) return 60;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 60;
  return Math.min(500, Math.floor(n));
}

function toDayKey(d: Date): string {
  // YYYY-MM-DD in UTC. Per-tenant timezone is a known follow-up.
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
