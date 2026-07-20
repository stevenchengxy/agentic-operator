import {
  withTenantWorkflowMutationLease,
  type TenantWorkflowMutationLease,
} from "../tenant-workflow-mutation";

/**
 * Backwards-compatible Agent Factory name for the shared tenant workflow
 * mutation lease. It deliberately uses the same durable resource as manifest
 * import and rollback, rather than a Factory-only mutex.
 */
export async function withFactoryTenantLock<T>(
  tenantId: string,
  fn: (lease: TenantWorkflowMutationLease) => Promise<T>,
): Promise<T> {
  return withTenantWorkflowMutationLease({
    tenantId,
    kind: "agent_factory_mutation",
    workId: tenantId,
    fn,
  });
}
