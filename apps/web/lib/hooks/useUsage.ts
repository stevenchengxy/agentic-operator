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
import { tenantHeader } from "./tenant-header";

interface ApiOk<T> {
  ok: true;
  data: T;
}
interface ApiErr {
  ok: false;
  error: { code: string; message: string };
}

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
  const body = (await res.json()) as ApiOk<T> | ApiErr;
  if (!body.ok) {
    throw new Error(`${path}: ${body.error.code} — ${body.error.message}`);
  }
  return body.data;
}

export interface UsageRow {
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

export interface UsageResponse {
  totals: {
    runs: number;
    calls: number;
    tokensIn: number;
    tokensOut: number;
    cachedInputTokens: number;
    reasoningTokens: number;
    usdNanos: number;
    usdCents: number;
    unpricedCalls: number;
  };
  byAgent: UsageRow[];
  byModel: UsageRow[];
  byProvider: UsageRow[];
  byReasoning: UsageRow[];
  byDay: UsageRow[];
  budget: BudgetRow | null;
}

export interface BudgetRow {
  tenantId?: string;
  monthlyTokenCap: number | null;
  monthlyUsdCap: number | null;
  usedTokensMonth: number;
  usedUsdMonth: number;
  usedUsdNanos: number;
  periodStart: number;
  updatedAt?: number;
}

const USAGE_KEYS = {
  all: ["usage"] as const,
  range: (since: number | null, until: number | null) =>
    ["usage", since, until] as const,
};

const BUDGET_KEYS = {
  current: ["budgets", "current"] as const,
};

export function useUsage(opts?: {
  since?: number;
  until?: number;
}): UseQueryResult<UsageResponse> {
  const since = opts?.since ?? null;
  const until = opts?.until ?? null;
  const sp = new URLSearchParams();
  if (since != null) sp.set("since", String(since));
  if (until != null) sp.set("until", String(until));
  const qs = sp.toString();
  return useQuery({
    queryKey: USAGE_KEYS.range(since, until),
    queryFn: () => callV1<UsageResponse>(`/v1/usage${qs ? `?${qs}` : ""}`),
    staleTime: 30_000,
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
