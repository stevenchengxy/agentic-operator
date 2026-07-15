import type { FastifyInstance, FastifyRequest } from "fastify";
import { createHash } from "node:crypto";
import { and, eq, or } from "drizzle-orm";
import { jwtVerify } from "jose";
import { apiTokens, getDb, memberships, tenants, users } from "@agentic/db";

export interface AuthedContext {
  tenantId: string;
  tenantSlug: string;
  via: "token" | "dev" | "cookie";
  /** Present for browser sessions; machine credentials intentionally have no user. */
  userId?: string;
  /** Workspace membership role. Dev mode is treated as an administrator. */
  role?: "admin" | "operator" | "viewer";
  /** Bearer-token capabilities. Browser/dev sessions do not use token scopes. */
  scopes?: string[];
}

const COOKIE_NAME = "agentic_session";

/**
 * UC-V11-29 / PF-GAP-05 — read the session JWT signing secret. Accepts
 * both `AUTH_SESSION_SECRET` (the canonical api-side name per
 * `.env.example`) and `SESSION_SECRET` (what `apps/web/lib/auth/session.ts`
 * sets today). Returns null when neither is configured — production
 * callers refuse cookie auth in that case and fall through to bearer.
 */
function getSessionSecret(): Uint8Array | null {
  const raw =
    process.env.AUTH_SESSION_SECRET ?? process.env.SESSION_SECRET ?? "";
  if (!raw) return null;
  return new TextEncoder().encode(raw);
}

/**
 * Single-cookie reader. Avoids `@fastify/cookie` because we only need
 * one well-known key and adding the plugin would force a plugin-order
 * change. RFC 6265 syntax: `name=value; name=value; ...`.
 */
function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (k !== name) continue;
    let v = part.slice(eq + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    return v;
  }
  return null;
}

/**
 * Verify a session JWT (HS256, per `apps/web/lib/auth/session.ts`) and
 * resolve to an `AuthedContext`. Returns null when the token is malformed,
 * signature invalid, expired, or references a tenant slug that no longer
 * exists in `tenants`. Caller falls through to bearer in any null case.
 */
async function authenticateCookie(jwt: string): Promise<AuthedContext | null> {
  const secret = getSessionSecret();
  if (!secret) return null;
  let payload: Record<string, unknown>;
  try {
    const verified = await jwtVerify(jwt, secret, { algorithms: ["HS256"] });
    payload = verified.payload as unknown as Record<string, unknown>;
  } catch {
    return null;
  }
  const tenantSlug = typeof payload.tenant === "string" ? payload.tenant : null;
  const subject = typeof payload.sub === "string" ? payload.sub : null;
  if (!tenantSlug || !subject) return null;
  const t = getDb()
    .select()
    .from(tenants)
    .where(eq(tenants.slug, tenantSlug))
    .all()[0];
  if (!t) return null;
  // The current web login emits the user's email as `sub`; older/CLI-issued
  // sessions may already use the canonical `usr-*` id. Resolve either form
  // before checking workspace membership.
  const user = getDb()
    .select({ id: users.id })
    .from(users)
    .where(or(eq(users.id, subject), eq(users.email, subject)))
    .all()[0];
  if (!user) return null;
  const membership = getDb()
    .select({ role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.tenantId, t.id), eq(memberships.userId, user.id)))
    .all()[0];
  if (!membership) return null;
  return {
    tenantId: t.id,
    tenantSlug: t.slug,
    via: "cookie",
    userId: user.id,
    role: membership.role,
  };
}

