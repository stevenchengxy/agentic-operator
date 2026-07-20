import type { FastifyInstance } from "fastify";
import path from "node:path";
import { realpath, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { and, asc, eq } from "drizzle-orm";
import { artifacts, getDb, runs } from "@agentic/db";
import { artifactsRoot } from "@agentic/runtime";
import { requirePermission } from "../../plugins/rbac";
import { artifactMetadata } from "../../services/studio-observability";

// Strip path separators, control characters, and non-ASCII from a stored
// logical name before it is echoed into Content-Disposition.
const UNSAFE_FILENAME_CHARS = new RegExp("[\\u0000-\\u001f\\u007f-\\uffff]", "g");

function safeDownloadName(
  logicalName: string | null,
  artifactId: string,
): string {
  const requested = logicalName ?? `${artifactId}.bin`;
  const leaf = path.posix.basename(requested.replaceAll("\\", "/"));
  return (
    leaf
      .replaceAll(UNSAFE_FILENAME_CHARS, "_")
      .replaceAll(/[";\\/]/g, "_")
      .slice(0, 180) || `${artifactId}.bin`
  );
}

function pathIsWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative.length > 0 &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== ".." &&
    !path.isAbsolute(relative)
  );
}

function safeContentType(value: string | null): string {
  return value && /^[\x20-\x7e]+$/.test(value) && !/[\r\n]/.test(value)
    ? value
    : "application/octet-stream";
}

export async function artifactsRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>(
    "/runs/:id/artifacts",
    async (req, reply) => {
      const auth = requirePermission(req, "runs.read");
      const db = getDb();
      const ownedRun = db
        .select({ id: runs.id })
        .from(runs)
        .where(
          and(eq(runs.id, req.params.id), eq(runs.tenantId, auth.tenantId)),
        )
        .limit(1)
        .all()[0];
      if (!ownedRun) return reply.fail("not_found", "run not found", 404);
      const rows = db
        .select()
        .from(artifacts)
        .where(
          and(
            eq(artifacts.runId, req.params.id),
            eq(artifacts.tenantId, auth.tenantId),
          ),
        )
        .orderBy(asc(artifacts.createdAt), asc(artifacts.id))
        .all();
      return reply.ok(
        rows.map((row) => ({
          ...artifactMetadata(row),
          kind: row.kind,
          downloadPath: `/v1/artifacts/${row.id}`,
        })),
      );
    },
  );

  app.get<{ Params: { id: string } }>("/artifacts/:id", async (req, reply) => {
    const auth = requirePermission(req, "runs.read");
    const row = getDb()
      .select()
      .from(artifacts)
      .where(
        and(
          eq(artifacts.id, req.params.id),
          eq(artifacts.tenantId, auth.tenantId),
        ),
      )
      .all()[0];
    if (!row) return reply.fail("not_found", "artifact not found", 404);
    if (row.retentionUntil && row.retentionUntil.getTime() <= Date.now()) {
      return reply.fail("gone", "artifact retention period has expired", 410);
    }

    // Path-traversal guard: the DB row's path must resolve (post-symlink)
    // inside the configured artifact root, and must be a regular file. A row
    // pointing anywhere else — however it got there — is treated as gone.
    let resolvedPath: string;
    let resolvedSize: number;
    try {
      const [root, artifactPath] = await Promise.all([
        realpath(path.resolve(artifactsRoot())),
        realpath(row.path),
      ]);
      if (!pathIsWithin(root, artifactPath)) {
        req.log.warn(
          { artifactId: row.id, action: "artifact.path_rejected" },
          "artifact path resolved outside the configured artifact root",
        );
        return reply.fail("gone", "artifact file unavailable", 410);
      }
      const file = await stat(artifactPath);
      if (!file.isFile()) {
        return reply.fail("gone", "artifact file unavailable", 410);
      }
      resolvedPath = artifactPath;
      resolvedSize = file.size;
    } catch {
      return reply.fail("gone", "artifact file missing", 410);
    }
    const contentType = safeContentType(row.contentType ?? row.kind);
    reply
      .header("Content-Type", contentType)
      .header("Content-Length", String(resolvedSize))
      .header("X-Content-Type-Options", "nosniff")
      .header(
        "Content-Disposition",
        `attachment; filename="${safeDownloadName(row.logicalName, row.id)}"`,
      );
    // HTML artifacts are LLM/agent-authored (e.g. factory reports) — render them in a
    // sandboxed, script-less, unique origin so a hostile artifact can never execute at
    // the portal origin (stored-XSS chokepoint). Static report HTML/SVG/CSS is unaffected.
    if (contentType.startsWith("text/html")) {
      reply.header(
        "Content-Security-Policy",
        "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:",
      );
    }
    return reply.send(createReadStream(resolvedPath));
  });
}
