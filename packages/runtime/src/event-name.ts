/** Resolve canonical event names onto a tenant-owned Inngest wire contract. */

import type { TenantEventAdapter } from "@agentic/agent-kit";
import { identityTenantEventAdapter } from "./event-adapter";

/**
 * Last-good adapters used by transport producers that do not hold a registry
 * object themselves (HTTP routes, recovery workers, etc). A bootstrap builds
 * functions with an explicit candidate adapter and commits it here only after
 * the complete tenant bootstrap succeeds.
 */
const activeTenantEventAdapters = new Map<string, TenantEventAdapter>();

export type TenantEventAdapterState = ReadonlyMap<string, TenantEventAdapter>;

/** Canonical internal event consumed by an agent whose only trigger is its
 * manifest schedule. Scheduler and registrar must share this exact name or a
 * cron function can successfully emit into an event nobody consumes. */
export function scheduledAgentTriggerName(agentName: string): string {
  return `__schedule.${agentName}`;
}

/** Strip only this tenant's prefix; never reinterpret another tenant's name. */
export function bareTenantEventName(
  tenantSlug: string,
  eventName: string,
): string {
  const prefix = `${tenantSlug}/`;
  return eventName.startsWith(prefix)
    ? eventName.slice(prefix.length)
    : eventName;
}

/**
 * Publish the adapter belonging to a successfully bootstrapped tenant. This
 * is deliberately a commit operation: callers must never publish a candidate
 * before manifest/function/schedule validation has completed.
 */
export function commitTenantEventAdapter(
  tenantSlug: string,
  eventAdapter?: TenantEventAdapter,
): void {
  const slug = tenantSlug.trim();
  if (!slug) throw new Error("tenant event adapter requires a tenant slug");
  activeTenantEventAdapters.set(
    slug,
    eventAdapter ?? identityTenantEventAdapter,
  );
}

/** Last-good adapter currently serving transport producers for this tenant. */
export function currentTenantEventAdapter(
  tenantSlug: string,
): TenantEventAdapter {
  return (
    activeTenantEventAdapters.get(tenantSlug) ?? identityTenantEventAdapter
  );
}

/** Capture/restore form one transaction boundary around an Inngest hot swap. */
export function captureTenantEventAdapterState(): TenantEventAdapterState {
  return new Map(activeTenantEventAdapters);
}

export function restoreTenantEventAdapterState(
  state: TenantEventAdapterState,
): void {
  activeTenantEventAdapters.clear();
  for (const [slug, adapter] of state) {
    activeTenantEventAdapters.set(slug, adapter);
  }
}

/** Test isolation only. Production callers replace adapters via commit. */
export function __resetTenantEventAdaptersForTests(): void {
  activeTenantEventAdapters.clear();
}

/** Event name to register/send on Inngest for this tenant. */
export function tenantEventName(
  tenantSlug: string,
  eventName: string,
  eventAdapter?: TenantEventAdapter,
): string {
  const adapter = eventAdapter ?? currentTenantEventAdapter(tenantSlug);
  if (adapter.wireEventName) {
    const adapted = adapter.wireEventName({ tenantSlug, eventName }).trim();
    if (!adapted) {
      throw new Error(
        `tenant event adapter ${adapter.name ?? "<unnamed>"} returned an empty wire event name`,
      );
    }
    return adapted;
  }
  // Preserve an already-qualified name (including platform/system events).
  return eventName.includes("/") ? eventName : `${tenantSlug}/${eventName}`;
}

/** Stable Inngest function id for a manifest agent. */
export function tenantFunctionId(
  tenantSlug: string,
  agentName: string,
  eventAdapter?: TenantEventAdapter,
): string {
  const adapted = eventAdapter?.functionId?.({ tenantSlug, agentName });
  if (typeof adapted === "string" && adapted.trim()) return adapted.trim();
  return `${tenantSlug}.${agentName}`;
}
