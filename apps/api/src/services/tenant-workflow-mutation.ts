import { and, eq } from "drizzle-orm";
import { deployments, getDb } from "@agentic/db";
import {
  tenantRuntimeMutationResourceKey,
  withTenantRuntimeMutationLease,
  type TenantRuntimeMutationLease,
} from "./tenant-runtime-mutation";

export type TenantWorkflowMutationLease = TenantRuntimeMutationLease;

export type DeploymentLane =
  | "workflow"
  | "tenant_code"
  | "agent"
  | "runtime"
  | "code_agent";

export interface LiveDeploymentBaseline {
  deploymentId: string;
  versionId: string;
  deployedAtMs: number;
}

export class TenantWorkflowMutationConflictError extends Error {
  readonly code = "tenant_workflow_mutation_conflict";
  readonly statusCode = 409;

  constructor(
    readonly tenantId: string,
    readonly lane: DeploymentLane,
    message: string,
  ) {
    super(message);
    this.name = "TenantWorkflowMutationConflictError";
  }
}

export function tenantWorkflowMutationResourceKey(tenantId: string): string {
  return tenantRuntimeMutationResourceKey(tenantId);
}

/**
 * The single cross-process serialization boundary for mutations which can
 * change a tenant's executable workflow. Factory promotion, manifest import,
 * agent compatibility deploys, and rollback must all use this resource key.
 */
export async function withTenantWorkflowMutationLease<T>(args: {
  tenantId: string;
  kind: string;
  workId?: string | null;
  ttlMs?: number;
  waitMs?: number;
  fn: (lease: TenantWorkflowMutationLease) => Promise<T>;
}): Promise<T> {
  return withTenantRuntimeMutationLease({
    tenantId: args.tenantId,
    kind: args.kind,
    workId: args.workId ?? null,
    ttlMs: args.ttlMs,
    waitMs: args.waitMs,
    fn: args.fn,
  });
}

/** Capture the exact live deployment generation for an optimistic CAS. */
export function captureLiveDeploymentBaseline(
  tenantId: string,
  lane: DeploymentLane,
): LiveDeploymentBaseline | null {
  const rows = getDb()
    .select({
      deploymentId: deployments.id,
      versionId: deployments.versionId,
      deployedAt: deployments.deployedAt,
    })
    .from(deployments)
    .where(
      and(
        eq(deployments.tenantId, tenantId),
        eq(deployments.target, lane),
        eq(deployments.status, "live"),
      ),
    )
    .all();
  if (rows.length > 1) {
    throw new TenantWorkflowMutationConflictError(
      tenantId,
      lane,
      `tenant ${tenantId} has ${rows.length} live ${lane} deployments`,
    );
  }
  const row = rows[0];
  return row
    ? {
        deploymentId: row.deploymentId,
        versionId: row.versionId,
        deployedAtMs: row.deployedAt.getTime(),
      }
    : null;
}

function sameBaseline(
  left: LiveDeploymentBaseline | null,
  right: LiveDeploymentBaseline | null,
): boolean {
  if (!left || !right) return left === right;
  return (
    left.deploymentId === right.deploymentId &&
    left.versionId === right.versionId &&
    left.deployedAtMs === right.deployedAtMs
  );
}

/**
 * Fail closed when a writer which bypassed the shared lease changed the live
 * deployment. Call inside the same SQLite transaction as the subsequent
 * conditional status update to make the check-and-swap atomic.
 */
export function assertLiveDeploymentBaseline(
  tenantId: string,
  lane: DeploymentLane,
  expected: LiveDeploymentBaseline | null,
): void {
  const observed = captureLiveDeploymentBaseline(tenantId, lane);
  if (sameBaseline(expected, observed)) return;
  throw new TenantWorkflowMutationConflictError(
    tenantId,
    lane,
    `live ${lane} deployment changed while the operation was in progress ` +
      `(expected=${expected?.deploymentId ?? "none"}@${expected?.versionId ?? "none"}, ` +
      `observed=${observed?.deploymentId ?? "none"}@${observed?.versionId ?? "none"})`,
  );
}
