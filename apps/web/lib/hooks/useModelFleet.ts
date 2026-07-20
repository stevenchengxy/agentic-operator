/**
 * useModelFleet + useAvailableModels — TanStack Query wrappers around
 * `/v1/llm/fleet` and `/v1/llm/providers/:id/available-models`.
 *
 * The Settings → Models view uses these to:
 *   1. Render the tenant's already-configured fleet (useFleet).
 *   2. Browse a provider's live model list (useAvailableModels).
 *   3. Add/remove/update fleet entries (mutations invalidate the list).
 *
 * Tenant scope rides on `tenantHeader()` (URL-derived) — same pattern as
 * useDeployments / useRuns. The api enforces tenant filtering server-side.
 */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";
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
  // Only set Content-Type when we're actually sending a body. Fastify's
  // strict JSON content-type parser rejects bodyless requests carrying
  // `Content-Type: application/json` with `FST_ERR_CTP_EMPTY_JSON_BODY`,
  // which broke DELETE /v1/llm/fleet/:id from the Settings UI.
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...tenantHeader(),
    ...(initHeaders as Record<string, string> | undefined),
  };
  if (rest.body !== undefined && rest.body !== null && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(path, {
    credentials: "same-origin",
    ...rest,
    headers,
  });
  const text = await res.text();
  let body: ApiOk<T> | ApiErr | null = null;
  try {
    body = text ? (JSON.parse(text) as ApiOk<T> | ApiErr) : null;
  } catch {
    body = null;
  }
  if (!res.ok || !body || !body.ok) {
    const detail = body && !body.ok
      ? `${body.error.code} — ${body.error.message}`
      : text.replace(/\s+/g, " ").trim().slice(0, 240) || res.statusText || "invalid response";
    throw new Error(`${path}: HTTP ${res.status} — ${detail}`);
  }
  return body.data;
}

export type FleetRole = "primary" | "fallback" | "shadow";

export interface FleetEntry {
  id: string;
  tenantSlug: string;
  provider: string;
  modelName: string;
  alias: string;
  role: FleetRole;
  dailyCapUsd: number;
  maxOutTokens: number;
  temperature: number;
  addedAt: number;
  addedBy: string | null;
  availability: "provider_confirmed" | "unverified";
  availabilityCheckedAt: number | null;
  availabilityMessage: string | null;
}

export interface AvailableModel {
  id: string;
  contextLength: number | null;
  inputPricePerMTok: number | null;
  outputPricePerMTok: number | null;
  vision: boolean;
  tools: boolean;
  reasoning: boolean;
  inFleet: boolean;
  origin: "live" | "catalog";
}

export interface AvailableModelsPayload {
  provider: string;
  source: "live" | "unsupported";
  message: string | null;
  models: AvailableModel[];
}

export interface ProviderInfo {
  id: string;
  name: string;
  hasKey: boolean;
  defaultModel: string | null;
  models: string[];
}

export interface ProviderKeyMeta {
  provider: string;
  hasKey: boolean;
  source: "vault" | "env" | "none";
  keyMasked: string | null;
  scope: "workspace" | "tenant" | null;
  setBy: string | null;
  setAt: number | null;
}

export interface ProviderTestResult {
  ok: boolean;
  statusCode: number | null;
  latencyMs: number;
  modelCount: number | null;
  message: string;
}

export interface DeleteProviderKeyResult {
  provider: string;
  deleted: true;
  /** Effective credential after deletion (for example, an env fallback). */
  effective: ProviderKeyMeta;
}

export const FLEET_KEYS = {
  list: ["llm", "fleet"] as const,
  available: (provider: string) => ["llm", "available-models", provider] as const,
  providers: ["llm", "providers"] as const,
  providerKeys: ["llm", "provider-keys"] as const,
};

/** Runtime-backed providers only; unavailable stubs and mock are filtered by the API. */
export function useModelProviders(): UseQueryResult<ProviderInfo[]> {
  return useQuery({
    queryKey: FLEET_KEYS.providers,
    queryFn: () => callV1<ProviderInfo[]>("/v1/llm/providers"),
    staleTime: 30_000,
  });
}

export function useProviderKeys(): UseQueryResult<ProviderKeyMeta[]> {
  return useQuery({
    queryKey: FLEET_KEYS.providerKeys,
    queryFn: () => callV1<ProviderKeyMeta[]>("/v1/llm/providers/keys"),
    staleTime: 10_000,
  });
}

