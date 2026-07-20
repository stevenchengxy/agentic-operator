"use client";

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { readApiData } from "@/lib/api-response";
import { tenantHeader } from "./tenant-header";

async function callV1<T>(path: string): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: { Accept: "application/json", ...tenantHeader() },
  });
  return readApiData<T>(response, path);
}

export interface ObservabilitySummary {
  window: { since: number; until: number; bucketMs: number };
  totals: {
    runs: number;
    agentInvocations: number;
    events: number;
    auditOperations: number | null;
    llmCalls: number;
    toolCalls: number;
    tokensIn: number;
    tokensOut: number;
    tokens: number;
    costUsdCents: number;
    unpricedTokens: number;
    costComplete: boolean;
    errors: number;
    active: number;
    activeAgents: number;
    agentsObserved: number;
    testRuns: number;
  };
  rates: { success: number; error: number; cancellation: number };
  latency: { avgMs: number | null; p50Ms: number | null; p95Ms: number | null };
  byAgent: Array<{
    agentId: string;
    agentName: string;
    agentTitle: string | null;
    kind: string;
    runs: number;
    successful: number;
    failed: number;
    active: number;
    tokensIn: number;
    tokensOut: number;
    successRate: number;
    avgDurationMs: number | null;
    p95DurationMs: number | null;
    lastRunAt: number | null;
  }>;
  byModel: Array<{
    model: string;
    provider: string | null;
    calls: number;
    runs: number;
    tokensIn: number;
    tokensOut: number;
    failures: number;
    fallbacks: number;
    avgLatencyMs: number | null;
    p95LatencyMs: number | null;
    exactProviderTokens: number;
    estimatedTokens: number;
    legacyRunTokens: number;
    unknownSourceTokens: number;
  }>;
  byStatus: Array<{ status: string; runs: number }>;
  byTool: Array<{
    name: string;
    calls: number;
    successful: number;
    failed: number;
    successRate: number;
    avgDurationMs: number | null;
    p95DurationMs: number | null;
    agents: string[];
    lastCalledAt: number | null;
  }>;
  timeSeries: Array<{
    start: number;
    end: number;
    runs: number;
    events: number;
    errors: number;
    tokensIn: number;
    tokensOut: number;
    llmCalls: number;
    toolCalls: number;
  }>;
  coverage: {
    auditAuthorized: boolean;
    toolCalls: "persisted_steps_only";
    tokens: {
      complete: boolean;
      exactProviderTokens: number;
      estimatedTokens: number;
      legacyRunTokens: number;
      ambiguousRuntimeCallTokens: number;
      unknownSourceTokens: number;
      ambiguousRuntimeCalls: number;
      unknownSourceCalls: number;
      unmeasuredRuntimeCalls: number;
    };
  };
}

export interface InvocationEdge {
  id: string;
  callerRunId: string | null;
  callerAgentId: string | null;
  callerAgent: string | null;
  callerAgentTitle: string | null;
  calleeRunId: string;
  calleeAgentId: string;
  calleeAgent: string;
  calleeAgentTitle: string | null;
  viaEvent: string | null;
  callType: "parent" | "event" | "event_agent" | "external";
  correlationId: string;
  startedAt: number;
  durationMs: number | null;
  status: string;
  tokensIn: number | null;
  tokensOut: number | null;
  at: number;
}

export interface InvocationResponse {
  items: InvocationEdge[];
  edges: InvocationEdge[];
  nodes: Array<{
    runId: string;
    agentId: string;
    agentName: string;
    agentTitle: string | null;
    correlationId: string;
    status: string;
    startedAt: number | null;
    durationMs: number | null;
    tokensIn: number | null;
    tokensOut: number | null;
  }>;
  nextCursor: string | null;
  count: number;
  window: { since: number; until: number; bucketMs: number };
  coverage: {
    complete: boolean;
    relations: "persisted_parent_or_event_evidence_only";
  };
}

export function useObservabilitySummary(opts: {
  since: number;
  until: number;
  bucketMs?: number;
}): UseQueryResult<ObservabilitySummary> {
  const spanMs = Math.max(0, opts.until - opts.since);
  const params = new URLSearchParams({
    since: String(opts.since),
    until: String(opts.until),
  });
  if (opts.bucketMs != null) params.set("bucketMs", String(opts.bucketMs));
  return useQuery({
    // Key by window size rather than the moving wall-clock bounds. The query
    // function is updated on render and interval/SSE refetches use the newest
    // bounds without leaving a new cache entry every 15 seconds.
    queryKey: [
      "observability",
      "summary",
      spanMs,
      opts.bucketMs ?? null,
    ] as const,
    queryFn: () =>
      callV1<ObservabilitySummary>(
        `/v1/observability/summary?${params.toString()}`,
      ),
    staleTime: 5_000,
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
    retry: 1,
  });
}

export function useObservabilityInvocations(opts: {
  since: number;
  until: number;
  limit?: number;
}): UseQueryResult<InvocationResponse> {
  const spanMs = Math.max(0, opts.until - opts.since);
  const params = new URLSearchParams({
    since: String(opts.since),
    until: String(opts.until),
    limit: String(opts.limit ?? 500),
  });
  return useQuery({
    queryKey: [
      "observability",
      "invocations",
      spanMs,
      opts.limit ?? 500,
    ] as const,
    queryFn: () =>
      callV1<InvocationResponse>(
        `/v1/observability/invocations?${params.toString()}`,
      ),
    staleTime: 5_000,
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
    retry: 1,
  });
}
