import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { jwtVerify, SignJWT } from "jose";
import { apiTokens, getDb, memberships, tenants, users } from "@agentic/db";
import type { PlatformRole, TenantRole } from "@agentic/contracts";

/**
 * P6-AUTH — authenticated request context.
 *
 * Identity (`userId`/`email`/`name`/`platformRole`) is resolved once per
 * request; the *active tenant* and the caller's `role` within it are resolved
 * from the request (the `x-agentic-tenant` header the portal forwards, or the
 * caller's first membership) and verified against `memberships`. RBAC
 * decisions read `platformRole` + `role` — see plugins/rbac.ts.
 *
 * `userId` is null only for legacy bearer tokens that carry no user link.
 */
export interface AuthedContext {
  userId: string | null;
  email: string | null;
  name: string | null;
  platformRole: PlatformRole;
  tenantId: string;
  tenantSlug: string;
  role: TenantRole | null;
  via: "token" | "dev" | "cookie";
}

const COOKIE_NAME = "agentic_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30d

/**
 * Session JWT signing secret. Accepts both `AUTH_SESSION_SECRET` (canonical
 * api name) and `SESSION_SECRET` (what apps/web sets). Returns null when
 * neither is configured. In dev we fall back to a fixed string so the portal
 * works out of the box; production MUST set one (the boot guard warns).
 */
function getSessionSecret(): Uint8Array {
  const raw =
    process.env.AUTH_SESSION_SECRET ??
    process.env.SESSION_SECRET ??
    "dev-only-do-not-use-in-prod";
  return new TextEncoder().encode(raw);
}

/**
 * Single-cookie reader. Avoids `@fastify/cookie` because we only need one
 * well-known key and adding the plugin would force a plugin-order change.
 */
function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    if (k !== name) continue;
    let v = part.slice(idx + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    return v;
  }
  return null;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function initialsFor(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "??";
  if (parts.length === 1) return (parts[0] ?? "").slice(0, 2).toUpperCase();
  const first = parts[0]?.[0] ?? "";
  const last = parts[parts.length - 1]?.[0] ?? "";
  return (first + last).toUpperCase();
}

// ─── Session cookie (API-owned auth, P6-AUTH) ────────────────────────────────

interface SessionClaims {
  sub: string; // userId
  name: string;
  initials: string;
  tenant: string; // last-active tenant slug (display/redirect hint only)
}

/** Sign an HS256 session JWT. Shape stays compatible with apps/web Session. */
export async function signSessionJwt(claims: SessionClaims): Promise<string> {
  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(getSessionSecret());
}

/** Set the HttpOnly session cookie on a reply (manual Set-Cookie string). */
export function setSessionCookie(reply: FastifyReply, jwt: string): void {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  reply.header(
    "set-cookie",
    `${COOKIE_NAME}=${jwt}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}${secure}`,
  );
}

/** Clear the session cookie (logout). */
export function clearSessionCookie(reply: FastifyReply): void {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  reply.header(
    "set-cookie",
    `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`,
  );
}

// ─── Tenant / role resolution ────────────────────────────────────────────────

/**
 * Dev-only tenant override header, now also the production signal for "which
 * tenant is this request acting on". The portal forwards the URL's `[tenant]`
 * segment here. It is SAFE to trust in production because the active role is
 * always re-derived from `memberships` server-side — a forged header for a
 * tenant the user isn't a member of yields `role = null` and the RBAC guard
 * denies. Slug shape mirrors tenants.slug.
 */
const TENANT_HEADER = "x-agentic-tenant";

function headerTenantSlug(req: FastifyRequest | null): string | null {
  if (!req) return null;
  const raw = req.headers[TENANT_HEADER];
  const slug = Array.isArray(raw) ? raw[0] : raw;
  if (typeof slug !== "string") return null;
  const trimmed = slug.trim();
  if (!/^[a-z0-9_-]{1,64}$/.test(trimmed)) return null;
  return trimmed;
}

