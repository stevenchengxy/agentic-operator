"use client";

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { AgentFactoryDomain } from "@/lib/domain-display";
import { fetchApiData } from "@/lib/api-response";
import { tenantHeader } from "./tenant-header";

export interface FactoryDomainBinding {
  tenantId: string;
  ontologyDomainId: string;
  ontologyDomainName: string | null;
  source: "explicit" | "auto" | "upload";
  createdAt: string;
  updatedAt: string;
}

export interface AgentFactoryDomainsResponse {
  domains: AgentFactoryDomain[];
  binding: FactoryDomainBinding | null;
  boundDomain: AgentFactoryDomain | null;
  boundActions: Array<{
    id: string;
    name: string;
    description: string | null;
    actor: string[];
  }>;
  gatewayConfigured?: boolean;
}

async function callV1<T>(path: string, tenant?: string): Promise<T> {
  return fetchApiData<T>(path, {
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      ...tenantHeader(),
      ...(tenant ? { "x-agentic-tenant": tenant } : {}),
    },
  });
}

export const AGENT_FACTORY_DOMAIN_KEYS = {
  all: ["agent-factory-domains"] as const,
  tenant: (tenant: string) => ["agent-factory-domains", tenant] as const,
};

export function useAgentFactoryDomains(
  tenant: string,
): UseQueryResult<AgentFactoryDomainsResponse> {
  return useQuery({
    // A binding belongs to one runtime tenant. A global cache key could show
    // tenant A's bound ontology while the operator is already viewing B.
    queryKey: AGENT_FACTORY_DOMAIN_KEYS.tenant(tenant),
    queryFn: () =>
      callV1<AgentFactoryDomainsResponse>("/v1/agent-factory/domains", tenant),
    enabled: Boolean(tenant),
    staleTime: 30_000,
  });
}
