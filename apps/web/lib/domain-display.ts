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

const VERSION_SUFFIX_RE = /-v\d+(?:\.\d+)*$/i;

const DOMAIN_SLUG_ALIASES = new Map<string, string>([
  ["raas-v1", "zhaopin"],
  ["招聘", "zhaopin"],
  ["招聘-v1", "zhaopin"],
]);

export function runtimeDomainSlug(id: string): string {
  const normalized = id.trim().toLowerCase().normalize("NFKC");
  const withoutVersion = normalized.replace(VERSION_SUFFIX_RE, "");
  return (
    DOMAIN_SLUG_ALIASES.get(normalized) ??
    DOMAIN_SLUG_ALIASES.get(withoutVersion) ??
    withoutVersion
  );
}

export function domainLabel(domain: AgentFactoryDomain): string {
  return domain.name?.trim() || domain.id;
}

function aliasedDomainSlug(value: string): string | null {
  const normalized = value.trim().toLowerCase().normalize("NFKC");
  const withoutVersion = normalized.replace(VERSION_SUFFIX_RE, "");
  return (
    DOMAIN_SLUG_ALIASES.get(normalized) ??
    DOMAIN_SLUG_ALIASES.get(withoutVersion) ??
    null
  );
}

function runtimeDomainSlugForDomain(domain: AgentFactoryDomain): string {
  const labelAlias = aliasedDomainSlug(domainLabel(domain));
  return labelAlias ?? runtimeDomainSlug(domain.id);
}

function labelScore(label: string, slug: string): number {
  const normalized = label.trim().toLowerCase().normalize("NFKC");
  let score = 0;
  if (normalized === "raas-v1") score += 10;
  if (VERSION_SUFFIX_RE.test(normalized)) score += 3;
  if (/[\u3400-\u9fff]/.test(label)) score += 3;
  if (normalized !== slug) score += 1;
  return score;
}

export function buildRuntimeDomainNameMap(
  domains: AgentFactoryDomain[] | undefined,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const domain of domains ?? []) {
    const slug = runtimeDomainSlugForDomain(domain);
    const label = domainLabel(domain);
    const existing = out.get(slug);
    if (!existing || labelScore(label, slug) > labelScore(existing, slug)) {
      out.set(slug, label);
    }
  }
  return out;
}

export function buildRuntimeDomainSlugSet(
  domains: AgentFactoryDomain[] | undefined,
): Set<string> {
  return new Set(
    (domains ?? []).map((domain) => runtimeDomainSlugForDomain(domain)),
  );
}

export function displayRuntimeDomainName(
  domain: RuntimeDomainLike,
  domainNames?: Map<string, string>,
): string {
  return domainNames?.get(domain.slug.toLowerCase()) ?? domain.name;
}

export function isInternalRuntimeDomain(slug: string): boolean {
  const s = slug.toLowerCase();
  return s === "__system" || s === "system" || s.endsWith("-sb");
}

export function isVisibleRuntimeDomain(
  domain: RuntimeDomainLike,
  domainSlugs?: Set<string>,
): boolean {
  const slug = domain.slug.toLowerCase();
  if (isInternalRuntimeDomain(slug)) return false;
  return Boolean(domainSlugs?.has(slug) || (domain.agentCount ?? 0) > 0);
}
