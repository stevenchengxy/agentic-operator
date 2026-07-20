/**
 * tenant-loader — P3-RT-08.
 *
 * Reads `data/tenants/<slug>/<version>/agentic.json` at boot and dynamically
 * `import()`s the tenant's `src/index.ts` (the `TenantRegistry` default
 * export). This is what makes "ship a new tenant without monorepo edits"
 * actually work: the api process no longer needs `@tenants/<slug>` declared in
 * its package.json — anything under `data/tenants/` is discovered + loaded at
 * runtime.
 *
 * Live version selection:
 *   1. If `deployments` has a `target='tenant_code'` row with status='live'
 *      for this tenant, use that version.
 *   2. Else, fall back to the highest numeric-aware `<version>/` dir on disk
 *      (`v10` sorts after `v9`, while dotted versions remain naturally ordered).
 *   3. Else, return null and the runtime falls back to whatever's wired up in
 *      `apps/api/src/bootstrap.ts#TENANT_REGISTRIES` (the legacy `tenants/`
 *      workspace path).
 *
 * Atomic switch model:
 *   - A new deployment row flips the live pointer.
 *   - `dataTenantsRoot()/<slug>/<version>/agentic.json` MUST exist.
 *   - On rollback, the prior version dir is still on disk; we just point at
 *     it again. We never delete a previous version's files automatically.
 *
 * Hot-reload concern:
 *   - Node caches modules by absolute URL. To pick up a new version of a
 *     tenant package on the same path, we append `?v=<version>&t=<mtime>` to
 *     the dynamic import URL so each load is a unique cache key. tsx supports
 *     query-string URLs for .ts modules.
 */

import path from "node:path";
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import {
  deployments,
  getDb,
  tenants,
  workflowVersions,
} from "@agentic/db";
import type { TenantRegistry } from "@agentic/agent-sdk";

/**
 * `agentic.json` shape per DESIGN.md §11.2.
 *
 * Loose-validated so a tenant author can ship forward-compatible extras
 * without us bumping the schema version every minor release.
 */
export interface TenantManifest {
  slug: string;
  name?: string;
  schemaVersion?: number;
  manifests?: string[];
  code?: { registry?: string };
  createdAt?: string;
}

const TenantManifestSchema = z
  .object({
    slug: z.string().min(1),
    name: z.string().min(1).optional(),
    schemaVersion: z.number().int().nonnegative().optional(),
    manifests: z.array(z.string().min(1)).optional(),
    code: z.object({ registry: z.string().min(1).optional() }).optional(),
    createdAt: z.string().min(1).optional(),
  })
  .passthrough();

export class TenantCodeIntegrityError extends Error {
  override readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "TenantCodeIntegrityError";
    this.cause = cause;
  }
}

const versionCollator = new Intl.Collator("en", {
  numeric: true,
  sensitivity: "base",
});

function compareTenantVersions(a: string, b: string): number {
  return versionCollator.compare(a, b);
}

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

async function regularFileExists(filePath: string): Promise<boolean> {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch (error) {
    if (isEnoent(error)) return false;
    throw error;
  }
}

export interface LoadedTenant {
  slug: string;
  version: string;
  dir: string;
  manifest: TenantManifest;
  registry: TenantRegistry | null;
}

/**
 * Resolve the data/tenants root. Override via AGENTIC_TENANTS_DIR for
 * packaged builds; defaults to `<cwd>/data/tenants`.
 */
export function dataTenantsRoot(): string {
  const raw = process.env.AGENTIC_TENANTS_DIR;
  if (raw && raw.trim() !== "") {
    return path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
  }
  return path.resolve(process.cwd(), "data", "tenants");
}

/**
 * List every `<slug>/<version>` pair found under `data/tenants/`.
 *
 * Skips:
 *   - Hidden dirs (`.git`, `.DS_Store`).
 *   - Slugs with no `<version>/agentic.json` file.
 *
 * The result is sorted by `(slug, version)` so callers iterate
 * deterministically.
 */
export async function listTenantVersions(): Promise<
  Array<{ slug: string; version: string; dir: string }>
> {
  const root = dataTenantsRoot();
  let rootEntries;
  try {
    rootEntries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isEnoent(error)) return [];
    throw error;
  }
  const slugs = rootEntries
    .filter((d) => d.isDirectory() && !d.name.startsWith("."))
    .map((d) => d.name)
    .sort();
  const out: Array<{ slug: string; version: string; dir: string }> = [];
  for (const slug of slugs) {
    const slugDir = path.join(root, slug);
    let versions: string[];
    try {
      versions = (await fs.readdir(slugDir, { withFileTypes: true }))
        .filter((d) => d.isDirectory() && !d.name.startsWith("."))
        .map((d) => d.name)
        .sort(compareTenantVersions);
    } catch (error) {
      // A slug may disappear between the root and child scans. Every other
      // failure is operational and must remain visible to bootstrap.
      if (isEnoent(error)) continue;
      throw error;
    }
    for (const v of versions) {
      const dir = path.join(slugDir, v);
      if (await regularFileExists(path.join(dir, "agentic.json"))) {
        out.push({ slug, version: v, dir });
      }
    }
  }
  return out;
}

