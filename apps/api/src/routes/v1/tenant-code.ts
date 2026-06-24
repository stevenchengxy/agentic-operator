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
 *   1. Extract to `data/tenants/<slug>/<version>.tmp-<rand>/` so a half-
 *      extracted tree never appears as live.
 *   2. Validate the tree (must contain `agentic.json`).
 *   3. fs.rename(tmpDir → finalDir) — atomic on the same filesystem.
 *   4. Insert workflow_version (version = tenant code version) + deployment
 *      row + flip the prior live row to `rolled_back`.
 *   5. Call `reregisterInngest()` to swap in the new Inngest functions.
 *
 * Errors:
 *   - `tarball_invalid` (400) — base64 decode failed or tar contained no
 *     `agentic.json`.
 *   - `version_exists` (409) — the target dir already contains a release of
 *     this version (refuse to overwrite — bump the version string).
 *   - `slug_unknown` (404) — no tenant row matches the slug.
 *
 * Caller can rollback via `POST /v1/deployments/:id/rollback`.
 */

import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { promisify } from "node:util";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import {
  deployments,
  getDb,
  tenants,
  workflows,
  workflowVersions,
} from "@agentic/db";
import { makeId } from "@agentic/shared";
import { dataTenantsRoot, publishStreamEvent } from "@agentic/runtime";
import { requireAuth } from "../../plugins/auth";
import { requirePermission } from "../../plugins/rbac";
import { writeAudit } from "../../plugins/audit";
import { reregisterInngest } from "../../services/inngest-registry";

const gunzip = promisify(zlib.gunzip);

const TENANT_CODE_WORKFLOW_SLUG = "__tenant_code__";

const UploadBody = z.object({
  version: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9._-]+$/, "version must be alnum/./_/-"),
  tarballBase64: z.string().min(1),
  note: z.string().max(1024).optional(),
});

export async function tenantCodeRoutes(app: FastifyInstance) {
  app.post<{ Params: { slug: string } }>(
    "/tenants/:slug/code",
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

      const parsed = UploadBody.parse(req.body);
      const db = getDb();

      const tenant = db
        .select()
        .from(tenants)
        .where(eq(tenants.slug, slug))
        .all()[0];
      if (!tenant) {
        return reply.fail("slug_unknown", `tenant slug=${slug} not found`, 404);
      }

      const finalDir = path.join(dataTenantsRoot(), slug, parsed.version);
      if (existsSync(finalDir)) {
        return reply.fail(
          "version_exists",
          `version ${parsed.version} already exists for tenant ${slug}; bump and retry`,
          409,
        );
      }

      // ── 1. Decode + extract ──────────────────────────────────────────
      let tarballBytes: Buffer;
      try {
        tarballBytes = Buffer.from(parsed.tarballBase64, "base64");
        if (tarballBytes.length === 0) throw new Error("empty");
      } catch (err) {
        return reply.fail(
          "tarball_invalid",
          `tarballBase64 decode failed: ${(err as Error).message}`,
          400,
        );
      }

      // gzip magic = 1f 8b
      let raw: Buffer;
      if (tarballBytes[0] === 0x1f && tarballBytes[1] === 0x8b) {
        try {
          raw = await gunzip(tarballBytes);
        } catch (err) {
          return reply.fail(
            "tarball_invalid",
            `gunzip failed: ${(err as Error).message}`,
            400,
          );
        }
      } else {
        raw = tarballBytes;
      }

      const tmpDir = path.join(
        dataTenantsRoot(),
        slug,
        `.tmp-${parsed.version}-${crypto.randomBytes(4).toString("hex")}`,
      );
      try {
        await fs.mkdir(tmpDir, { recursive: true });
        const entries = parseTarball(raw);
        if (entries.length === 0) {
          return reply.fail("tarball_invalid", "tarball contained no files", 400);
        }
        let sawManifest = false;
        for (const e of entries) {
          if (e.path === "agentic.json") sawManifest = true;
          await writeEntry(tmpDir, e);
        }
        if (!sawManifest) {
          return reply.fail(
            "tarball_invalid",
            "tarball missing agentic.json at the root",
            400,
          );
        }

        // ── 2. Atomic rename ──────────────────────────────────────────
        await fs.rename(tmpDir, finalDir);
      } catch (err) {
        // Best-effort cleanup of the partial tmp dir.
        try {
          await fs.rm(tmpDir, { recursive: true, force: true });
        } catch {
          // ignore
        }
        if (
          err &&
          typeof err === "object" &&
          "statusCode" in err &&
          typeof (err as { statusCode?: unknown }).statusCode === "number"
        ) {
          throw err;
        }
        return reply.fail(
          "tarball_invalid",
          `extract failed: ${(err as Error).message}`,
          400,
        );
      }

      // ── 3. DB rows: workflow + workflow_version + deployment ─────────
      let codeWorkflow = db
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
        const wid = makeId("wf");
        db.insert(workflows)
          .values({
            id: wid,
            tenantId: tenant.id,
            slug: TENANT_CODE_WORKFLOW_SLUG,
            name: `${slug} (tenant code)`,
          })
          .onConflictDoNothing({ target: [workflows.tenantId, workflows.slug] })
          .run();
        codeWorkflow = db
          .select()
          .from(workflows)
          .where(
            and(
              eq(workflows.tenantId, tenant.id),
              eq(workflows.slug, TENANT_CODE_WORKFLOW_SLUG),
            ),
          )
          .all()[0]!;
      }

      let wfv = db
        .select()
        .from(workflowVersions)
        .where(
          and(
            eq(workflowVersions.workflowId, codeWorkflow.id),
            eq(workflowVersions.version, parsed.version),
          ),
        )
        .all()[0];
      if (!wfv) {
        const wfvId = makeId("wfv");
        db.insert(workflowVersions)
          .values({
            id: wfvId,
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
        wfv = db
          .select()
          .from(workflowVersions)
          .where(eq(workflowVersions.id, wfvId))
          .all()[0]!;
      }

      const dplId = makeId("dpl");
      db.transaction(() => {
        db.update(deployments)
          .set({ status: "rolled_back" })
          .where(
            and(
              eq(deployments.tenantId, tenant.id),
              eq(deployments.target, "tenant_code"),
              eq(deployments.status, "live"),
            ),
          )
          .run();
        db.insert(deployments)
          .values({
            id: dplId,
            tenantId: tenant.id,
            target: "tenant_code",
            versionId: wfv.id,
            status: "live",
            note: parsed.note ?? null,
          })
          .run();
      });

      // ── 4. Hot-swap Inngest functions for this tenant ────────────────
      const reregister = await reregisterInngest({ tenantSlug: slug });

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
        action: "tenant.code.upload",
        targetType: "deployment",
        targetId: dplId,
        meta: {
          slug,
          version: parsed.version,
          file_count: countTarballFiles(finalDir),
          inngest_fns: reregister.fnCount,
        },
      });

      return reply.ok(
        {
          deployment_id: dplId,
          slug,
          version: parsed.version,
          dir: finalDir,
          inngest_fns: reregister.fnCount,
          note: "tenant code live; new events route to the new version",
        },
        201,
      );
    },
  );
}

