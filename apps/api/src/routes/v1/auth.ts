/**
 * Auth + identity (P6-AUTH).
 *
 *   POST /v1/auth/register   public · self-service signup (email + password)
 *   POST /v1/auth/login      public · password verify → session cookie
 *   POST /v1/auth/logout     clear session cookie
 *   GET  /v1/me              identity + active-tenant role + capability set
 *   POST /v1/me/password     change own password
 *
 * The api owns auth because apps/web has zero DB access (password hashes live
 * here). The web sign-in/up forms POST these endpoints through the Next
 * `/v1/*` rewrite so the Set-Cookie lands same-origin.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, eq } from "drizzle-orm";
import {
  getDb,
  hashPassword,
  memberships,
  tenants,
  users,
  verifyPassword,
} from "@agentic/db";
import { makeId } from "@agentic/shared";
import {
  ChangePasswordBody,
  LoginBody,
  RegisterBody,
  capabilitiesFor,
  type MeMembership,
  type TenantRole,
} from "@agentic/contracts";
import {
  clearSessionCookie,
  initialsFor,
  requireAuth,
  setSessionCookie,
  signSessionJwt,
  type AuthedContext,
} from "../../plugins/auth";
import { writeAudit } from "../../plugins/rbac";

// ─── Light in-memory rate limit (anti-abuse for register/login) ──────────────

interface Bucket {
  count: number;
  resetAt: number;
}
const WINDOW_MS = 60_000;
const buckets = new Map<string, Bucket>();

function rateLimited(key: string, max: number): boolean {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || now > b.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }
  b.count += 1;
  return b.count > max;
}

function clientIp(req: FastifyRequest): string {
  const fwd = req.headers["x-forwarded-for"];
  const first = Array.isArray(fwd) ? fwd[0] : fwd?.split(",")[0];
  return (first ?? req.ip ?? "unknown").trim();
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function membershipsFor(userId: string): MeMembership[] {
  const rows = getDb()
    .select({
      role: memberships.role,
      slug: tenants.slug,
      name: tenants.name,
    })
    .from(memberships)
    .innerJoin(tenants, eq(memberships.tenantId, tenants.id))
    .where(eq(memberships.userId, userId))
    .all();
  return rows.map((r) => ({
    tenantSlug: r.slug,
    tenantName: r.name,
    role: r.role as TenantRole,
  }));
}

/** Pick the slug to stamp into the session cookie (display/redirect hint). */
function preferredTenantSlug(userId: string, hint?: string): string {
  const mine = membershipsFor(userId);
  if (hint && mine.some((m) => m.tenantSlug === hint)) return hint;
  if (mine[0]) return mine[0].tenantSlug;
  return hint ?? process.env.AGENTIC_DEV_TENANT ?? "raas";
}

async function issueSession(
  reply: FastifyReply,
  user: { id: string; name: string },
  tenantSlug: string,
): Promise<void> {
  const jwt = await signSessionJwt({
    sub: user.id,
    name: user.name,
    initials: initialsFor(user.name),
    tenant: tenantSlug,
  });
  setSessionCookie(reply, jwt);
}

function meResponse(ctx: AuthedContext) {
  const mine = ctx.userId ? membershipsFor(ctx.userId) : [];
  const activeTenant = ctx.tenantSlug
    ? {
        slug: ctx.tenantSlug,
        name:
          getDb()
            .select({ name: tenants.name })
            .from(tenants)
            .where(eq(tenants.id, ctx.tenantId))
            .all()[0]?.name ?? ctx.tenantSlug,
        role: ctx.role,
      }
    : null;
  return {
    user: {
      id: ctx.userId ?? "",
      email: ctx.email ?? "",
      name: ctx.name ?? "",
      platformRole: ctx.platformRole,
    },
    activeTenant,
    memberships: mine,
    capabilities: capabilitiesFor(ctx.role, ctx.platformRole),
  };
}

// ─── Routes ──────────────────────────────────────────────────────────────────

