/**
 * useReasoning — TanStack Query wrappers for the 推理审计 page (W3).
 *
 * Both feeds poll (`refetchInterval`) so the page stays live as production runs
 * land new LLM turns / rule decisions, without a bespoke SSE channel.
 */
"use client";

import { useQuery } from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";
import { fetchApiData } from "@/lib/api-response";
import { tenantHeader } from "./tenant-header";

async function callV1<T>(path: string): Promise<T> {
  return fetchApiData<T>(path, {
    credentials: "same-origin",
    headers: { Accept: "application/json", ...tenantHeader() },
  });
}

export interface ReasoningTurn {
  id: string;
  runId: string;
  agentName: string | null;
  agentTitle: string | null;
  subject: string | null;
  runStatus: string;
  ord: number;
  responseText: string | null;
  reasoning: string | null;
  toolCalls: Array<{ name: string; input: unknown }>;
  provider: string | null;
  model: string | null;
  finishReason: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  latencyMs: number | null;
  createdAt: string | null;
}

export interface RuleAuditRow {
  id: string;
  name: string;
  subject: string | null;
  receivedAt: string | null;
  sourceAgentName: string | null;
  sourceAgentTitle: string | null;
  verdict: "pass" | "fail" | "neutral";
  consumerRunId: string | null;
  payload: unknown;
}

/** Recent LLM-response turns across the tenant's runs (the live 推理流 feed). */
export function useReasoning(
  opts: { agent?: string; limit?: number } = {},
): UseQueryResult<ReasoningTurn[]> {
  const sp = new URLSearchParams();
  if (opts.agent) sp.set("agent", opts.agent);
  if (opts.limit) sp.set("limit", String(opts.limit));
  const qs = sp.toString();
  return useQuery({
    queryKey: ["reasoning", "turns", opts],
    queryFn: () =>
      callV1<ReasoningTurn[]>(`/v1/reasoning${qs ? `?${qs}` : ""}`),
    refetchInterval: 5_000,
    staleTime: 2_000,
  });
}

/** Recent rule-check / gate decisions with derived verdicts (the 规则审计 lens). */
export function useRuleAudit(
  opts: { limit?: number } = {},
): UseQueryResult<RuleAuditRow[]> {
  const qs = opts.limit ? `?limit=${opts.limit}` : "";
  return useQuery({
    queryKey: ["reasoning", "audit", opts],
    queryFn: () => callV1<RuleAuditRow[]>(`/v1/reasoning/audit${qs}`),
    refetchInterval: 6_000,
    staleTime: 2_000,
  });
}
