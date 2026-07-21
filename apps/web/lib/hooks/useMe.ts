/**
 * useMe — the signed-in user's identity, active-tenant role, and resolved
 * capability set (from GET /v1/me). The whole portal gates UI off this:
 * `useCan("members.write")` etc. Keyed on the active tenant slug so switching
 * tenants refetches the role/capabilities for the new tenant.
 */

"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import { usePathname } from "next/navigation";
import type { MeResponse, Permission } from "@agentic/contracts";
import { ApiResponseError, fetchApiData } from "@/lib/api-response";
import { tenantHeader, tenantFromPathname } from "./tenant-header";

async function callV1<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { headers: initHeaders, ...rest } = init;
  // Only set a JSON content-type when there's a body. Fastify 400s on an empty
  // body with `content-type: application/json` (FST_ERR_CTP_EMPTY_JSON_BODY),
  // which would otherwise break bodyless POST/DELETE (logout, delete, revoke).
  return fetchApiData<T>(path, {
    credentials: "same-origin",
    ...rest,
    headers: {
      Accept: "application/json",
      ...(init.body != null ? { "content-type": "application/json" } : {}),
      ...tenantHeader(),
      ...(initHeaders as Record<string, string> | undefined),
    },
  });
}

export const ME_KEY = ["me"] as const;

export function useMe(): UseQueryResult<MeResponse> {
  const pathname = usePathname() ?? "";
  const tenant = tenantFromPathname(pathname) ?? "";
  return useQuery({
    queryKey: [...ME_KEY, tenant] as const,
    queryFn: () => callV1<MeResponse>("/v1/me"),
    staleTime: 30_000,
    retry: false,
  });
}

/**
 * Returns a `can(permission)` predicate driven by the live capability set.
 * Defaults to deny while loading so privileged UI never flashes before
 * permissions are known.
 */
export function useCan(): (perm: Permission) => boolean {
  const { data } = useMe();
  const caps = data?.capabilities ?? [];
  return (perm: Permission) => caps.includes(perm);
}

export function useIsSuperadmin(): boolean {
  const { data } = useMe();
  return data?.user.platformRole === "superadmin";
}

export function useChangePassword() {
  return useMutation({
    mutationFn: async (body: {
      currentPassword: string;
      newPassword: string;
    }) => {
      const result = await callV1<{ ok?: unknown }>("/v1/me/password", {
        method: "POST",
        body: JSON.stringify(body),
      });
      if (result.ok !== true) {
        throw new ApiResponseError(
          "/v1/me/password",
          200,
          "password_change_unconfirmed",
          "",
          { clientKind: "passwordChangeUnconfirmed" },
        );
      }
      return { ok: true as const };
    },
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const result = await callV1<{ ok?: unknown }>("/v1/auth/logout", {
        method: "POST",
      });
      if (result.ok !== true) {
        throw new ApiResponseError(
          "/v1/auth/logout",
          200,
          "logout_unconfirmed",
          "",
          { clientKind: "logoutUnconfirmed" },
        );
      }
      return { ok: true as const };
    },
    onSuccess: () => {
      qc.clear();
      if (typeof window !== "undefined") window.location.href = "/sign-in";
    },
  });
}