export async function authRoutes(app: FastifyInstance): Promise<void> {
  // ── POST /v1/auth/register ──────────────────────────────────────────────
  app.post("/auth/register", async (req, reply) => {
    if (rateLimited(`reg:${clientIp(req)}`, 10)) {
      return reply.fail("rate_limited", "too many attempts, try again shortly", 429);
    }
    const body = RegisterBody.parse(req.body);
    const email = body.email.toLowerCase();
    const db = getDb();

    const existing = db.select({ id: users.id }).from(users).where(eq(users.email, email)).all()[0];
    if (existing) {
      return reply.fail("email_taken", "an account with this email already exists", 409);
    }

    const userId = makeId("usr");
    const now = new Date();
    db.insert(users)
      .values({
        id: userId,
        email,
        name: body.name,
        passwordHash: hashPassword(body.password),
        platformRole: "none",
        status: "active",
        createdAt: now,
        updatedAt: now,
      })
      .run();

    const tenantSlug = preferredTenantSlug(userId);
    await issueSession(reply, { id: userId, name: body.name }, tenantSlug);

    writeAudit(
      {
        userId,
        email,
        name: body.name,
        platformRole: "none",
        tenantId: "",
        tenantSlug: "",
        role: null,
        via: "cookie",
      },
      { action: "user.register", targetType: "user", targetId: userId, meta: { email } },
    );

    // New self-registered users have no memberships yet — the portal shows a
    // "request access" state until an admin grants one.
    return reply.ok(
      {
        user: { id: userId, email, name: body.name, platformRole: "none" as const },
        memberships: [],
      },
      201,
    );
  });

  // ── POST /v1/auth/login ─────────────────────────────────────────────────
  app.post("/auth/login", async (req, reply) => {
    if (rateLimited(`login:${clientIp(req)}`, 20)) {
      return reply.fail("rate_limited", "too many attempts, try again shortly", 429);
    }
    const body = LoginBody.parse(req.body);
    const email = body.email.toLowerCase();
    const u = getDb().select().from(users).where(eq(users.email, email)).all()[0];

    // Uniform failure for unknown email / bad password / no credential set, so
    // we don't leak which accounts exist.
    if (!u || u.status !== "active" || !verifyPassword(body.password, u.passwordHash)) {
      return reply.fail("invalid_credentials", "email or password is incorrect", 401);
    }

    const tenantSlug = preferredTenantSlug(u.id, body.tenant);
    await issueSession(reply, { id: u.id, name: u.name }, tenantSlug);

    writeAudit(
      {
        userId: u.id,
        email: u.email,
        name: u.name,
        platformRole: u.platformRole as "none" | "superadmin",
        tenantId: "",
        tenantSlug: "",
        role: null,
        via: "cookie",
      },
      { action: "user.login", targetType: "user", targetId: u.id },
    );

    return reply.ok({
      user: {
        id: u.id,
        email: u.email,
        name: u.name,
        platformRole: u.platformRole as "none" | "superadmin",
      },
      tenant: tenantSlug,
      memberships: membershipsFor(u.id),
    });
  });

  // ── POST /v1/auth/logout ────────────────────────────────────────────────
  app.post("/auth/logout", async (req, reply) => {
    if (req.auth) {
      writeAudit(req.auth, { action: "user.logout", targetType: "user", targetId: req.auth.userId });
    }
    clearSessionCookie(reply);
    return reply.ok({ ok: true });
  });

  // ── GET /v1/me ──────────────────────────────────────────────────────────
  app.get("/me", async (req, reply) => {
    const ctx = requireAuth(req);
    return reply.ok(meResponse(ctx));
  });

  // ── POST /v1/me/password ────────────────────────────────────────────────
  app.post("/me/password", async (req, reply) => {
    const ctx = requireAuth(req);
    if (!ctx.userId) {
      return reply.fail("no_user", "this credential is not tied to a user account", 400);
    }
    const body = ChangePasswordBody.parse(req.body);
    const db = getDb();
    const u = db.select().from(users).where(eq(users.id, ctx.userId)).all()[0];
    if (!u || !verifyPassword(body.currentPassword, u.passwordHash)) {
      return reply.fail("invalid_credentials", "current password is incorrect", 401);
    }
    db.update(users)
      .set({ passwordHash: hashPassword(body.newPassword), updatedAt: new Date() })
      .where(eq(users.id, ctx.userId))
      .run();
    writeAudit(ctx, { action: "user.password_change", targetType: "user", targetId: ctx.userId });
    return reply.ok({ ok: true });
  });

  void and;
}
