/**
 * tenant-header — derive the `x-agentic-tenant` header from the current URL.
 *
 * Hotfix — dashboard render hang (`/portal/hello/dashboard`).
 *
 * Every `/v1/*` fetch on the client side runs through this helper so the api
 * scopes the response to the tenant the user is *looking* at. Without this
 * header, the authenticated session's last tenant could disagree with the
 * current URL until the next navigation.
 *
 * Since P6-AUTH the api honors this header in production too, but it is NOT a
 * trust vector: the header only selects WHICH tenant the request acts on; the
 * caller's role in that tenant is always re-derived from `memberships`
 * server-side, so a forged slug for a tenant the user isn't a member of
 * resolves to `role=null` and the RBAC guard denies. Identity still comes
 * solely from the session cookie / bearer token. See
 * `apps/api/src/plugins/auth.ts:resolveTenant`.
 *
 * Returns an empty object on the server side (`typeof window === "undefined"`)
 * — server components / RSC routes should derive the tenant from `params`
 * and set the header explicitly when they need to call back into the api.
 */

const TENANT_HEADER = "x-agentic-tenant";

/**
 * Pure helper exposed for unit tests: extract the `[tenant]` segment from a
 * portal pathname. Returns null when the path doesn't sit under `/portal/`.
 */
export function tenantFromPathname(pathname: string): string | null {
  const m = pathname.match(/^\/portal\/([a-z0-9_-]{1,32})(?:\/|$)/i);
  return m ? (m[1] ?? null) : null;
}

/**
 * Build a headers fragment carrying the URL-derived tenant slug. Returns
 * `{}` when not in a browser or when the URL isn't a `/portal/<slug>/...`
 * path; non-portal callers must pass their scope explicitly.
 */
export function tenantHeader(): Record<string, string> {
  if (typeof window === "undefined") return {};
  const slug = tenantFromPathname(window.location.pathname);
  return slug ? { [TENANT_HEADER]: slug } : {};
}
