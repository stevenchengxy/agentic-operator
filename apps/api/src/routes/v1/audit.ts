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
 *   cursor=<opaque>   pagination cursor — `<at-ms>:<id>` (legacy unix-ms accepted)
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
import { and, desc, eq, gte, lt, or } from "drizzle-orm";
import { auditLog, getDb } from "@agentic/db";
import { requirePermission } from "../../plugins/rbac";

interface QueryString {
  since?: string;
  until?: string;
  actor?: string;
  action?: string;
  limit?: string;
  cursor?: string;
}

function parseCursor(raw: string): { at: number; id: string | null } | null {
  const separator = raw.indexOf(":");
  const at = Number(separator === -1 ? raw : raw.slice(0, separator));
  if (!Number.isFinite(at)) return null;
  return {
    at,
    id: separator === -1 ? null : raw.slice(separator + 1) || null,
  };
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
    // Composite cursor: audit writes can share the same millisecond. Ordering
    // and paging by `(at DESC, id DESC)` prevents rows at the boundary from
    // being skipped. Numeric legacy cursors remain supported.
    if (q.cursor !== undefined) {
      const cursor = parseCursor(q.cursor);
      if (cursor) {
        const beforeTime = lt(auditLog.at, new Date(cursor.at));
        conds.push(
          cursor.id
            ? or(
                beforeTime,
                and(
                  eq(auditLog.at, new Date(cursor.at)),
                  lt(auditLog.id, cursor.id),
                ),
              )!
            : beforeTime,
        );
      }
    }

    const db = getDb();
    const rows = db
      .select()
      .from(auditLog)
      .where(and(...conds))
      .orderBy(desc(auditLog.at), desc(auditLog.id))
      .limit(limit + 1)
      .all();

    const items = rows.slice(0, limit);
    const hasMore = rows.length > limit;
    const last = items[items.length - 1];
    const nextCursor =
      hasMore && last ? `${last.at.getTime()}:${last.id}` : null;

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
