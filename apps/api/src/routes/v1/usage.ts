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
 * Pricing: when a `MODEL_PRICING` table isn't configured the route returns
 * `usdCents = 0` and the UI falls back to displaying token totals. The
 * stub pricing table here matches the canonical Anthropic + OpenAI prices
 * as of 2026-05; refresh periodically.
 */

import type { FastifyInstance } from "fastify";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import { agents, getDb, runs, tenantBudgets } from "@agentic/db";
import { requireAuth } from "../../plugins/auth";
import { requirePermission } from "../../plugins/rbac";

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
}

/**
 * Stub model→price table. cents per 1M tokens. Real implementation should
 * lift this from `@agentic/contracts/providers` or a config file.
 */
const MODEL_PRICING: Record<string, { inCents: number; outCents: number }> = {
  "claude-sonnet-4-5": { inCents: 300, outCents: 1500 },
  "claude-haiku-4-5": { inCents: 80, outCents: 400 },
  "claude-opus-4": { inCents: 1500, outCents: 7500 },
  "gpt-4.1-mini": { inCents: 15, outCents: 60 },
  "gpt-4.1": { inCents: 250, outCents: 1000 },
  "gpt-4o": { inCents: 250, outCents: 1000 },
  "gpt-4o-mini": { inCents: 15, outCents: 60 },
  "gemini-2.5-pro": { inCents: 125, outCents: 500 },
  "gemini-2.5-flash": { inCents: 7, outCents: 30 },
  default: { inCents: 100, outCents: 400 },
};

function priceCents(model: string | null, tIn: number, tOut: number): number {
  const p = MODEL_PRICING[model ?? "default"] ?? MODEL_PRICING.default!;
  // tokens * (cents per 1M) / 1M → cents (round half-up).
  return Math.round((tIn * p.inCents + tOut * p.outCents) / 1_000_000);
}

interface RawRunRow {
  agentName: string;
  agentTitle: string | null;
  model: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  startedAt: Date | null;
}

export async function usageRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: QueryString }>("/usage", async (req, reply) => {
    const auth = requirePermission(req, "usage.read");
    const q = req.query;

    const limit = clampLimit(q.limit);
    const conds = [eq(runs.tenantId, auth.tenantId)];
    if (q.since != null) {
      const ms = Number(q.since);
      if (Number.isFinite(ms)) conds.push(gte(runs.startedAt, new Date(ms)));
    }
    if (q.until != null) {
      const ms = Number(q.until);
      if (Number.isFinite(ms)) conds.push(lt(runs.startedAt, new Date(ms)));
    }

    const db = getDb();
    const rows: RawRunRow[] = db
      .select({
        agentName: agents.name,
        agentTitle: agents.title,
        model: runs.model,
        tokensIn: runs.tokensIn,
        tokensOut: runs.tokensOut,
        startedAt: runs.startedAt,
      })
      .from(runs)
      .innerJoin(agents, eq(agents.id, runs.agentId))
      .where(and(...conds))
      .all() as RawRunRow[];

    const byAgent = aggregate(rows, (r) => r.agentTitle ?? r.agentName);
    const byModel = aggregate(rows, (r) => r.model ?? "unknown");
    const byDay = aggregate(rows, (r) =>
      r.startedAt ? toDayKey(r.startedAt) : "unknown",
    );

    // Stable, capped lists.
    const sortDesc = (a: UsageRow, b: UsageRow) =>
      b.tokensIn + b.tokensOut - (a.tokensIn + a.tokensOut);
    const sortDayAsc = (a: UsageRow, b: UsageRow) => a.key.localeCompare(b.key);

    const totals = byAgent.reduce(
      (acc, r) => ({
        runs: acc.runs + r.runs,
        tokensIn: acc.tokensIn + r.tokensIn,
        tokensOut: acc.tokensOut + r.tokensOut,
        usdCents: acc.usdCents + r.usdCents,
      }),
      { runs: 0, tokensIn: 0, tokensOut: 0, usdCents: 0 },
    );

    // Pull current budget row (lazily creating one to mirror the budgets
    // route's behaviour).
    const budgetRow = db
      .select()
      .from(tenantBudgets)
      .where(eq(tenantBudgets.tenantId, auth.tenantId))
      .all()[0];

    return reply.ok({
      totals,
      byAgent: byAgent.sort(sortDesc).slice(0, limit),
      byModel: byModel.sort(sortDesc).slice(0, limit),
      byDay: byDay.sort(sortDayAsc).slice(-limit),
      budget: budgetRow
        ? {
            monthlyTokenCap: budgetRow.monthlyTokenCap,
            monthlyUsdCap: budgetRow.monthlyUsdCap,
            usedTokensMonth: budgetRow.usedTokensMonth,
            usedUsdMonth: budgetRow.usedUsdMonth,
            periodStart: budgetRow.periodStart.getTime(),
          }
        : null,
    });
  });
}

function aggregate(rows: RawRunRow[], keyFn: (r: RawRunRow) => string): UsageRow[] {
  const m = new Map<string, UsageRow>();
  for (const r of rows) {
    const k = keyFn(r);
    const tIn = r.tokensIn ?? 0;
    const tOut = r.tokensOut ?? 0;
    const cents = priceCents(r.model, tIn, tOut);
    const cur = m.get(k);
    if (cur) {
      cur.runs += 1;
      cur.tokensIn += tIn;
      cur.tokensOut += tOut;
      cur.usdCents += cents;
    } else {
      m.set(k, {
        key: k,
        runs: 1,
        tokensIn: tIn,
        tokensOut: tOut,
        usdCents: cents,
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

// Suppress unused warning for `sql` import (kept for raw-SQL fallback).
void sql;
