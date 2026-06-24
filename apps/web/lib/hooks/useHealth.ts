/**
 * useHealth — TanStack Query wrapper around `GET /health`.
 *
 * The api exposes an unauthenticated health endpoint (apps/api/src/routes/health.ts)
 * with three sub-component reports: inngest, sqlite, and disk. The Next.js
 * rewrite in `next.config.mjs` routes `/health` to the api on :3540 so this
 * hook works the same in dev and prod.
 *
 * Used by:
 *   - Dashboard SystemHealth panel (FE-P0-4 sub-fix 4b)
 *   - Deployments page LiveCards (Wave 4 follow-up)
 *   - Sidebar footer drilldown (UC-V11-09, deferred)
 *
 * The response shape matches `HealthReport` in `@agentic/contracts`. We poll
 * every 15s so the dashboard reflects sub-component status without manual
 * refresh.
 */
"use client";

import { useQuery } from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";

export interface HealthReport {
  ok: boolean;
  inngest: {
    ok: boolean;
    reachable?: boolean;
    note?: string;
  };
  sqlite: {
    ok: boolean;
    sizeBytes?: number;
    journalMode?: string;
  };
  disk: {
    ok: boolean;
    logsDir?: string;
    freeBytes?: number;
  };
  /**
   * 2026-05-26 — AGENTIC_DEMO_MODE flag. Surfaced so the sidebar can render
   * a lime "DEMO" pill near the logo. Optional because older api builds
   * (without this field) still parse cleanly; treat undefined as false.
   */
  demoMode?: boolean;
}

export const HEALTH_KEYS = {
  current: ["health", "current"] as const,
};

/**
 * `/health` is unauthenticated AND does NOT use the {ok, data} envelope —
 * it returns the HealthReport at top level and sets HTTP status 503 when
 * any sub-component is unhealthy. We treat any 2xx OR 503 as a successful
 * fetch (we still want the report on 503).
 */
async function fetchHealth(): Promise<HealthReport> {
  const res = await fetch("/health", {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });
  // 200 = all-ok, 503 = at least one sub-component failed — both deliver
  // the full report body that we want to surface in the UI.
  if (res.status !== 200 && res.status !== 503) {
    throw new Error(`/health: HTTP ${res.status}`);
  }
  return (await res.json()) as HealthReport;
}

export function useHealth(): UseQueryResult<HealthReport> {
  return useQuery({
    queryKey: HEALTH_KEYS.current,
    queryFn: fetchHealth,
    staleTime: 15_000,
    refetchInterval: 15_000,
  });
}

/** Format `sqlite.sizeBytes` to a short human string ("8.4 MB"). */
export function fmtBytes(n: number | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}
