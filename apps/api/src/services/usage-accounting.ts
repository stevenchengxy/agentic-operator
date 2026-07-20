/** Shared token/cost accounting used by usage charts and budget reads. */

import { and, eq, gte, lt } from "drizzle-orm";
import { getDb, llmCalls, runs, tenantBudgets } from "@agentic/db";
import { estimateTokenCostCents } from "@agentic/llm-gateway";

/** Returns null when provider+model pricing is unknown. Callers must expose
 * that incompleteness; there is intentionally no plausible-looking default. */
export function estimateCostCents(
  model: string | null | undefined,
  tokensIn: number,
  tokensOut: number,
  provider?: string | null,
): number | null {
  return (
    estimateTokenCostCents({ provider, model, tokensIn, tokensOut })
      ?.usdCents ?? null
  );
}

export interface AccountedUsage {
  tokensIn: number;
  tokensOut: number;
  tokens: number;
  usdCents: number;
  runTokens: number;
  runtimeCallTokens: number;
  /** Provider call rows that carry a durable run id and can therefore be
   * de-duplicated against the run aggregate. */
  linkedRuntimeCallTokens: number;
  /** Legacy runtime call rows without run attribution. They are excluded
   * from totals because adding them to run aggregates would double count;
   * the non-zero value makes that coverage gap explicit. */
  ambiguousRuntimeCallTokens: number;
  ambiguousRuntimeCalls: number;
  auxiliaryCallTokens: number;
  /** Run aggregates used only when no attributed provider-call rows exist. */
  legacyRunTokens: number;
  /** Provider-reported token measurements included in totals. */
  exactProviderTokens: number;
  /** Character-derived estimates included in totals (Agent Factory calls). */
  estimatedTokens: number;
  /** Included rows whose historic provenance predates token_source. */
  unknownSourceTokens: number;
  unknownSourceCalls: number;
  unmeasuredRuntimeCalls: number;
  tokenCoverageComplete: boolean;
  /** Tokens whose exact provider+served-model price is unavailable. */
  unpricedTokens: number;
  costComplete: boolean;
  costEstimated: boolean;
}

function utcMonthStart(at = new Date()): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
}

/** Materialize the budget row and advance stale rows to the current calendar
 * month. A manual reset later in the current month remains intact because its
 * periodStart is newer than the month boundary. */
export function ensureBudgetRow(tenantId: string) {
  const db = getDb();
  let row = db
    .select()
    .from(tenantBudgets)
    .where(eq(tenantBudgets.tenantId, tenantId))
    .all()[0];
  const monthStart = utcMonthStart();
  if (!row) {
    db.insert(tenantBudgets)
      .values({
        tenantId,
        monthlyTokenCap: null,
        monthlyUsdCap: null,
        usedTokensMonth: 0,
        usedUsdMonth: 0,
        periodStart: monthStart,
      })
      .onConflictDoNothing({ target: tenantBudgets.tenantId })
      .run();
    row = db
      .select()
      .from(tenantBudgets)
      .where(eq(tenantBudgets.tenantId, tenantId))
      .all()[0]!;
  } else if (row.periodStart.getTime() < monthStart.getTime()) {
    db.update(tenantBudgets)
      .set({
        periodStart: monthStart,
        usedTokensMonth: 0,
        usedUsdMonth: 0,
        updatedAt: new Date(),
      })
      .where(eq(tenantBudgets.tenantId, tenantId))
      .run();
    row = {
      ...row,
      periodStart: monthStart,
      usedTokensMonth: 0,
      usedUsdMonth: 0,
    };
  }
  return row;
}

/**
 * Reconstruct usage from durable facts for one period without guessing.
 *
 * New runtime calls carry llm_calls.run_id and are counted from the provider
 * call row; the matching run aggregate is excluded. Historic runs without an
 * attributed call are counted from runs. Historic runtime call rows without a
 * run id are reported as ambiguous coverage and deliberately excluded: using
 * max(runTokens, callTokens), or adding both, fabricates an exact total from
 * evidence that cannot be joined.
 */
