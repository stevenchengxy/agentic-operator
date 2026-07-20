/**
 * Durable deployment rollback.
 *
 * A workflow deployment is not selected by the DB pointer alone: the runtime
 * rebuilds functions from the highest `workflow_v<N>.json` file.  Rolling the
 * DB row back without publishing a new file therefore changed the UI while
 * leaving both the hot runtime and the next process boot on the newer code.
 *
 * This service makes the source switch and the live-pointer switch one
 * recoverable operation:
 *   1. validate the historical workflow manifest;
 *   2. publish workflow + actions as one immutable numeric source head;
 *   3. flip the DB live pointer;
 *   4. rebuild the affected tenant app;
 *   5. on any rebuild failure, remove the new head, restore the exact prior DB
 *      statuses and rebuild last-good before surfacing the error.
 *
 * Rollbacks share a durable per-tenant runtime lease with deploy, promotion,
 * and tenant lifecycle operations across API processes.
 */

import path from "node:path";
import { randomUUID } from "node:crypto";
import { link, open, readdir, rm, unlink } from "node:fs/promises";
import { and, eq } from "drizzle-orm";
import { deployments, getDb, workflowVersions } from "@agentic/db";
import {
  ActionsManifestSchema,
  WorkflowManifestSchema,
  workflowVersionIdentityKind,
  loadTenant,
  tenantSlugFromFolder,
  type ActionsManifest,
  type WorkflowManifest,
} from "@agentic/runtime";
import { reregisterInngest } from "./inngest-registry";
import { syncTenantApp, verifyTenantAppRegistration } from "./inngest-sync";
import {
  assertLiveDeploymentBaseline,
  withTenantWorkflowMutationLease,
  type LiveDeploymentBaseline,
  type TenantWorkflowMutationLease,
} from "./tenant-workflow-mutation";

export class DeploymentRollbackNotFoundError extends Error {
  constructor(id: string) {
    super(`deployment ${id} not found`);
    this.name = "DeploymentRollbackNotFoundError";
  }
}

export class DeploymentRollbackForbiddenError extends Error {
  constructor(id: string) {
    super(`deployment ${id} does not belong to this tenant`);
    this.name = "DeploymentRollbackForbiddenError";
  }
}

export class DeploymentRollbackSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeploymentRollbackSourceError";
  }
}

export class DeploymentRollbackPendingImportError extends Error {
  readonly code = "pending_import";
  readonly statusCode = 409;

  constructor(readonly deploymentId: string) {
    super(
      `rollback refused because manifest import ${deploymentId} is still pending`,
    );
    this.name = "DeploymentRollbackPendingImportError";
  }
}

export class DeploymentRollbackAlreadyLiveError extends Error {
  readonly code = "already_live";
  readonly statusCode = 409;

  constructor(readonly deploymentId: string) {
    super(`deployment ${deploymentId} is already live; rollback is a no-op`);
    this.name = "DeploymentRollbackAlreadyLiveError";
  }
}

export interface DeploymentRollbackResult {
  deploymentId: string;
  status: "live";
  target: "workflow" | "tenant_code";
  versionId: string;
  version: string;
  fileWritten: string | null;
  actionsFileWritten: string | null;
  inngestFunctions: number;
}

export interface DeploymentRollbackDependencies {
  reregister?: typeof reregisterInngest;
  sync?: typeof syncTenantApp;
  verify?: typeof verifyTenantAppRegistration;
  /** Test hook; production always resolves AGENTIC_MODELS_DIR. */
  modelsRoot?: () => string;
}

/** Backwards-compatible name for the shared cross-process runtime lease. */
export async function withTenantRollbackLock<T>(
  tenantId: string,
  operation: (lease: TenantWorkflowMutationLease) => Promise<T>,
): Promise<T> {
  return withTenantWorkflowMutationLease({
    tenantId,
    kind: "deployment_rollback",
    workId: tenantId,
    fn: operation,
  });
}

function defaultModelsRoot(): string {
  const configured = process.env.AGENTIC_MODELS_DIR;
  if (!configured) {
    throw new DeploymentRollbackSourceError(
      "AGENTIC_MODELS_DIR is not set; cannot publish a durable workflow rollback",
    );
  }
  return path.isAbsolute(configured)
    ? configured
    : path.resolve(process.cwd(), configured);
}

