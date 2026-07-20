/**
 * Platform-wide user + membership management (P6-AUTH) — the Access tab
 * "all users" view. Superadmin only (requireSuperadmin).
 *
 *   GET    /v1/admin/users                              all users + memberships
 *   PATCH  /v1/admin/users/:userId                      set platformRole/status
 *   POST   /v1/admin/users/:userId/memberships          grant cross-tenant role
 *   DELETE /v1/admin/users/:userId/memberships/:slug    revoke a membership
 *   DELETE /v1/admin/users/:userId                      hard-delete an account
 */

import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import {
  auditLog,
  deployments,
  getDb,
  memberships,
  tasks,
  tenants,
  users,
  workflowVersions,
} from "@agentic/db";
import {
  AdminMembershipBody,
  AdminUpdateUserBody,
  type AdminUserRow,
  type TenantRole,
} from "@agentic/contracts";
import { requireSuperadmin, writeAudit } from "../../plugins/rbac";

function superadminCount(): number {
  return getDb()
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.platformRole, "superadmin"), eq(users.status, "active")))
    .all().length;
}

function listUsers(): AdminUserRow[] {
  const db = getDb();
  const allUsers = db.select().from(users).all();
  const allMemberships = db
    .select({
      userId: memberships.userId,
      role: memberships.role,
      slug: tenants.slug,
      name: tenants.name,
    })
    .from(memberships)
    .innerJoin(tenants, eq(memberships.tenantId, tenants.id))
    .all();
  const byUser = new Map<string, AdminUserRow["memberships"]>();
  for (const m of allMemberships) {
    const arr = byUser.get(m.userId) ?? [];
    arr.push({ tenantSlug: m.slug, tenantName: m.name, role: m.role as TenantRole });
    byUser.set(m.userId, arr);
  }
  return allUsers
    .map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      platformRole: u.platformRole as "none" | "superadmin",
      status: u.status as "active" | "suspended",
      createdAt: u.createdAt instanceof Date ? u.createdAt.getTime() : Number(u.createdAt ?? 0),
      memberships: (byUser.get(u.id) ?? []).sort((a, b) =>
        a.tenantSlug.localeCompare(b.tenantSlug),
      ),
    }))
    .sort((a, b) => a.email.localeCompare(b.email));
}

