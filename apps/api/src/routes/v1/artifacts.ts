import type { FastifyInstance } from "fastify";
import { stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { eq } from "drizzle-orm";
import { artifacts, getDb } from "@agentic/db";
import { requirePermission } from "../../plugins/rbac";

export async function artifactsRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>("/artifacts/:id", async (req, reply) => {
    const auth = requirePermission(req, "runs.read");
    const row = getDb()
      .select()
      .from(artifacts)
      .where(eq(artifacts.id, req.params.id))
      .all()[0];
    if (!row) return reply.fail("not_found", "artifact not found", 404);
    if (row.tenantId !== auth.tenantId)
      return reply.fail("forbidden", "forbidden", 403);

    try {
      await stat(row.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return reply.fail("gone", "artifact file missing", 410);
      }
      throw error;
    }
    reply
      .header("Content-Type", row.kind ?? "application/octet-stream")
      .header("Content-Length", String(row.size))
      .header("X-Content-Type-Options", "nosniff");
    // HTML artifacts are LLM/agent-authored (e.g. factory reports) — render them in a
    // sandboxed, script-less, unique origin so a hostile artifact can never execute at
    // the portal origin (stored-XSS chokepoint). Static report HTML/SVG/CSS is unaffected.
    if ((row.kind ?? "").startsWith("text/html")) {
      reply.header("Content-Security-Policy", "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:");
    }
    return reply.send(createReadStream(row.path));
  });
}