async function tenantModelDir(slug: string, root: string): Promise<string> {
  const entries = await readdir(root, { withFileTypes: true });
  const matches: Array<{ dir: string; version: number }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    if (tenantSlugFromFolder(entry.name) !== slug) continue;
    const suffix = entry.name.match(/-v(\d+(?:\.\d+)*)$/i)?.[1];
    const version = suffix
      ? suffix.split(".").reduce((n, part) => n * 1_000 + Number(part), 0)
      : 1;
    matches.push({ dir: path.join(root, entry.name), version });
  }
  matches.sort((a, b) => b.version - a.version || a.dir.localeCompare(b.dir));
  if (!matches[0]) {
    throw new DeploymentRollbackSourceError(
      `no models directory found for tenant ${slug}`,
    );
  }
  return matches[0].dir;
}

function nextManifestVersion(files: ReadonlyArray<string>): number {
  let max = 0;
  for (const file of files) {
    const match = file.match(/^(?:workflow|actions)(?:_v(\d+))?\.json$/i);
    if (!match) continue;
    max = Math.max(max, match[1] ? Number(match[1]) : 1);
  }
  return max + 1;
}

async function syncDirectory(dir: string): Promise<void> {
  const handle = await open(dir, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

interface PublishedWorkflowHead {
  workflowPath: string;
  actionsPath: string;
}

/**
 * Publish an exact workflow+actions pair without overwriting another writer's
 * version. Both durable temp files are complete before the actions link is
 * exposed; the workflow link is the commit point used by the serialized
 * runtime reload. Any failure removes both names and fsyncs the directory.
 */
async function publishWorkflowHead(
  dir: string,
  manifest: WorkflowManifest,
  actions: ActionsManifest,
): Promise<PublishedWorkflowHead> {
  const workflowText = JSON.stringify(manifest, null, 2) + "\n";
  const actionsText = JSON.stringify(actions, null, 2) + "\n";
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const version = nextManifestVersion(await readdir(dir));
    const workflowPath = path.join(dir, `workflow_v${version}.json`);
    const actionsPath = path.join(dir, `actions_v${version}.json`);
    const nonce = randomUUID();
    const workflowTemp = path.join(dir, `.rollback-workflow-${nonce}.tmp`);
    const actionsTemp = path.join(dir, `.rollback-actions-${nonce}.tmp`);
    let workflowHandle: Awaited<ReturnType<typeof open>> | null = null;
    let actionsHandle: Awaited<ReturnType<typeof open>> | null = null;
    let workflowLinked = false;
    let actionsLinked = false;
    try {
      workflowHandle = await open(workflowTemp, "wx", 0o600);
      actionsHandle = await open(actionsTemp, "wx", 0o600);
      await workflowHandle.writeFile(workflowText, "utf8");
      await actionsHandle.writeFile(actionsText, "utf8");
      await workflowHandle.sync();
      await actionsHandle.sync();
      await workflowHandle.close();
      workflowHandle = null;
      await actionsHandle.close();
      actionsHandle = null;

      // Expose actions first and workflow last. Runtime reload is serialized by
      // the tenant mutation lease, so workflowPath is the pair's commit point.
      await link(actionsTemp, actionsPath);
      actionsLinked = true;
      await link(workflowTemp, workflowPath);
      workflowLinked = true;
      await unlink(actionsTemp);
      await unlink(workflowTemp);
      await syncDirectory(dir);
      return { workflowPath, actionsPath };
    } catch (error) {
      if (workflowHandle) await workflowHandle.close().catch(() => undefined);
      if (actionsHandle) await actionsHandle.close().catch(() => undefined);
      await rm(workflowTemp, { force: true }).catch(() => undefined);
      await rm(actionsTemp, { force: true }).catch(() => undefined);
      if (workflowLinked || actionsLinked) {
        if (workflowLinked)
          await rm(workflowPath, { force: true }).catch(() => undefined);
        if (actionsLinked)
          await rm(actionsPath, { force: true }).catch(() => undefined);
        await syncDirectory(dir).catch(() => undefined);
      }
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
  }
  throw new DeploymentRollbackSourceError(
    "could not reserve a unique workflow/actions rollback head after 8 attempts",
  );
}

interface LaneSnapshot {
  id: string;
  versionId: string;
  status: "pending" | "live" | "rolled_back";
  deployedAt: Date;
  filePath: string | null;
}

function assertNoPendingManifestImport(tenantId: string): void {
  const pending = getDb()
    .select({ id: deployments.id })
    .from(deployments)
    .where(
      and(
        eq(deployments.tenantId, tenantId),
        eq(deployments.target, "workflow"),
        eq(deployments.status, "pending"),
      ),
    )
    .all()[0];
  if (pending) throw new DeploymentRollbackPendingImportError(pending.id);
}

function baselineFromSnapshot(
  snapshot: ReadonlyArray<LaneSnapshot>,
): LiveDeploymentBaseline | null {
  const live = snapshot.filter((row) => row.status === "live");
  if (live.length > 1) {
    throw new Error(
      `rollback snapshot contains ${live.length} live deployments`,
    );
  }
  return live[0]
    ? {
        deploymentId: live[0].id,
        versionId: live[0].versionId,
        deployedAtMs: live[0].deployedAt.getTime(),
      }
    : null;
}

/** Restore live selection after a failed hot swap. */
function restoreLane(
  tenantId: string,
  target: "workflow" | "tenant_code",
  snapshot: ReadonlyArray<LaneSnapshot>,
  expectedCurrent: LiveDeploymentBaseline,
): void {
  const db = getDb();
  db.transaction(() => {
    // Never let stale compensation overwrite a deployment activated by a
    // writer that bypassed or outlived this operation's lease.
    assertLiveDeploymentBaseline(tenantId, target, expectedCurrent);
    // A failed bootstrap can have inserted another live deployment. Demote it
    // before restoring the snapshot to satisfy the one-live partial index.
    db.update(deployments)
      .set({ status: "rolled_back" })
      .where(
        and(
          eq(deployments.tenantId, tenantId),
          eq(deployments.target, target),
          eq(deployments.status, "live"),
        ),
      )
      .run();
    for (const row of snapshot) {
      db.update(deployments)
        .set({
          status: row.status,
          deployedAt: row.deployedAt,
          filePath: row.filePath,
        })
        .where(eq(deployments.id, row.id))
        .run();
    }
    assertLiveDeploymentBaseline(
      tenantId,
      target,
      baselineFromSnapshot(snapshot),
    );
  });
}

export async function rollbackDeployment(
  input: {
    deploymentId: string;
    tenantId: string;
    tenantSlug: string;
  },
  dependencies: DeploymentRollbackDependencies = {},
): Promise<DeploymentRollbackResult> {
  return withTenantRollbackLock(input.tenantId, async (lease) => {
    lease.assertOwned();
    const db = getDb();
    const target = db
      .select()
      .from(deployments)
      .where(eq(deployments.id, input.deploymentId))
      .all()[0];
    if (!target) throw new DeploymentRollbackNotFoundError(input.deploymentId);
    if (target.tenantId !== input.tenantId) {
      throw new DeploymentRollbackForbiddenError(input.deploymentId);
    }
    if (target.target !== "workflow" && target.target !== "tenant_code") {
      throw new DeploymentRollbackSourceError(
        `deployment target ${target.target} is not rollback-capable`,
      );
    }
    if (target.status === "pending") {
      throw new DeploymentRollbackPendingImportError(target.id);
    }
    if (target.status === "live") {
      throw new DeploymentRollbackAlreadyLiveError(target.id);
    }
    assertNoPendingManifestImport(input.tenantId);

    const version = db
      .select()
      .from(workflowVersions)
      .where(eq(workflowVersions.id, target.versionId))
      .all()[0];
    if (!version) {
      throw new DeploymentRollbackSourceError(
        `workflow version ${target.versionId} no longer exists`,
      );
    }

    const lane = db
      .select()
      .from(deployments)
      .where(
        and(
          eq(deployments.tenantId, input.tenantId),
          eq(deployments.target, target.target),
        ),
      )
      .all();
    const snapshot: LaneSnapshot[] = lane.map((row) => ({
      id: row.id,
      versionId: row.versionId,
      status: row.status,
      deployedAt: row.deployedAt,
      filePath: row.filePath,
    }));
    const initialBaseline = baselineFromSnapshot(snapshot);
    assertLiveDeploymentBaseline(
      input.tenantId,
      target.target,
      initialBaseline,
    );

    const reregister = dependencies.reregister ?? reregisterInngest;
    const sync = dependencies.sync ?? syncTenantApp;
    const verify = dependencies.verify ?? verifyTenantAppRegistration;
    let fileWritten: string | null = null;
    let actionsFileWritten: string | null = null;
    let mutationApplied = false;
    let activatedBaseline: LiveDeploymentBaseline | null = null;
    try {
      if (target.target === "workflow") {
        const parsed = WorkflowManifestSchema.safeParse(version.manifestJson);
        if (!parsed.success) {
          throw new DeploymentRollbackSourceError(
            `deployment ${target.id} contains an invalid workflow manifest: ${parsed.error.issues
              .slice(0, 3)
              .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
              .join("; ")}`,
          );
        }
        const parsedActions = ActionsManifestSchema.safeParse(
          version.actionsJson ?? [],
        );
        if (!parsedActions.success) {
          throw new DeploymentRollbackSourceError(
            `deployment ${target.id} contains an invalid actions manifest: ${parsedActions.error.issues
              .slice(0, 3)
              .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
              .join("; ")}`,
          );
        }
        const identityKind = workflowVersionIdentityKind(
          version.version,
          parsed.data,
          parsedActions.data,
        );
        if (!identityKind) {
          throw new DeploymentRollbackSourceError(
            `deployment ${target.id} has a workflow version identity that does not match its exact manifest and actions content`,
          );
        }
        const root = (dependencies.modelsRoot ?? defaultModelsRoot)();
        const dir = await tenantModelDir(input.tenantSlug, root);
        const published = await publishWorkflowHead(
          dir,
          parsed.data,
          parsedActions.data,
        );
        fileWritten = published.workflowPath;
        actionsFileWritten = published.actionsPath;
      } else {
        // Fail before touching the live pointer when the historical package was
        // manually deleted. `loadTenant` also validates agentic.json and the
        // registry import, so the subsequent hot swap cannot silently fall back
        // to a different disk version.
        const loaded = await loadTenant(input.tenantSlug, version.version);
        if (!loaded) {
          throw new DeploymentRollbackSourceError(
            `tenant code ${input.tenantSlug}@${version.version} is missing or unreadable`,
          );
        }
      }

      lease.assertOwned();
      assertNoPendingManifestImport(input.tenantId);
      const activatedAt = new Date(
        Math.max(Date.now(), (initialBaseline?.deployedAtMs ?? 0) + 1),
      );
      activatedBaseline = {
        deploymentId: target.id,
        versionId: target.versionId,
        deployedAtMs: activatedAt.getTime(),
      };
      db.transaction(() => {
        assertNoPendingManifestImport(input.tenantId);
        assertLiveDeploymentBaseline(
          input.tenantId,
          target.target,
          initialBaseline,
        );
        if (initialBaseline) {
          const demoted = db
            .update(deployments)
            .set({ status: "rolled_back" })
            .where(
              and(
                eq(deployments.id, initialBaseline.deploymentId),
                eq(deployments.tenantId, input.tenantId),
                eq(deployments.target, target.target),
                eq(deployments.versionId, initialBaseline.versionId),
                eq(
                  deployments.deployedAt,
                  new Date(initialBaseline.deployedAtMs),
                ),
                eq(deployments.status, "live"),
              ),
            )
            .run() as { changes?: number };
          if ((demoted.changes ?? 0) !== 1) {
            throw new Error(
              "live deployment compare-and-swap was lost during rollback",
            );
          }
        }
        const activated = db
          .update(deployments)
          .set({
            status: "live",
            deployedAt: activatedAt,
            filePath: fileWritten ?? target.filePath,
          })
          .where(
            and(
              eq(deployments.id, target.id),
              eq(deployments.tenantId, input.tenantId),
              eq(deployments.target, target.target),
              eq(deployments.versionId, target.versionId),
              eq(deployments.deployedAt, target.deployedAt),
              eq(deployments.status, "rolled_back"),
            ),
          )
          .run() as { changes?: number };
        if ((activated.changes ?? 0) !== 1) {
          throw new Error("rollback target compare-and-swap was lost");
        }
        assertLiveDeploymentBaseline(
          input.tenantId,
          target.target,
          activatedBaseline,
        );
      });
      mutationApplied = true;
      lease.assertOwned();

      const registered = await reregister({
        tenantSlug: input.tenantSlug,
        scope: "tenant",
      });
      lease.assertOwned();
      assertLiveDeploymentBaseline(
        input.tenantId,
        target.target,
        activatedBaseline,
      );
      const registeredCount = registered.appFnCount ?? registered.fnCount;
      const synchronized = await sync(input.tenantSlug);
      lease.assertOwned();
      assertLiveDeploymentBaseline(
        input.tenantId,
        target.target,
        activatedBaseline,
      );
      if (!synchronized.ok) {
        throw new Error(
          `Inngest rejected rollback app sync${synchronized.status ? ` (${synchronized.status})` : ""}: ${synchronized.error ?? "unknown error"}`,
        );
      }
      const activation = await verify(input.tenantSlug, registeredCount);
      lease.assertOwned();
      assertLiveDeploymentBaseline(
        input.tenantId,
        target.target,
        activatedBaseline,
      );
      if (!activation.verified) {
        throw new Error(
          `Inngest rollback activation was not verified (expected=${activation.expectedFunctionCount}, observed=${String(activation.observedFunctionCount)}, connected=${activation.connected}): ${activation.error ?? "unknown error"}`,
        );
      }
      return {
        deploymentId: target.id,
        status: "live",
        target: target.target,
        versionId: version.id,
        version: version.version,
        fileWritten,
        actionsFileWritten,
        inngestFunctions: registeredCount,
      };
    } catch (error) {
      // Restore disk first so the compensating rebuild cannot observe the
      // failed rollback head. DB follows, then the runtime last-good rebuild.
      const compensationErrors: Error[] = [];
      const artifactPaths = [fileWritten, actionsFileWritten].filter(
        (value): value is string => Boolean(value),
      );
      for (const artifactPath of artifactPaths) {
        try {
          await rm(artifactPath, { force: true });
        } catch (failure) {
          compensationErrors.push(
            failure instanceof Error ? failure : new Error(String(failure)),
          );
        }
      }
      for (const dir of new Set(
        artifactPaths.map((value) => path.dirname(value)),
      )) {
        try {
          await syncDirectory(dir);
        } catch (failure) {
          compensationErrors.push(
            failure instanceof Error ? failure : new Error(String(failure)),
          );
        }
      }
      let databaseRestored = !mutationApplied;
      if (mutationApplied) {
        try {
          if (!activatedBaseline) {
            throw new Error("rollback activation baseline is missing");
          }
          restoreLane(
            input.tenantId,
            target.target,
            snapshot,
            activatedBaseline,
          );
          databaseRestored = true;
        } catch (failure) {
          compensationErrors.push(
            failure instanceof Error ? failure : new Error(String(failure)),
          );
        }
      }

      if (mutationApplied && databaseRestored) {
        try {
          // The original lease may have been lost. The exact live-generation
          // CAS above makes DB restoration safe; verify it still owns the
          // restored baseline before repairing external runtime state.
          assertLiveDeploymentBaseline(
            input.tenantId,
            target.target,
            initialBaseline,
          );
          const restoredRegistration = await reregister({
            tenantSlug: input.tenantSlug,
            scope: "tenant",
          });
          assertLiveDeploymentBaseline(
            input.tenantId,
            target.target,
            initialBaseline,
          );
          const restoredCount =
            restoredRegistration.appFnCount ?? restoredRegistration.fnCount;
          const restored = await sync(input.tenantSlug);
          assertLiveDeploymentBaseline(
            input.tenantId,
            target.target,
            initialBaseline,
          );
          if (!restored.ok) {
            throw new Error(
              `Inngest rejected last-good app sync${restored.status ? ` (${restored.status})` : ""}: ${restored.error ?? "unknown error"}`,
            );
          }
          const restoredActivation = await verify(
            input.tenantSlug,
            restoredCount,
          );
          assertLiveDeploymentBaseline(
            input.tenantId,
            target.target,
            initialBaseline,
          );
          if (!restoredActivation.verified) {
            throw new Error(
              `Inngest last-good activation was not verified (expected=${restoredActivation.expectedFunctionCount}, observed=${String(restoredActivation.observedFunctionCount)}, connected=${restoredActivation.connected}): ${restoredActivation.error ?? "unknown error"}`,
            );
          }
        } catch (failure) {
          compensationErrors.push(
            failure instanceof Error ? failure : new Error(String(failure)),
          );
        }
      }
      if (compensationErrors.length > 0) {
        throw new AggregateError(
          [
            error instanceof Error ? error : new Error(String(error)),
            ...compensationErrors,
          ],
          "deployment rollback and last-good recovery both failed",
        );
      }
      throw error;
    }
  });
}
