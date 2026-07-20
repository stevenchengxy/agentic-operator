import type {
  TenantReasoningConfigLike,
  TenantRegistry,
} from "@agentic/agent-kit";

export interface TenantReasoningConfig {
  ontology: {
    provider: "allmeta";
    domainId: string;
  };
  allowedActions: string[] | null;
}

const configs = new Map<string, TenantReasoningConfig>();

function normalize(
  tenantSlug: string,
  raw: TenantReasoningConfigLike,
): TenantReasoningConfig {
  if (raw.ontology?.provider !== "allmeta") {
    throw new Error(
      `tenant '${tenantSlug}' Reasoning ontology provider must be 'allmeta'`,
    );
  }
  const domainId = raw.ontology.domainId?.trim();
  if (!domainId) {
    throw new Error(
      `tenant '${tenantSlug}' Reasoning ontology domainId is required`,
    );
  }
  const allowed = raw.allowedActions
    ? [...new Set(raw.allowedActions.map((value) => value.trim()).filter(Boolean))]
    : null;
  if (raw.allowedActions && !allowed?.length) {
    throw new Error(
      `tenant '${tenantSlug}' Reasoning allowedActions cannot be empty`,
    );
  }
  return {
    ontology: { provider: "allmeta", domainId },
    allowedActions: allowed,
  };
}

/** Replace the standalone Reasoning policy snapshot at runtime bootstrap. */
export function syncTenantReasoningConfigs(
  registries: Record<string, TenantRegistry | undefined>,
): void {
  configs.clear();
  for (const [tenantSlug, registry] of Object.entries(registries)) {
    if (registry?.reasoning) {
      configs.set(tenantSlug, normalize(tenantSlug, registry.reasoning));
    }
  }
}

/** Used by a tenant-code hot swap and by isolated API tests. */
export function setTenantReasoningConfig(
  tenantSlug: string,
  config: TenantReasoningConfigLike | null,
): void {
  if (!config) {
    configs.delete(tenantSlug);
    return;
  }
  configs.set(tenantSlug, normalize(tenantSlug, config));
}

export function getTenantReasoningConfig(
  tenantSlug: string,
): TenantReasoningConfig | null {
  return configs.get(tenantSlug) ?? null;
}
