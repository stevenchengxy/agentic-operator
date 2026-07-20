import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { getDb, tasks } from "@agentic/db";
import { ResolveTaskBody } from "@agentic/contracts";
import { requirePermission } from "../../plugins/rbac";
import { writeAudit } from "../../plugins/audit";
import { listAllTasks, getTask } from "../../queries/tasks";
import {
  HumanTaskDispatchError,
  HumanTaskError,
  requestHumanTaskResolution,
} from "../../services/hitl-recovery";

export async function tasksRoutes(app: FastifyInstance) {
  // GET /v1/tasks — list
  app.get("/tasks", async (req, reply) => {
    const auth = requirePermission(req, "tasks.read");
    const rows = await listAllTasks(auth.tenantSlug, { limit: 100 });
    return reply.ok(rows);
  });

  // GET /v1/tasks/:id — detail
  app.get<{ Params: { id: string } }>("/tasks/:id", async (req, reply) => {
    const auth = requirePermission(req, "tasks.read");
    const row = await getTask(auth.tenantSlug, req.params.id);
    if (!row) return reply.fail("not_found", "task not found", 404);
    return reply.ok(row);
  });

  // POST /v1/tasks/:id/resolve
  app.post<{ Params: { id: string } }>(
    "/tasks/:id/resolve",
    async (req, reply) => {
      const auth = requirePermission(req, "tasks.resolve");
      const body = ResolveTaskBody.parse(req.body);
      const db = getDb();
      const row = db.select().from(tasks).where(eq(tasks.id, req.params.id)).all()[0];
      if (!row) return reply.fail("not_found", "task not found", 404);
      if (row.tenantId !== auth.tenantId)
        return reply.fail("forbidden", "forbidden", 403);
      try {
        const result = await requestHumanTaskResolution({
          taskId: req.params.id,
          tenantId: auth.tenantId,
          tenantSlug: auth.tenantSlug,
          actorUserId: auth.userId,
          decision: body.decision,
          payload: body.payload,
        });
        writeAudit({
          tenantId: auth.tenantId,
          actorUserId: auth.userId ?? undefined,
          action: "task.resolve",
          targetType: "task",
          targetId: req.params.id,
          meta: {
            decision: body.decision,
            deliveryStatus: result.status,
            resumeMarker: result.resumeMarker,
            attempt: result.attempt,
          },
        });
        return reply.ok({
          task_id: result.taskId,
          decision: result.decision,
          status: result.status,
          resume_marker: result.resumeMarker,
        });
      } catch (error) {
        if (error instanceof HumanTaskDispatchError) {
          // The decision is durable and retry-safe even though the broker did
          // not accept this transport attempt. Never roll it back to `open` or
          // claim it was resolved; startup/periodic reconciliation will retry.
          writeAudit({
            tenantId: auth.tenantId,
            actorUserId: auth.userId ?? undefined,
            action: "task.resolve.pending",
            targetType: "task",
            targetId: req.params.id,
            meta: {
              decision: body.decision,
              resumeMarker: error.resumeMarker,
              error: error.message,
            },
          });
          return reply.fail(
            error.code,
            error.message,
            error.statusCode,
            "decision is persisted; retrying the same request is safe",
          );
        }
        if (error instanceof HumanTaskError) {
          return reply.fail(error.code, error.message, error.statusCode);
        }
        throw error;
      }
    },
  );
}