// ─── Cheap directory-file count helper for audit metadata ───────────────────

function countTarballFiles(dir: string): number {
  // Synchronous count; small bound (`tar files`) so avoiding async is fine.
  let n = 0;
  const stack = [dir];
  // We use the sync fs API here because audit metadata isn't latency-
  // sensitive and `fs.promises.readdir` recursive would be more code.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fsSync = require("node:fs") as typeof import("node:fs");
  while (stack.length > 0) {
    const cur = stack.pop()!;
    let entries;
    try {
      entries = fsSync.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) n++;
    }
  }
  return n;
}

// ─── Minimal POSIX/ustar tar reader ─────────────────────────────────────────
//
// Avoids pulling in `tar` / `tar-stream` as a direct dep. The format is one
// 512-byte header followed by the file contents rounded up to 512.
//
// We support the bare minimum:
//   - Regular files (`typeflag` in {'0', '\0'} or absent)
//   - Directories (`typeflag === '5'`) — we ignore; we mkdir on each file path.
//   - GNU long-name extension (`typeflag === 'L'`) so node-tar generated
//     archives with paths >100 chars work.
//
// Symlinks, hardlinks, char/block devices, sparse files, PAX extended
// headers are rejected by silently skipping (tenants shouldn't ship them).

interface TarEntry {
  path: string;
  content: Buffer;
  mode: number;
}

function parseTarball(buf: Buffer): TarEntry[] {
  const out: TarEntry[] = [];
  let pos = 0;
  let nextLongName: string | null = null;
  while (pos + 512 <= buf.length) {
    const hdr = buf.subarray(pos, pos + 512);
    pos += 512;
    if (hdr.every((b) => b === 0)) break; // end-of-archive
    const name = readStr(hdr, 0, 100);
    const prefix = readStr(hdr, 345, 155);
    const sizeOct = readStr(hdr, 124, 12).trim();
    const size = sizeOct ? parseInt(sizeOct, 8) : 0;
    const modeOct = readStr(hdr, 100, 8).trim();
    const mode = modeOct ? parseInt(modeOct, 8) : 0o644;
    const typeflag = String.fromCharCode(hdr[156] ?? 0);
    let entryPath = prefix ? `${prefix}/${name}` : name;
    if (nextLongName !== null) {
      entryPath = nextLongName;
      nextLongName = null;
    }
    const dataLen = size;
    const blockLen = Math.ceil(dataLen / 512) * 512;
    const content = buf.subarray(pos, pos + dataLen);
    pos += blockLen;

    if (typeflag === "L") {
      // GNU long-name extension; the file's actual name is in this block.
      nextLongName = content.toString("utf8").replace(/\0+$/, "");
      continue;
    }
    if (typeflag === "5") {
      // Directory — we synthesize them on write, skip.
      continue;
    }
    if (typeflag !== "0" && typeflag !== "" && typeflag !== "\0") {
      // Unsupported (symlink, etc.) — drop.
      continue;
    }
    if (!entryPath) continue;

    out.push({ path: entryPath, content, mode });
  }
  return out;
}

function readStr(buf: Buffer, off: number, len: number): string {
  let end = off;
  while (end < off + len && buf[end] !== 0) end++;
  return buf.toString("utf8", off, end);
}

async function writeEntry(rootDir: string, entry: TarEntry): Promise<void> {
  // Path safety: refuse anything that tries to escape rootDir.
  const normalized = path.normalize(entry.path).replace(/^\/+/, "");
  if (normalized.startsWith("..") || path.isAbsolute(normalized)) {
    throw new Error(`unsafe path in tarball: ${entry.path}`);
  }
  // Strip a single leading dir component if every file shares it (common when
  // people `tar -czf foo.tgz mydir/`).
  const dest = path.join(rootDir, normalized);
  const parent = path.dirname(dest);
  await fs.mkdir(parent, { recursive: true });
  await fs.writeFile(dest, entry.content, { mode: entry.mode || 0o644 });
}
