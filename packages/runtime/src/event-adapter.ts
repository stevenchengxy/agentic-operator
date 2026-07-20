import type {
  TenantEventAdapter,
  TenantInboundEvent,
  TenantOutboundEvent,
  TenantRegistry,
} from "@agentic/agent-kit";

/**
 * Default wire contract for every tenant that does not opt into a transport
 * adapter. Returning the original objects preserves the historical identity
 * semantics (including object identity) and avoids an unnecessary copy.
 */
export const identityTenantEventAdapter: TenantEventAdapter = Object.freeze({
  name: "identity",
  inbound: (input: TenantInboundEvent) => input.data,
  outbound: (input: TenantOutboundEvent) => input.payload,
});

/** Resolve a direct registration override, then the tenant package, then identity. */
export function resolveTenantEventAdapter(input: {
  eventAdapter?: TenantEventAdapter;
  tenantRegistry?: TenantRegistry;
}): TenantEventAdapter {
  return (
    input.eventAdapter ??
    input.tenantRegistry?.eventAdapter ??
    identityTenantEventAdapter
  );
}
