import type { FastifyInstance } from "fastify";
import { stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { eq } from "drizzle-orm";
import { artifacts, getDb } from "@agentic/db";
import { requireAuth } from "../../plugins/auth";
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
    } catch {
      return reply.fail("gone", "artifact file missing", 410);
    }
    reply
      .header("Content-Type", row.kind ?? "application/octet-stream")
      .header("Content-Length", String(row.size));
    return reply.send(createReadStream(row.path));
  });
}