/**
 * Resolve the live version for a tenant.
 *
 * Order:
 *   1. `deployments(target='tenant_code', status='live')` row's `version_id`,
 *      which we encode as `workflow_versions.version` set to the tenant code
 *      version string (e.g. "0.1.0"). Joins `workflow_versions` to read it.
 *   2. Highest-sorted version directory on disk for that slug.
 *   3. null.
 */
export async function resolveLiveVersion(
  slug: string,
): Promise<string | null> {
  // ── 1. DB-tracked live pointer ─────────────────────────────────────────
  const db = getDb();
  const tenant = db
    .select()
    .from(tenants)
    .where(eq(tenants.slug, slug))
    .all()[0];
  if (tenant) {
    const live = db
      .select({ version: workflowVersions.version })
      .from(deployments)
      .innerJoin(
        workflowVersions,
        eq(workflowVersions.id, deployments.versionId),
      )
      .where(
        and(
          eq(deployments.tenantId, tenant.id),
          eq(deployments.target, "tenant_code"),
          eq(deployments.status, "live"),
        ),
      )
      .orderBy(desc(deployments.deployedAt), desc(deployments.id))
      .all()[0];
    if (live?.version) {
      const dir = path.join(dataTenantsRoot(), slug, live.version);
      if (await regularFileExists(path.join(dir, "agentic.json"))) {
        return live.version;
      }
      // A live pointer is an explicit operator decision. Falling through to
      // another on-disk version would execute code that was never selected.
      throw new TenantCodeIntegrityError(
        `[tenant-loader] live tenant_code deployment for ${slug}@${live.version} has no agentic.json`,
      );
    }
  }

  // ── 2. Disk fallback ───────────────────────────────────────────────────
  const all = await listTenantVersions();
  const forSlug = all
    .filter((x) => x.slug === slug)
    .map((x) => x.version)
    .sort(compareTenantVersions);
  if (forSlug.length === 0) return null;
  return forSlug[forSlug.length - 1] ?? null;
}

/**
 * Load a tenant by slug + version. Reads `agentic.json` and dynamically
 * `import()`s the registry entrypoint.
 *
 * Returns null only when `agentic.json` is absent. Malformed/unreadable
 * manifests and declared-but-missing registries are integrity failures.
 */
export async function loadTenant(
  slug: string,
  version: string,
): Promise<LoadedTenant | null> {
  const dir = path.join(dataTenantsRoot(), slug, version);
  const manifestPath = path.join(dir, "agentic.json");
  let raw: string;
  try {
    raw = await fs.readFile(manifestPath, "utf8");
  } catch (error) {
    if (isEnoent(error)) return null;
    throw new TenantCodeIntegrityError(
      `[tenant-loader] ${slug}@${version}: agentic.json unreadable`,
      error,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new TenantCodeIntegrityError(
      `[tenant-loader] ${slug}@${version}: agentic.json is invalid JSON`,
      error,
    );
  }
  const manifestResult = TenantManifestSchema.safeParse(parsed);
  if (!manifestResult.success) {
    throw new TenantCodeIntegrityError(
      `[tenant-loader] ${slug}@${version}: invalid agentic.json (${manifestResult.error.issues
        .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
        .join("; ")})`,
    );
  }
  const manifest = manifestResult.data as TenantManifest;
  if (manifest.slug !== slug) {
    throw new TenantCodeIntegrityError(
      `[tenant-loader] ${slug}@${version}: agentic.json slug=${manifest.slug} mismatch`,
    );
  }

  const registryRel = manifest.code?.registry;
  let registry: TenantRegistry | null = null;
  if (registryRel) {
    const registryAbs = path.resolve(dir, registryRel);
    const relative = path.relative(dir, registryAbs);
    if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
      throw new TenantCodeIntegrityError(
        `[tenant-loader] ${slug}@${version}: registry path escapes the tenant package (${registryRel})`,
      );
    }
    if (!(await regularFileExists(registryAbs))) {
      // Some authors omit the explicit .ts extension; try that.
      const alt = registryAbs.endsWith(".ts") ? null : `${registryAbs}.ts`;
      if (alt && (await regularFileExists(alt))) {
        registry = await importTenantRegistry(alt, version);
      } else {
        throw new TenantCodeIntegrityError(
          `[tenant-loader] ${slug}@${version}: registry file missing at ${registryRel}`,
        );
      }
    } else {
      registry = await importTenantRegistry(registryAbs, version);
    }
  }

  return { slug, version, dir, manifest, registry };
}