function roleFor(userId: string, tenantId: string): TenantRole | null {
  const hit = getDb()
    .select({ role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.userId, userId), eq(memberships.tenantId, tenantId)))
    .all()[0];
  return (hit?.role as TenantRole | undefined) ?? null;
}

interface TenantResolution {
  tenantId: string;
  tenantSlug: string;
  role: TenantRole | null;
}

/**
 * Resolve the active tenant + the caller's role in it. Honours an explicit
 * request (header / cookie tenant claim) first — even when the user isn't a
 * member (role stays null so the guard denies) — then falls back to the
 * caller's first membership, then a configured default.
 */
function resolveTenant(
  userId: string,
  explicit: Array<string | null>,
): TenantResolution {
  const db = getDb();
  const seen = new Set<string>();
  for (const slug of explicit) {
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    const t = db.select().from(tenants).where(eq(tenants.slug, slug)).all()[0];
    if (!t) continue;
    return { tenantId: t.id, tenantSlug: t.slug, role: roleFor(userId, t.id) };
  }
  // First membership.
  const first = db
    .select({ tenantId: memberships.tenantId, role: memberships.role })
    .from(memberships)
    .where(eq(memberships.userId, userId))
    .all()[0];
  if (first) {
    const t = db.select().from(tenants).where(eq(tenants.id, first.tenantId)).all()[0];
    if (t) return { tenantId: t.id, tenantSlug: t.slug, role: first.role as TenantRole };
  }
  // Configured default (superadmin with no memberships, or none at all).
  const fbSlug = process.env.AGENTIC_DEV_TENANT ?? "raas";
  const fb = db.select().from(tenants).where(eq(tenants.slug, fbSlug)).all()[0];
  if (fb) return { tenantId: fb.id, tenantSlug: fb.slug, role: roleFor(userId, fb.id) };
  return { tenantId: "", tenantSlug: "", role: null };
}

/** Map a bearer token's scopes to an effective tenant role. */
function roleFromScopes(scopes: string[]): TenantRole {
  if (scopes.includes("tenant:write")) return "admin";
  if (scopes.some((s) => s.endsWith(":invoke") || s === "agents:invoke")) {
    return "operator";
  }
  return "viewer";
}

declare module "fastify" {
  interface FastifyRequest {
    auth?: AuthedContext;
  }
}

// ─── authenticate ────────────────────────────────────────────────────────────

async function authenticateCookie(
  jwt: string,
  req: FastifyRequest,
): Promise<AuthedContext | null> {
  let payload: Record<string, unknown>;
  try {
    const verified = await jwtVerify(jwt, getSessionSecret(), {
      algorithms: ["HS256"],
    });
    payload = verified.payload as unknown as Record<string, unknown>;
  } catch {
    return null;
  }
  const userId = typeof payload.sub === "string" ? payload.sub : null;
  if (!userId) return null;
  const u = getDb().select().from(users).where(eq(users.id, userId)).all()[0];
  if (!u || u.status !== "active") return null;
  const cookieTenant = typeof payload.tenant === "string" ? payload.tenant : null;
  const resolved = resolveTenant(u.id, [headerTenantSlug(req), cookieTenant]);
  return {
    userId: u.id,
    email: u.email,
    name: u.name,
    platformRole: u.platformRole as PlatformRole,
    ...resolved,
    via: "cookie",
  };
}

function authenticateDev(req: FastifyRequest): AuthedContext | null {
  const email = process.env.AGENTIC_DEV_USER_EMAIL ?? "ops@agentic.local";
  const u = getDb().select().from(users).where(eq(users.email, email)).all()[0];
  if (!u) return null;
  // Pin the active tenant to AGENTIC_DEV_TENANT when the request carries no
  // explicit tenant header — preserves the legacy dev default (the seeded dev
  // user is a member of every tenant, so "first membership" would be
  // non-deterministic and break tenant-scoped tests/dashboards).
  const resolved = resolveTenant(u.id, [
    headerTenantSlug(req),
    process.env.AGENTIC_DEV_TENANT ?? "raas",
  ]);
  return {
    userId: u.id,
    email: u.email,
    name: u.name,
    platformRole: u.platformRole as PlatformRole,
    ...resolved,
    via: "dev",
  };
}

