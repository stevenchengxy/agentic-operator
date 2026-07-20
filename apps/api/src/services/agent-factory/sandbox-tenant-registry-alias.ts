/**
 * Ephemeral projection from a nonce sandbox tenant to the tenant registry the
 * candidate is intended to use after promotion.
 *
 * This is deliberately an execution-plane concern, not an Agents-generation
 * adapter: the mapping is installed from the authenticated target tenant in a
 * signed sandbox job and works for every domain/tenant registry.  It never
 * changes the target registry and is removed together with the nonce App.
 */
export interface FactorySandboxTenantRegistryAlias {
  sandboxTenantSlug: string;
  targetTenantSlug: string;
  expectedRegistryVersion?: string;
  /** Attempt-owned descriptors reconstructed from the signed bundle. This is
   * never a loaded tenant adapter; every handler is a fail-closed sentinel and
   * external calls must be intercepted by exact replay first. */
  replayRegistry?: TenantRegistry;
  installedAt: string;
}

const aliases = new Map<string, FactorySandboxTenantRegistryAlias>();

function requiredSlug(label: string, value: string): string {
  const slug = value.trim();
  if (!slug || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(slug)) {
    throw new Error(`${label} is invalid`);
  }
  return slug;
}

export function installFactorySandboxTenantRegistryAlias(input: {
  sandboxTenantSlug: string;
  targetTenantSlug: string;
  expectedRegistryVersion?: string;
  replayRegistry?: TenantRegistry;
}): FactorySandboxTenantRegistryAlias {
  const sandboxTenantSlug = requiredSlug("sandbox tenant slug", input.sandboxTenantSlug);
  const targetTenantSlug = requiredSlug("target tenant slug", input.targetTenantSlug);
  if (!sandboxTenantSlug.startsWith("af-sbx-") || !sandboxTenantSlug.endsWith("-sb")) {
    throw new Error("registry alias target is not a Factory nonce sandbox tenant");
  }
  if (sandboxTenantSlug === targetTenantSlug) {
    throw new Error("sandbox registry alias cannot target itself");
  }
  const expectedRegistryVersion = input.expectedRegistryVersion?.trim() || undefined;
  if (
    input.replayRegistry
    && (input.replayRegistry.eventAdapter
      || Object.keys(input.replayRegistry.prompts ?? {}).length > 0)
  ) {
    throw new Error("signed-bundle replay registry cannot carry prompts or an event adapter");
  }
  const existing = aliases.get(sandboxTenantSlug);
  if (existing && (
    existing.targetTenantSlug !== targetTenantSlug
    || existing.expectedRegistryVersion !== expectedRegistryVersion
    || existing.replayRegistry !== input.replayRegistry
  )) {
    throw new Error("sandbox registry alias identity drift");
  }
  const alias: FactorySandboxTenantRegistryAlias = existing ?? {
    sandboxTenantSlug,
    targetTenantSlug,
    ...(expectedRegistryVersion ? { expectedRegistryVersion } : {}),
    ...(input.replayRegistry ? { replayRegistry: input.replayRegistry } : {}),
    installedAt: new Date().toISOString(),
  };
  aliases.set(sandboxTenantSlug, alias);
  return alias;
}

export function getFactorySandboxTenantRegistryAlias(
  sandboxTenantSlug: string,
): FactorySandboxTenantRegistryAlias | undefined {
  return aliases.get(sandboxTenantSlug);
}

export function removeFactorySandboxTenantRegistryAlias(
  sandboxTenantSlug: string,
): boolean {
  return aliases.delete(sandboxTenantSlug);
}

/** Test/process shutdown helper. */
export function clearFactorySandboxTenantRegistryAliases(): void {
  aliases.clear();
}
import type { TenantRegistry } from "@agentic/agent-kit";
