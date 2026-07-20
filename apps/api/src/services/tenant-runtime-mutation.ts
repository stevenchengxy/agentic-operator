import { withDurableLease, type DurableLeaseHandle } from "./durable-lease";

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_WAIT_MS = 30_000;

export type TenantRuntimeMutationLease = DurableLeaseHandle;

export function tenantRuntimeMutationResourceKey(tenantId: string): string {
  // Wire-compatibility key: older Factory API processes already coordinate on
  // factory-mutex. Reusing it lets rolling old/new deployments share one lock;
  // renaming requires a deliberate dual-lock migration protocol.
  return `factory-mutex:${tenantId}`;
}

/**
 * Cross-process arbitration for every operation that can rebuild or replace a
 * tenant's served runtime. Callers retain their own timeout semantics while
 * sharing one durable resource key.
 */
export async function withTenantRuntimeMutationLease<T>(args: {
  tenantId: string;
  kind: string;
  workId?: string | null;
  ttlMs?: number;
  waitMs?: number;
  fn: (lease: TenantRuntimeMutationLease) => Promise<T>;
}): Promise<T> {
  return withDurableLease({
    resourceKey: tenantRuntimeMutationResourceKey(args.tenantId),
    tenantId: args.tenantId,
    kind: args.kind,
    workId: args.workId ?? null,
    ttlMs: args.ttlMs ?? DEFAULT_TTL_MS,
    waitMs: args.waitMs ?? DEFAULT_WAIT_MS,
    fn: args.fn,
  });
}
