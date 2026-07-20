/**
 * useAudit — TanStack Query wrapper around `GET /v1/audit`.
 *
 * The api endpoint is paginated by an opaque cursor (the wire format is just
 * the `at` timestamp of the last row). This hook supports two consumption
 * patterns:
 *
 *   - `useAudit(filter)`             → single page (most recent N rows)
 *   - `useAuditPages(filter)`        → useInfiniteQuery for cursor pagination
 *
 * The route is read-only — no mutation hook here. Mutations elsewhere
 * (deployments, tenants, llm-keys, …) write rows that this hook surfaces.
 *
 * Wired by docs/team-execution/03-logging-audit.md: previously the
 * Settings → Audit section called `/v1/audit` via raw fetch, which 404'd
 * because the route file wasn't registered in `apps/api/src/server.ts`. This
 * hook lets the section consume the same path through a typed wrapper.
 */
"use client";

import {
  useInfiniteQuery,
  useQuery,
  type InfiniteData,
  type UseInfiniteQueryResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import { readApiData } from "@/lib/api-response";
import { tenantHeader } from "./tenant-header";

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
  return readApiData<T>(res, path);
}

export interface AuditRow {
  id: string;
  tenantId: string;
  actorUserId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  at: number;
  meta: Record<string, unknown> | null;
}

export interface AuditResponse {
  items: AuditRow[];
  nextCursor: string | null;
  count: number;
}

export interface AuditFilter {
  /** Inclusive lower bound on `at` (unix-ms). */
  since?: number;
  /** Exclusive upper bound on `at` (unix-ms). */
  until?: number;
  /** Exact match on `actor_user_id`. */
  actor?: string;
  /** Exact match on `action`. */
  action?: string;
  /** Page size — defaults to 100 server-side. Max 500. */
  limit?: number;
}

function buildQuery(filter: AuditFilter, cursor?: string): string {
  const sp = new URLSearchParams();
  if (filter.since != null) sp.set("since", String(filter.since));
  if (filter.until != null) sp.set("until", String(filter.until));
  if (filter.actor) sp.set("actor", filter.actor);
  if (filter.action) sp.set("action", filter.action);
  if (filter.limit != null) sp.set("limit", String(filter.limit));
  if (cursor) sp.set("cursor", cursor);
  const s = sp.toString();
  return s ? `?${s}` : "";
}

export const AUDIT_KEYS = {
  all: ["audit"] as const,
  list: (filter?: AuditFilter) => ["audit", "list", filter ?? null] as const,
  pages: (filter?: AuditFilter) => ["audit", "pages", filter ?? null] as const,
};

export function useAudit(
  filter: AuditFilter = {},
): UseQueryResult<AuditResponse> {
  const qs = buildQuery(filter);
  return useQuery({
    queryKey: AUDIT_KEYS.list(filter),
    queryFn: () => callV1<AuditResponse>(`/v1/audit${qs}`),
    staleTime: 5_000,
    // `audit.recorded` SSE invalidation is primary. Polling remains a bounded
    // resilience fallback for older runtimes and temporarily dropped streams.
    refetchInterval: 10_000,
    refetchIntervalInBackground: false,
  });
}

/**
 * Cursor pagination for the audit log. Use when the operator wants to
 * walk through the entire history rather than just the top page.
 */
export function useAuditPages(
  filter: AuditFilter = {},
): UseInfiniteQueryResult<InfiniteData<AuditResponse, string | undefined>> {
  return useInfiniteQuery({
    queryKey: AUDIT_KEYS.pages(filter),
    queryFn: ({ pageParam }) => {
      const qs = buildQuery(filter, pageParam as string | undefined);
      return callV1<AuditResponse>(`/v1/audit${qs}`);
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    staleTime: 5_000,
  });
}
