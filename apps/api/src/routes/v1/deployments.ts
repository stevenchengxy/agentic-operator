import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { deployments, getDb } from "@agentic/db";
import { requireAuth } from "../../plugins/auth";
import { requirePermission } from "../../plugins/rbac";
import { writeAudit } from "../../plugins/audit";
import { getLiveDeployment, listDeployments } from "../../queries/deployments";

export async function deploymentsRoutes(app: FastifyInstance) {
  // GET /v1/deployments — list history
  app.get("/deployments", async (req, reply) => {
    const auth = requirePermission(req, "deployments.read");
    const [list, live] = await Promise.all([
      listDeployments(auth.tenantSlug),
      getLiveDeployment(auth.tenantSlug),
    ]);
    return reply.ok({ list, live });
  });

  // POST /v1/deployments/:id/rollback
  app.post<{ Params: { id: string } }>(
    "/deployments/:id/rollback",
    async (req, reply) => {
      const auth = requirePermission(req, "deployments.write");
      const db = getDb();
      const target = db
        .select()
        .from(deployments)
        .where(eq(deployments.id, req.params.id))
        .all()[0];
      if (!target) return reply.fail("not_found", "deployment not found", 404);
      if (target.tenantId !== auth.tenantId)
        return reply.fail("forbidden", "forbidden", 403);

      db.transaction(() => {
        // Demote the current live deployment for the SAME target — other
        // targets (e.g. workflow vs tenant_code) live independently and must
        // not be touched by a rollback in a different lane.
        db.update(deployments)
          .set({ status: "rolled_back" })
          .where(
            and(
              eq(deployments.tenantId, target.tenantId),
              eq(deployments.target, target.target),
              eq(deployments.status, "live"),
            ),
          )
          .run();
        db.update(deployments)
          .set({ status: "live", deployedAt: new Date() })
          .where(eq(deployments.id, req.params.id))
          .run();
      });

      writeAudit({
        tenantId: auth.tenantId,
        action: "deployment.rollback",
        targetType: "deployment",
        targetId: req.params.id,
        meta: { version_id: target.versionId, target: target.target },
      });

      return reply.ok({
        deployment_id: req.params.id,
        status: "live" as const,
        target: target.target,
        note: "live pointer flipped. Restart api for runtime to pick up the new manifest.",
      });
    },
  );
}
