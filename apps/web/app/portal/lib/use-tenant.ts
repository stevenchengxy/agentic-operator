"use client";

/**
 * useTenant (P2-FE-25) — extract the active tenant slug from the URL.
 *
 * The portal is routed at /portal/[tenant]/<view>; this hook is the canonical
 * way to read that param. A caller outside the tenant segment must be under a
 * verified SessionProvider (or pass that verified tenant explicitly); silently
 * selecting a business tenant would risk cross-tenant reads.
 *
 * Use `useTenantNavigate` to push a new tenant while keeping the rest of the
 * path intact — used by the TenantSwitcher dropdown.
 */

import { useParams, usePathname, useRouter } from "next/navigation";
import { useCallback } from "react";
import { useDirty } from "./dirty-context";
import { useSession } from "./session-context";

/**
 * Pure helper exposed for unit tests: given the raw `tenant` URL param
 * (which Next.js may surface as `string`, `string[]`, or `undefined`),
 * return a stable string. Missing params fail closed unless the server-verified
 * session tenant is supplied by the caller.
 */
export function resolveTenantParam(
  raw: string | string[] | undefined,
  sessionTenant?: string,
): string {
  const fromRoute = Array.isArray(raw) ? raw[0] : raw;
  if (typeof fromRoute === "string" && /^[a-z0-9_-]{1,64}$/i.test(fromRoute)) {
    return fromRoute;
  }
  if (
    typeof sessionTenant === "string" &&
    /^[a-z0-9_-]{1,64}$/i.test(sessionTenant)
  ) {
    return sessionTenant;
  }
  throw new Error("Tenant route parameter is required");
}

/**
 * Pure helper: rewrite the tenant segment in a portal path. Used by
 * `useTenantNavigate` to swap tenant without losing the rest of the URL.
 */
export function rewriteTenantInPath(
  pathname: string,
  nextTenant: string,
): string {
  if (!/^[a-z0-9_-]{1,64}$/i.test(nextTenant)) {
    throw new Error("Invalid tenant slug");
  }
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] === "portal" && parts.length >= 2) {
    parts[1] = nextTenant;
    // Entity detail ids are tenant-scoped. Preserve the top-level view but
    // drop stale ids when switching domains. Settings/usage is a view, not
    // an entity detail, and is safe to preserve.
    if (!(parts[2] === "settings" && parts[3] === "usage")) {
      parts.splice(3);
    }
  } else {
    parts.splice(0, parts.length, "portal", nextTenant, "dashboard");
  }
  return "/" + parts.join("/");
}

export function useTenant(sessionTenant?: string): string {
  const params = useParams<{ tenant?: string | string[] }>();
  const verifiedSession = useSession();
  return resolveTenantParam(
    params?.tenant,
    sessionTenant ?? verifiedSession?.tenant,
  );
}

export function useTenantNavigate(): (nextTenant: string) => void {
  const router = useRouter();
  const pathname = usePathname() ?? "/portal";
  const dirty = useDirty();
  return useCallback(
    (nextTenant: string) => {
      // UC-V11-15: when an editor has unsaved changes, require explicit
      // confirmation before tearing down the tenant scope (which discards
      // every in-flight draft because the URL drives the data context).
      if (dirty.isDirty()) {
        const detail = dirty.describe();
        const ok =
          typeof window !== "undefined" &&
          window.confirm(
            `You have unsaved changes${detail ? ` (${detail})` : ""}. Switch tenants anyway? Your draft will be lost.`,
          );
        if (!ok) return;
      }
      router.push(rewriteTenantInPath(pathname, nextTenant) as never);
    },
    [pathname, router, dirty],
  );
}
