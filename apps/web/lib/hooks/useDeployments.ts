/**
 * useDeployments — TanStack Query wrappers around `/v1/deployments`.
 *
 * Live deployment history + rollback. The pre-2026-05-26 v1_1 SPA used a
 * bootstrap-synthesized fixture list; that mock fallback was removed when
 * the "production = zero mock" rule landed. Tenant scope comes from the
 * bearer (AUTH_MODE=dev resolves it from AGENTIC_DEV_TENANT) — the path
 * itself isn't tenant-prefixed.
 *
 * Cache shape:
 *   - queryKey ["deployments", "list"]: { list, live }
 *
 * Mutations:
 *   - rollback(deploymentId): flips the live pointer; invalidates the list.
 *     Inngest re-register requires an api restart — surfaced in the response
 *     `note` field, not handled here.
 */
"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";
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

export interface DeploymentRow {
  id: string;
  versionId: string;
  versionString: string;
  status: "live" | "pending" | "rolled_back" | "superseded" | string;
  deployedAt: string | null;
  deployedBy: string | null;
  note: string | null;
  workflowSlug: string;
  agentCount: number;
}

export interface DeploymentsPayload {
  list: DeploymentRow[];
  live: DeploymentRow | null;
}

export interface RollbackPayload {
  deployment_id: string;
  status: "live";
  note: string;
}

export const DEPLOYMENT_KEYS = {
  list: ["deployments", "list"] as const,
};

export function useDeployments(): UseQueryResult<DeploymentsPayload> {
  return useQuery({
    queryKey: DEPLOYMENT_KEYS.list,
    queryFn: () => callV1<DeploymentsPayload>("/v1/deployments"),
    staleTime: 5_000,
  });
}

/**
 * Rollback a prior deployment to live. Invalidates the list on settle so the
 * "live" badge moves in the UI; the runtime requires an api restart for
 * Inngest to pick up the new manifest (surfaced in `note`).
 */
export function useRollbackDeployment() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (deploymentId: string) =>
      callV1<RollbackPayload>(
        `/v1/deployments/${encodeURIComponent(deploymentId)}/rollback`,
        { method: "POST" },
      ),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: DEPLOYMENT_KEYS.list });
    },
  });
}
