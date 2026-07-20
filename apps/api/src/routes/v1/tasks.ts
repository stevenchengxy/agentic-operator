import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { getDb, tasks } from "@agentic/db";
import { validateValueAgainstJsonSchema } from "@agentic/runtime";
import { ResolveTaskBody } from "@agentic/contracts";
import { requirePermission } from "../../plugins/rbac";
import { writeAudit } from "../../plugins/audit";
import { listAllTasks, getTask } from "../../queries/tasks";
import {
  HumanTaskDispatchError,
  HumanTaskError,
  requestHumanTaskResolution,
} from "../../services/hitl-recovery";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function canonicalFormDecision(
  value: unknown,
): "approve" | "reject" | "supplement" | null {
  if (typeof value !== "string") return null;
  switch (value.trim().toLowerCase()) {
    case "approve":
    case "approved":
      return "approve";
    case "reject":
    case "rejected":
      return "reject";
    case "supplement":
    case "revise":
    case "revision":
    case "request_changes":
      return "supplement";
    default:
      return null;
  }
}

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

      // Tasks that carry a structured form contract validate the answer BEFORE
      // the durable resolution is claimed, so a bad/incomplete submission stays
      // on the open task instead of waking the run with unusable input.
      const formSchema = asRecord(asRecord(row.payloadJson)?.formSchema);
      if (formSchema) {
        const formDecision = canonicalFormDecision(
          asRecord(body.payload)?.decision,
        );
        if (formDecision && formDecision !== body.decision) {
          return reply.fail(
            "task_decision_mismatch",
            "The form decision does not match the requested task outcome",
            400,
          );
        }
        const issues = validateValueAgainstJsonSchema(
          formSchema as never,
          body.payload ?? null,
          "/payload",
          "task_payload",
        );
        if (issues.length > 0) {
          const summary = issues
            .slice(0, 3)
            .map((issue) => `${issue.path}: ${issue.message}`)
            .join("; ");
          return reply.fail(
            "invalid_task_payload",
            `Task form validation failed: ${summary}`,
            400,
          );
        }
      }

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
