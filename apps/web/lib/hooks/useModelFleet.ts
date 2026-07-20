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
import { usePathname } from "next/navigation";
import type {
  CatalogModelStatus,
  ModelTier,
  ReasoningEffort,
  ReasoningMode,
  TemperatureRange,
  TextVerbosity,
} from "@agentic/contracts";
import { tenantFromPathname, tenantHeader } from "./tenant-header";

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
  if (
    rest.body !== undefined &&
    rest.body !== null &&
    !headers["Content-Type"]
  ) {
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(path, {
    credentials: "same-origin",
    ...rest,
    headers,
  });
  const body = (await res.json()) as ApiOk<T> | ApiErr;
  if (!body.ok) {
    throw new Error(`${path}: ${body.error.code} — ${body.error.message}`);
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
  /** null means the parameter is omitted and the provider/model default wins. */
  temperature: number | null;
  addedAt: number;
  addedBy: string | null;
}

export interface AvailableModel {
  id: string;
  contextLength: number | null;
  inputPricePerMTok: number | null;
  outputPricePerMTok: number | null;
  vision: boolean;
  tools: boolean;
  reasoning: boolean;
  reasoningEfforts: ReasoningEffort[];
  reasoningModes: ReasoningMode[];
  defaultReasoningEffort: ReasoningEffort | null;
  defaultReasoningMode: ReasoningMode | null;
  reasoningMandatory: boolean;
  reasoningDefaultEnabled: boolean;
  textVerbosities: TextVerbosity[];
  /** null=unsupported, object=supported range, absent=unknown */
  temperatureRange?: TemperatureRange | null;
  tier: ModelTier | null;
  status: CatalogModelStatus;
  selectable: boolean;
  unavailableReason: string | null;
  releaseDate: string | null;
  providerCatalogCreatedAt: string | null;
  expiresAt: string | null;
  inFleet: boolean;
  origin: "live" | "catalog";
}

export interface AvailableModelsPayload {
  provider: string;
  source: "live" | "unsupported";
  message: string | null;
  models: AvailableModel[];
}

export const FLEET_KEYS = {
  root: ["llm", "fleet"] as const,
  list: (tenant: string) => ["llm", "fleet", tenant] as const,
  availableRoot: (tenant: string) =>
    ["llm", "available-models", tenant] as const,
  available: (tenant: string, provider: string) =>
    ["llm", "available-models", tenant, provider] as const,
};

function useTenantQueryScope(): string {
  const pathname = usePathname() ?? "";
  return tenantFromPathname(pathname) ?? "default";
}

export function useFleet(): UseQueryResult<FleetEntry[]> {
  const tenant = useTenantQueryScope();
  return useQuery({
    queryKey: FLEET_KEYS.list(tenant),
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
  const tenant = useTenantQueryScope();
  return useQuery({
    queryKey: FLEET_KEYS.available(tenant, provider),
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
  temperature?: number | null;
}

export function useAddFleetEntry() {
  const client = useQueryClient();
  const tenant = useTenantQueryScope();
  return useMutation({
    mutationFn: (input: AddFleetInput) =>
      callV1<FleetEntry>("/v1/llm/fleet", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSettled: (_data, _err, vars) => {
      void client.invalidateQueries({ queryKey: FLEET_KEYS.list(tenant) });
      if (vars?.provider) {
        void client.invalidateQueries({
          queryKey: FLEET_KEYS.available(tenant, vars.provider),
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
    temperature?: number | null;
  };
}

export function useUpdateFleetEntry() {
  const client = useQueryClient();
  const tenant = useTenantQueryScope();
  return useMutation({
    mutationFn: ({ id, patch }: UpdateFleetInput) =>
      callV1<FleetEntry>(`/v1/llm/fleet/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      }),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: FLEET_KEYS.list(tenant) });
    },
  });
}

export function useDeleteFleetEntry() {
  const client = useQueryClient();
  const tenant = useTenantQueryScope();
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
        client.invalidateQueries({ queryKey: FLEET_KEYS.list(tenant) }),
        client.invalidateQueries({
          queryKey: FLEET_KEYS.availableRoot(tenant),
        }),
      ]);
    },
  });
}
