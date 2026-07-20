/** Per-tenant token and exact-cost budget accounting. */
import { getDb, tenantBudgets } from "@agentic/db";
import { and, eq, lt, sql } from "drizzle-orm";
import { LLMError } from "./errors";
import { USD_NANOS_PER_CENT } from "./pricing";
import type { CostBreakdown, ProviderId, TokenUsage } from "./types";

/**
 * Read-only preflight. It deliberately does not reserve a guessed maximum;
 * the successful call is charged from authoritative returned usage/cost.
 */
export function assertBudgetAvailable(
  tenantId: string | undefined,
  provider: ProviderId,
): void {
  if (!tenantId) return;
  ensureCurrentBudgetPeriod(tenantId);
  const row = getDb()
    .select()
    .from(tenantBudgets)
    .where(eq(tenantBudgets.tenantId, tenantId))
    .all()[0];
  if (!row) return;

  if (
    row.monthlyTokenCap !== null &&
    row.usedTokensMonth >= row.monthlyTokenCap
  ) {
    throw new LLMError(
      `tenant ${tenantId} exceeded monthly token cap (${row.usedTokensMonth}/${row.monthlyTokenCap})`,
      "cost_limit_exceeded",
      provider,
    );
  }

  // Preserve compatibility with rows inserted before exact nanodollars were
  // added. Once an exact value exists it is authoritative: usedUsdMonth is a
  // rounded-up display projection and must never be fed back into accounting.
  const usedUsdNanos =
    row.usedUsdNanos === 0 && row.usedUsdMonth > 0
      ? row.usedUsdMonth * USD_NANOS_PER_CENT
      : row.usedUsdNanos;
  const capUsdNanos =
    row.monthlyUsdCap === null ? null : row.monthlyUsdCap * USD_NANOS_PER_CENT;
  if (capUsdNanos !== null && usedUsdNanos >= capUsdNanos) {
    throw new LLMError(
      `tenant ${tenantId} exceeded monthly USD cap (${row.usedUsdMonth}c/${row.monthlyUsdCap}c)`,
      "cost_limit_exceeded",
      provider,
    );
  }
}
/** Accumulate exact spend; an unpriced call increments tokens but not USD. */
export function recordActualSpend(args: {
  tenantId: string | undefined;
  usage: TokenUsage;
  cost: CostBreakdown;
}): {
  tokens: number;
  usdNanos: number | null;
  usdCents: number | null;
} | null {
  if (!args.tenantId) return null;
  ensureCurrentBudgetPeriod(args.tenantId);
  const tokens = args.usage.available === false ? 0 : args.usage.totalTokens;
  const usdNanos = args.cost.totalUsdNanos;
  const chargedNanos = usdNanos ?? 0;
  const db = getDb();
  const now = new Date();

  db.insert(tenantBudgets)
    .values({
      tenantId: args.tenantId,
      monthlyTokenCap: null,
      monthlyUsdCap: null,
      usedTokensMonth: 0,
      usedUsdMonth: 0,
      usedUsdNanos: 0,
      periodStart: budgetPeriodStart(now),
      updatedAt: now,
    })
    .onConflictDoNothing({ target: tenantBudgets.tenantId })
    .run();

  // A zero exact balance paired with a non-zero cents balance identifies a
  // legacy row that predates usedUsdNanos. Hydrate that projection once. For
  // all current rows, including sub-cent balances, exact nanodollars remain
  // the only accumulation base.
  const exactBalance = sql`CASE WHEN ${tenantBudgets.usedUsdNanos} = 0 AND ${tenantBudgets.usedUsdMonth} > 0 THEN ${tenantBudgets.usedUsdMonth} * ${USD_NANOS_PER_CENT} ELSE ${tenantBudgets.usedUsdNanos} END`;

  db.update(tenantBudgets)
    .set({
      usedTokensMonth: sql`${tenantBudgets.usedTokensMonth} + ${tokens}`,
      usedUsdNanos: sql`${exactBalance} + ${chargedNanos}`,
      // Integer ceiling of the exact accumulated nanodollar total.
      usedUsdMonth: sql`CAST((${exactBalance} + ${chargedNanos} + ${USD_NANOS_PER_CENT - 1}) / ${USD_NANOS_PER_CENT} AS INTEGER)`,
      updatedAt: now,
    })
    .where(eq(tenantBudgets.tenantId, args.tenantId))
    .run();

  return {
    tokens,
    usdNanos,
    usdCents:
      usdNanos === null ? null : Math.ceil(usdNanos / USD_NANOS_PER_CENT),
  };
}

export function budgetPeriodStart(at = new Date()): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
}

/** Reset monthly usage exactly once when the UTC calendar month advances. */
export function ensureCurrentBudgetPeriod(
  tenantId: string,
  at = new Date(),
): void {
  const start = budgetPeriodStart(at);
  getDb()
    .update(tenantBudgets)
    .set({
      usedTokensMonth: 0,
      usedUsdMonth: 0,
      usedUsdNanos: 0,
      periodStart: start,
      updatedAt: at,
    })
    .where(
      and(
        eq(tenantBudgets.tenantId, tenantId),
        lt(tenantBudgets.periodStart, start),
      ),
    )
    .run();
}
