/**
 * @agentic/contracts/permissions — the single source of truth for RBAC.
 *
 * Both layers consume this exact catalog so authorization can never drift:
 *   - apps/api guards every route with `requirePermission(req, "<perm>")`
 *     (apps/api/src/plugins/rbac.ts), and
 *   - apps/web gates buttons / nav / pages off the capability set returned by
 *     `GET /v1/me` (which is computed here via `capabilitiesFor`).
 *
 * Model (P6-AUTH):
 *   - Tenant roles (`memberships.role`): viewer ⊂ operator ⊂ admin.
 *   - Platform role (`users.platform_role`): `superadmin` bypasses tenant RBAC
 *     entirely and additionally holds every `platform.*` permission.
 */

import { z } from "zod";

// ─── Roles ───────────────────────────────────────────────────────────────────

export const TENANT_ROLES = ["viewer", "operator", "admin"] as const;
export type TenantRole = (typeof TENANT_ROLES)[number];
export const TenantRoleSchema = z.enum(TENANT_ROLES);

export const PLATFORM_ROLES = ["none", "superadmin"] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];
export const PlatformRoleSchema = z.enum(PLATFORM_ROLES);

// ─── Permission catalog ──────────────────────────────────────────────────────
// Identifier shape: "<resource>.<action>". `platform.*` are superadmin-only.

export const PERMISSIONS = [
  // Reads (granted to every role, including viewer)
  "dashboard.read",
  "agents.read",
  "workflows.read",
  "runs.read",
  "events.read",
  "tasks.read",
  "tools.read",
  "deployments.read",
  "usage.read",
  "audit.read",
  "members.read",
  "settings.read",
  "tokens.read",
  "models.read",

  // Operator actions (operating the live system, no config changes)
  "agents.invoke",
  "runs.cancel",
  "runs.replay",
  "events.publish",
  "tasks.resolve",

  // Admin writes (configuration + membership within a tenant)
  "agents.write",
  "workflows.write",
  "deployments.write",
  "events.write",
  "tasks.write",
  "settings.write",
  "tokens.write",
  "models.write",
  "webhooks.write",
  "budgets.write",
  "members.write",
  "tenant.update",

  // Platform-only (superadmin)
  "platform.tenants.create",
  "platform.tenants.archive",
  "platform.users.read",
  "platform.users.write",
  "platform.memberships.write",
] as const;

export type Permission = (typeof PERMISSIONS)[number];
export const PermissionSchema = z.enum(PERMISSIONS);

const ALL = PERMISSIONS as readonly Permission[];

/** A permission only the platform superadmin may ever hold. */
export function isPlatformPermission(p: Permission): boolean {
  return p.startsWith("platform.");
}

// ─── Role → permission matrix ────────────────────────────────────────────────

// Reads granted to every role (observability). Sensitive reads
// (members/audit/tokens) are deliberately NOT here — they are admin-only.
const VIEWER_PERMS: Permission[] = [
  "dashboard.read",
  "agents.read",
  "workflows.read",
  "runs.read",
  "events.read",
  "tasks.read",
  "tools.read",
  "deployments.read",
  "models.read",
  "usage.read",
  "settings.read",
];

// Operating the live system, no configuration changes.
const OPERATOR_EXTRA: Permission[] = [
  "agents.invoke",
  "runs.cancel",
  "runs.replay",
  "events.publish",
  "tasks.resolve",
];

// Configuration + membership + sensitive reads, scoped to the tenant.
const ADMIN_EXTRA: Permission[] = [
  "members.read",
  "audit.read",
  "tokens.read",
  "agents.write",
  "workflows.write",
  "deployments.write",
  "events.write",
  "tasks.write",
  "settings.write",
  "tokens.write",
  "models.write",
  "webhooks.write",
  "budgets.write",
  "members.write",
  "tenant.update",
];

const OPERATOR_PERMS = [...VIEWER_PERMS, ...OPERATOR_EXTRA];
const ADMIN_PERMS = [...OPERATOR_PERMS, ...ADMIN_EXTRA];

/** Tenant-role → permission set. Does NOT include any `platform.*`. */
export const ROLE_PERMISSIONS: Record<TenantRole, Permission[]> = {
  viewer: VIEWER_PERMS,
  operator: OPERATOR_PERMS,
  admin: ADMIN_PERMS,
};

// ─── Resolution ──────────────────────────────────────────────────────────────

/**
 * Does the caller hold `perm`? Superadmin holds everything (tenant + platform);
 * an ordinary user's authority comes solely from their role in the active
 * tenant, and they can never hold a `platform.*` permission.
 */
export function can(
  role: TenantRole | null,
  platformRole: PlatformRole,
  perm: Permission,
): boolean {
  if (platformRole === "superadmin") return true;
  if (isPlatformPermission(perm)) return false;
  if (!role) return false;
  return ROLE_PERMISSIONS[role].includes(perm);
}

/** The full capability set for a caller — what `GET /v1/me` returns. */
export function capabilitiesFor(
  role: TenantRole | null,
  platformRole: PlatformRole,
): Permission[] {
  if (platformRole === "superadmin") return [...ALL];
  if (!role) return [];
  return [...ROLE_PERMISSIONS[role]];
}
