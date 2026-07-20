/**
 * useDeployManifest — mutation for `POST /v1/agents` (manifest upload),
 * powering the in-portal Workflow editor save flow (P3-FE-01).
 *
 * Request shape mirrors the `ManifestUploadBody` contract. `workflowSlug`
 * must be the canonical runtime identity (currently `${tenant}-default`),
 * not the bare tenant slug; omitting it delegates to the API default:
 *   { manifest: WorkflowManifest, workflowSlug?: string, note?: string, actions?: unknown[] }
 *
 * Response shape:
 *   {
 *     workflow_version_id: string,
 *     version: string,
 *     diff: { added: string[]; removed: string[]; modified: string[]; prior_version: string | null },
 *     note: string
 *   }
 *
 * On success we invalidate the agents/workflows/runs query keys so the
 * portal updates without a reload.
 */
"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AGENT_KEYS, COUNT_KEYS } from "./useStream";
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

export interface ManifestDeployResponse {
  workflow_version_id: string;
  version: string;
  diff: {
    added: string[];
    removed: string[];
    modified: string[];
    prior_version: string | null;
  };
  note: string;
}

export interface ManifestDeployBody {
  manifest: unknown[];
  /** Canonical runtime workflow id (for example `raas-default`). */
  workflowSlug?: string;
  note?: string;
  actions?: unknown[];
}

export function useDeployManifest() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: ManifestDeployBody) =>
      callV1<ManifestDeployResponse>("/v1/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: AGENT_KEYS.all });
      void client.invalidateQueries({ queryKey: COUNT_KEYS.tenant });
      void client.invalidateQueries({ queryKey: ["workflows"] as const });
    },
  });
}