/**
 * Dynamic import with a cache-busting query string. Node caches by URL, so
 * appending `?v=<version>&t=<mtime>` ensures hot-reload picks up a re-saved
 * file. The query string is ignored by the loader (tsx + Node's ESM loader
 * tolerate it).
 */
async function importTenantRegistry(
  absPath: string,
  version: string,
): Promise<TenantRegistry> {
  try {
    const st = await fs.stat(absPath);
    const url = `${pathToFileURL(absPath).href}?v=${encodeURIComponent(
      version,
    )}&t=${st.mtimeMs}`;
    const mod = (await import(url)) as { default?: TenantRegistry };
    if (!mod.default || typeof mod.default !== "object" || Array.isArray(mod.default)) {
      throw new TenantCodeIntegrityError(
        `[tenant-loader] tenant registry at ${absPath} must default-export an object`,
      );
    }
    return mod.default;
  } catch (err) {
    console.error(
      `[tenant-loader] failed to import tenant registry at ${absPath}`,
      err,
    );
    throw err;
  }
}

/**
 * Convenience: discover + load the LIVE version of every tenant on disk.
 *
 * Returns one entry per slug (only the resolved live version). Used by the
 * runtime bootstrap to compose the legacy hard-wired `TENANT_REGISTRIES`
 * with anything that's been deployed dynamically.
 */
export async function loadLiveTenants(): Promise<Map<string, LoadedTenant>> {
  const out = new Map<string, LoadedTenant>();
  const all = await listTenantVersions();
  // Include DB-selected tenants even when their entire directory vanished;
  // otherwise the stale live pointer would never be examined and bootstrap
  // would quietly omit the deployed tenant.
  const deployedSlugs = getDb()
    .select({ slug: tenants.slug })
    .from(deployments)
    .innerJoin(tenants, eq(tenants.id, deployments.tenantId))
    .where(
      and(
        eq(deployments.target, "tenant_code"),
        eq(deployments.status, "live"),
      ),
    )
    .all()
    .map((row) => row.slug);
  const slugs = Array.from(
    new Set([...all.map((x) => x.slug), ...deployedSlugs]),
  ).sort();
  for (const slug of slugs) {
    // Integrity failures stay FAIL-CLOSED per tenant (its code is NOT loaded — a live pointer
    // to a missing/altered bundle never falls through to unselected code) but must not brick
    // the whole api boot: one tenant's broken pointer previously crashed bootstrap for every
    // tenant. Quarantine to the slug, log loud, keep booting.
    try {
      const v = await resolveLiveVersion(slug);
      if (!v) continue;
      const loaded = await loadTenant(slug, v);
      if (loaded) out.set(slug, loaded);
    } catch (error) {
      try {
        console.error(
          `[tenant-loader] 跳过租户 ${slug} 的 tenant_code 加载（完整性/加载失败——该租户代码不生效，boot 继续）：${String((error as Error)?.message ?? error).slice(0, 300)}`,
        );
      } catch { /* best-effort */ }
    }
  }
  return out;
}

/**
 * Sprint 4 — Defensive assert that a tenant registry exposes every prompt a
 * manifest's `logic` actions reference. Throws a single concise diagnostic
 * naming the missing keys; intended for use in test `beforeEach` blocks
 * (and any future hot-reload path) to fail loud and early when a registry
 * has been wired with a partial `prompts` map.
 *
 * This is a strictly stronger statement than `findMissingTenantPrompts` in
 * `register.ts`: that helper walks the manifest to compute missing entries
 * at boot. This helper accepts the expected key list directly so tests can
 * lock down the contract without re-loading manifests.
 *
 * Returns silently when every required key is present. The returned object
 * is only useful for assertions that want to count entries — most callers
 * should just rely on the throw.
 */
export function assertTenantRegistryComplete(
  slug: string,
  registry: { prompts?: Record<string, unknown> } | null | undefined,
  requiredActionNames: ReadonlyArray<string>,
): { matched: number; required: number } {
  const prompts = registry?.prompts ?? {};
  const missing = requiredActionNames.filter((name) => !prompts[name]);
  if (missing.length > 0) {
    throw new Error(
      `[tenant ${slug}] registry missing ${missing.length} prompt(s): ${missing.join(", ")}`,
    );
  }
  return {
    matched: requiredActionNames.length,
    required: requiredActionNames.length,
  };
}
