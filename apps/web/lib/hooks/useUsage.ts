/**
 * useUsage / useBudget — TanStack Query wrappers for the cost dashboard
 * (P3-FE-03).
 *
 *   GET /v1/usage         → ledger-based aggregation: runs · calls · tokens ·
 *                            usdNanos/usdCents, grouped by agent / model /
 *                            provider / account / surface / day / … plus
 *                            attempt-level reliability metrics.
 *   GET /v1/budgets       → current tenant budget caps + used totals.
 *   PUT /v1/budgets       → upsert caps.
 *
 * Query keys are tenant-scoped (URL-derived via tenantFromPathname) so
 * switching tenants in the portal can never serve another tenant's cached
 * usage rows.
 */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";
import { usePathname } from "next/navigation";
import { readApiData } from "@/lib/api-response";
import { tenantFromPathname, tenantHeader } from "./tenant-header";

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
  calls: number;
  tokensIn: number;
  tokensOut: number;
  cachedInputTokens: number;
  reasoningTokens: number;
  usdNanos: number;
  usdCents: number;
  unpricedCalls: number;
}

/**
 * Legacy token-provenance block from the pre-ledger `/v1/usage` shape.
 * Optional: the ledger-based endpoint may not serve it. Consumers must
 * guard (`data.coverage?.…`) and fall back to ledger-derived signals
 * (`unpricedCalls`) when absent.
 */
export interface UsageCoverage {
  runTokens: number;
  runtimeCallTokens: number;
  linkedRuntimeCallTokens: number;
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
    /** Legacy field — only present if the API still tags test runs. */
    testRuns?: number;
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
  /** Legacy provenance block — absent on the ledger-based endpoint. */
  coverage?: UsageCoverage;
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
  /** Prefix used by useStream invalidation (`["usage"]` matches all tenants). */
  all: ["usage"] as const,
  scope: (tenant: string) => ["usage", tenant] as const,
};

const BUDGET_KEYS = {
  current: (tenant: string) => ["budgets", tenant, "current"] as const,
};

function useTenantQueryScope(): string {
  const pathname = usePathname() ?? "";
  return tenantFromPathname(pathname) ?? "default";
}

export interface UsageFilterOptions {
  taskType?: string;
  gatewayInstanceId?: string;
  route?: string;
  actorId?: string;
  model?: string;
  functionName?: string;
  apiRoute?: string;
}

const USAGE_FILTER_KEYS = [
  "taskType",
  "gatewayInstanceId",
  "route",
  "actorId",
  "model",
  "functionName",
  "apiRoute",
] as const;

export type UsageQueryOptions =
  | ({
      since?: number;
      until?: number;
      rollingWindowMs?: never;
    } & UsageFilterOptions)
  | ({
      since?: never;
      until?: never;
      rollingWindowMs: number;
    } & UsageFilterOptions);

function usageFilterFingerprint(opts?: UsageQueryOptions): string {
  if (!opts) return "";
  const sp = new URLSearchParams();
  for (const key of USAGE_FILTER_KEYS) {
    const value = opts[key];
    if (value) sp.set(key, value);
  }
  return sp.toString();
}

/**
 * A rolling window deliberately keeps one cache entry per window size. The
 * concrete timestamps are calculated when the request runs, so periodic
 * refreshes move the window without allocating a new React Query cache entry.
 *
 * Pure — the tenant scope is spliced in by the hook (`["usage", tenant, …]`)
 * so this stays unit-testable without a router.
 */
export function usageQueryKey(opts?: UsageQueryOptions): readonly unknown[] {
  const filters = usageFilterFingerprint(opts);
  if (opts?.rollingWindowMs != null) {
    const base = ["usage", "rolling", opts.rollingWindowMs] as const;
    return filters ? ([...base, filters] as const) : base;
  }
  const base = ["usage", opts?.since ?? null, opts?.until ?? null] as const;
  return filters ? ([...base, filters] as const) : base;
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
  for (const key of USAGE_FILTER_KEYS) {
    const value = opts?.[key];
    if (value) sp.set(key, value);
  }
  const qs = sp.toString();
  return `/v1/usage${qs ? `?${qs}` : ""}`;
}

export function useUsage(
  opts?: UsageQueryOptions,
): UseQueryResult<UsageResponse> {
  const tenant = useTenantQueryScope();
  return useQuery({
    // Tenant slug is spliced in after the "usage" prefix so the shared
    // `["usage"]` invalidation in useStream still matches.
    queryKey: [
      ...USAGE_KEYS.scope(tenant),
      ...usageQueryKey(opts).slice(1),
    ] as const,
    queryFn: () => callV1<UsageResponse>(usageRequestPath(opts)),
    staleTime: 30_000,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
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
      void client.invalidateQueries({ queryKey: BUDGET_KEYS.current(tenant) });
      void client.invalidateQueries({ queryKey: USAGE_KEYS.scope(tenant) });
    },
  });
}
