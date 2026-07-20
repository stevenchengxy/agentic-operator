/**
 * useTenants — TanStack Query hook for the sidebar tenant switcher.
 *
 * The chrome (`apps/web/app/portal/components/shell/chrome.tsx`) used to
 * read from a static `TENANTS` constant in `lib/tenants.ts`, which meant
 * tenants created via `POST /v1/tenants` never showed up until rebuild.
 * This hook makes the sidebar reflect the live DB state.
 *
 * Invalidate via `TENANTS_KEYS.all` after any tenant CRUD mutation:
 *
 *   queryClient.invalidateQueries({ queryKey: TENANTS_KEYS.all });
 */

"use client";

import type { TenantDetail, TenantUpdateBody } from "@agentic/contracts";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
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
  const res = await fetch(path, {
    credentials: "same-origin",
    ...rest,
    headers: {
      Accept: "application/json",
      ...tenantHeader(),
      ...(initHeaders as Record<string, string> | undefined),
    },
  });
  const body = (await res.json()) as ApiOk<T> | ApiErr;
  if (!body.ok) {
    throw new Error(`${path}: ${body.error.code} — ${body.error.message}`);
  }
  return body.data;
}

export interface TenantListItem {
  id: string;
  slug: string;
  name: string;
  subtitle: string | null;
  color: string | null;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
  agentCount: number;
  runs24h: number;
  openTasks: number;
  membership: "admin" | "editor" | "viewer" | null;
}

interface TenantsListResponse {
  items: TenantListItem[];
  count: number;
  viewer?: { userId: string | null; isPlatformAdmin: boolean };
}

export const TENANTS_KEYS = {
  all: ["tenants"] as const,
  list: (includeArchived: boolean) => ["tenants", { includeArchived }] as const,
};

export function useTenants(opts?: {
  includeArchived?: boolean;
}): UseQueryResult<TenantsListResponse> {
  const includeArchived = opts?.includeArchived ?? false;
  return useQuery({
    queryKey: TENANTS_KEYS.list(includeArchived),
    queryFn: () =>
      callV1<TenantsListResponse>(
        `/v1/tenants${includeArchived ? "?include_archived=1" : ""}`,
      ),
    // Tenants change rarely; 30s stale time is enough for the sidebar to
    // feel live without hammering the api. Mutations explicitly invalidate.
    staleTime: 30_000,
  });
}

export interface UpdateTenantInput {
  slug: string;
  patch: TenantUpdateBody;
}

/**
 * Update the mutable identity fields of a tenant. Exported separately from
 * the React mutation so the request contract can be unit-tested without a
 * browser/query-client harness.
 */
export function updateTenant(input: UpdateTenantInput): Promise<TenantDetail> {
  return callV1<TenantDetail>(`/v1/tenants/${encodeURIComponent(input.slug)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input.patch),
  });
}

export function useUpdateTenant() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: updateTenant,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: TENANTS_KEYS.all });
    },
  });
}