export function useSaveProviderKey() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ provider, apiKey }: { provider: string; apiKey: string }) =>
      callV1<ProviderKeyMeta>(`/v1/llm/providers/${encodeURIComponent(provider)}/key`, {
        method: "POST",
        body: JSON.stringify({ apiKey, scope: "workspace" }),
      }),
    onSuccess: async (_data, vars) => {
      await Promise.all([
        client.invalidateQueries({ queryKey: FLEET_KEYS.providers }),
        client.invalidateQueries({ queryKey: FLEET_KEYS.providerKeys }),
        client.invalidateQueries({ queryKey: FLEET_KEYS.available(vars.provider) }),
      ]);
    },
  });
}

/**
 * Remove the persisted workspace credential for a provider. Environment-backed
 * credentials are deliberately not presented as revocable in the UI because a
 * process restart would restore them; those must be removed from deployment
 * configuration instead.
 */
export function useDeleteProviderKey() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (provider: string) =>
      callV1<DeleteProviderKeyResult>(
        `/v1/llm/providers/${encodeURIComponent(provider)}/key`,
        { method: "DELETE" },
      ),
    onSuccess: async (_data, provider) => {
      await Promise.all([
        client.invalidateQueries({ queryKey: FLEET_KEYS.providers }),
        client.invalidateQueries({ queryKey: FLEET_KEYS.providerKeys }),
        client.invalidateQueries({ queryKey: FLEET_KEYS.available(provider) }),
      ]);
    },
  });
}

export function useTestProviderKey() {
  return useMutation({
    mutationFn: ({ provider, apiKey }: { provider: string; apiKey?: string }) =>
      callV1<ProviderTestResult>(`/v1/llm/providers/${encodeURIComponent(provider)}/test`, {
        method: "POST",
        body: JSON.stringify(apiKey?.trim() ? { apiKey: apiKey.trim() } : {}),
      }),
  });
}

export function useFleet(): UseQueryResult<FleetEntry[]> {
  return useQuery({
    queryKey: FLEET_KEYS.list,
    queryFn: () => callV1<FleetEntry[]>("/v1/llm/fleet"),
    staleTime: 5_000,
  });
}

/**
 * Live models from a single provider. Disabled when `provider` is empty so
 * the picker can lazy-load on selection. Refetches on window focus are
 * disabled because the provider /models endpoint is rate-limited on some
 * vendors — the user can click "refresh" explicitly via invalidation.
 */
export function useAvailableModels(
  provider: string,
): UseQueryResult<AvailableModelsPayload> {
  return useQuery({
    queryKey: FLEET_KEYS.available(provider),
    queryFn: () =>
      callV1<AvailableModelsPayload>(
        `/v1/llm/providers/${encodeURIComponent(provider)}/available-models`,
      ),
    enabled: provider.length > 0,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
}

export interface AddFleetInput {
  provider: string;
  modelName: string;
  alias?: string;
  role?: FleetRole;
  dailyCapUsd?: number;
  maxOutTokens?: number;
  temperature?: number;
}

export function useAddFleetEntry() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: AddFleetInput) =>
      callV1<FleetEntry>("/v1/llm/fleet", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSettled: (_data, _err, vars) => {
      void client.invalidateQueries({ queryKey: FLEET_KEYS.list });
      if (vars?.provider) {
        void client.invalidateQueries({
          queryKey: FLEET_KEYS.available(vars.provider),
        });
      }
    },
  });
}

export interface UpdateFleetInput {
  id: string;
  patch: {
    alias?: string;
    role?: FleetRole;
    dailyCapUsd?: number;
    maxOutTokens?: number;
    temperature?: number;
  };
}

export function useUpdateFleetEntry() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: UpdateFleetInput) =>
      callV1<FleetEntry>(`/v1/llm/fleet/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      }),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: FLEET_KEYS.list });
    },
  });
}

export function useDeleteFleetEntry() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      callV1<{ id: string; deleted: true }>(
        `/v1/llm/fleet/${encodeURIComponent(id)}`,
        { method: "DELETE" },
      ),
    // Await the refetch so callers that `mutateAsync()` see the table update
    // before resolving — `void` here meant the UI could briefly still show
    // the just-deleted row on slow networks. The available-models cache is
    // invalidated alongside the list (we don't track which provider this
    // entry came from) — bedrock/vertex/custom never fetch anyway.
    onSettled: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: FLEET_KEYS.list }),
        client.invalidateQueries({ queryKey: ["llm", "available-models"] }),
      ]);
    },
  });
}
