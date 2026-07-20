/**
 * Boot-time crash recovery for the manifest-import wizard.
 *
 * Three failure modes the commit transaction may leave behind, per
 * `docs/design/import-workflow-manifest.md` §"Commit transaction sequence":
 *
 *   1. EXPIRED PENDING — `status='pending' AND expires_at < now()`. The
 *      operator abandoned a validate; the row + its workflow_version + the
 *      `AGENTIC_IMPORTS_DIR/<deployment_id>/` tmp dir should all be removed.
 *
 *   2. CRASHED RENAME — `status='live'` with `file_path` inside the configured
 *      `AGENTIC_IMPORTS_DIR`.
 *      Phase 3 (DB commit) succeeded but phase 4 (rename + re-register) did
 *      not. The DB says the new version is live; the runtime would load
 *      the OLD manifest from disk because the new one is still under
 *      `AGENTIC_IMPORTS_DIR/<deployment_id>/workflow.json`. Complete the rename,
 *      then `reregisterInngest`.
 *
 *   3. MISSING ON-DISK FILE — `status='live' AND file_path NOT NULL AND
 *      file_path missing on disk`. Someone manually deleted the file. The
 *      DB still has `workflow_versions.manifest_json` (it's the durable
 *      source of truth for in-flight replays per `migrations/index.ts:13`),
 *      so we re-emit the file from there.
 *
 * Idempotent. Safe to re-run.
 */

import { mkdir, open, readdir, rm, stat, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  deployments,
  workflowVersions,
  workflows,
  tenants,
  getDb,
} from "@agentic/db";
import { and, eq, isNotNull, lt } from "drizzle-orm";
import { tenantSlugFromFolder, publishStreamEvent } from "@agentic/runtime";

type Db = ReturnType<typeof getDb>;

function importsRoot(): string {
  return process.env.AGENTIC_IMPORTS_DIR
    ? process.env.AGENTIC_IMPORTS_DIR
    : path.join(process.env.AGENTIC_DATA_DIR ?? "./data", "imports");
}

function modelsRoot(): string {
  const env = process.env.AGENTIC_MODELS_DIR;
  if (!env) throw new Error("AGENTIC_MODELS_DIR is required for import reconciliation");
  return path.isAbsolute(env) ? env : path.resolve(process.cwd(), env);
}

/** Return the tenant model dirs sorted by version desc (mirrors workflowRoutes). */
async function findTenantDirs(
  slug: string,
): Promise<Array<{ folder: string; version: number; absDir: string }>> {
  const root = modelsRoot();
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`models root does not exist: ${root}`, { cause: error });
    throw error;
  }
  const matches: Array<{ folder: string; version: number; absDir: string }> = [];
  for (const folder of entries) {
    if (folder.startsWith(".")) continue;
    const abs = path.join(root, folder);
    let isDir = false;
    try {
      isDir = (await stat(abs)).isDirectory();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (!isDir) continue;
    if (tenantSlugFromFolder(folder) !== slug) continue;
    const m = folder.match(/-v(\d+)$/i);
    const version = m ? Number(m[1]) : 1;
    matches.push({ folder, version, absDir: abs });
  }
  matches.sort((a, b) => b.version - a.version);
  return matches;
}

