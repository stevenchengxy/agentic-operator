/**
 * Tenant-scoped membership management (P6-AUTH) — the Access tab "members"
 * view. Operates on the caller's ACTIVE tenant (resolved from the
 * x-agentic-tenant header).
 *
 *   GET    /v1/members            list members of the active tenant
 *   POST   /v1/members            add an existing (registered) user by email
 *   PATCH  /v1/members/:userId    change a member's role
 *   DELETE /v1/members/:userId    remove a member from the tenant
 *
 * Self-service registration model: you add people who have already registered.
 * A "last admin" guard prevents a tenant from being left with no admin.
 */

import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { getDb, memberships, tenants, users } from "@agentic/db";
import {
  AddMemberBody,
  UpdateMemberRoleBody,
  type MemberRow,
  type TenantRole,
} from "@agentic/contracts";
import { requirePermission, writeAudit } from "../../plugins/rbac";

function adminCount(tenantId: string): number {
  return getDb()
    .select({ role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.tenantId, tenantId), eq(memberships.role, "admin")))
    .all().length;
}

function listMembers(tenantId: string, selfUserId: string | null): MemberRow[] {
  const rows = getDb()
    .select({
      userId: users.id,
      email: users.email,
      name: users.name,
      platformRole: users.platformRole,
      status: users.status,
      role: memberships.role,
      createdAt: memberships.createdAt,
    })
    .from(memberships)
    .innerJoin(users, eq(memberships.userId, users.id))
    .where(eq(memberships.tenantId, tenantId))
    .all();
  return rows
    .map((r) => ({
      userId: r.userId,
      email: r.email,
      name: r.name,
      role: r.role as TenantRole,
      platformRole: r.platformRole as "none" | "superadmin",
      status: r.status as "active" | "suspended",
      createdAt:
        r.createdAt instanceof Date ? r.createdAt.getTime() : Number(r.createdAt ?? 0),
      isSelf: r.userId === selfUserId,
    }))
    .sort((a, b) => a.email.localeCompare(b.email));
}

export async function membersRoutes(app: FastifyInstance): Promise<void> {
  // ── GET /v1/members ─────────────────────────────────────────────────────
  app.get("/members", async (req, reply) => {
    const ctx = requirePermission(req, "members.read");
    if (!ctx.tenantId) return reply.fail("no_tenant", "no active tenant", 400);
    return reply.ok({ items: listMembers(ctx.tenantId, ctx.userId) });
  });

  // ── POST /v1/members ────────────────────────────────────────────────────
  app.post("/members", async (req, reply) => {
    const ctx = requirePermission(req, "members.write");
    if (!ctx.tenantId) return reply.fail("no_tenant", "no active tenant", 400);
    const body = AddMemberBody.parse(req.body);
    const email = body.email.toLowerCase();
    const db = getDb();

    const target = db.select().from(users).where(eq(users.email, email)).all()[0];
    if (!target) {
      return reply.fail(
        "user_not_found",
        "no registered user with this email — ask them to sign up first",
        404,
      );
    }
    const existing = db
      .select({ role: memberships.role })
      .from(memberships)
      .where(and(eq(memberships.userId, target.id), eq(memberships.tenantId, ctx.tenantId)))
      .all()[0];
    if (existing) {
      return reply.fail("already_member", "user is already a member of this tenant", 409);
    }

    db.insert(memberships)
      .values({
        userId: target.id,
        tenantId: ctx.tenantId,
        role: body.role,
        createdAt: new Date(),
        createdBy: ctx.userId ?? null,
      })
      .run();
    writeAudit(ctx, {
      action: "member.add",
      targetType: "user",
      targetId: target.id,
      meta: { email, role: body.role },
    });
    return reply.ok({ items: listMembers(ctx.tenantId, ctx.userId) }, 201);
  });

  // ── PATCH /v1/members/:userId ───────────────────────────────────────────
  app.patch<{ Params: { userId: string } }>("/members/:userId", async (req, reply) => {
    const ctx = requirePermission(req, "members.write");
    if (!ctx.tenantId) return reply.fail("no_tenant", "no active tenant", 400);
    const { userId } = req.params;
    const body = UpdateMemberRoleBody.parse(req.body);
    const db = getDb();

    const current = db
      .select({ role: memberships.role })
      .from(memberships)
      .where(and(eq(memberships.userId, userId), eq(memberships.tenantId, ctx.tenantId)))
      .all()[0];
    if (!current) return reply.fail("not_member", "user is not a member of this tenant", 404);

    if (current.role === "admin" && body.role !== "admin" && adminCount(ctx.tenantId) <= 1) {
      return reply.fail("last_admin", "cannot demote the last admin of this tenant", 409);
    }

    db.update(memberships)
      .set({ role: body.role })
      .where(and(eq(memberships.userId, userId), eq(memberships.tenantId, ctx.tenantId)))
      .run();
    writeAudit(ctx, {
      action: "member.role_change",
      targetType: "user",
      targetId: userId,
      meta: { from: current.role, to: body.role },
    });
    return reply.ok({ items: listMembers(ctx.tenantId, ctx.userId) });
  });

  // ── DELETE /v1/members/:userId ──────────────────────────────────────────
  app.delete<{ Params: { userId: string } }>("/members/:userId", async (req, reply) => {
    const ctx = requirePermission(req, "members.write");
    if (!ctx.tenantId) return reply.fail("no_tenant", "no active tenant", 400);
    const { userId } = req.params;
    const db = getDb();

    const current = db
      .select({ role: memberships.role })
      .from(memberships)
      .where(and(eq(memberships.userId, userId), eq(memberships.tenantId, ctx.tenantId)))
      .all()[0];
    if (!current) return reply.fail("not_member", "user is not a member of this tenant", 404);
    if (current.role === "admin" && adminCount(ctx.tenantId) <= 1) {
      return reply.fail("last_admin", "cannot remove the last admin of this tenant", 409);
    }

    db.delete(memberships)
      .where(and(eq(memberships.userId, userId), eq(memberships.tenantId, ctx.tenantId)))
      .run();
    writeAudit(ctx, { action: "member.remove", targetType: "user", targetId: userId });
    return reply.ok({ items: listMembers(ctx.tenantId, ctx.userId) });
  });

  void tenants;
}
