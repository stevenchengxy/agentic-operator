"use client";

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { AgentFactoryDomain } from "@/lib/domain-display";
import { tenantHeader } from "./tenant-header";

interface ApiOk<T> {
  ok: true;
  data: T;
}

interface ApiErr {
  ok: false;
  error: { code: string; message: string };
}

interface AgentFactoryDomainsResponse {
  domains: AgentFactoryDomain[];
  gatewayConfigured?: boolean;
}

async function callV1<T>(path: string): Promise<T> {
  const res = await fetch(path, {
    credentials: "same-origin",
    headers: { Accept: "application/json", ...tenantHeader() },
  });
  const body = (await res.json()) as ApiOk<T> | ApiErr;
  if (!body.ok) {
    throw new Error(`${path}: ${body.error.code} - ${body.error.message}`);
  }
  return body.data;
}

export const AGENT_FACTORY_DOMAIN_KEYS = {
  all: ["agent-factory-domains"] as const,
};

export function useAgentFactoryDomains(): UseQueryResult<AgentFactoryDomainsResponse> {
  return useQuery({
    queryKey: AGENT_FACTORY_DOMAIN_KEYS.all,
    queryFn: () =>
      callV1<AgentFactoryDomainsResponse>("/v1/agent-factory/domains"),
    staleTime: 30_000,
  });
}
