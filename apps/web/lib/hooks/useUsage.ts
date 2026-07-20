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
import { usePathname } from "next/navigation";
import { tenantFromPathname, tenantHeader } from "./tenant-header";

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
  attempts: AttemptMetricRow;
  byAgent: UsageRow[];
  byModel: UsageRow[];
  byProvider: UsageRow[];
  byAccount: UsageRow[];
  byProductSurface: UsageRow[];
  byProductAction: UsageRow[];
  byFunction: UsageRow[];
  byApiCall: UsageRow[];
  byReasoning: UsageRow[];
  byDay: UsageRow[];
  byTask: AttemptMetricRow[];
  byGateway: AttemptMetricRow[];
  byRoute: AttemptMetricRow[];
  byActor: AttemptMetricRow[];
  byRoutingProfile: AttemptMetricRow[];
  budget: BudgetRow | null;
}

export interface AttemptMetricRow {
  key?: string;
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
  all: (tenant: string) => ["usage", tenant] as const,
  range: (tenant: string, query: string) =>
    ["usage", tenant, query] as const,
};

const BUDGET_KEYS = {
  current: (tenant: string) => ["budgets", tenant, "current"] as const,
};

function useTenantQueryScope(): string {
  const pathname = usePathname() ?? "";
  return tenantFromPathname(pathname) ?? "default";
}

export function useUsage(opts?: {
  since?: number;
  until?: number;
  taskType?: string;
  gatewayInstanceId?: string;
  route?: string;
  actorId?: string;
  model?: string;
  functionName?: string;
  apiRoute?: string;
}): UseQueryResult<UsageResponse> {
  const tenant = useTenantQueryScope();
  const since = opts?.since ?? null;
  const until = opts?.until ?? null;
  const sp = new URLSearchParams();
  if (since != null) sp.set("since", String(since));
  if (until != null) sp.set("until", String(until));
  for (const key of [
    "taskType",
    "gatewayInstanceId",
    "route",
    "actorId",
    "model",
    "functionName",
    "apiRoute",
  ] as const) {
    const value = opts?.[key];
    if (value) sp.set(key, value);
  }
  const qs = sp.toString();
  return useQuery({
    queryKey: USAGE_KEYS.range(tenant, qs),
    queryFn: () => callV1<UsageResponse>(`/v1/usage${qs ? `?${qs}` : ""}`),
    staleTime: 30_000,
  });
}

export function useBudget(): UseQueryResult<BudgetRow> {
  const tenant = useTenantQueryScope();
  return useQuery({
    queryKey: BUDGET_KEYS.current(tenant),
    queryFn: () => callV1<BudgetRow>("/v1/budgets"),
    staleTime: 30_000,
  });
}

export function useUpdateBudget() {
  const client = useQueryClient();
  const tenant = useTenantQueryScope();
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
      void client.invalidateQueries({
        queryKey: BUDGET_KEYS.current(tenant),
      });
      void client.invalidateQueries({ queryKey: USAGE_KEYS.all(tenant) });
    },
  });
}
