/**
 * P3-API-01 — `POST /v1/tenants/:slug/code`.
 *
 * Accepts a gzipped tarball of a tenant package, lands it under
 * `data/tenants/<slug>/<version>/`, writes a `deployments` row, and re-
 * registers Inngest functions for the affected tenant via the dynamic
 * re-register hook (P3-API-03).
 *
 * Request shape (JSON, base64 tar):
 *   POST /v1/tenants/raas/code
 *   Content-Type: application/json
 *   {
 *     "version": "0.1.1",
 *     "tarballBase64": "<base64-encoded .tar.gz>",
 *     "note": "<optional changelog>"
 *   }
 *
 * Atomicity:
 *   1. Strictly decode and validate the bounded gzip/ustar in memory.
 *   2. Extract to a hidden sibling directory; fsync every file/directory.
 *   3. fs.rename(tmpDir → finalDir), then fsync the containing directory.
 *   4. Atomically create workflow/version/deployment rows and flip the prior
 *      live pointer to `rolled_back`.
 *   5. Rebuild and broker-sync Inngest. Any failure restores DB, disk and the
 *      last-good runtime before the error reaches the caller.
 *
 * Errors:
 *   - `tarball_invalid` (400) — base64 decode failed or tar contained no
 *     `agentic.json`.
 *   - `version_exists` (409) — the target dir already contains a release of
 *     this version (refuse to overwrite — bump the version string).
 *   - `slug_unknown` (404) — no tenant row matches the slug.
 *
 * Normal historical rollback uses `POST /v1/deployments/:id/rollback`.
 * A multi-part deploy can compensate its just-created live upload with
 * `DELETE /v1/tenants/:slug/code/:deploymentId` plus exact `confirmVersion`.
 */

import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import crypto from "node:crypto";
import zlib from "node:zlib";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import {
  deployments,
  getDb,
  tenants,
  workflows,
  workflowVersions,
} from "@agentic/db";
import { makeId } from "@agentic/shared";
import {
  dataTenantsRoot,
  loadTenant,
  publishStreamEvent,
} from "@agentic/runtime";
import { requirePermission } from "../../plugins/rbac";
import { writeAudit } from "../../plugins/audit";
import { reregisterInngest } from "../../services/inngest-registry";
import { syncTenantApp } from "../../services/inngest-sync";
import { withTenantRollbackLock } from "../../services/deployment-rollback";

const TENANT_CODE_WORKFLOW_SLUG = "__tenant_code__";

/**
 * Tenant packages are source bundles, not dependency/vendor archives. These
 * limits bound memory, CPU and inode consumption even when the global Fastify
 * body limit is raised for a particular deployment.
 */
export const TENANT_CODE_ARCHIVE_LIMITS = Object.freeze({
  compressedBytes: 8 * 1024 * 1024,
  uncompressedBytes: 32 * 1024 * 1024,
  singleFileBytes: 8 * 1024 * 1024,
  totalFileBytes: 24 * 1024 * 1024,
  entries: 4_096,
  files: 2_048,
  pathBytes: 1_024,
});

const MAX_BASE64_CHARS =
  Math.ceil(TENANT_CODE_ARCHIVE_LIMITS.compressedBytes / 3) * 4;
const UPLOAD_JSON_BODY_LIMIT = MAX_BASE64_CHARS + 4_096;

const UploadBody = z
  .object({
    version: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9._-]+$/, "version must be alnum/./_/-"),
    tarballBase64: z.string().min(1).max(MAX_BASE64_CHARS),
    note: z.string().max(1024).optional(),
  })
  .strict();

const RemoveBody = z
  .object({
    confirmVersion: z.string().min(1).max(64),
  })
  .strict();

