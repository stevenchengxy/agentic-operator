/**
 * useAgents — TanStack Query wrappers around `/v1/agents` and
 * `/v1/agents/:kebab`, plus `/v1/counts` and `/v1/workflows/dag`.
 *
 * The agent set rarely mutates outside of a deploy, so we let cache age more
 * gracefully than runs/events. The dashboard counts ride alongside since
 * they're refreshed by the same SSE events (run.*, event.emitted, task.*).
 */
"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";
import type { AgentSpec } from "@agentic/contracts";
import { AGENT_KEYS, COUNT_KEYS } from "./useStream";
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

export interface AgentListRow {
  id: string;
  kebabId: string;
  name: string;
  title: string;
  description: string | null;
  actor: "Agent" | "Human";
  kind: "code" | "manifest";
  enabled: boolean;
  runCount: number;
  errorCount: number;
  lastRunAt: string | null;
}

export interface AgentDetail {
  id: string;
  kebabId: string;
  name: string;
  title: string;
  actor: "Agent" | "Human";
  triggers: string[];
  triggeredEvents: string[];
  actions: Array<{
    order: string;
    name: string;
    type: string;
    description?: string;
  }>;
  workflowSlug: string;
  workflowVersion: string;
  recentRuns: Array<{
    id: string;
    status: string;
    subject: string | null;
    startedAt: string | null;
    durationMs: number | null;
  }>;
}

export interface TenantCounts {
  agents: number;
  runningRuns: number;
  okRuns24h: number;
  failedRuns24h: number;
  events24h: number;
  openTasks: number;
  totalRuns: number;
}

export interface DagAgent {
  id: string;
  kebabId: string;
  name: string;
  title: string;
  actor: "Agent" | "Human";
  triggers: string[];
  emits: string[];
  stage: number;
  recentRunCount: number;
  isLive: boolean;
  definition?: AgentSpec;
  position?: { x: number; y: number };
}

export interface DagPayload {
  agents: DagAgent[];
  edges: Array<{
    fromAgent: string;
    toAgent: string;
    event: string;
    active: boolean;
  }>;
  workflowVersion: string;
  workflowVersionId: string | null;
  workflowSlug: string | null;
  workflowName: string | null;
  workflowIsLive: boolean;
}

export function useAgents(opts?: {
  kind?: "code" | "manifest" | "all";
}): UseQueryResult<AgentListRow[]> {
  const kind = opts?.kind ?? "all";
  return useQuery({
    queryKey: [...AGENT_KEYS.list, kind] as const,
    queryFn: () => callV1<AgentListRow[]>(`/v1/agents?kind=${kind}`),
    staleTime: 5_000,
  });
}

export function useAgent(
  kebab: string | null | undefined,
): UseQueryResult<AgentDetail> {
  return useQuery({
    queryKey: kebab
      ? AGENT_KEYS.detail(kebab)
      : (["agents", "detail", "__none__"] as const),
    queryFn: () =>
      callV1<AgentDetail>(`/v1/agents/${encodeURIComponent(kebab!)}`),
    enabled: Boolean(kebab),
  });
}

export function useCounts(): UseQueryResult<TenantCounts> {
  return useQuery({
    queryKey: COUNT_KEYS.tenant,
    queryFn: () => callV1<TenantCounts>("/v1/counts"),
    staleTime: 2_000,
  });
}

export function useDag(
  workflowSlug?: string | null,
): UseQueryResult<DagPayload> {
  const query = workflowSlug
    ? `?workflow=${encodeURIComponent(workflowSlug)}`
    : "";
  return useQuery({
    queryKey: ["workflows", "dag", workflowSlug ?? "__live__"] as const,
    queryFn: () => callV1<DagPayload>(`/v1/workflows/dag${query}`),
    staleTime: 5_000,
  });
}

/** Invoke an agent: `POST /v1/agents/:name/invoke`. */
export function useInvokeAgent() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      name: string;
      input?: unknown;
      async?: boolean;
      testRun?: boolean;
    }) => {
      const sp = new URLSearchParams();
      if (vars.async) sp.set("async", "1");
      if (vars.testRun) sp.set("testRun", "1");
      const qs = sp.toString();
      const path = `/v1/agents/${encodeURIComponent(vars.name)}/invoke${qs ? `?${qs}` : ""}`;
      // The route returns one of two shapes:
      //   * code-agent (sync):  { runId, status: 'ok'|'failed', output, ... }
      //   * manifest fallback:  { kind: 'manifest', status: 'queued', eventId, eventName, correlationId, ... }
      // Both are typed here so callers can branch without `as` casts.
      return callV1<{
        runId?: string;
        run_id?: string;
        result?: unknown;
        status?: string;
        kind?: "code" | "manifest";
        eventId?: string;
        eventName?: string;
        subject?: string;
        correlationId?: string;
      }>(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: vars.input ?? {} }),
      });
    },
    onSettled: () => {
      // A successful invoke creates a run. Touch the run list + counts so
      // dashboards reflect the new state. SSE `run.started` will then push.
      void client.invalidateQueries({ queryKey: ["runs"] as const });
      void client.invalidateQueries({ queryKey: COUNT_KEYS.tenant });
    },
  });
}
