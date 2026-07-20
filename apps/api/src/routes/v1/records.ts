import type { FastifyInstance } from "fastify";
import { and, eq, desc } from "drizzle-orm";
import { businessRecords, getDb } from "@agentic/db";
import { requirePermission } from "../../plugins/rbac";

/**
 * Read-only monitoring API for durable business records (candidate / resume /
 * candidate_match_result / candidate_identity_result / communication_log) written by the `records.upsert`
 * tool. Tenant-scoped; reuses the `runs.read` permission (no new grant needed).
 */
export async function recordsRoutes(app: FastifyInstance) {
  app.get<{
    Querystring: {
      type?: string;
      candidate_id?: string;
      correlation_id?: string;
      limit?: string;
    };
  }>("/records", async (req, reply) => {
    const auth = requirePermission(req, "runs.read");
    const q = req.query;
    const limit = Math.min(Math.max(parseInt(String(q.limit ?? "50"), 10) || 50, 1), 200);
    const conds = [eq(businessRecords.tenantId, auth.tenantId)];
    if (q.type) conds.push(eq(businessRecords.recordType, q.type));
    if (q.candidate_id) conds.push(eq(businessRecords.candidateId, q.candidate_id));
    if (q.correlation_id) conds.push(eq(businessRecords.correlationId, q.correlation_id));
    const rows = getDb()
      .select()
      .from(businessRecords)
      .where(and(...conds))
      .orderBy(desc(businessRecords.updatedAt))
      .limit(limit)
      .all();
    return reply.ok(rows);
  });

  app.get<{ Params: { id: string } }>("/records/:id", async (req, reply) => {
    const auth = requirePermission(req, "runs.read");
    const row = getDb()
      .select()
      .from(businessRecords)
      .where(eq(businessRecords.id, req.params.id))
      .all()[0];
    if (!row) return reply.fail("not_found", "record not found", 404);
    if (row.tenantId !== auth.tenantId) return reply.fail("forbidden", "forbidden", 403);
    return reply.ok(row);
  });
}