async function nextWorkflowVN(targetDir: string): Promise<string> {
  let files: string[] = [];
  try {
    files = await readdir(targetDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let max = 0;
  const re = /^workflow(?:_v(\d+))?\.json$/i;
  for (const f of files) {
    const m = f.match(re);
    if (!m) continue;
    const v = m[1] ? Number(m[1]) : 1;
    if (v > max) max = v;
  }
  return `workflow_v${max + 1}.json`;
}

function isUnderImports(filePath: string | null): boolean {
  if (!filePath) return false;
  const root = path.resolve(importsRoot());
  const candidate = path.resolve(filePath);
  const relative = path.relative(root, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function reserveNextWorkflow(targetDir: string): Promise<{ name: string; filePath: string }> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const name = await nextWorkflowVN(targetDir);
    const filePath = path.join(targetDir, name);
    try {
      const reservation = await open(filePath, "wx", 0o600);
      await reservation.close();
      return { name, filePath };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      await rm(filePath, { force: true }).catch(() => undefined);
      throw error;
    }
  }
  throw new Error("could not reserve a unique reconciled workflow filename after 8 attempts");
}

async function writeDurableJson(filePath: string, value: unknown): Promise<void> {
  const temp = `${filePath}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(temp, "wx", 0o600);
    await handle.writeFile(JSON.stringify(value, null, 2) + "\n", "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temp, filePath);
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

interface ReconcileSummary {
  expired_pruned: number;
  rename_completed: number;
  missing_file_repaired: number;
  failures: number;
}

/** Look up tenant slug for a deployment row via the workflow_version → workflow → tenant chain. */
function tenantSlugForDeployment(
  db: Db,
  deploymentId: string,
): { slug: string; tenantId: string; archivedAt: Date | null } | null {
  const row = db
    .select({
      tenantId: tenants.id,
      slug: tenants.slug,
      archivedAt: tenants.archivedAt,
    })
    .from(deployments)
    .innerJoin(workflowVersions, eq(workflowVersions.id, deployments.versionId))
    .innerJoin(workflows, eq(workflows.id, workflowVersions.workflowId))
    .innerJoin(tenants, eq(tenants.id, workflows.tenantId))
    .where(eq(deployments.id, deploymentId))
    .all()[0];
  return row
    ? { slug: row.slug, tenantId: row.tenantId, archivedAt: row.archivedAt }
    : null;
}

/**
 * Run the three recovery sweeps. Per-row repair failures are counted in the
 * summary so the composition root can fail readiness; store-level/query
 * failures are allowed to throw because no trustworthy sweep was performed.
 *
 * @param db - the database connection. Pass `getDb()`.
 * @param opts.reregister - optional callback to re-register Inngest functions
 *                          for a tenant after a crashed-rename repair.
 *                          When undefined the repair still completes the
 *                          rename + updates `file_path`; the runtime picks
 *                          up the new manifest the next time `bootstrapAll`
 *                          runs (typically the same boot, immediately).
 */
export async function reconcileImports(
  db: Db,
  opts: {
    reregister?: (tenantSlug: string) => Promise<void>;
  } = {},
): Promise<ReconcileSummary> {
  const summary: ReconcileSummary = {
    expired_pruned: 0,
    rename_completed: 0,
    missing_file_repaired: 0,
    failures: 0,
  };

  // ── 1. EXPIRED PENDING ────────────────────────────────────────────────
  const now = new Date();
  const expired = db
    .select()
    .from(deployments)
    .where(
      and(
        eq(deployments.status, "pending"),
        lt(deployments.expiresAt, now),
      ),
    )
    .all();
  for (const row of expired) {
    try {
      await rm(path.join(importsRoot(), row.id), {
        recursive: true,
        force: true,
      });
      db.transaction(() => {
        db.delete(deployments).where(eq(deployments.id, row.id)).run();
        db.delete(workflowVersions)
          .where(eq(workflowVersions.id, row.versionId))
          .run();
      });
      summary.expired_pruned += 1;
    } catch {
      summary.failures += 1;
    }
  }

  // ── 2. CRASHED RENAME ─────────────────────────────────────────────────
  // Live rows whose file_path still points at the tmp staging dir. Phase 4
  // never finished. Complete the rename and re-register.
  const stranded = db
    .select()
    .from(deployments)
    .where(
      and(
        eq(deployments.status, "live"),
        isNotNull(deployments.filePath),
      ),
    )
    .all();
  for (const row of stranded.filter((r) => isUnderImports(r.filePath))) {
    let finalPathForCleanup: string | null = null;
    let finalActionsForCleanup: string | null = null;
    let deploymentUpdated = false;
    try {
      const tenantRow = tenantSlugForDeployment(db, row.id);
      if (!tenantRow) {
        summary.failures += 1;
        continue;
      }
      // Archived tenants are intentionally inert. Factory sandbox cleanup
      // archives the audit identity and removes executable artifacts; boot
      // recovery must not recreate those files or re-register the deleted App.
      if (tenantRow.archivedAt) continue;
      const wfv = db
        .select()
        .from(workflowVersions)
        .where(eq(workflowVersions.id, row.versionId))
        .all()[0];
      if (!wfv) throw new Error(`workflow version ${row.versionId} is missing`);

      // Verify whether the tmp file survived. If the crash happened after
      // rename but before the DB update, reconstruct from the durable
      // workflow_versions row instead of leaving the stranded deployment.
      const tmpPath = row.filePath!;
      let tmpExists = false;
      try {
        await stat(tmpPath);
        tmpExists = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      // Pick / reserve the final filename in the tenant's models folder.
      const dirs = await findTenantDirs(tenantRow.slug);
      let targetDir: string;
      if (dirs.length === 0) {
        targetDir = path.join(modelsRoot(), `${tenantRow.slug}-v1`);
        await mkdir(targetDir, { recursive: true });
      } else {
        targetDir = dirs[0]!.absDir;
      }
      const reserved = await reserveNextWorkflow(targetDir);
      const nextName = reserved.name;
      const finalPath = reserved.filePath;
      finalPathForCleanup = finalPath;
      if (tmpExists) await rename(tmpPath, finalPath);
      else await writeDurableJson(finalPath, wfv.manifestJson);

      // Rename actions.json when it exists. Only ENOENT means the optional
      // actions manifest is absent; permissions/I/O errors block recovery.
      const tmpDir = path.dirname(tmpPath);
      const tmpActions = path.join(tmpDir, "actions.json");
      let actionsExist = false;
      try {
        await stat(tmpActions);
        actionsExist = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (actionsExist) {
        const versionMatch = nextName.match(/v(\d+)/);
        const v = versionMatch ? versionMatch[1] : "1";
        const finalActions = path.join(targetDir, `actions_v${v}.json`);
        finalActionsForCleanup = finalActions;
        await rename(tmpActions, finalActions);
      }
      const updated = db.update(deployments)
        .set({ filePath: finalPath })
        .where(eq(deployments.id, row.id))
        .run() as { changes?: number };
      if ((updated.changes ?? 0) !== 1) throw new Error(`deployment ${row.id} was not updated`);
      deploymentUpdated = true;
      await rm(tmpDir, { recursive: true, force: true });
      if (opts.reregister) {
        await opts.reregister(tenantRow.slug);
      }
      // UC-V11-06 — emit `deployment.created` so any portal session that
      // re-establishes its SSE stream after the crash sees the recovered
      // deployment in its toast / list. Best-effort: a publish failure does
      // not roll back the rename. (`workflow_versions.version` is the
      // canonical version label; fall back to the row id if absent.)
      try {
        const wfv = db
          .select({ version: workflowVersions.version })
          .from(workflowVersions)
          .where(eq(workflowVersions.id, row.versionId))
          .all()[0];
        publishStreamEvent({
          type: "deployment.created",
          tenantId: tenantRow.tenantId,
          at: Date.now(),
          deploymentId: row.id,
          kind: "manifest",
          version: wfv?.version ?? row.id,
          workflowSlug: tenantRow.slug,
        });
      } catch {
        /* publish best-effort */
      }
      summary.rename_completed += 1;
    } catch {
      if (!deploymentUpdated) {
        await Promise.all(
          [finalPathForCleanup, finalActionsForCleanup]
            .filter((filePath): filePath is string => Boolean(filePath))
            .map((filePath) => rm(filePath, { force: true }).catch(() => undefined)),
        );
      }
      summary.failures += 1;
    }
  }

  // ── 3. MISSING ON-DISK FILE ───────────────────────────────────────────
  // Live rows whose file_path is set but the file doesn't exist on disk.
  // The DB is the source of truth (workflow_versions.manifest_json); re-emit.
  const liveWithFile = db
    .select()
    .from(deployments)
    .where(
      and(
        eq(deployments.status, "live"),
        isNotNull(deployments.filePath),
      ),
    )
    .all();
  for (const row of liveWithFile) {
    try {
      if (!row.filePath) continue;
      // Skip stranded-tmp survivors (handled above).
      if (isUnderImports(row.filePath)) continue;
      let exists = true;
      try {
        await stat(row.filePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        exists = false;
      }
      if (exists) continue;
      // Re-emit from the workflow_versions row.
      const wfv = db
        .select()
        .from(workflowVersions)
        .where(eq(workflowVersions.id, row.versionId))
        .all()[0];
      if (!wfv) throw new Error(`workflow version ${row.versionId} is missing`);
      const tenantRow = tenantSlugForDeployment(db, row.id);
      if (!tenantRow) throw new Error(`deployment ${row.id} has no tenant`);
      // Missing files for an archived tenant are the expected result of
      // decommissioning, not a crashed live deployment to resurrect.
      if (tenantRow.archivedAt) continue;
      await mkdir(path.dirname(row.filePath), { recursive: true });
      await writeDurableJson(row.filePath, wfv.manifestJson);
      if (opts.reregister) await opts.reregister(tenantRow.slug);
      summary.missing_file_repaired += 1;
    } catch {
      summary.failures += 1;
    }
  }

  return summary;
}
