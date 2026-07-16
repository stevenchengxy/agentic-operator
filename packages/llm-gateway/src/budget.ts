/** Per-tenant token and exact-cost budget accounting. */
import { getDb, tenantBudgets } from "@agentic/db";
import { eq, sql } from "drizzle-orm";
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
  const row = getDb()
    .select()
    .from(tenantBudgets)
    .where(eq(tenantBudgets.tenantId, tenantId))
    .all()[0];
  if (!row) return;

  if (row.monthlyTokenCap !== null && row.usedTokensMonth >= row.monthlyTokenCap) {
    throw new LLMError(
      `tenant ${tenantId} exceeded monthly token cap (${row.usedTokensMonth}/${row.monthlyTokenCap})`,
      "cost_limit_exceeded",
      provider,
    );
  }

  // Preserve compatibility with rows inserted by older code/tests that only
  // populated the cents projection.
  const usedUsdNanos = Math.max(
    row.usedUsdNanos,
    row.usedUsdMonth * USD_NANOS_PER_CENT,
  );
  const capUsdNanos = row.monthlyUsdCap === null
    ? null
    : row.monthlyUsdCap * USD_NANOS_PER_CENT;
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
}): { tokens: number; usdNanos: number | null; usdCents: number | null } | null {
  if (!args.tenantId) return null;
  const tokens = args.usage.available === false ? 0 : args.usage.totalTokens;
  const usdNanos = args.cost.totalUsdNanos;
  const chargedNanos = usdNanos ?? 0;
  const db = getDb();

  db.insert(tenantBudgets).values({
    tenantId: args.tenantId,
    monthlyTokenCap: null,
    monthlyUsdCap: null,
    usedTokensMonth: 0,
    usedUsdMonth: 0,
    usedUsdNanos: 0,
  }).onConflictDoNothing({ target: tenantBudgets.tenantId }).run();

  db.update(tenantBudgets).set({
    usedTokensMonth: sql`${tenantBudgets.usedTokensMonth} + ${tokens}`,
    usedUsdNanos: sql`max(${tenantBudgets.usedUsdNanos}, ${tenantBudgets.usedUsdMonth} * ${USD_NANOS_PER_CENT}) + ${chargedNanos}`,
    // Integer ceiling of the exact accumulated nanodollar total.
    usedUsdMonth: sql`(max(${tenantBudgets.usedUsdNanos}, ${tenantBudgets.usedUsdMonth} * ${USD_NANOS_PER_CENT}) + ${chargedNanos} + ${USD_NANOS_PER_CENT - 1}) / ${USD_NANOS_PER_CENT}`,
    updatedAt: new Date(),
  }).where(eq(tenantBudgets.tenantId, args.tenantId)).run();

  return {
    tokens,
    usdNanos,
    usdCents: usdNanos === null ? null : Math.ceil(usdNanos / USD_NANOS_PER_CENT),
  };
}