declare module "fastify" {
  interface FastifyRequest {
    auth?: AuthedContext;
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Dev-only tenant override header. The Next.js portal forwards the URL's
 * `[tenant]` segment as `x-agentic-tenant` so dashboards bound to
 * `/portal/<slug>/...` see that tenant's data — not whatever
 * `AGENTIC_DEV_TENANT` happens to be. Strictly gated to `AUTH_MODE=dev`:
 * production must continue to derive tenant exclusively from the bearer
 * token / session cookie, never from a client-controlled header.
 *
 * Hotfix — dashboard render hang (`/portal/hello/dashboard`). See
 * docs/team-execution/00-master-plan.md for the full narrative.
 */
const DEV_TENANT_HEADER = "x-agentic-tenant";

/**
 * Read the dev-only tenant override from a request. Returns the trimmed
 * slug when the header is present, non-empty, and references an existing
 * (non-archived) tenant; otherwise returns null so callers fall back to
 * `AGENTIC_DEV_TENANT`. NEVER consults this header outside `AUTH_MODE=dev`.
 */
function devTenantOverride(req: FastifyRequest | null): string | null {
  if (!req) return null;
  const raw = req.headers[DEV_TENANT_HEADER];
  const slug = Array.isArray(raw) ? raw[0] : raw;
  if (typeof slug !== "string") return null;
  const trimmed = slug.trim();
  if (!trimmed) return null;
  // Slug shape mirrors `packages/db/schema.ts#tenants.slug` and the wizard
  // validator: 1-32 chars of [a-z0-9_-]. Reject malformed values rather
  // than running a SELECT with attacker-controlled text — defense in depth.
  if (!/^[a-z0-9_-]{1,32}$/.test(trimmed)) return null;
  return trimmed;
}

function devTenant(req: FastifyRequest | null = null): AuthedContext | null {
  const override = devTenantOverride(req);
  const fallback = process.env.AGENTIC_DEV_TENANT ?? "raas";
  // Try the URL-bound tenant first; fall back to the env-pinned slug if it
  // doesn't resolve. The header is advisory in dev mode — never a 401.
  const candidates =
    override && override !== fallback ? [override, fallback] : [fallback];
  for (const slug of candidates) {
    const t = getDb()
      .select()
      .from(tenants)
      .where(eq(tenants.slug, slug))
      .all()[0];
    if (t) {
      return {
        tenantId: t.id,
        tenantSlug: t.slug,
        via: "dev",
        role: "admin",
      };
    }
  }
  return null;
}

/**
 * Resolve an authenticated context for `req`, or `null` if no credential
 * matched.
 *
 * Dev-tenant unlock requires the EXPLICIT opt-in `AUTH_MODE=dev`. The earlier
 * implementation also fell back to "any non-production NODE_ENV", which meant
 * a staging build deployed with `NODE_ENV=staging` would silently bypass
 * bearer auth and resolve every request to the seeded admin tenant. P0-AUTH-01.
 */
export async function authenticate(
  req: FastifyRequest,
): Promise<AuthedContext | null> {
  if (process.env.AUTH_MODE === "dev") {
    return devTenant(req);
  }

  // UC-V11-29 / PF-GAP-05 — cookie auth precedes bearer in prod. The
  // Next.js web app sets an HttpOnly `agentic_session` JWT after sign-in
  // (`apps/web/lib/auth/session.ts`); without this branch the browser
  // session is invisible to the api and every /v1 call from /portal
  // 401s. Bearer remains the path for CLI + machine clients.
  const cookieHeader = req.headers.cookie;
  const sessionJwt = readCookie(cookieHeader, COOKIE_NAME);
  if (sessionJwt) {
    const cookieCtx = await authenticateCookie(sessionJwt);
    if (cookieCtx) return cookieCtx;
    // Cookie present but invalid (rotated secret, expired, bogus tenant)
    // — fall through to bearer so a CLI request carrying a stale browser
    // cookie can still authenticate via its bearer token.
  }

  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) return null;
  const token = header.slice(7).trim();
  if (!token) return null;
  const hash = hashToken(token);

  const db = getDb();
  const row = db
    .select({
      id: apiTokens.id,
      tenantId: apiTokens.tenantId,
      scopes: apiTokens.scopes,
    })
    .from(apiTokens)
    .where(eq(apiTokens.hash, hash))
    .all()[0];
  if (!row) return null;

  db.update(apiTokens)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiTokens.id, row.id))
    .run();

  const tenant = db
    .select({ slug: tenants.slug })
    .from(tenants)
    .where(eq(tenants.id, row.tenantId))
    .all()[0];
  if (!tenant) return null;

  return {
    tenantId: row.tenantId,
    tenantSlug: tenant.slug,
    via: "token",
    scopes: row.scopes,
  };
}

