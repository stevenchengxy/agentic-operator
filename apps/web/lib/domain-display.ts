"use client";

export interface AgentFactoryDomain {
  id: string;
  name?: string | null;
  source?: string;
  counts?: {
    actions?: number;
    events?: number;
    objects?: number;
    rules?: number;
    workflow?: number;
  };
}

export interface RuntimeDomainLike {
  slug: string;
  name: string;
  archivedAt?: number | null;
  agentCount?: number | null;
}

export function domainLabel(domain: AgentFactoryDomain): string {
  return domain.name?.trim() || domain.id;
}

export function isInternalRuntimeDomain(slug: string): boolean {
  const s = slug.toLowerCase();
  return s === "__system" || s === "system" || s.endsWith("-sb");
}

export function isVisibleRuntimeDomain(
  domain: RuntimeDomainLike,
): boolean {
  const slug = domain.slug.toLowerCase();
  if (isInternalRuntimeDomain(slug)) return false;
  // A runtime tenant is a real isolation boundary even before its first agent
  // exists and even when no ontology has been connected yet.
  return true;
}
