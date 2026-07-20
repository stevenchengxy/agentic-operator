import { and, eq, isNull } from "drizzle-orm";
import { auditLog, getDb, tenants } from "@agentic/db";
import { publishStreamEvent } from "@agentic/runtime";
import { makeId } from "@agentic/shared";
import { DurableLeaseBusyError } from "./durable-lease";
import { withTenantRuntimeMutationLease } from "./tenant-runtime-mutation";

export type TenantLifecycleAction = "archive" | "restore";

export class TenantLifecycleError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "TenantLifecycleError";
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function publishAudit(args: {
  id: string;
  tenantId: string;
  at: Date;
  action: string;
  actorUserId: string | null;
}): void {
  try {
    publishStreamEvent({
      type: "audit.recorded",
      tenantId: args.tenantId,
      at: args.at.getTime(),
      auditId: args.id,
      action: args.action,
      actorUserId: args.actorUserId,
      targetType: "tenant",
      targetId: args.tenantId,
      decision: null,
    });
  } catch {
    // The audit row is durable; SSE delivery is intentionally best effort.
  }
}

/**
 * Apply a tenant archive/restore as a compensated external-state transition.
 *
 * SQLite state + the success audit are committed atomically, then the real
 * Inngest registry/control plane is rebuilt. If that hand-off fails, both the
 * database state and in-process/broker registration are restored to their
 * exact prior state before an error is returned. A durable resource lease
 * prevents archive/restore races across multiple API processes.
 */
