/**
 * Workflow manifest read/write surface.
 *
 *   GET  /v1/tenants/:slug/workflow      → current manifest + schema metadata
 *   PUT  /v1/tenants/:slug/workflow      → save a new version (writes next _vN file)
 *
 * The PUT endpoint is the editor's save path. It Zod-parses the incoming
 * manifest with `WorkflowManifestSchema`, writes the result as the next
 * versioned file in `models/<slug>-v<N+1>/workflow_v<N+1>.json`, and calls
 * rebuilds the local registry and synchronizes the tenant app with Inngest.
 *
 * Versioning: each save creates a new sibling directory `<slug>-v<N+1>` so
 * older versions remain on disk for rollback. Inngest functions for this
 * tenant rebind to the new manifest the next time an event fires.
 */

import type { FastifyInstance } from "fastify";
import { readdir, readFile, mkdir, open, rename, rm, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  WorkflowManifestSchema,
  tenantSlugFromFolder,
  CURRENT_SCHEMA_VERSION,
  buildWorkflowJsonSchema,
} from "@agentic/runtime";
import { requirePermission } from "../../plugins/rbac";
import { writeAudit } from "../../plugins/audit";
import { reregisterInngest } from "../../services/inngest-registry";
import { syncTenantApp } from "../../services/inngest-sync";
import { findWorkflowSecretPolicyIssues } from "../../services/workflow-secret-policy";

/**
 * Cache the JSON Schema build: it's pure and depends only on the Zod
 * source. The first request pays the build cost; subsequent ones hit
 * the in-memory cache and are essentially free.
 */
let cachedJsonSchema: Record<string, unknown> | null = null;
function getCachedJsonSchema(): Record<string, unknown> {
  if (!cachedJsonSchema) cachedJsonSchema = buildWorkflowJsonSchema();
  return cachedJsonSchema;
}

function modelsRoot(): string {
  const env = process.env.AGENTIC_MODELS_DIR;
  if (!env) {
    throw new Error(
      "AGENTIC_MODELS_DIR is not set — the api process must point at a models directory.",
    );
  }
  return path.isAbsolute(env) ? env : path.resolve(process.cwd(), env);
}

/**
 * Return all folders under AGENTIC_MODELS_DIR whose derived slug matches.
 * E.g. for slug "raas" this returns [{ folder: "RAAS-v1", version: 1, ... }, …]
 * sorted by version descending so element [0] is the active manifest dir.
 */
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
  const matches: Array<{ folder: string; version: number; absDir: string }> =
    [];
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

/**
 * Pick the next workflow file path in a tenant dir. If `workflow_v3.json`
 * exists we write `workflow_v4.json`. Bare `workflow.json` (no suffix) is
 * treated as v1.
 */
async function pickNextWorkflowFilename(
  dir: string,
): Promise<{ filename: string; nextVersion: number }> {
  let files: string[] = [];
  try {
    files = await readdir(dir);
  } catch {
    files = [];
  }
  let max = 0;
  for (const f of files) {
    const m = f.match(/^workflow(?:_v(\d+))?\.json$/i);
    if (!m) continue;
    const v = m[1] ? Number(m[1]) : 1;
    if (v > max) max = v;
  }
  const next = max + 1;
  return { filename: `workflow_v${next}.json`, nextVersion: next };
}

