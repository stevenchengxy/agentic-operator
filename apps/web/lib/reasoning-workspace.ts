const STANDALONE_REASONING_TENANTS = new Set(["raas", "zhaopin"]);

/**
 * Reasoning is a standalone workspace, not an Agent Factory capability.
 * Keep supported tenants on their own Reasoning configuration and route every
 * other workspace to the dedicated RAAS control surface.
 */
export function reasoningWorkspaceTenant(currentTenant: string): string {
  return STANDALONE_REASONING_TENANTS.has(currentTenant)
    ? currentTenant
    : "raas";
}

export function reasoningAgentHref(currentTenant: string): string {
  return `/portal/${reasoningWorkspaceTenant(currentTenant)}/reasoning-agent`;
}