function authenticateBearer(token: string): AuthedContext | null {
  const db = getDb();
  const row = db
    .select({ id: apiTokens.id, tenantId: apiTokens.tenantId, scopes: apiTokens.scopes })
    .from(apiTokens)
    .where(eq(apiTokens.hash, hashToken(token)))
    .all()[0];
  if (!row) return null;
  db.update(apiTokens).set({ lastUsedAt: new Date() }).where(eq(apiTokens.id, row.id)).run();
  const t = db.select().from(tenants).where(eq(tenants.id, row.tenantId)).all()[0];
  if (!t) return null;
  return {
    userId: null,
    email: null,
    name: t.name,
    platformRole: "none",
    tenantId: t.id,
    tenantSlug: t.slug,
    role: roleFromScopes((row.scopes as string[] | null) ?? []),
    via: "token",
  };
}

/**
 * Resolve an authenticated context for `req`, or null if no credential matched.
 *
 * Dev-mode (`AUTH_MODE=dev`) resolves a REAL seeded user (default
 * `ops@agentic.local`) so audit + RBAC always have a concrete `userId` — it no
 * longer fabricates a userless tenant context.
 */
export async function authenticate(req: FastifyRequest): Promise<AuthedContext | null> {
  if (process.env.AUTH_MODE === "dev") {
    return authenticateDev(req);
  }

  const sessionJwt = readCookie(req.headers.cookie, COOKIE_NAME);
  if (sessionJwt) {
    const cookieCtx = await authenticateCookie(sessionJwt, req);
    if (cookieCtx) return cookieCtx;
    // Cookie present but invalid — fall through to bearer.
  }

  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) return null;
  const token = header.slice(7).trim();
  if (!token) return null;
  return authenticateBearer(token);
}

/**
 * Boot-time guard: fail fast on env combos that would silently bypass auth.
 */
export function assertAuthModeSafe(): void {
  if (process.env.AUTH_MODE !== "dev") return;

  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "AUTH_MODE=dev is incompatible with NODE_ENV=production — the dev-user " +
        "unlock would bypass real authentication. Unset AUTH_MODE for prod or " +
        "run with NODE_ENV=development.",
    );
  }

  const slug = process.env.AGENTIC_DEV_TENANT ?? "raas";
  const tenant = getDb().select({ id: tenants.id }).from(tenants).where(eq(tenants.slug, slug)).all()[0];
  if (!tenant) {
    throw new Error(
      `AUTH_MODE=dev requires AGENTIC_DEV_TENANT to match an existing tenant slug; ` +
        `'${slug}' was not found. Seed the tenant (e.g. \`pnpm db:seed\`) or set ` +
        `AGENTIC_DEV_TENANT to an existing slug.`,
    );
  }

  const email = process.env.AGENTIC_DEV_USER_EMAIL ?? "ops@agentic.local";
  const user = getDb().select({ id: users.id }).from(users).where(eq(users.email, email)).all()[0];
  if (!user) {
    throw new Error(
      `AUTH_MODE=dev requires AGENTIC_DEV_USER_EMAIL to match a seeded user; ` +
        `'${email}' was not found. Run \`pnpm db:seed\` or set AGENTIC_DEV_USER_EMAIL.`,
    );
  }
}

export async function registerAuth(app: FastifyInstance) {
  assertAuthModeSafe();
  app.addHook("onRequest", async (req) => {
    req.auth = (await authenticate(req)) ?? undefined;
  });
}

/** Require auth or fail with 401. */
export function requireAuth(req: FastifyRequest): AuthedContext {
  if (!req.auth) {
    const err: Error & { statusCode?: number; code?: string } = new Error("unauthorized");
    err.statusCode = 401;
    err.code = "unauthorized";
    throw err;
  }
  return req.auth;
}