/** Atomically replace a workflow file after forcing its bytes to stable storage. */
async function writeWorkflowFile(targetPath: string, text: string): Promise<void> {
  const tmp = `${targetPath}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(tmp, "wx", 0o600);
    await handle.writeFile(text, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(tmp, targetPath);
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function reserveNextWorkflowFilename(
  dir: string,
): Promise<{ filename: string; nextVersion: number; path: string }> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const picked = await pickNextWorkflowFilename(dir);
    const candidate = path.join(dir, picked.filename);
    try {
      const reservation = await open(candidate, "wx", 0o600);
      await reservation.close();
      return { ...picked, path: candidate };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      await rm(candidate, { force: true }).catch(() => undefined);
      throw error;
    }
  }
  throw new Error("could not reserve a unique workflow version after 8 attempts");
}

/**
 * Stable head ordering for an agent object: well-known keys first, then
 * alpha. Keeps git diffs readable across editor and hand edits.
 */
const AGENT_KEY_ORDER = [
  "id",
  "name",
  "title",
  "description",
  "actor",
  "trigger",
  "input_data",
  "ontology_instructions",
  "actions",
  "typescript_code",
  "tool_use",
  "retries",
  "timeout_s",
  "model",
  "concurrency",
  "cron",
  "cron_timezone",
  "triggered_event",
];

function reorderAgent(agent: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of AGENT_KEY_ORDER) {
    if (k in agent) out[k] = agent[k];
  }
  for (const k of Object.keys(agent).sort()) {
    if (!(k in out)) out[k] = agent[k];
  }
  return out;
}

function serializeManifest(
  manifest: ReadonlyArray<Record<string, unknown>>,
): string {
  const ordered = manifest.map(reorderAgent);
  return JSON.stringify(ordered, null, 2) + "\n";
}

export async function workflowRoutes(app: FastifyInstance) {
  // GET /v1/workflow/schema — return the editor-facing JSON Schema.
  // The schema is generated from the Zod canonical source at boot; this
  // endpoint just serves the cached blob so the editor can validate
  // against the exact same shape the runtime enforces. No auth: it's a
  // public schema definition, not tenant data.
  app.get("/workflow/schema", async (_req, reply) => {
    return reply.ok({
      schema: getCachedJsonSchema(),
      schema_version: CURRENT_SCHEMA_VERSION,
    });
  });

  // GET /v1/tenants/:slug/workflow — read the current on-disk manifest plus
  // the active version metadata. The editor uses this as its initial load.
  app.get<{ Params: { slug: string } }>(
    "/tenants/:slug/workflow",
    async (req, reply) => {
      const auth = requirePermission(req, "workflows.read");
      const slug = req.params.slug;
      if (auth.tenantSlug !== slug) {
        return reply.fail(
          "forbidden",
          "cannot read another tenant's workflow",
          403,
        );
      }
      const dirs = await findTenantDirs(slug);
      if (dirs.length === 0) {
        return reply.fail(
          "not_found",
          `no models directory for tenant ${slug}`,
          404,
        );
      }
      const active = dirs[0]!;
      const files = await readdir(active.absDir);
      // Prefer the highest-versioned `workflow_v<N>.json`; fall back to bare
      // `workflow.json` (treated as v1). The editor uses `file_version` to
      // compute the next save target (N + 1).
      const sortedByVersion = files
        .filter((f) => /^workflow(?:_v\d+)?\.json$/i.test(f))
        .map((f) => {
          const m = f.match(/^workflow(?:_v(\d+))?\.json$/i);
          return { file: f, version: m && m[1] ? Number(m[1]) : 1 };
        })
        .sort((a, b) => b.version - a.version);
      const top = sortedByVersion[0];
      if (!top) {
        return reply.fail(
          "not_found",
          `no workflow.json in ${active.folder}`,
          404,
        );
      }
      const raw = JSON.parse(
        await readFile(path.join(active.absDir, top.file), "utf8"),
      );
      const manifest = WorkflowManifestSchema.parse(raw);
      return reply.ok({
        slug,
        folder: active.folder,
        folder_version: active.version,
        file: top.file,
        file_version: top.version,
        schema_version: CURRENT_SCHEMA_VERSION,
        manifest,
      });
    },
  );

  // PUT /v1/tenants/:slug/workflow — save the manifest.
  //
  // Two modes (selected by the `mode` body field):
  //   - "new_version" (default): write `workflow_v<N+1>.json` so older
  //     versions stay on disk for rollback. Use this for "Save as".
  //   - "overwrite": replace an existing `workflow_v<N>.json` in place.
  //     The file is identified by `target_file` (must match the safe
  //     `workflow(_v<N>)?.json` pattern and exist in the tenant dir).
  //     Use this for plain "Save" — the file the editor loaded from.
  app.put<{
    Params: { slug: string };
    Body: {
      manifest: unknown;
      comment?: string;
      mode?: "new_version" | "overwrite";
      target_file?: string;
    };
  }>("/tenants/:slug/workflow", async (req, reply) => {
    const auth = requirePermission(req, "workflows.write");
    const slug = req.params.slug;
    if (auth.tenantSlug !== slug) {
      return reply.fail(
        "forbidden",
        "cannot write another tenant's workflow",
        403,
      );
    }
    if (!req.body || typeof req.body !== "object") {
      return reply.fail(
        "bad_request",
        "body must be { manifest, mode?, target_file?, comment? }",
        400,
      );
    }
    const body = req.body;
    const mode = body.mode === "overwrite" ? "overwrite" : "new_version";
    const parsed = WorkflowManifestSchema.safeParse(body.manifest);
    if (!parsed.success) {
      const hint = parsed.error.issues
        .slice(0, 6)
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ");
      return reply.fail(
        "invalid_manifest",
        "manifest failed Zod validation",
        400,
        hint,
      );
    }

    // This legacy editor route writes directly to the live models directory,
    // bypassing the immutable authoring/import services. Enforce the same
    // tenant-scoped credential and endpoint policy before resolving a target
    // file so a rejected payload cannot create or overwrite any artifact.
    const policyIssues = findWorkflowSecretPolicyIssues(
      parsed.data,
      undefined,
      { tenantSlug: slug },
    );
    if (policyIssues.length > 0) {
      return reply.fail(
        "invalid_workflow_manifest",
        "workflow contains forbidden credentials, secret references, or endpoints",
        400,
        undefined,
        { issues: policyIssues },
      );
    }

    const dirs = await findTenantDirs(slug);
    if (dirs.length === 0) {
      return reply.fail(
        "not_found",
        `no models directory for tenant ${slug}`,
        404,
      );
    }
    const active = dirs[0]!;

    // Resolve the target filename + version based on mode.
    let filename: string;
    let savedVersion: number;
    let reservedNewPath: string | null = null;
    let previousText: string | null = null;
    if (mode === "overwrite") {
      const targetFile = body.target_file;
      if (!targetFile || typeof targetFile !== "string") {
        return reply.fail(
          "bad_request",
          "overwrite mode requires `target_file`",
          400,
        );
      }
      // Defense in depth: reject any path traversal and require the
      // canonical workflow filename shape.
      const m = targetFile.match(/^workflow(?:_v(\d+))?\.json$/i);
      if (!m) {
        return reply.fail(
          "bad_request",
          "target_file must match `workflow.json` or `workflow_v<N>.json`",
          400,
        );
      }
      // Verify the file already exists in the tenant dir — overwrite is
      // only for files we previously served. New files must use new_version.
      const existing: string[] = await readdir(active.absDir).catch(
        () => [] as string[],
      );
      if (!existing.includes(targetFile)) {
        return reply.fail(
          "not_found",
          `target_file ${targetFile} does not exist in ${active.folder}`,
          404,
        );
      }
      filename = targetFile;
      savedVersion = m[1] ? Number(m[1]) : 1;
      previousText = await readFile(path.join(active.absDir, targetFile), "utf8");
    } else {
      const picked = await reserveNextWorkflowFilename(active.absDir);
      filename = picked.filename;
      savedVersion = picked.nextVersion;
      reservedNewPath = picked.path;
    }
    const targetPath = path.join(active.absDir, filename);

    // Serialize with stable key order so diffs stay legible.
    const text = serializeManifest(
      parsed.data as ReadonlyArray<Record<string, unknown>>,
    );
    await mkdir(active.absDir, { recursive: true });
    try {
      await writeWorkflowFile(targetPath, text);
      reservedNewPath = null;
    } catch (error) {
      if (reservedNewPath) await rm(reservedNewPath, { force: true }).catch(() => undefined);
      throw error;
    }

    // A save is not complete until the real tenant app has been rebuilt and
    // synchronized with Inngest. Returning success for "disk only" left the
    // editor showing a version the runtime was not executing.
    let registered: Awaited<ReturnType<typeof reregisterInngest>>;
    try {
      registered = await reregisterInngest({ tenantSlug: slug, scope: "tenant" });
      const sync = await syncTenantApp(slug, {
        info: (message) => req.log.info({ tenantSlug: slug }, message),
        warn: (message) => req.log.warn({ tenantSlug: slug }, message),
      });
      if (!sync.ok) {
        throw new Error(
          `Inngest rejected tenant app sync${sync.status ? ` (${sync.status})` : ""}: ${sync.error ?? "unknown error"}`,
        );
      }
    } catch (error) {
      let rollbackError: unknown = null;
      try {
        if (mode === "new_version") {
          await rm(targetPath, { force: true });
        } else if (previousText !== null) {
          await writeWorkflowFile(targetPath, previousText);
        }
        // Rebuild the in-process registry from the restored source. The
        // broker may still be unavailable, but a second failure is retained
        // in the surfaced aggregate instead of being swallowed.
        await reregisterInngest({ tenantSlug: slug, scope: "tenant" });
        const rollbackSync = await syncTenantApp(slug, {
          info: (message) => req.log.info({ tenantSlug: slug, rollback: true }, message),
          warn: (message) => req.log.warn({ tenantSlug: slug, rollback: true }, message),
        });
        if (!rollbackSync.ok) {
          throw new Error(
            `restored workflow could not be synchronized with Inngest${rollbackSync.status ? ` (${rollbackSync.status})` : ""}: ${rollbackSync.error ?? "unknown error"}`,
          );
        }
      } catch (rollbackFailure) {
        rollbackError = rollbackFailure;
      }
      req.log.error(
        { err: error, rollbackErr: rollbackError, file: targetPath },
        "workflow save failed to synchronize; source rollback attempted",
      );
      writeAudit({
        tenantId: auth.tenantId,
        actorUserId: auth.userId ?? undefined,
        action: "workflow.save.failed",
        targetType: "workflow",
        targetId: filename,
        meta: {
          mode,
          error: String((error as Error)?.message ?? error).slice(0, 500),
          rollback_ok: rollbackError === null,
          rollback_error: rollbackError
            ? String((rollbackError as Error)?.message ?? rollbackError).slice(0, 500)
            : null,
        },
      });
      if (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "workflow save and runtime rollback both failed",
        );
      }
      throw error;
    }
    const fnCount = registered.appFnCount ?? registered.fnCount;

    writeAudit({
      tenantId: auth.tenantId,
      actorUserId: auth.userId ?? undefined,
      action: "workflow.save",
      targetType: "workflow",
      targetId: filename,
      meta: {
        folder: active.folder,
        file: filename,
        file_version: savedVersion,
        mode,
        schema_version: CURRENT_SCHEMA_VERSION,
        agent_count: parsed.data.length,
        comment: body.comment ?? "",
        inngest_fns: fnCount,
      },
    });

    return reply.ok({
      slug,
      folder: active.folder,
      file: filename,
      file_version: savedVersion,
      mode,
      schema_version: CURRENT_SCHEMA_VERSION,
      agent_count: parsed.data.length,
      inngest_fns: fnCount,
    });
  });
}