export async function adminUsersRoutes(app: FastifyInstance): Promise<void> {
  // ── GET /v1/admin/users ─────────────────────────────────────────────────
  app.get("/admin/users", async (req, reply) => {
    requireSuperadmin(req);
    return reply.ok({ items: listUsers() });
  });

  // ── PATCH /v1/admin/users/:userId ───────────────────────────────────────
  app.patch<{ Params: { userId: string } }>("/admin/users/:userId", async (req, reply) => {
    const ctx = requireSuperadmin(req);
    const { userId } = req.params;
    const body = AdminUpdateUserBody.parse(req.body);
    const db = getDb();

    const target = db.select().from(users).where(eq(users.id, userId)).all()[0];
    if (!target) return reply.fail("user_not_found", "no such user", 404);

    // Guard: don't strip the last active superadmin (demote or suspend).
    const losingSuper =
      target.platformRole === "superadmin" &&
      ((body.platformRole !== undefined && body.platformRole !== "superadmin") ||
        body.status === "suspended");
    if (losingSuper && superadminCount() <= 1) {
      return reply.fail("last_superadmin", "cannot remove the last platform superadmin", 409);
    }

    const patch: { platformRole?: "none" | "superadmin"; status?: "active" | "suspended"; updatedAt: Date } = {
      updatedAt: new Date(),
    };
    if (body.platformRole !== undefined) patch.platformRole = body.platformRole;
    if (body.status !== undefined) patch.status = body.status;
    db.transaction(() => {
      const updated = db.update(users).set(patch).where(eq(users.id, userId)).run() as {
        changes?: number;
      };
      if ((updated.changes ?? 0) !== 1) throw new Error(`user ${userId} changed during update`);
      writeAudit(ctx, {
        action: "platform.user.update",
        targetType: "user",
        targetId: userId,
        meta: { ...body },
      });
    });
    return reply.ok({ items: listUsers() });
  });

  // ── POST /v1/admin/users/:userId/memberships ────────────────────────────
  app.post<{ Params: { userId: string } }>(
    "/admin/users/:userId/memberships",
    async (req, reply) => {
      const ctx = requireSuperadmin(req);
      const { userId } = req.params;
      const body = AdminMembershipBody.parse(req.body);
      const db = getDb();

      const target = db.select({ id: users.id }).from(users).where(eq(users.id, userId)).all()[0];
      if (!target) return reply.fail("user_not_found", "no such user", 404);
      const t = db.select().from(tenants).where(eq(tenants.slug, body.tenantSlug)).all()[0];
      if (!t) return reply.fail("tenant_not_found", `no tenant "${body.tenantSlug}"`, 404);

      // Upsert: change role if already a member, else insert.
      const existing = db
        .select({ role: memberships.role })
        .from(memberships)
        .where(and(eq(memberships.userId, userId), eq(memberships.tenantId, t.id)))
        .all()[0];
      db.transaction(() => {
        if (existing) {
          const updated = db
            .update(memberships)
            .set({ role: body.role })
            .where(and(eq(memberships.userId, userId), eq(memberships.tenantId, t.id)))
            .run() as { changes?: number };
          if ((updated.changes ?? 0) !== 1) {
            throw new Error(`membership ${userId}/${body.tenantSlug} changed during update`);
          }
        } else {
          db.insert(memberships)
            .values({
              userId,
              tenantId: t.id,
              role: body.role,
              createdAt: new Date(),
              createdBy: ctx.userId ?? null,
            })
            .run();
        }
        writeAudit(ctx, {
          action: "platform.membership.write",
          targetType: "user",
          targetId: userId,
          tenantId: t.id,
          meta: { tenant: body.tenantSlug, role: body.role },
        });
      });
      return reply.ok({ items: listUsers() });
    },
  );

  // ── DELETE /v1/admin/users/:userId/memberships/:slug ────────────────────
  app.delete<{ Params: { userId: string; slug: string } }>(
    "/admin/users/:userId/memberships/:slug",
    async (req, reply) => {
      const ctx = requireSuperadmin(req);
      const { userId, slug } = req.params;
      const db = getDb();
      const target = db.select({ id: users.id }).from(users).where(eq(users.id, userId)).all()[0];
      if (!target) return reply.fail("user_not_found", "no such user", 404);
      const t = db.select().from(tenants).where(eq(tenants.slug, slug)).all()[0];
      if (!t) return reply.fail("tenant_not_found", `no tenant "${slug}"`, 404);
      const existing = db
        .select({ userId: memberships.userId })
        .from(memberships)
        .where(and(eq(memberships.userId, userId), eq(memberships.tenantId, t.id)))
        .all()[0];
      if (!existing) {
        return reply.fail("membership_not_found", `user is not a member of tenant "${slug}"`, 404);
      }
      db.transaction(() => {
        const removed = db
          .delete(memberships)
          .where(and(eq(memberships.userId, userId), eq(memberships.tenantId, t.id)))
          .run() as { changes?: number };
        if ((removed.changes ?? 0) !== 1) {
          throw new Error(`membership ${userId}/${slug} changed during removal`);
        }
        writeAudit(ctx, {
          action: "platform.membership.remove",
          targetType: "user",
          targetId: userId,
          tenantId: t.id,
          meta: { tenant: slug },
        });
      });
      return reply.ok({ items: listUsers() });
    },
  );

  // ── DELETE /v1/admin/users/:userId ──────────────────────────────────────
  // Hard-delete an account. Historical rows (runs/deployments/tasks/audit) are
  // preserved but unattributed: their nullable user references are cleared
  // first so the delete can't violate a FK, then the user's own memberships
  // and the user row are removed.
  app.delete<{ Params: { userId: string } }>("/admin/users/:userId", async (req, reply) => {
    const ctx = requireSuperadmin(req);
    const { userId } = req.params;
    const db = getDb();

    const target = db.select().from(users).where(eq(users.id, userId)).all()[0];
    if (!target) return reply.fail("user_not_found", "no such user", 404);
    if (userId === ctx.userId) {
      return reply.fail("cannot_delete_self", "you cannot delete your own account", 400);
    }
    if (target.platformRole === "superadmin" && superadminCount() <= 1) {
      return reply.fail("last_superadmin", "cannot delete the last platform superadmin", 409);
    }

    db.transaction(() => {
      db.update(workflowVersions).set({ createdBy: null }).where(eq(workflowVersions.createdBy, userId)).run();
      db.update(deployments).set({ deployedBy: null }).where(eq(deployments.deployedBy, userId)).run();
      db.update(tasks).set({ awaitingUserId: null }).where(eq(tasks.awaitingUserId, userId)).run();
      db.update(tasks).set({ resolvedBy: null }).where(eq(tasks.resolvedBy, userId)).run();
      db.update(auditLog).set({ actorUserId: null }).where(eq(auditLog.actorUserId, userId)).run();
      db.update(memberships).set({ createdBy: null }).where(eq(memberships.createdBy, userId)).run();
      db.delete(memberships).where(eq(memberships.userId, userId)).run();
      const removed = db.delete(users).where(eq(users.id, userId)).run() as { changes?: number };
      if ((removed.changes ?? 0) !== 1) throw new Error(`user ${userId} changed during removal`);
      writeAudit(ctx, {
        action: "platform.user.delete",
        targetType: "user",
        targetId: userId,
        meta: { email: target.email },
      });
    });
    return reply.ok({ items: listUsers() });
  });
}
