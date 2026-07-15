import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { getDb, tasks } from "@agentic/db";
import { inngest, validateValueAgainstJsonSchema } from "@agentic/runtime";
import { ResolveTaskBody } from "@agentic/contracts";
import { requireAuth, requireWorkspaceWriter } from "../../plugins/auth";
import { writeAudit } from "../../plugins/audit";
import { listAllTasks, getTask } from "../../queries/tasks";

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
    const auth = requireAuth(req);
    const rows = await listAllTasks(auth.tenantSlug, { limit: 100 });
    return reply.ok(rows);
  });

  // GET /v1/tasks/:id — detail
  app.get<{ Params: { id: string } }>("/tasks/:id", async (req, reply) => {
    const auth = requireAuth(req);
    const row = await getTask(auth.tenantSlug, req.params.id);
    if (!row) return reply.fail("not_found", "task not found", 404);
    return reply.ok(row);
  });

  // POST /v1/tasks/:id/resolve
  app.post<{ Params: { id: string } }>(
    "/tasks/:id/resolve",
    async (req, reply) => {
      const auth = requireWorkspaceWriter(req);
      const body = ResolveTaskBody.parse(req.body);
      const db = getDb();
      const row = db
        .select()
        .from(tasks)
        .where(eq(tasks.id, req.params.id))
        .all()[0];
      if (!row) return reply.fail("not_found", "task not found", 404);
      if (row.tenantId !== auth.tenantId)
        return reply.fail("forbidden", "forbidden", 403);
      if (row.status !== "open")
        return reply.fail(
          "already_resolved",
          `task already ${row.status}`,
          409,
        );

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

      // P5-TEN-01 — include tenantId in the resolve event so the waiting
      // agent's `step.waitForEvent` can pin the predicate to the issuing
      // tenant. Without this, a leaked taskId in tenant A would let an
      // attacker resume tenant B's HITL flow.
      await inngest.send({
        name: "task.resolved",
        data: {
          taskId: req.params.id,
          tenantId: auth.tenantId,
          decision: body.decision,
          payload: body.payload ?? null,
        },
      });

      writeAudit({
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action: "task.resolve",
        targetType: "task",
        targetId: req.params.id,
        meta: { decision: body.decision },
      });

      return reply.ok({ task_id: req.params.id, decision: body.decision });
    },
  );
}
