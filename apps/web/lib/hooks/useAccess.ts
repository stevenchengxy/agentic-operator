/**
 * useAccess — TanStack Query hooks for the Access tab.
 *
 *   useMembers / useAddMember / useUpdateMemberRole / useRemoveMember
 *       → tenant-scoped membership management (GET/POST/PATCH/DELETE /v1/members)
 *   useAdminUsers / useUpdateUser / useGrantMembership / useRevokeMembership
 *       → platform-wide user administration (/v1/admin/users*)
 *
 * All write hooks invalidate the relevant list so the table stays live.
 */

"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import type {
  AdminUserRow,
  MemberRow,
  TenantRole,
} from "@agentic/contracts";
import { tenantHeader } from "./tenant-header";

interface ApiOk<T> {
  ok: true;
  data: T;
}
interface ApiErr {
  ok: false;
  error: { code: string; message: string };
}

async function callV1<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { headers: initHeaders, ...rest } = init;
  // Only set a JSON content-type when there's a body — Fastify 400s on an empty
  // body with `content-type: application/json`, which would break bodyless
  // DELETE (remove member, revoke membership, delete user).
  const res = await fetch(path, {
    credentials: "same-origin",
    ...rest,
    headers: {
      Accept: "application/json",
      ...(init.body != null ? { "content-type": "application/json" } : {}),
      ...tenantHeader(),
      ...(initHeaders as Record<string, string> | undefined),
    },
  });
  const body = (await res.json()) as ApiOk<T> | ApiErr;
  if (!body.ok) {
    const e = new Error(`${body.error.code} — ${body.error.message}`) as Error & {
      code?: string;
    };
    e.code = body.error.code;
    throw e;
  }
  return body.data;
}

export const ACCESS_KEYS = {
  members: ["access", "members"] as const,
  users: ["access", "admin-users"] as const,
};

// ─── Tenant-scoped members ───────────────────────────────────────────────────

export function useMembers(enabled: boolean): UseQueryResult<MemberRow[]> {
  return useQuery({
    queryKey: ACCESS_KEYS.members,
    queryFn: () => callV1<{ items: MemberRow[] }>("/v1/members").then((d) => d.items),
    enabled,
    staleTime: 10_000,
    retry: false,
  });
}

export function useAddMember() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { email: string; role: TenantRole }) =>
      callV1<{ items: MemberRow[] }>("/v1/members", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ACCESS_KEYS.members }),
  });
}

export function useUpdateMemberRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: TenantRole }) =>
      callV1<{ items: MemberRow[] }>(`/v1/members/${userId}`, {
        method: "PATCH",
        body: JSON.stringify({ role }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ACCESS_KEYS.members }),
  });
}

export function useRemoveMember() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) =>
      callV1<{ items: MemberRow[] }>(`/v1/members/${userId}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ACCESS_KEYS.members }),
  });
}

// ─── Platform-wide users (superadmin) ────────────────────────────────────────

export function useAdminUsers(enabled: boolean): UseQueryResult<AdminUserRow[]> {
  return useQuery({
    queryKey: ACCESS_KEYS.users,
    queryFn: () => callV1<{ items: AdminUserRow[] }>("/v1/admin/users").then((d) => d.items),
    enabled,
    staleTime: 10_000,
    retry: false,
  });
}

export function useUpdateUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      userId,
      ...body
    }: {
      userId: string;
      platformRole?: "none" | "superadmin";
      status?: "active" | "suspended";
    }) =>
      callV1<{ items: AdminUserRow[] }>(`/v1/admin/users/${userId}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ACCESS_KEYS.users }),
  });
}

export function useGrantMembership() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      userId,
      tenantSlug,
      role,
    }: {
      userId: string;
      tenantSlug: string;
      role: TenantRole;
    }) =>
      callV1<{ items: AdminUserRow[] }>(`/v1/admin/users/${userId}/memberships`, {
        method: "POST",
        body: JSON.stringify({ tenantSlug, role }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ACCESS_KEYS.users }),
  });
}

export function useDeleteUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) =>
      callV1<{ items: AdminUserRow[] }>(`/v1/admin/users/${userId}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ACCESS_KEYS.users }),
  });
}

export function useRevokeMembership() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, tenantSlug }: { userId: string; tenantSlug: string }) =>
      callV1<{ items: AdminUserRow[] }>(
        `/v1/admin/users/${userId}/memberships/${tenantSlug}`,
        { method: "DELETE" },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ACCESS_KEYS.users }),
  });
}
