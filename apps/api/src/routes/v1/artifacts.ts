import type { FastifyInstance } from "fastify";
import path from "node:path";
import { realpath, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { and, asc, eq } from "drizzle-orm";
import { artifacts, getDb, runs } from "@agentic/db";
import { artifactsRoot } from "@agentic/runtime";
import { requireAuth } from "../../plugins/auth";
import { artifactMetadata } from "../../services/studio-observability";

function safeDownloadName(
  logicalName: string | null,
  artifactId: string,
): string {
  const requested = logicalName ?? `${artifactId}.bin`;
  const leaf = path.posix.basename(requested.replaceAll("\\", "/"));
  return (
    leaf
      .replaceAll(/[\u0000-\u001f\u007f-\uffff]/g, "_")
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
      const auth = requireAuth(req);
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
    const auth = requireAuth(req);
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
    reply
      .header("Content-Type", safeContentType(row.contentType ?? row.kind))
      .header("Content-Length", String(resolvedSize))
      .header(
        "Content-Disposition",
        `attachment; filename="${safeDownloadName(row.logicalName, row.id)}"`,
      );
    return reply.send(createReadStream(resolvedPath));
  });
}