const TenantPackageManifest = z
  .object({
    slug: z.string().min(1),
    code: z
      .object({ registry: z.string().min(1).optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

export async function tenantCodeRoutes(app: FastifyInstance) {
  app.post<{ Params: { slug: string } }>(
    "/tenants/:slug/code",
    { bodyLimit: UPLOAD_JSON_BODY_LIMIT },
    async (req, reply) => {
      const auth = requirePermission(req, "deployments.write");
      const slug = req.params.slug;
      if (auth.tenantSlug !== slug) {
        return reply.fail(
          "forbidden",
          `auth tenant=${auth.tenantSlug} cannot deploy code for slug=${slug}`,
          403,
        );
      }

      const body = UploadBody.safeParse(req.body);
      if (!body.success) {
        return reply.fail(
          "bad_request",
          `invalid tenant-code upload: ${body.error.issues
            .slice(0, 3)
            .map(
              (issue) => `${issue.path.join(".") || "body"}: ${issue.message}`,
            )
            .join("; ")}`,
          400,
        );
      }
      const parsed = body.data;
      const db = getDb();

      const tenant = db
        .select()
        .from(tenants)
        .where(eq(tenants.slug, slug))
        .all()[0];
      if (!tenant) {
        return reply.fail("slug_unknown", `tenant slug=${slug} not found`, 404);
      }

      let archiveEntries: TarEntry[];
      try {
        const raw = await decodeTenantCodeArchive(parsed.tarballBase64);
        archiveEntries = parseTenantCodeTarball(raw);
        if (
          archiveEntries.filter((entry) => entry.kind === "file").length === 0
        ) {
          throw new TenantCodeArchiveError("tarball contained no files");
        }
        const manifest = archiveEntries.find(
          (entry): entry is TarFileEntry =>
            entry.kind === "file" && entry.path === "agentic.json",
        );
        if (!manifest) {
          throw new TenantCodeArchiveError(
            "tarball missing regular file agentic.json at the root",
          );
        }
        validateTenantPackageManifest(manifest.content, slug, archiveEntries);
      } catch (error) {
        if (error instanceof TenantCodeArchiveError) {
          return reply.fail("tarball_invalid", error.message, 400);
        }
        throw error;
      }

      return withTenantRollbackLock(tenant.id, async () => {
        const finalDir = path.join(dataTenantsRoot(), slug, parsed.version);
        if (existsSync(finalDir)) {
          return reply.fail(
            "version_exists",
            `version ${parsed.version} already exists for tenant ${slug}; bump and retry`,
            409,
          );
        }
        const existingCodeWorkflow = db
          .select({ id: workflows.id })
          .from(workflows)
          .where(
            and(
              eq(workflows.tenantId, tenant.id),
              eq(workflows.slug, TENANT_CODE_WORKFLOW_SLUG),
            ),
          )
          .all()[0];
        if (
          existingCodeWorkflow &&
          db
            .select({ id: workflowVersions.id })
            .from(workflowVersions)
            .where(
              and(
                eq(workflowVersions.workflowId, existingCodeWorkflow.id),
                eq(workflowVersions.version, parsed.version),
              ),
            )
            .all()[0]
        ) {
          return reply.fail(
            "version_exists",
            `version ${parsed.version} already exists in tenant ${slug} deployment history; bump and retry`,
            409,
          );
        }

        const tmpDir = path.join(
          dataTenantsRoot(),
          slug,
          `.tmp-${parsed.version}-${crypto.randomBytes(8).toString("hex")}`,
        );
        try {
          await stageArchiveDurably(tmpDir, finalDir, archiveEntries);
        } catch (error) {
          let cleanupError: unknown = null;
          try {
            await removeDirectoryDurably(tmpDir);
          } catch (failure) {
            cleanupError = failure;
          }
          writeAudit({
            tenantId: tenant.id,
            actorUserId: auth.userId ?? undefined,
            action: "tenant.code.upload.failed",
            targetType: "tenant_code_version",
            targetId: parsed.version,
            meta: {
              slug,
              version: parsed.version,
              phase: "durable_extract",
              error: errorMessage(error),
              cleanup_ok: cleanupError === null,
              cleanup_error: cleanupError ? errorMessage(cleanupError) : null,
            },
          });
          if (cleanupError) {
            throw new AggregateError(
              [error, cleanupError],
              "tenant-code extraction and staging cleanup both failed",
            );
          }
          throw error;
        }

        // The tree is fully fsynced and atomically published before its live
        // database pointer is created. Disk failures remain server errors.
        // ── DB rows: workflow + workflow_version + deployment ───────────
        const dplId = makeId("dpl");
        let controlPlane: {
          priorLane: Array<{
            id: string;
            status: "pending" | "live" | "rolled_back";
          }>;
          createdWorkflow: boolean;
          createdWorkflowVersion: boolean;
          codeWorkflow: typeof workflows.$inferSelect;
          wfv: typeof workflowVersions.$inferSelect;
        };
        try {
          controlPlane = db.transaction((tx) => {
            const priorLane = tx
              .select({ id: deployments.id, status: deployments.status })
              .from(deployments)
              .where(
                and(
                  eq(deployments.tenantId, tenant.id),
                  eq(deployments.target, "tenant_code"),
                ),
              )
              .all();

            let createdWorkflow = false;
            let codeWorkflow = tx
              .select()
              .from(workflows)
              .where(
                and(
                  eq(workflows.tenantId, tenant.id),
                  eq(workflows.slug, TENANT_CODE_WORKFLOW_SLUG),
                ),
              )
              .all()[0];
            if (!codeWorkflow) {
              const workflowId = makeId("wf");
              tx.insert(workflows)
                .values({
                  id: workflowId,
                  tenantId: tenant.id,
                  slug: TENANT_CODE_WORKFLOW_SLUG,
                  name: `${slug} (tenant code)`,
                })
                .run();
              codeWorkflow = tx
                .select()
                .from(workflows)
                .where(eq(workflows.id, workflowId))
                .all()[0]!;
              createdWorkflow = true;
            }

            const existingWorkflowVersion = tx
              .select()
              .from(workflowVersions)
              .where(
                and(
                  eq(workflowVersions.workflowId, codeWorkflow.id),
                  eq(workflowVersions.version, parsed.version),
                ),
              )
              .all()[0];
            if (existingWorkflowVersion) {
              throw new Error(
                `tenant-code version ${parsed.version} was created concurrently`,
              );
            }
            const workflowVersionId = makeId("wfv");
            tx.insert(workflowVersions)
              .values({
                id: workflowVersionId,
                workflowId: codeWorkflow.id,
                version: parsed.version,
                manifestJson: {
                  kind: "tenant_code",
                  slug,
                  version: parsed.version,
                } as unknown as object,
                actionsJson: null,
              })
              .run();
            const wfv = tx
              .select()
              .from(workflowVersions)
              .where(eq(workflowVersions.id, workflowVersionId))
              .all()[0]!;

            tx.update(deployments)
              .set({ status: "rolled_back" })
              .where(
                and(
                  eq(deployments.tenantId, tenant.id),
                  eq(deployments.target, "tenant_code"),
                  eq(deployments.status, "live"),
                ),
              )
              .run();
            tx.insert(deployments)
              .values({
                id: dplId,
                tenantId: tenant.id,
                target: "tenant_code",
                versionId: wfv.id,
                status: "live",
                note: parsed.note ?? null,
              })
              .run();
            return {
              priorLane,
              createdWorkflow,
              createdWorkflowVersion: true,
              codeWorkflow,
              wfv,
            };
          });
        } catch (error) {
          let cleanupError: unknown = null;
          try {
            await removeDirectoryDurably(finalDir);
          } catch (failure) {
            cleanupError = failure;
          }
          writeAudit({
            tenantId: tenant.id,
            actorUserId: auth.userId ?? undefined,
            action: "tenant.code.upload.failed",
            targetType: "deployment",
            targetId: dplId,
            meta: {
              slug,
              version: parsed.version,
              phase: "database_commit",
              error: errorMessage(error),
              recovery_ok: cleanupError === null,
              recovery_error: cleanupError ? errorMessage(cleanupError) : null,
            },
          });
          if (cleanupError) {
            throw new AggregateError(
              [error, cleanupError],
              "tenant-code database commit and staged-file cleanup both failed",
            );
          }
          throw error;
        }
        const {
          priorLane,
          createdWorkflow,
          createdWorkflowVersion,
          codeWorkflow,
          wfv,
        } = controlPlane;

        // ── 4. Hot-swap and broker-sync Inngest functions for this tenant ──
        let reregister: Awaited<ReturnType<typeof reregisterInngest>>;
        try {
          reregister = await reregisterInngest({
            tenantSlug: slug,
            scope: "tenant",
          });
          const synchronized = await syncTenantApp(slug, {
            info: (message) => req.log.info({ tenantSlug: slug }, message),
            warn: (message) => req.log.warn({ tenantSlug: slug }, message),
          });
          if (!synchronized.ok) {
            throw new Error(
              `Inngest rejected tenant-code app sync${synchronized.status ? ` (${synchronized.status})` : ""}: ${synchronized.error ?? "unknown error"}`,
            );
          }
        } catch (error) {
          let recoveryError: unknown = null;
          try {
            db.transaction((tx) => {
              tx.delete(deployments).where(eq(deployments.id, dplId)).run();
              tx.update(deployments)
                .set({ status: "rolled_back" })
                .where(
                  and(
                    eq(deployments.tenantId, tenant.id),
                    eq(deployments.target, "tenant_code"),
                  ),
                )
                .run();
              for (const prior of priorLane) {
                tx.update(deployments)
                  .set({ status: prior.status })
                  .where(eq(deployments.id, prior.id))
                  .run();
              }
              if (createdWorkflowVersion) {
                tx.delete(workflowVersions)
                  .where(eq(workflowVersions.id, wfv.id))
                  .run();
              }
              if (createdWorkflow) {
                tx.delete(workflows)
                  .where(eq(workflows.id, codeWorkflow.id))
                  .run();
              }
            });
            await removeDirectoryDurably(finalDir);
            await reregisterInngest({ tenantSlug: slug, scope: "tenant" });
            const restored = await syncTenantApp(slug);
            if (!restored.ok) {
              throw new Error(
                `Inngest rejected restored tenant-code app sync${restored.status ? ` (${restored.status})` : ""}: ${restored.error ?? "unknown error"}`,
              );
            }
          } catch (failure) {
            recoveryError = failure;
          }
          writeAudit({
            tenantId: tenant.id,
            actorUserId: auth.userId ?? undefined,
            action: "tenant.code.upload.failed",
            targetType: "deployment",
            targetId: dplId,
            meta: {
              slug,
              version: parsed.version,
              error: errorMessage(error),
              recovery_ok: recoveryError === null,
              recovery_error: recoveryError
                ? errorMessage(recoveryError)
                : null,
            },
          });
          if (recoveryError) {
            throw new AggregateError(
              [error, recoveryError],
              "tenant-code deployment and last-good recovery both failed",
            );
          }
          throw error;
        }

        // UC-V11-06 — emit `deployment.created` so connected portal sessions
        // fire the "Tenant code <version> active" hot-reload toast without
        // waiting for a manual refresh. Additive — the audit + reply.ok still
        // run identically. Per `packages/contracts/src/stream.ts`
        // DeploymentCreatedEvent.
        publishStreamEvent({
          type: "deployment.created",
          tenantId: tenant.id,
          at: Date.now(),
          deploymentId: dplId,
          kind: "tenant_code",
          version: parsed.version,
          workflowSlug: slug,
        });

        writeAudit({
          tenantId: tenant.id,
          actorUserId: auth.userId ?? undefined,
          action: "tenant.code.upload",
          targetType: "deployment",
          targetId: dplId,
          meta: {
            slug,
            version: parsed.version,
            file_count: archiveEntries.filter((entry) => entry.kind === "file")
              .length,
            inngest_fns: reregister.appFnCount ?? reregister.fnCount,
          },
        });

        return reply.ok(
          {
            deployment_id: dplId,
            slug,
            version: parsed.version,
            dir: finalDir,
            inngest_fns: reregister.appFnCount ?? reregister.fnCount,
            note: "tenant code live; new events route to the new version",
          },
          201,
        );
      });
    },
  );

  /**
   * Compensate a just-completed tenant-code upload (for example when the
   * manifest half of a CLI deployment subsequently fails). Only the current
   * live deployment can be removed, and its exact version must be confirmed.
   */
  app.delete<{ Params: { slug: string; deploymentId: string } }>(
    "/tenants/:slug/code/:deploymentId",
    async (req, reply) => {
      const auth = requirePermission(req, "deployments.write");
      const slug = req.params.slug;
      if (auth.tenantSlug !== slug) {
        return reply.fail(
          "forbidden",
          "cannot remove another tenant's code",
          403,
        );
      }
      const body = RemoveBody.safeParse(req.body);
      if (!body.success) {
        writeAudit({
          tenantId: auth.tenantId,
          actorUserId: auth.userId ?? undefined,
          action: "tenant.code.remove.failed",
          targetType: "deployment",
          targetId: req.params.deploymentId,
          meta: {
            slug,
            code: "bad_request",
            committed: false,
            recovery_ok: true,
          },
        });
        return reply.fail(
          "bad_request",
          `confirmVersion is required: ${body.error.issues[0]?.message ?? "invalid body"}`,
          400,
        );
      }

      const db = getDb();
      const tenant = db
        .select()
        .from(tenants)
        .where(eq(tenants.slug, slug))
        .all()[0];
      if (!tenant) return reply.fail("slug_unknown", "tenant not found", 404);

      let result: TenantCodeRemovalResult;
      try {
        result = await withTenantRollbackLock(tenant.id, () =>
          removeLiveTenantCode({
            tenantId: tenant.id,
            tenantSlug: slug,
            deploymentId: req.params.deploymentId,
            confirmVersion: body.data.confirmVersion,
            log: {
              info: (message) => req.log.info({ tenantSlug: slug }, message),
              warn: (message) => req.log.warn({ tenantSlug: slug }, message),
            },
          }),
        );
      } catch (error) {
        if (error instanceof TenantCodeRemovalError) {
          if (!error.operational) {
            writeAudit({
              tenantId: tenant.id,
              actorUserId: auth.userId ?? undefined,
              action: "tenant.code.remove.failed",
              targetType: "deployment",
              targetId: req.params.deploymentId,
              meta: {
                slug,
                confirm_version: body.data.confirmVersion,
                code: error.code,
                committed: false,
                recovery_ok: true,
                error: errorMessage(error),
              },
            });
            return reply.fail(error.code, error.message, error.statusCode);
          }
          writeAudit({
            tenantId: tenant.id,
            actorUserId: auth.userId ?? undefined,
            action: "tenant.code.remove.failed",
            targetType: "deployment",
            targetId: req.params.deploymentId,
            meta: {
              slug,
              confirm_version: body.data.confirmVersion,
              committed: error.committed,
              recovery_ok: error.recoveryOk,
              error: errorMessage(error),
            },
          });
          req.log.error(
            { err: error, deploymentId: req.params.deploymentId },
            "tenant-code compensation failed",
          );
          throw error;
        }
        writeAudit({
          tenantId: tenant.id,
          actorUserId: auth.userId ?? undefined,
          action: "tenant.code.remove.failed",
          targetType: "deployment",
          targetId: req.params.deploymentId,
          meta: {
            slug,
            confirm_version: body.data.confirmVersion,
            committed: false,
            recovery_ok: false,
            error: errorMessage(error),
          },
        });
        throw error;
      }

      writeAudit({
        tenantId: tenant.id,
        actorUserId: auth.userId ?? undefined,
        action: "tenant.code.remove",
        targetType: "deployment",
        targetId: req.params.deploymentId,
        meta: {
          slug,
          removed_version: result.removedVersion,
          restored_deployment_id: result.restoredDeploymentId,
          restored_version: result.restoredVersion,
          inngest_fns: result.inngestFunctions,
        },
      });

      return reply.ok({
        deployment_id: req.params.deploymentId,
        removed_version: result.removedVersion,
        restored_deployment_id: result.restoredDeploymentId,
        restored_version: result.restoredVersion,
        inngest_fns: result.inngestFunctions,
        note: result.restoredDeploymentId
          ? "tenant-code upload removed; prior live deployment restored"
          : "tenant-code upload removed; tenant returned to its packaged runtime",
      });
    },
  );
}

export interface TenantCodeRemovalResult {
  removedVersion: string;
  restoredDeploymentId: string | null;
  restoredVersion: string | null;
  inngestFunctions: number;
}

class TenantCodeRemovalError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly operational: boolean;
  readonly committed: boolean;
  readonly recoveryOk: boolean;

  constructor(
    code: string,
    message: string,
    options: {
      statusCode?: number;
      operational?: boolean;
      committed?: boolean;
      recoveryOk?: boolean;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "TenantCodeRemovalError";
    this.code = code;
    this.statusCode = options.statusCode ?? 409;
    this.operational = options.operational ?? false;
    this.committed = options.committed ?? false;
    this.recoveryOk = options.recoveryOk ?? true;
  }
}

export interface RemovalLogger {
  info(message: string): void;
  warn(message: string): void;
}

export interface TenantCodeRemovalDependencies {
  reregister?: typeof reregisterInngest;
  sync?: typeof syncTenantApp;
}

export async function removeLiveTenantCode(
  input: {
    tenantId: string;
    tenantSlug: string;
    deploymentId: string;
    confirmVersion: string;
    log: RemovalLogger;
  },
  dependencies: TenantCodeRemovalDependencies = {},
): Promise<TenantCodeRemovalResult> {
  const db = getDb();
  const reregister = dependencies.reregister ?? reregisterInngest;
  const sync = dependencies.sync ?? syncTenantApp;
  const target = db
    .select()
    .from(deployments)
    .where(eq(deployments.id, input.deploymentId))
    .all()[0];
  if (!target || target.tenantId !== input.tenantId) {
    throw new TenantCodeRemovalError("not_found", "deployment not found", {
      statusCode: 404,
    });
  }
  if (target.target !== "tenant_code") {
    throw new TenantCodeRemovalError(
      "compensation_unavailable",
      `deployment ${target.id} is not a tenant-code deployment`,
    );
  }
  if (target.status !== "live") {
    throw new TenantCodeRemovalError(
      "compensation_unavailable",
      `deployment ${target.id} is ${target.status}; only the current live upload can be removed`,
    );
  }

  const version = db
    .select()
    .from(workflowVersions)
    .where(eq(workflowVersions.id, target.versionId))
    .all()[0];
  if (!version) {
    throw new TenantCodeRemovalError(
      "compensation_unavailable",
      `deployment ${target.id} has no workflow-version record`,
    );
  }
  if (version.version !== input.confirmVersion) {
    throw new TenantCodeRemovalError(
      "version_confirmation_mismatch",
      `confirmVersion does not match live version ${version.version}`,
    );
  }
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(version.version)) {
    throw new TenantCodeRemovalError(
      "compensation_unavailable",
      "live tenant-code version is not a safe filesystem component",
    );
  }

  const codeWorkflow = db
    .select()
    .from(workflows)
    .where(eq(workflows.id, version.workflowId))
    .all()[0];
  if (
    !codeWorkflow ||
    codeWorkflow.tenantId !== input.tenantId ||
    codeWorkflow.slug !== TENANT_CODE_WORKFLOW_SLUG
  ) {
    throw new TenantCodeRemovalError(
      "compensation_unavailable",
      "tenant-code deployment points at an unexpected workflow",
    );
  }

  const references = db
    .select({ id: deployments.id })
    .from(deployments)
    .where(eq(deployments.versionId, version.id))
    .all();
  if (references.some((row) => row.id !== target.id)) {
    throw new TenantCodeRemovalError(
      "compensation_unavailable",
      "tenant-code version is referenced by another deployment",
    );
  }

  const lane = db
    .select()
    .from(deployments)
    .where(
      and(
        eq(deployments.tenantId, input.tenantId),
        eq(deployments.target, "tenant_code"),
      ),
    )
    .orderBy(desc(deployments.deployedAt), desc(deployments.id))
    .all();
  const previous = lane.find(
    (row) => row.id !== target.id && row.status === "rolled_back",
  );
  let previousVersion: typeof version | null = null;
  if (previous) {
    previousVersion =
      db
        .select()
        .from(workflowVersions)
        .where(eq(workflowVersions.id, previous.versionId))
        .all()[0] ?? null;
    if (!previousVersion || previousVersion.workflowId !== codeWorkflow.id) {
      throw new TenantCodeRemovalError(
        "compensation_unavailable",
        "the immediately prior tenant-code deployment has no valid version record",
      );
    }
    try {
      const loaded = await loadTenant(
        input.tenantSlug,
        previousVersion.version,
      );
      if (!loaded) throw new Error("package not found");
    } catch (error) {
      throw new TenantCodeRemovalError(
        "compensation_unavailable",
        `prior tenant-code package ${previousVersion.version} is not loadable: ${errorMessage(error)}`,
      );
    }
  }

  const root = path.resolve(dataTenantsRoot());
  const parent = path.resolve(root, input.tenantSlug);
  const finalDir = path.resolve(parent, version.version);
  if (
    path.relative(root, parent).startsWith("..") ||
    path.relative(parent, finalDir).startsWith("..")
  ) {
    throw new TenantCodeRemovalError(
      "compensation_unavailable",
      "tenant-code source path escaped its configured root",
    );
  }
  try {
    const stat = await fs.lstat(finalDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("source is not a real directory");
    }
    const loaded = await loadTenant(input.tenantSlug, version.version);
    if (!loaded) throw new Error("package not found");
  } catch (error) {
    throw new TenantCodeRemovalError(
      "compensation_unavailable",
      `live tenant-code package ${version.version} is not recoverable: ${errorMessage(error)}`,
    );
  }

  if (!previous) {
    const alternates = await visibleTenantCodeVersions(parent, version.version);
    if (alternates.length > 0) {
      throw new TenantCodeRemovalError(
        "compensation_unavailable",
        `cannot return to packaged runtime while untracked tenant-code versions exist: ${alternates.join(", ")}`,
      );
    }
  }

  const workflowVersionRows = db
    .select({ id: workflowVersions.id })
    .from(workflowVersions)
    .where(eq(workflowVersions.workflowId, codeWorkflow.id))
    .all();
  const deleteWorkflow = workflowVersionRows.length === 1;
  const quarantineDir = path.join(
    parent,
    `.remove-${version.version}-${crypto.randomBytes(8).toString("hex")}`,
  );

  let quarantined = false;
  let databaseMutated = false;
  let runtimeSwitched = false;
  try {
    await fs.rename(finalDir, quarantineDir);
    quarantined = true;
    await syncDirectory(parent);

    if (!previous) {
      const alternates = await visibleTenantCodeVersions(parent, null);
      if (alternates.length > 0) {
        throw new Error(
          `alternate tenant-code source appeared during compensation: ${alternates.join(", ")}`,
        );
      }
    }

    db.transaction((tx) => {
      tx.delete(deployments).where(eq(deployments.id, target.id)).run();
      if (previous) {
        tx.update(deployments)
          .set({ status: "live", deployedAt: new Date() })
          .where(eq(deployments.id, previous.id))
          .run();
      }
      tx.delete(workflowVersions)
        .where(eq(workflowVersions.id, version.id))
        .run();
      if (deleteWorkflow) {
        tx.delete(workflows).where(eq(workflows.id, codeWorkflow.id)).run();
      }
    });
    databaseMutated = true;

    const registered = await reregister({
      tenantSlug: input.tenantSlug,
      scope: "tenant",
    });
    const synchronized = await sync(input.tenantSlug, input.log);
    if (!synchronized.ok) {
      throw new Error(
        `Inngest rejected compensated tenant app sync${synchronized.status ? ` (${synchronized.status})` : ""}: ${synchronized.error ?? "unknown error"}`,
      );
    }
    runtimeSwitched = true;

    try {
      await removeDirectoryDurably(quarantineDir);
    } catch (cleanupError) {
      throw new TenantCodeRemovalError(
        "tenant_code_remove_cleanup_failed",
        `tenant-code removal committed but quarantined files could not be deleted: ${errorMessage(cleanupError)}`,
        {
          statusCode: 500,
          operational: true,
          committed: true,
          recoveryOk: false,
          cause: cleanupError,
        },
      );
    }

    return {
      removedVersion: version.version,
      restoredDeploymentId: previous?.id ?? null,
      restoredVersion: previousVersion?.version ?? null,
      inngestFunctions: registered.appFnCount ?? registered.fnCount,
    };
  } catch (error) {
    if (runtimeSwitched) throw error;

    const recoveryErrors: unknown[] = [];
    if (quarantined) {
      try {
        await fs.rename(quarantineDir, finalDir);
        await syncDirectory(parent);
      } catch (recoveryError) {
        recoveryErrors.push(recoveryError);
      }
    }
    if (databaseMutated) {
      try {
        db.transaction((tx) => {
          if (deleteWorkflow) tx.insert(workflows).values(codeWorkflow).run();
          tx.insert(workflowVersions).values(version).run();
          tx.update(deployments)
            .set({ status: "rolled_back" })
            .where(
              and(
                eq(deployments.tenantId, input.tenantId),
                eq(deployments.target, "tenant_code"),
                eq(deployments.status, "live"),
              ),
            )
            .run();
          tx.insert(deployments)
            .values({ ...target, status: "rolled_back" })
            .run();
          for (const row of lane.filter((item) => item.status !== "live")) {
            tx.update(deployments)
              .set({ status: row.status, deployedAt: row.deployedAt })
              .where(eq(deployments.id, row.id))
              .run();
          }
          const live = lane.find((row) => row.status === "live");
          if (live) {
            tx.update(deployments)
              .set({ status: "live", deployedAt: live.deployedAt })
              .where(eq(deployments.id, live.id))
              .run();
          }
        });
      } catch (recoveryError) {
        recoveryErrors.push(recoveryError);
      }

      try {
        await reregister({
          tenantSlug: input.tenantSlug,
          scope: "tenant",
        });
        const restored = await sync(input.tenantSlug, input.log);
        if (!restored.ok) {
          throw new Error(
            `Inngest rejected restored tenant app sync${restored.status ? ` (${restored.status})` : ""}: ${restored.error ?? "unknown error"}`,
          );
        }
      } catch (recoveryError) {
        recoveryErrors.push(recoveryError);
      }
    }

    throw new TenantCodeRemovalError(
      "tenant_code_remove_failed",
      recoveryErrors.length > 0
        ? "tenant-code compensation and last-good recovery both failed"
        : `tenant-code compensation failed; original state restored: ${errorMessage(error)}`,
      {
        statusCode: 500,
        operational: true,
        committed: false,
        recoveryOk: recoveryErrors.length === 0,
        cause:
          recoveryErrors.length > 0
            ? new AggregateError([error, ...recoveryErrors])
            : error,
      },
    );
  }
}

async function visibleTenantCodeVersions(
  tenantDir: string,
  excludeVersion: string | null,
): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(tenantDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const versions: string[] = [];
  for (const entry of entries) {
    if (
      !entry.isDirectory() ||
      entry.name.startsWith(".") ||
      entry.name === excludeVersion
    ) {
      continue;
    }
    try {
      const stat = await fs.lstat(
        path.join(tenantDir, entry.name, "agentic.json"),
      );
      if (stat.isFile() && !stat.isSymbolicLink()) versions.push(entry.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return versions.sort();
}

// ─── Bounded POSIX/ustar reader + durable staging ───────────────────────────

export class TenantCodeArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TenantCodeArchiveError";
  }
}

interface TarFileEntry {
  kind: "file";
  path: string;
  content: Buffer;
  mode: number;
}

interface TarDirectoryEntry {
  kind: "directory";
  path: string;
  mode: number;
}

type TarEntry = TarFileEntry | TarDirectoryEntry;

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

function errorMessage(error: unknown): string {
  return String((error as Error | null)?.message ?? error).slice(0, 500);
}

/** Strictly decode one gzip member (or concatenated gzip members) with a cap. */
export async function decodeTenantCodeArchive(
  encoded: string,
): Promise<Buffer> {
  if (
    encoded.length === 0 ||
    encoded.length > MAX_BASE64_CHARS ||
    encoded.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      encoded,
    )
  ) {
    throw new TenantCodeArchiveError(
      "tarballBase64 must be canonical padded standard base64",
    );
  }

  const compressed = Buffer.from(encoded, "base64");
  if (compressed.toString("base64") !== encoded) {
    throw new TenantCodeArchiveError("tarballBase64 is not canonical base64");
  }
  if (compressed.length > TENANT_CODE_ARCHIVE_LIMITS.compressedBytes) {
    throw new TenantCodeArchiveError(
      `compressed archive exceeds ${TENANT_CODE_ARCHIVE_LIMITS.compressedBytes} bytes`,
    );
  }
  if (compressed[0] !== 0x1f || compressed[1] !== 0x8b) {
    throw new TenantCodeArchiveError(
      "tenant-code archive must be gzip-compressed",
    );
  }

  let raw: Buffer;
  try {
    raw = await new Promise<Buffer>((resolve, reject) => {
      zlib.gunzip(
        compressed,
        { maxOutputLength: TENANT_CODE_ARCHIVE_LIMITS.uncompressedBytes },
        (error, result) => (error ? reject(error) : resolve(result)),
      );
    });
  } catch (error) {
    throw new TenantCodeArchiveError(
      `gzip decode failed or exceeded ${TENANT_CODE_ARCHIVE_LIMITS.uncompressedBytes} bytes: ${errorMessage(error)}`,
    );
  }
  if (
    raw.length === 0 ||
    raw.length > TENANT_CODE_ARCHIVE_LIMITS.uncompressedBytes
  ) {
    throw new TenantCodeArchiveError(
      "decompressed tar size is outside the allowed range",
    );
  }
  if (raw.length % 512 !== 0) {
    throw new TenantCodeArchiveError(
      "tar length is not aligned to a 512-byte block",
    );
  }
  return raw;
}

function validateTenantPackageManifest(
  content: Buffer,
  tenantSlug: string,
  entries: ReadonlyArray<TarEntry>,
): void {
  let value: unknown;
  try {
    value = JSON.parse(decodeUtf8(content, "agentic.json")) as unknown;
  } catch (error) {
    if (error instanceof TenantCodeArchiveError) throw error;
    throw new TenantCodeArchiveError("agentic.json is not valid JSON");
  }
  const parsed = TenantPackageManifest.safeParse(value);
  if (!parsed.success) {
    throw new TenantCodeArchiveError(
      `agentic.json is invalid: ${parsed.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  if (parsed.data.slug !== tenantSlug) {
    throw new TenantCodeArchiveError(
      `agentic.json slug=${parsed.data.slug} does not match tenant ${tenantSlug}`,
    );
  }

  const registry = parsed.data.code?.registry;
  if (!registry) return;
  const safeRegistry = normalizeArchivePath(registry, "file", -1);
  const files = new Set(
    entries
      .filter((entry): entry is TarFileEntry => entry.kind === "file")
      .map((entry) => entry.path),
  );
  if (!files.has(safeRegistry) && !files.has(`${safeRegistry}.ts`)) {
    throw new TenantCodeArchiveError(
      `agentic.json registry file is missing from archive: ${registry}`,
    );
  }
}

/**
 * Parse a strict ustar/GNU-ustar archive. Metadata that can redirect writes
 * (links, devices, FIFOs, sparse/PAX records and unknown types) is rejected,
 * never skipped.
 */
export function parseTenantCodeTarball(buf: Buffer): TarEntry[] {
  if (
    buf.length === 0 ||
    buf.length > TENANT_CODE_ARCHIVE_LIMITS.uncompressedBytes
  ) {
    throw new TenantCodeArchiveError("tar size is outside the allowed range");
  }
  if (buf.length % 512 !== 0) {
    throw new TenantCodeArchiveError(
      "tar length is not aligned to a 512-byte block",
    );
  }

  const entries: TarEntry[] = [];
  const explicitKinds = new Map<string, TarEntry["kind"]>();
  const requiredDirectories = new Set<string>();
  let pos = 0;
  let headerCount = 0;
  let fileCount = 0;
  let totalFileBytes = 0;
  let nextLongName: string | null = null;
  let terminated = false;

  while (pos < buf.length) {
    if (pos + 512 > buf.length) {
      throw new TenantCodeArchiveError(`truncated tar header at offset ${pos}`);
    }
    const headerOffset = pos;
    const header = buf.subarray(pos, pos + 512);
    pos += 512;

    if (isZeroBlock(header)) {
      if (
        pos + 512 > buf.length ||
        !isZeroBlock(buf.subarray(pos, pos + 512))
      ) {
        throw new TenantCodeArchiveError("tar must end with two zero blocks");
      }
      pos += 512;
      if (!isZeroBlock(buf.subarray(pos))) {
        throw new TenantCodeArchiveError(
          "tar contains data after its end marker",
        );
      }
      terminated = true;
      break;
    }

    headerCount += 1;
    if (headerCount > TENANT_CODE_ARCHIVE_LIMITS.entries) {
      throw new TenantCodeArchiveError(
        `tar contains more than ${TENANT_CODE_ARCHIVE_LIMITS.entries} entries`,
      );
    }

    validateHeaderChecksum(header, headerOffset);
    validateUstarMagic(header, headerOffset);
    const mode = readOctal(header, 100, 8, "mode", headerOffset, true);
    readOctal(header, 108, 8, "uid", headerOffset, true);
    readOctal(header, 116, 8, "gid", headerOffset, true);
    const size = readOctal(header, 124, 12, "size", headerOffset, false);
    readOctal(header, 136, 12, "mtime", headerOffset, true);

    if (size > TENANT_CODE_ARCHIVE_LIMITS.uncompressedBytes) {
      throw new TenantCodeArchiveError(
        `entry at offset ${headerOffset} declares an excessive size`,
      );
    }
    const blockLength = Math.ceil(size / 512) * 512;
    if (!Number.isSafeInteger(blockLength) || pos + blockLength > buf.length) {
      throw new TenantCodeArchiveError(
        `entry at offset ${headerOffset} exceeds archive bounds`,
      );
    }
    const content = buf.subarray(pos, pos + size);
    if (!isZeroBlock(buf.subarray(pos + size, pos + blockLength))) {
      throw new TenantCodeArchiveError(
        `entry at offset ${headerOffset} has non-zero data padding`,
      );
    }
    pos += blockLength;

    const typeByte = header[156] ?? 0;
    const type = typeByte === 0 ? "\0" : String.fromCharCode(typeByte);
    const linkName = readTarText(header, 157, 100, "linkname", headerOffset);
    if (linkName !== "") {
      throw new TenantCodeArchiveError(
        `entry at offset ${headerOffset} has a forbidden link target`,
      );
    }

    if (type === "L") {
      if (nextLongName !== null) {
        throw new TenantCodeArchiveError(
          "consecutive GNU long-name records are invalid",
        );
      }
      if (size < 2 || size > TENANT_CODE_ARCHIVE_LIMITS.pathBytes + 1) {
        throw new TenantCodeArchiveError(
          "GNU long-name record has an invalid size",
        );
      }
      if (
        content[content.length - 1] !== 0 ||
        content.subarray(0, -1).includes(0)
      ) {
        throw new TenantCodeArchiveError(
          "GNU long-name record is not NUL-terminated",
        );
      }
      nextLongName = decodeUtf8(content.subarray(0, -1), "GNU long-name path");
      continue;
    }

    if (type !== "0" && type !== "\0" && type !== "5") {
      const label =
        typeByte >= 0x20 && typeByte <= 0x7e
          ? type
          : `0x${typeByte.toString(16)}`;
      throw new TenantCodeArchiveError(
        `unsupported tar entry type ${label} at offset ${headerOffset}`,
      );
    }

    const name = readTarText(header, 0, 100, "name", headerOffset);
    const prefix = readTarText(header, 345, 155, "prefix", headerOffset);
    const rawPath = nextLongName ?? (prefix ? `${prefix}/${name}` : name);
    nextLongName = null;
    const kind: TarEntry["kind"] = type === "5" ? "directory" : "file";
    const safePath = normalizeArchivePath(rawPath, kind, headerOffset);
    registerArchivePath(safePath, kind, explicitKinds, requiredDirectories);

    if (kind === "directory") {
      if (size !== 0) {
        throw new TenantCodeArchiveError(
          `directory ${safePath} must have size zero`,
        );
      }
      entries.push({
        kind,
        path: safePath,
        mode: sanitizeMode(mode, 0o755, 0o700),
      });
      continue;
    }

    fileCount += 1;
    if (fileCount > TENANT_CODE_ARCHIVE_LIMITS.files) {
      throw new TenantCodeArchiveError(
        `tar contains more than ${TENANT_CODE_ARCHIVE_LIMITS.files} files`,
      );
    }
    if (size > TENANT_CODE_ARCHIVE_LIMITS.singleFileBytes) {
      throw new TenantCodeArchiveError(
        `file ${safePath} exceeds ${TENANT_CODE_ARCHIVE_LIMITS.singleFileBytes} bytes`,
      );
    }
    totalFileBytes += size;
    if (totalFileBytes > TENANT_CODE_ARCHIVE_LIMITS.totalFileBytes) {
      throw new TenantCodeArchiveError(
        `archive files exceed ${TENANT_CODE_ARCHIVE_LIMITS.totalFileBytes} bytes in total`,
      );
    }
    entries.push({
      kind,
      path: safePath,
      content: Buffer.from(content),
      mode: sanitizeMode(mode, 0o644, 0o600),
    });
  }

  if (!terminated) {
    throw new TenantCodeArchiveError("tar is missing its two-block end marker");
  }
  if (nextLongName !== null) {
    throw new TenantCodeArchiveError(
      "GNU long-name record has no following entry",
    );
  }
  return entries;
}

function isZeroBlock(bytes: Uint8Array): boolean {
  for (const byte of bytes) if (byte !== 0) return false;
  return true;
}

function validateHeaderChecksum(header: Buffer, offset: number): void {
  const expected = readOctal(header, 148, 8, "checksum", offset, false);
  let actual = 0;
  for (let index = 0; index < 512; index += 1) {
    actual += index >= 148 && index < 156 ? 0x20 : (header[index] ?? 0);
  }
  if (actual !== expected) {
    throw new TenantCodeArchiveError(
      `tar header checksum mismatch at offset ${offset}`,
    );
  }
}

function validateUstarMagic(header: Buffer, offset: number): void {
  const magic = header.subarray(257, 263);
  const version = header.subarray(263, 265);
  const posix =
    magic.equals(Buffer.from("ustar\0", "ascii")) &&
    version.equals(Buffer.from("00", "ascii"));
  const gnu =
    magic.equals(Buffer.from("ustar ", "ascii")) &&
    version[0] === 0x20 &&
    version[1] === 0;
  if (!posix && !gnu) {
    throw new TenantCodeArchiveError(
      `unsupported tar header format at offset ${offset}; expected ustar`,
    );
  }
}

function readOctal(
  header: Buffer,
  start: number,
  length: number,
  field: string,
  headerOffset: number,
  allowEmpty: boolean,
): number {
  const bytes = header.subarray(start, start + length);
  if ((bytes[0] ?? 0) & 0x80) {
    throw new TenantCodeArchiveError(
      `${field} uses unsupported base-256 encoding at offset ${headerOffset}`,
    );
  }
  const text = bytes.toString("ascii");
  const nul = text.indexOf("\0");
  if (
    nul !== -1 &&
    ![...bytes.subarray(nul)].every((byte) => byte === 0 || byte === 0x20)
  ) {
    throw new TenantCodeArchiveError(
      `${field} has bytes after NUL at offset ${headerOffset}`,
    );
  }
  const valueText = (nul === -1 ? text : text.slice(0, nul)).trim();
  if (valueText === "") {
    if (allowEmpty) return 0;
    throw new TenantCodeArchiveError(
      `${field} is empty at offset ${headerOffset}`,
    );
  }
  if (!/^[0-7]+$/.test(valueText)) {
    throw new TenantCodeArchiveError(
      `${field} is not octal at offset ${headerOffset}`,
    );
  }
  const value = Number.parseInt(valueText, 8);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TenantCodeArchiveError(
      `${field} is out of range at offset ${headerOffset}`,
    );
  }
  return value;
}

function readTarText(
  header: Buffer,
  start: number,
  length: number,
  field: string,
  headerOffset: number,
): string {
  const bytes = header.subarray(start, start + length);
  const nul = bytes.indexOf(0);
  const end = nul === -1 ? bytes.length : nul;
  if (nul !== -1 && !isZeroBlock(bytes.subarray(nul))) {
    throw new TenantCodeArchiveError(
      `${field} has bytes after NUL at offset ${headerOffset}`,
    );
  }
  return decodeUtf8(
    bytes.subarray(0, end),
    `${field} at offset ${headerOffset}`,
  );
}

function decodeUtf8(bytes: Uint8Array, label: string): string {
  try {
    return utf8Decoder.decode(bytes);
  } catch {
    throw new TenantCodeArchiveError(`${label} is not valid UTF-8`);
  }
}

function normalizeArchivePath(
  value: string,
  kind: TarEntry["kind"],
  headerOffset: number,
): string {
  const location =
    headerOffset >= 0 ? ` at offset ${headerOffset}` : " in agentic.json";
  const raw =
    kind === "directory" && value.endsWith("/") ? value.slice(0, -1) : value;
  if (
    raw.length === 0 ||
    raw.startsWith("/") ||
    raw.includes("\\") ||
    /^[A-Za-z]:/.test(raw) ||
    /[\u0000-\u001f\u007f]/.test(raw)
  ) {
    throw new TenantCodeArchiveError(`unsafe tar path${location}`);
  }
  if (Buffer.byteLength(raw, "utf8") > TENANT_CODE_ARCHIVE_LIMITS.pathBytes) {
    throw new TenantCodeArchiveError(`tar path is too long${location}`);
  }
  const parts = raw.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new TenantCodeArchiveError(`unsafe tar path ${raw}`);
  }
  if (path.posix.normalize(raw) !== raw) {
    throw new TenantCodeArchiveError(`non-canonical tar path ${raw}`);
  }
  return raw;
}

function registerArchivePath(
  entryPath: string,
  kind: TarEntry["kind"],
  explicitKinds: Map<string, TarEntry["kind"]>,
  requiredDirectories: Set<string>,
): void {
  const existing = explicitKinds.get(entryPath);
  if (existing) {
    throw new TenantCodeArchiveError(`duplicate tar path ${entryPath}`);
  }
  if (kind === "file" && requiredDirectories.has(entryPath)) {
    throw new TenantCodeArchiveError(
      `file path conflicts with directory ${entryPath}`,
    );
  }
  const parts = entryPath.split("/");
  for (let index = 1; index < parts.length; index += 1) {
    const ancestor = parts.slice(0, index).join("/");
    if (explicitKinds.get(ancestor) === "file") {
      throw new TenantCodeArchiveError(
        `path ${entryPath} is nested below file ${ancestor}`,
      );
    }
    requiredDirectories.add(ancestor);
  }
  explicitKinds.set(entryPath, kind);
}

function sanitizeMode(
  mode: number,
  fallback: number,
  requiredOwnerBits: number,
): number {
  const safe = mode & 0o777;
  return (safe === 0 ? fallback : safe) | requiredOwnerBits;
}

function safeDestination(rootDir: string, archivePath: string): string {
  const destination = path.resolve(rootDir, ...archivePath.split("/"));
  const relative = path.relative(path.resolve(rootDir), destination);
  if (
    relative === "" ||
    relative.startsWith("..") ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`archive destination escaped staging root: ${archivePath}`);
  }
  return destination;
}

async function syncDirectory(dir: string): Promise<void> {
  const handle = await fs.open(dir, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function ensureDirectoryDurably(
  dir: string,
  mode = 0o755,
): Promise<void> {
  const missing: string[] = [];
  let cursor = path.resolve(dir);
  while (true) {
    try {
      const stat = await fs.lstat(cursor);
      if (!stat.isDirectory()) throw new Error(`${cursor} is not a directory`);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      missing.push(cursor);
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      cursor = parent;
    }
  }
  for (const directory of missing.reverse()) {
    await fs.mkdir(directory, { mode });
    await syncDirectory(directory);
    await syncDirectory(path.dirname(directory));
  }
}

async function writeEntryDurably(
  rootDir: string,
  entry: TarEntry,
): Promise<void> {
  const destination = safeDestination(rootDir, entry.path);
  if (entry.kind === "directory") {
    await ensureDirectoryDurably(destination, entry.mode);
    await fs.chmod(destination, entry.mode);
    await syncDirectory(destination);
    await syncDirectory(path.dirname(destination));
    return;
  }

  await ensureDirectoryDurably(path.dirname(destination));
  const handle = await fs.open(destination, "wx", entry.mode);
  try {
    await handle.writeFile(entry.content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(path.dirname(destination));
}

async function stageArchiveDurably(
  tmpDir: string,
  finalDir: string,
  entries: ReadonlyArray<TarEntry>,
): Promise<void> {
  const parent = path.dirname(tmpDir);
  await ensureDirectoryDurably(parent);
  await fs.mkdir(tmpDir, { mode: 0o700 });
  await syncDirectory(tmpDir);
  await syncDirectory(parent);

  let published = false;
  try {
    for (const entry of entries) await writeEntryDurably(tmpDir, entry);
    await syncDirectory(tmpDir);
    try {
      await fs.lstat(finalDir);
      throw new Error(`tenant-code version path already exists: ${finalDir}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await fs.rename(tmpDir, finalDir);
    published = true;
    await syncDirectory(parent);
  } catch (error) {
    if (published) {
      try {
        await fs.rename(finalDir, tmpDir);
        await syncDirectory(parent);
      } catch (recoveryError) {
        throw new AggregateError(
          [error, recoveryError],
          "archive publish and filesystem recovery both failed",
        );
      }
    }
    throw error;
  }
}

async function removeDirectoryDurably(dir: string): Promise<void> {
  let stat;
  try {
    stat = await fs.lstat(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`refusing to recursively remove non-directory ${dir}`);
  }
  await fs.rm(dir, { recursive: true, force: false });
  await syncDirectory(path.dirname(dir));
}
