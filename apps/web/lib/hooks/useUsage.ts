/**
 * useUsage / useBudget — TanStack Query wrappers for the cost dashboard
 * (P3-FE-03).
 *
 *   GET /v1/usage         → aggregated runs · tokensIn · tokensOut · usdCents,
 *                            grouped by agent / model / day.
 *   GET /v1/budgets       → current tenant budget caps + used totals.
 *   PUT /v1/budgets       → upsert caps.
 *
 * The usage endpoint is new (P3-FE-03). When the backend hasn't been
 * deployed yet `useUsage()` surfaces `error` and the dashboard shows the
 * budget row + a "live data unavailable" notice (the brief said: render
 * the budget row at minimum).
 */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";
import { readApiData } from "@/lib/api-response";
import { tenantHeader } from "./tenant-header";

async function callV1<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { headers: initHeaders, ...rest } = init;
  const res = await fetch(path, {
    credentials: "same-origin",
    ...rest,
    headers: {
      Accept: "application/json",
      ...tenantHeader(),
      ...(initHeaders as Record<string, string> | undefined),
    },
  });
  return readApiData<T>(res, path);
}

export interface UsageRow {
  key: string;
  runs: number;
  tokensIn: number;
  tokensOut: number;
  usdCents: number;
  /** Tokens whose model/provider price is not configured. */
  unpricedTokens: number;
  /** False means usdCents is only the known priced minimum. */
  costComplete: boolean;
}

export interface UsageResponse {
  totals: {
    runs: number;
    tokensIn: number;
    tokensOut: number;
    usdCents: number;
    testRuns: number;
  };
  coverage: {
    runTokens: number;
    runtimeCallTokens: number;
    linkedRuntimeCallTokens: number;
    /** Legacy runtime calls without a run id; excluded to avoid double count. */
    ambiguousRuntimeCallTokens: number;
    ambiguousRuntimeCalls: number;
    auxiliaryCallTokens: number;
    legacyRunTokens: number;
    exactProviderTokens: number;
    estimatedTokens: number;
    unknownSourceTokens: number;
    unknownSourceCalls: number;
    unmeasuredRuntimeCalls: number;
    tokenCoverageComplete: boolean;
    unpricedTokens: number;
    costComplete: boolean;
    costEstimated: boolean;
  };
  byAgent: UsageRow[];
  byModel: UsageRow[];
  byDay: UsageRow[];
  budget: BudgetRow | null;
}

export interface BudgetRow {
  tenantId?: string;
  monthlyTokenCap: number | null;
  monthlyUsdCap: number | null;
  usedTokensMonth: number;
  usedUsdMonth: number;
  /** Tokens in the current budget period that have no configured price. */
  unpricedTokens: number;
  /** False means usedUsdMonth is only the known priced minimum. */
  costComplete: boolean;
  /** In-flight model calls currently holding budget capacity. */
  activeReservations: number;
  reservedTokens: number;
  reservedUsdCents: number;
  periodStart: number;
  updatedAt?: number;
}

const USAGE_KEYS = {
  all: ["usage"] as const,
  range: (since: number | null, until: number | null) =>
    ["usage", since, until] as const,
  rolling: (windowMs: number) => ["usage", "rolling", windowMs] as const,
};

const BUDGET_KEYS = {
  current: ["budgets", "current"] as const,
};

export type UsageQueryOptions =
  | { since?: number; until?: number; rollingWindowMs?: never }
  | { since?: never; until?: never; rollingWindowMs: number };

/**
 * A rolling window deliberately keeps one cache entry per window size. The
 * concrete timestamps are calculated when the request runs, so periodic
 * refreshes move the window without allocating a new React Query cache entry.
 */
export function usageQueryKey(opts?: UsageQueryOptions) {
  if (opts?.rollingWindowMs != null) {
    return USAGE_KEYS.rolling(opts.rollingWindowMs);
  }
  return USAGE_KEYS.range(opts?.since ?? null, opts?.until ?? null);
}

export function usageRequestPath(
  opts?: UsageQueryOptions,
  now = Date.now(),
): string {
  let since = opts?.since ?? null;
  let until = opts?.until ?? null;
  if (opts?.rollingWindowMs != null) {
    if (!Number.isFinite(opts.rollingWindowMs) || opts.rollingWindowMs <= 0) {
      throw new Error("rollingWindowMs must be a positive finite number");
    }
    until = now;
    since = now - opts.rollingWindowMs;
  }
  const sp = new URLSearchParams();
  if (since != null) sp.set("since", String(since));
  if (until != null) sp.set("until", String(until));
  const qs = sp.toString();
  return `/v1/usage${qs ? `?${qs}` : ""}`;
}

export function useUsage(
  opts?: UsageQueryOptions,
): UseQueryResult<UsageResponse> {
  return useQuery({
    queryKey: usageQueryKey(opts),
    queryFn: () => callV1<UsageResponse>(usageRequestPath(opts)),
    staleTime: 30_000,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });
}

export function useBudget(): UseQueryResult<BudgetRow> {
  return useQuery({
    queryKey: BUDGET_KEYS.current,
    queryFn: () => callV1<BudgetRow>("/v1/budgets"),
    staleTime: 30_000,
  });
}

export function useUpdateBudget() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      monthlyTokenCap?: number | null;
      monthlyUsdCap?: number | null;
      reset?: boolean;
    }) =>
      callV1<BudgetRow>("/v1/budgets", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: BUDGET_KEYS.current });
      void client.invalidateQueries({ queryKey: USAGE_KEYS.all });
    },
  });
}
