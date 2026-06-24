/**
 * GET /v1/audit — paginated read of the per-tenant audit_log.
 *
 * Query params (all optional):
 *
 *   since=<unix-ms>   inclusive lower bound on `at`
 *   until=<unix-ms>   exclusive upper bound on `at`
 *   actor=<userId>    filter by `actor_user_id`
 *   action=<string>   filter by `action` (exact match)
 *   limit=<number>    page size (default 100, max 500)
 *   cursor=<unix-ms>  pagination cursor — opaque, equals `at` of last row
 *
 * Response (success envelope):
 *
 *   {
 *     items: AuditLogRow[],
 *     nextCursor: string | null,
 *     count: number,
 *   }
 *
 * Each row is tenant-scoped via `requireAuth`. The endpoint is read-only.
 */

import type { FastifyInstance } from "fastify";
import { and, desc, eq, gte, lt } from "drizzle-orm";
import { auditLog, getDb } from "@agentic/db";
import { requireAuth } from "../../plugins/auth";
import { requirePermission } from "../../plugins/rbac";

interface QueryString {
  since?: string;
  until?: string;
  actor?: string;
  action?: string;
  limit?: string;
  cursor?: string;
}

export async function auditRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: QueryString }>("/audit", async (req, reply) => {
    const auth = requirePermission(req, "audit.read");
    const q = req.query;

    const limitRaw = q.limit ? Number(q.limit) : 100;
    const limit = Math.min(
      Math.max(Number.isFinite(limitRaw) ? limitRaw : 100, 1),
      500,
    );

    const conds = [eq(auditLog.tenantId, auth.tenantId)];
    if (q.since !== undefined) {
      const ms = Number(q.since);
      if (Number.isFinite(ms)) conds.push(gte(auditLog.at, new Date(ms)));
    }
    if (q.until !== undefined) {
      const ms = Number(q.until);
      if (Number.isFinite(ms)) conds.push(lt(auditLog.at, new Date(ms)));
    }
    if (q.actor !== undefined && q.actor !== "") {
      conds.push(eq(auditLog.actorUserId, q.actor));
    }
    if (q.action !== undefined && q.action !== "") {
      conds.push(eq(auditLog.action, q.action));
    }
    // Cursor: pages descend by `at`, so the next page starts STRICTLY before
    // the previous page's last row's `at`. Equal timestamps may exist; the
    // upper bound is exclusive so we never re-emit the boundary row.
    if (q.cursor !== undefined) {
      const ms = Number(q.cursor);
      if (Number.isFinite(ms)) conds.push(lt(auditLog.at, new Date(ms)));
    }

    const db = getDb();
    const rows = db
      .select()
      .from(auditLog)
      .where(and(...conds))
      .orderBy(desc(auditLog.at))
      .limit(limit + 1)
      .all();

    const items = rows.slice(0, limit);
    const hasMore = rows.length > limit;
    const last = items[items.length - 1];
    const nextCursor = hasMore && last ? String(last.at.getTime()) : null;

    return reply.ok({
      items: items.map((r) => ({
        id: r.id,
        tenantId: r.tenantId,
        actorUserId: r.actorUserId,
        action: r.action,
        targetType: r.targetType,
        targetId: r.targetId,
        at: r.at.getTime(),
        meta: r.metaJson ?? null,
      })),
      nextCursor,
      count: items.length,
    });
  });
}
