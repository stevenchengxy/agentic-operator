/**
 * Workflow manifest read/write surface.
 *
 *   GET  /v1/tenants/:slug/workflow      → current manifest + schema metadata
 *   PUT  /v1/tenants/:slug/workflow      → save a new version (writes next _vN file)
 *
 * The PUT endpoint is the editor's save path. It Zod-parses the incoming
 * manifest with `WorkflowManifestSchema`, writes the result as the next
 * versioned file in `models/<slug>-v<N+1>/workflow_v<N+1>.json`, and calls
 * `reregisterInngest()` to hot-swap the live function set without an api
 * restart.
 *
 * Versioning: each save creates a new sibling directory `<slug>-v<N+1>` so
 * older versions remain on disk for rollback. Inngest functions for this
 * tenant rebind to the new manifest the next time an event fires.
 */

import type { FastifyInstance } from "fastify";
import { readdir, readFile, mkdir, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  WorkflowManifestSchema,
  tenantSlugFromFolder,
  CURRENT_SCHEMA_VERSION,
  buildWorkflowJsonSchema,
} from "@agentic/runtime";
import { requireAuth } from "../../plugins/auth";
import { requirePermission } from "../../plugins/rbac";
import { writeAudit } from "../../plugins/audit";
import { reregisterInngest } from "../../services/inngest-registry";

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
async function findTenantDirs(slug: string): Promise<
  Array<{ folder: string; version: number; absDir: string }>
> {
  const root = modelsRoot();
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return [];
  }
  const matches: Array<{ folder: string; version: number; absDir: string }> = [];
  for (const folder of entries) {
    if (folder.startsWith(".")) continue;
    const abs = path.join(root, folder);
    let isDir = false;
    try {
      isDir = (await stat(abs)).isDirectory();
    } catch {
      continue;
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
async function pickNextWorkflowFilename(dir: string): Promise<{ filename: string; nextVersion: number }> {
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

function serializeManifest(manifest: ReadonlyArray<Record<string, unknown>>): string {
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
        return reply.fail("forbidden", "cannot read another tenant's workflow", 403);
      }
      const dirs = await findTenantDirs(slug);
      if (dirs.length === 0) {
        return reply.fail("not_found", `no models directory for tenant ${slug}`, 404);
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
        return reply.fail("not_found", `no workflow.json in ${active.folder}`, 404);
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
      return reply.fail("forbidden", "cannot write another tenant's workflow", 403);
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
      return reply.fail("invalid_manifest", "manifest failed Zod validation", 400, hint);
    }

    const dirs = await findTenantDirs(slug);
    if (dirs.length === 0) {
      return reply.fail("not_found", `no models directory for tenant ${slug}`, 404);
    }
    const active = dirs[0]!;

    // Resolve the target filename + version based on mode.
    let filename: string;
    let savedVersion: number;
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
      const existing: string[] = await readdir(active.absDir).catch(() => [] as string[]);
      if (!existing.includes(targetFile)) {
        return reply.fail(
          "not_found",
          `target_file ${targetFile} does not exist in ${active.folder}`,
          404,
        );
      }
      filename = targetFile;
      savedVersion = m[1] ? Number(m[1]) : 1;
    } else {
      const picked = await pickNextWorkflowFilename(active.absDir);
      filename = picked.filename;
      savedVersion = picked.nextVersion;
    }
    const targetPath = path.join(active.absDir, filename);

    // Serialize with stable key order so diffs stay legible.
    const text = serializeManifest(
      parsed.data as ReadonlyArray<Record<string, unknown>>,
    );
    await mkdir(active.absDir, { recursive: true });
    await writeFile(targetPath, text, "utf8");

    // Hot-swap Inngest functions for this tenant. Failure here is logged
    // but doesn't block the save — the file is on disk and the next api
    // restart will pick it up.
    let fnCount = -1;
    try {
      const r = await reregisterInngest({ tenantSlug: slug, scope: "tenant" });
      fnCount = r.fnCount;
    } catch (err) {
      req.log.warn({ err }, "workflow save: inngest re-register skipped");
    }

    writeAudit({
      tenantId: auth.tenantId,
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