export function calculateTenantUsage(
  tenantId: string,
  since: Date,
  until: Date = new Date(),
): AccountedUsage {
  const db = getDb();
  const runRows = db
    .select({
      id: runs.id,
      model: runs.model,
      tokensIn: runs.tokensIn,
      tokensOut: runs.tokensOut,
    })
    .from(runs)
    .where(
      and(
        eq(runs.tenantId, tenantId),
        gte(runs.startedAt, since),
        lt(runs.startedAt, until),
      ),
    )
    .all();
  const callRows = db
    .select({
      runId: llmCalls.runId,
      conversationId: llmCalls.conversationId,
      provider: llmCalls.provider,
      model: llmCalls.servedModel,
      requestedModel: llmCalls.requestedModel,
      tokensIn: llmCalls.approxTokensIn,
      tokensOut: llmCalls.approxTokensOut,
      tokenSource: llmCalls.tokenSource,
    })
    .from(llmCalls)
    .where(
      and(
        eq(llmCalls.tenantId, tenantId),
        gte(llmCalls.createdAt, since),
        lt(llmCalls.createdAt, until),
      ),
    )
    .all();

  const sum = <T>(
    rows: T[],
    fields: (row: T) => {
      provider: string | null;
      model: string | null;
      input: number;
      output: number;
    },
  ) =>
    rows.reduce(
      (acc, row) => {
        const value = fields(row);
        acc.input += value.input;
        acc.output += value.output;
        const cost = estimateCostCents(
          value.model,
          value.input,
          value.output,
          value.provider,
        );
        if (cost === null) acc.unpriced += value.input + value.output;
        else acc.cost += cost;
        return acc;
      },
      { input: 0, output: 0, cost: 0, unpriced: 0 },
    );

  const fromRuns = sum(runRows, (row) => ({
    provider: null,
    model: row.model,
    input: row.tokensIn ?? 0,
    output: row.tokensOut ?? 0,
  }));
  const runtimeCalls = callRows.filter(
    (row) => row.conversationId === "runtime",
  );
  const auxiliaryCalls = callRows.filter(
    (row) => row.conversationId !== "runtime",
  );
  const linkedRuntimeCalls = runtimeCalls.filter((row) => Boolean(row.runId));
  const ambiguousRuntimeCalls = runtimeCalls.filter((row) => !row.runId);
  const linkedRunIds = new Set(
    linkedRuntimeCalls.flatMap((row) => (row.runId ? [row.runId] : [])),
  );
  const legacyRuns = runRows.filter((row) => !linkedRunIds.has(row.id));
  const fromLinkedRuntimeCalls = sum(linkedRuntimeCalls, (row) => ({
    provider: row.provider,
    model: row.model ?? row.requestedModel,
    input: row.tokensIn ?? 0,
    output: row.tokensOut ?? 0,
  }));
  const fromAmbiguousRuntimeCalls = sum(ambiguousRuntimeCalls, (row) => ({
    provider: row.provider,
    model: row.model ?? row.requestedModel,
    input: row.tokensIn ?? 0,
    output: row.tokensOut ?? 0,
  }));
  const fromAuxiliaryCalls = sum(auxiliaryCalls, (row) => ({
    provider: row.provider,
    model: row.model ?? row.requestedModel,
    input: row.tokensIn ?? 0,
    output: row.tokensOut ?? 0,
  }));
  const fromLegacyRuns = sum(legacyRuns, (row) => ({
    provider: null,
    model: row.model,
    input: row.tokensIn ?? 0,
    output: row.tokensOut ?? 0,
  }));

  const runsTotal = fromRuns.input + fromRuns.output;
  const runtimeCallsTotal = runtimeCalls.reduce(
    (total, row) => total + (row.tokensIn ?? 0) + (row.tokensOut ?? 0),
    0,
  );
  const linkedRuntimeCallTokens =
    fromLinkedRuntimeCalls.input + fromLinkedRuntimeCalls.output;
  const ambiguousRuntimeCallTokens =
    fromAmbiguousRuntimeCalls.input + fromAmbiguousRuntimeCalls.output;
  const auxiliaryCallTokens =
    fromAuxiliaryCalls.input + fromAuxiliaryCalls.output;
  const legacyRunTokens = fromLegacyRuns.input + fromLegacyRuns.output;
  const tokensIn =
    fromLinkedRuntimeCalls.input +
    fromLegacyRuns.input +
    fromAuxiliaryCalls.input;
  const tokensOut =
    fromLinkedRuntimeCalls.output +
    fromLegacyRuns.output +
    fromAuxiliaryCalls.output;
  const countedCalls = [...linkedRuntimeCalls, ...auxiliaryCalls];
  const exactProviderTokens = countedCalls.reduce(
    (total, row) =>
      total +
      (row.tokenSource === "provider"
        ? (row.tokensIn ?? 0) + (row.tokensOut ?? 0)
        : 0),
    0,
  );
  // Factory telemetry has always used chars/4. Old rows predate the explicit
  // token_source column but retain the same producer contract.
  const estimatedTokens = countedCalls.reduce(
    (total, row) =>
      total +
      (row.tokenSource === "estimated_chars" ||
      (row.tokenSource == null && row.conversationId !== "runtime")
        ? (row.tokensIn ?? 0) + (row.tokensOut ?? 0)
        : 0),
    0,
  );
  const unknownSourceTokens = [...linkedRuntimeCalls, ...auxiliaryCalls].reduce(
    (total, row) =>
      total +
      (row.tokenSource == null && row.conversationId === "runtime"
        ? (row.tokensIn ?? 0) + (row.tokensOut ?? 0)
        : 0),
    0,
  );
  const unknownSourceCalls = linkedRuntimeCalls.filter(
    (row) => row.tokenSource == null,
  ).length;
  const unmeasuredRuntimeCalls = linkedRuntimeCalls.filter(
    (row) => row.tokensIn == null || row.tokensOut == null,
  ).length;
  const unpricedTokens =
    fromLinkedRuntimeCalls.unpriced +
    fromLegacyRuns.unpriced +
    fromAuxiliaryCalls.unpriced;
  return {
    tokensIn,
    tokensOut,
    tokens: tokensIn + tokensOut,
    usdCents:
      fromLinkedRuntimeCalls.cost +
      fromLegacyRuns.cost +
      fromAuxiliaryCalls.cost,
    runTokens: runsTotal,
    runtimeCallTokens: runtimeCallsTotal,
    linkedRuntimeCallTokens,
    ambiguousRuntimeCallTokens,
    ambiguousRuntimeCalls: ambiguousRuntimeCalls.length,
    auxiliaryCallTokens,
    legacyRunTokens,
    exactProviderTokens,
    estimatedTokens,
    unknownSourceTokens,
    unknownSourceCalls,
    unmeasuredRuntimeCalls,
    tokenCoverageComplete:
      ambiguousRuntimeCalls.length === 0 &&
      unknownSourceCalls === 0 &&
      unmeasuredRuntimeCalls === 0 &&
      legacyRunTokens === 0,
    unpricedTokens,
    costComplete: unpricedTokens === 0,
    costEstimated: estimatedTokens > 0 || legacyRunTokens > 0,
  };
}

/** Read the authoritative gateway-enforcement counters alongside telemetry.
 * This function intentionally performs no reconciliation write. Provider
 * settlement/lease expiry owns those counters transactionally; reconstructing
 * and writing them from partially joinable read models can reopen or invent
 * budget usage. */
export function reconcileBudgetUsage(
  row: typeof tenantBudgets.$inferSelect,
  until: Date = new Date(),
): AccountedUsage {
  const usage = calculateTenantUsage(row.tenantId, row.periodStart, until);
  return {
    ...usage,
    tokens: row.usedTokensMonth,
    usdCents: row.usedUsdMonth,
  };
}
