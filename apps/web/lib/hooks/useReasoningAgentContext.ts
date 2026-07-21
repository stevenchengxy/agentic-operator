"use client";

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { fetchApiData } from "@/lib/api-response";
import { tenantHeader } from "./tenant-header";
import { reasoningRunPollInterval } from "./reasoning-run-liveness";

export interface ReasoningAgentContextResponse {
  domainId: string;
  provider: "allmeta";
  actions: Array<{
    id: string;
    name: string;
    description: string | null;
    actor: string[];
  }>;
}

export interface ReasoningRunStep {
  id: string;
  ord: number;
  name: string;
  type: string;
  status: string;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  error: string | null;
  provider: string | null;
  model: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  input: unknown;
  output: unknown;
}

export interface ReasoningRunResponse {
  run: {
    id: string;
    status: string;
    agentName: string;
    startedAt: string | null;
    endedAt: string | null;
    durationMs: number | null;
    tokensIn: number | null;
    tokensOut: number | null;
    model: string | null;
    error: string | null;
    errorMessage?: string | null;
    currentStepName: string | null;
    currentStepOrd: number | null;
    stepCount: number | null;
  };
  steps: ReasoningRunStep[];
  children: Array<{
    role: "qualified";
    runtimeRole: "qualified";
    run: ReasoningRunResponse["run"] & { parentRunId?: string | null };
    steps: ReasoningRunStep[];
  }>;
  result: unknown | null;
  resultSchemaVersion: string | null;
}

async function loadContext(
  tenant: string,
): Promise<ReasoningAgentContextResponse> {
  return fetchApiData<ReasoningAgentContextResponse>(
    "/v1/reasoning-agent/context",
    {
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        ...tenantHeader(),
        "x-agentic-tenant": tenant,
      },
    },
  );
}

async function loadReasoningRun(
  tenant: string,
  runId: string,
): Promise<ReasoningRunResponse> {
  const path = `/v1/reasoning-agent/runs/${encodeURIComponent(runId)}`;
  return fetchApiData<ReasoningRunResponse>(path, {
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      ...tenantHeader(),
      "x-agentic-tenant": tenant,
    },
  });
}

export const REASONING_AGENT_CONTEXT_KEYS = {
  tenant: (tenant: string) => ["reasoning-agent-context", tenant] as const,
  run: (tenant: string, runId: string) =>
    ["reasoning-agent-run", tenant, runId] as const,
};

export function useReasoningAgentContext(
  tenant: string,
): UseQueryResult<ReasoningAgentContextResponse> {
  return useQuery({
    queryKey: REASONING_AGENT_CONTEXT_KEYS.tenant(tenant),
    queryFn: () => loadContext(tenant),
    enabled: Boolean(tenant),
    staleTime: 30_000,
  });
}

/** Polls the real persisted run/step projection while a reasoning run executes. */
export function useReasoningAgentRun(
  tenant: string,
  runId: string | null,
): UseQueryResult<ReasoningRunResponse> {
  return useQuery({
    queryKey: REASONING_AGENT_CONTEXT_KEYS.run(tenant, runId ?? "__none__"),
    queryFn: () => loadReasoningRun(tenant, runId!),
    enabled: Boolean(tenant && runId),
    refetchInterval: (query) => {
      return reasoningRunPollInterval(
        query.state.data,
        query.state.error,
        query.state.fetchFailureCount,
      );
    },
    staleTime: 0,
  });
}