/**
 * Boot-time guard: fail fast on env-var combinations that would silently
 * bypass auth in production.
 *
 * Refuses to return on:
 *   - `AUTH_MODE=dev` + `NODE_ENV=production` (deploy-time misconfig — would
 *     authenticate every unauthenticated request as the seeded admin tenant).
 *   - `AUTH_MODE=dev` + `AGENTIC_DEV_TENANT` pointing at a slug that doesn't
 *     exist in `tenants` (a typo silently making every dev request `null`).
 *
 * A silent prod auth bypass is worse than downtime, so this throws rather
 * than warning. P5-TEN-01 / tc-53.
 */
export function assertAuthModeSafe(): void {
  if (process.env.AUTH_MODE !== "dev") return; // bearer-only path is always safe

  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "AUTH_MODE=dev is incompatible with NODE_ENV=production — the dev-tenant " +
        "unlock would bypass bearer auth and authenticate every unauthenticated " +
        "request as the seeded admin tenant. Unset AUTH_MODE for prod or run with " +
        "NODE_ENV=development.",
    );
  }

  const slug = process.env.AGENTIC_DEV_TENANT ?? "raas";
  const row = getDb()
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.slug, slug))
    .all()[0];
  if (!row) {
    throw new Error(
      `AUTH_MODE=dev requires AGENTIC_DEV_TENANT to match an existing tenant slug; ` +
        `'${slug}' was not found. Seed the tenant (e.g. \`pnpm db:seed\`) or set ` +
        `AGENTIC_DEV_TENANT to an existing slug.`,
    );
  }
}

/**
 * Decorate every request with an `auth` context. Routes that need it can read
 * `req.auth`; routes that don't (like /health) ignore it. Bearer auth happens
 * automatically — only fail explicitly inside the route.
 *
 * Also runs `assertAuthModeSafe()` at plugin-register time so an unsafe env
 * combination crashes boot rather than silently shipping a prod auth bypass.
 */
export async function registerAuth(app: FastifyInstance) {
  assertAuthModeSafe();
  app.addHook("onRequest", async (req) => {
    req.auth = (await authenticate(req)) ?? undefined;
  });
}

/** Convenience: require auth or fail with 401. */
export function requireAuth(req: FastifyRequest): AuthedContext {
  if (!req.auth) {
    const err: Error & { statusCode?: number; code?: string } = new Error(
      "unauthorized",
    );
    err.statusCode = 401;
    err.code = "unauthorized";
    throw err;
  }
  return req.auth;
}

/**
 * Credential administration is deliberately browser-admin/dev only. An API
 * token must never be able to mint, rotate, or revoke other workspace-wide
 * credentials, even when it carries a broad runtime scope.
 */
export function requireTenantAdmin(req: FastifyRequest): AuthedContext {
  const auth = requireAuth(req);
  if (auth.via === "dev" || (auth.via === "cookie" && auth.role === "admin")) {
    return auth;
  }
  const err: Error & { statusCode?: number; code?: string } = new Error(
    "tenant administrator access required",
  );
  err.statusCode = 403;
  err.code = "forbidden";
  throw err;
}

const WORKSPACE_WRITE_SCOPES = new Set([
  "*",
  "workspace:all",
  "tenant:write",
  "workflow:write",
  "workflows:write",
]);

/** Require an operator/admin session or an explicitly write-capable token. */
export function requireWorkspaceWriter(req: FastifyRequest): AuthedContext {
  const auth = requireAuth(req);
  const permitted =
    auth.via === "dev" ||
    (auth.via === "cookie" &&
      (auth.role === "admin" || auth.role === "operator")) ||
    (auth.via === "token" &&
      (auth.scopes ?? []).some((scope) => WORKSPACE_WRITE_SCOPES.has(scope)));
  if (permitted) return auth;
  const err: Error & { statusCode?: number; code?: string } = new Error(
    "workspace write access required",
  );
  err.statusCode = 403;
  err.code = "forbidden";
  throw err;
}
