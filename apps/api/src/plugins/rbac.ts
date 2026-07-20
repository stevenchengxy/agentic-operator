/**
 * P6-AUTH — RBAC guard + audit helper.
 *
 * `requirePermission(req, "<perm>")` is the single gate every protected route
 * calls (mirrors the existing `requireAuth(req)` idiom — called at the top of a
 * handler, not as a hook). It 401s when unauthenticated, 403s + writes a
 * `decision:"deny"` audit row when authenticated-but-unauthorized, else returns
 * the AuthedContext. Authorization logic lives in @agentic/contracts/permissions
 * so the web and api never drift.
 *
 * `writeAudit(ctx, …)` records a row in `audit_log`. Platform-scoped actions
 * (no active tenant) anchor to the `__system` tenant since `audit_log.tenant_id`
 * is NOT NULL.
 */

import type { FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import { getDb, tenants } from "@agentic/db";
import { can as canPerm, type Permission } from "@agentic/contracts";
import { requireAuth, type AuthedContext } from "./auth";
import { writeAudit as writeAuditEntry } from "./audit";

let systemTenantIdCache: string | null = null;
function systemTenantId(): string {
  if (systemTenantIdCache) return systemTenantIdCache;
  const t = getDb().select({ id: tenants.id }).from(tenants).where(eq(tenants.slug, "__system")).all()[0];
  systemTenantIdCache = t?.id ?? "";
  return systemTenantIdCache;
}

/** Does the caller hold `perm`? */
export function can(ctx: AuthedContext, perm: Permission): boolean {
  return canPerm(ctx.role, ctx.platformRole, perm);
}

export interface AuditOpts {
  action: string;
  targetType?: string;
  targetId?: string | null;
  /** Override the tenant the row is anchored to (defaults to ctx active tenant
   * → `__system`). */
  tenantId?: string;
  meta?: Record<string, unknown>;
  decision?: "allow" | "deny";
}

/** Durable audit write. An operation that cannot be supervised must fail
 * visibly instead of silently disappearing from the operation log. */
export function writeAudit(ctx: AuthedContext, opts: AuditOpts): void {
  const tenantId = opts.tenantId || ctx.tenantId || systemTenantId();
  if (!tenantId) {
    throw new Error(`cannot persist audit action ${opts.action}: no tenant anchor exists`);
  }
  writeAuditEntry({
    tenantId,
    actorUserId: ctx.userId ?? undefined,
    action: opts.action,
    targetType: opts.targetType,
    targetId: opts.targetId ?? undefined,
    meta: {
      decision: opts.decision ?? "allow",
      actorEmail: ctx.email ?? undefined,
      ...(opts.meta ?? {}),
    },
  });
}

function forbidden(perm: string): never {
  const err: Error & { statusCode?: number; code?: string } = new Error(
    `forbidden — missing permission: ${perm}`,
  );
  err.statusCode = 403;
  err.code = "forbidden";
  throw err;
}

/**
 * Require `perm`, returning the AuthedContext on success. 401 if anonymous,
 * 403 (+ audit deny) if authenticated but unauthorized.
 */
export function requirePermission(req: FastifyRequest, perm: Permission): AuthedContext {
  const ctx = requireAuth(req);
  if (can(ctx, perm)) return ctx;
  writeAudit(ctx, {
    action: perm,
    decision: "deny",
    meta: { method: req.method, url: req.url },
  });
  forbidden(perm);
}

/** Require the platform superadmin role. */
export function requireSuperadmin(req: FastifyRequest): AuthedContext {
  const ctx = requireAuth(req);
  if (ctx.platformRole === "superadmin") return ctx;
  writeAudit(ctx, {
    action: "platform.superadmin",
    decision: "deny",
    meta: { method: req.method, url: req.url },
  });
  forbidden("platform.superadmin");
}
