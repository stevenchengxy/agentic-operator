/**
 * Shared token/cost accounting for the FACTORY TELEMETRY plane
 * (`llm_call_telemetry` + legacy run aggregates). The billing-authoritative
 * ledger is `llm_calls` (usage-ledger); this module only reconstructs
 * observability estimates for dashboards that predate the ledger.
 */

import { and, gte, lt, eq } from "drizzle-orm";
import { getDb, llmCallTelemetry, runs } from "@agentic/db";
import { calculateCost, USD_NANOS_PER_CENT } from "@agentic/llm-gateway";
import { PROVIDER_IDS, findCatalogModel, type ProviderId } from "@agentic/contracts";

function isProviderId(s: string): s is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(s);
}

/** Returns null when provider+model pricing is unknown. Callers must expose
 * that incompleteness; there is intentionally no plausible-looking default. */
export function estimateCostCents(
  model: string | null | undefined,
  tokensIn: number,
  tokensOut: number,
  provider?: string | null,
): number | null {
  if (!model) return null;
  // Telemetry rows may lack provider attribution (legacy run aggregates).
  // Search the catalog across providers in that case; pricing is keyed on
  // (provider, model) in the merged catalog.
  const candidates: ProviderId[] =
    provider && isProviderId(provider)
      ? [provider]
      : (PROVIDER_IDS as readonly ProviderId[]).filter((id) =>
          Boolean(findCatalogModel(id, model)),
        );
  for (const candidate of candidates) {
    const cost = calculateCost({
      provider: candidate,
      model,
      usage: {
        inputTokens: tokensIn,
        outputTokens: tokensOut,
        totalTokens: tokensIn + tokensOut,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        cacheWrite5mInputTokens: 0,
        cacheWrite1hInputTokens: 0,
        reasoningTokens: 0,
        inputAudioTokens: 0,
        outputAudioTokens: 0,
      },
    });
    if (cost.totalUsdNanos != null) {
      return cost.totalUsdNanos / USD_NANOS_PER_CENT;
    }
  }
  return null;
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
      runId: llmCallTelemetry.runId,
      conversationId: llmCallTelemetry.conversationId,
      provider: llmCallTelemetry.provider,
      model: llmCallTelemetry.servedModel,
      requestedModel: llmCallTelemetry.requestedModel,
      tokensIn: llmCallTelemetry.approxTokensIn,
      tokensOut: llmCallTelemetry.approxTokensOut,
      tokenSource: llmCallTelemetry.tokenSource,
    })
    .from(llmCallTelemetry)
    .where(
      and(
        eq(llmCallTelemetry.tenantId, tenantId),
        gte(llmCallTelemetry.createdAt, since),
        lt(llmCallTelemetry.createdAt, until),
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