export async function transitionTenantLifecycle(
  args: {
    tenantId: string;
    slug: string;
    action: TenantLifecycleAction;
    actorUserId: string | null;
    callerSlug: string;
    reason?: string | null;
  },
  syncRuntime: (slug: string) => Promise<unknown>,
): Promise<{ changedAt: Date }> {
  try {
    return await withTenantRuntimeMutationLease({
      tenantId: args.tenantId,
      kind: "tenant_lifecycle",
      workId: `${args.action}:${args.slug}`,
      ttlMs: 2 * 60 * 1000,
      waitMs: 0,
      fn: async (lease) => {
        lease.assertOwned();
        const db = getDb();
        const before = db
          .select()
          .from(tenants)
          .where(
            and(eq(tenants.id, args.tenantId), eq(tenants.slug, args.slug)),
          )
          .all()[0];
        if (!before) {
          throw new TenantLifecycleError(
            "tenant_not_found",
            `no tenant with slug "${args.slug}"`,
            404,
          );
        }
        if (args.action === "archive" && before.archivedAt) {
          throw new TenantLifecycleError(
            "already_archived",
            `domain "${args.slug}" is already deleted`,
            409,
          );
        }
        if (args.action === "restore" && !before.archivedAt) {
          throw new TenantLifecycleError(
            "not_archived",
            `tenant "${args.slug}" is not archived`,
            409,
          );
        }

        const changedAt = new Date();
        const successAuditId = makeId("aud");
        const successAction = `tenant.${args.action}`;
        const targetArchivedAt = args.action === "archive" ? changedAt : null;

        db.transaction((tx) => {
          const expected =
            args.action === "archive"
              ? and(eq(tenants.id, before.id), isNull(tenants.archivedAt))
              : and(
                  eq(tenants.id, before.id),
                  eq(tenants.archivedAt, before.archivedAt!),
                );
          const updated = tx
            .update(tenants)
            .set({ archivedAt: targetArchivedAt, updatedAt: changedAt })
            .where(expected)
            .run() as { changes?: number };
          if ((updated.changes ?? 0) !== 1) {
            throw new TenantLifecycleError(
              "tenant_state_changed",
              `tenant "${args.slug}" changed while ${args.action} was starting`,
              409,
            );
          }
          tx.insert(auditLog)
            .values({
              id: successAuditId,
              tenantId: before.id,
              actorUserId: args.actorUserId,
              action: successAction,
              targetType: "tenant",
              targetId: before.id,
              at: changedAt,
              metaJson: {
                slug: args.slug,
                reason: args.reason ?? null,
                by_tenant: args.callerSlug,
              } as never,
            })
            .run();
        });
        lease.assertOwned();

        try {
          lease.assertOwned();
          await syncRuntime(args.slug);
          lease.assertOwned();
        } catch (syncError) {
          const compensationErrors: Error[] = [
            syncError instanceof Error
              ? syncError
              : new Error(String(syncError)),
          ];
          let databaseRestored = false;
          let runtimeRestored = false;
          let failureAuditId: string | null = null;
          let failureAuditAt: Date | null = null;

          try {
            // Compensation is guarded by the exact archivedAt CAS below, so
            // it remains safe and necessary even if the runtime lease was
            // lost after the forward DB transition.
            db.transaction((tx) => {
              const targetPredicate = targetArchivedAt
                ? eq(tenants.archivedAt, targetArchivedAt)
                : isNull(tenants.archivedAt);
              const reverted = tx
                .update(tenants)
                .set({
                  archivedAt: before.archivedAt,
                  updatedAt: before.updatedAt,
                })
                .where(and(eq(tenants.id, before.id), targetPredicate))
                .run() as { changes?: number };
              if ((reverted.changes ?? 0) !== 1) {
                throw new Error(
                  `tenant ${args.slug} lifecycle compensation lost its state compare-and-swap`,
                );
              }
              tx.delete(auditLog).where(eq(auditLog.id, successAuditId)).run();
            });
            databaseRestored = true;
          } catch (error) {
            compensationErrors.push(
              error instanceof Error ? error : new Error(String(error)),
            );
          }

          if (databaseRestored) {
            try {
              // Rebuild from the restored DB row. This repairs both the local
              // registry (which may already have swapped) and broker state.
              await syncRuntime(args.slug);
              runtimeRestored = true;
            } catch (error) {
              compensationErrors.push(
                error instanceof Error ? error : new Error(String(error)),
              );
            }
          }

          try {
            failureAuditId = makeId("aud");
            failureAuditAt = new Date();
            db.insert(auditLog)
              .values({
                id: failureAuditId,
                tenantId: before.id,
                actorUserId: args.actorUserId,
                action: `${successAction}.failed`,
                targetType: "tenant",
                targetId: before.id,
                at: failureAuditAt,
                metaJson: {
                  slug: args.slug,
                  reason: args.reason ?? null,
                  by_tenant: args.callerSlug,
                  error: message(syncError),
                  database_restored: databaseRestored,
                  runtime_restored: runtimeRestored,
                } as never,
              })
              .run();
          } catch (error) {
            compensationErrors.push(
              error instanceof Error ? error : new Error(String(error)),
            );
          }
          if (failureAuditId && failureAuditAt) {
            publishAudit({
              id: failureAuditId,
              tenantId: before.id,
              at: failureAuditAt,
              action: `${successAction}.failed`,
              actorUserId: args.actorUserId,
            });
          }

          const compensated =
            databaseRestored && runtimeRestored && failureAuditId !== null;
          throw new TenantLifecycleError(
            compensated
              ? "inngest_sync_failed"
              : "tenant_lifecycle_compensation_failed",
            compensated
              ? `${successAction} was not completed because Inngest rejected the change; the prior tenant state was restored`
              : `${successAction} failed and compensation was incomplete; operator intervention is required`,
            compensated ? 503 : 500,
            { cause: new AggregateError(compensationErrors) },
          );
        }

        publishAudit({
          id: successAuditId,
          tenantId: before.id,
          at: changedAt,
          action: successAction,
          actorUserId: args.actorUserId,
        });
        return { changedAt };
      },
    });
  } catch (error) {
    if (error instanceof DurableLeaseBusyError) {
      throw new TenantLifecycleError(
        "tenant_lifecycle_busy",
        `tenant "${args.slug}" already has an archive/restore operation in progress`,
        409,
        { cause: error },
      );
    }
    throw error;
  }
}
