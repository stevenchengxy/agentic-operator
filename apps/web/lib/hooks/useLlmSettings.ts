"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import { usePathname } from "next/navigation";
import type {
  GatewayInstance,
  LlmSettings,
  ReasoningConfig,
  ResolvedLlmRouting,
  TaskModelParameters,
  TextVerbosity,
} from "@agentic/contracts";
import { tenantFromPathname, tenantHeader } from "./tenant-header";
import { usageAttributionHeaders } from "./usage-attribution";

interface ApiOk<T> {
  ok: true;
  data: T;
}

interface ApiErr {
  ok: false;
  error: { code: string; message: string; hint?: string };
}

export class LlmSettingsApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = "LlmSettingsApiError";
  }
}

async function callV1<T>(
  path: string,
  init: RequestInit = {},
  productAction = "read-settings",
): Promise<T> {
  const { headers: initHeaders, ...rest } = init;
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...tenantHeader(),
    ...usageAttributionHeaders("llm-settings"),
    "X-Agentic-Product-Action": productAction,
    ...(initHeaders as Record<string, string> | undefined),
  };
  if (rest.body !== undefined && rest.body !== null) {
    headers["Content-Type"] ??= "application/json";
  }

  const response = await fetch(path, {
    credentials: "same-origin",
    ...rest,
    headers,
  });
  let body: ApiOk<T> | ApiErr;
  try {
    body = (await response.json()) as ApiOk<T> | ApiErr;
  } catch {
    throw new LlmSettingsApiError(
      "invalid_response",
      response.status,
      `${path} returned a non-JSON response`,
    );
  }
  if (!body.ok) {
    throw new LlmSettingsApiError(
      body.error.code,
      response.status,
      body.error.message,
      body.error.hint,
    );
  }
  return body.data;
}

export interface SettingsSyncState {
  status: "synced" | "drift";
  jsonPath: string;
  envPath: string;
  checksum: string;
  message: string | null;
}

export interface GatewayCredentialMeta {
  provider: string;
  credentialId: string | null;
  hasKey: boolean;
  source: "vault" | "env" | "none";
  keyMasked: string | null;
  scope: "workspace" | "tenant" | null;
  setBy: string | null;
  setAt: number | null;
}

export interface LlmSettingsSnapshot {
  settings: LlmSettings;
  sync: SettingsSyncState;
  credentials?: Record<string, GatewayCredentialMeta>;
}

export interface GatewayConnectionResult {
  ok: boolean;
  statusCode: number | null;
  latencyMs: number;
  modelCount: number | null;
  message: string;
  endpoint: string | null;
  testedAt: number;
}

export interface GatewayDiscoveredModel {
  id: string;
  contextLength?: number;
  inputPricePerMTok?: number;
  outputPricePerMTok?: number;
  vision?: boolean;
  tools?: boolean;
  reasoning?: boolean;
  temperatureSupported?: boolean;
  providerCatalogCreatedAt?: string;
  expiresAt?: string;
}

export interface GatewayModelsResult {
  gatewayInstanceId: string;
  source: "live" | "unsupported";
  models: GatewayDiscoveredModel[];
  message: string | null;
}

export interface TestCallRouting {
  requestedRoute?: string;
  effectiveRoute?: string;
  gatewayInstanceId?: string;
  gatewayKind?: string;
  modelFamily?: string;
  taskType?: string;
  matchedTaskType?: string;
  profileId?: string;
  settingsRevision?: number;
  resolutionReason?: "explicit" | "exact" | "alias" | "parent" | "default";
  explanation?: string;
}

export interface TestCallUsage {
  available?: boolean;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  cacheWrite5mInputTokens: number;
  cacheWrite1hInputTokens: number;
  reasoningTokens: number;
  inputAudioTokens: number;
  outputAudioTokens: number;
}

export interface TestCallResult {
  text: string;
  provider: string;
  model: string;
  routing?: TestCallRouting;
  latencyMs: number;
  tokensIn: number | null;
  tokensOut: number | null;
  usage?: TestCallUsage;
  cost?: {
    totalUsdNanos: number | null;
    inputUsdNanos: number | null;
    cachedInputUsdNanos: number | null;
    cacheWriteUsdNanos: number | null;
    outputUsdNanos: number | null;
    source: "provider" | "catalog" | "unpriced";
    priceSource?: string;
    priceAsOf?: string;
  };
  finishReason: string;
  providerRequestId?: string;
  reasoning?: ReasoningConfig;
  verbosity?: TextVerbosity;
}

export interface TestCallInput {
  route?: string;
  taskClass?: string;
  prompt: string;
  maxTokens?: number;
  timeoutMs?: number;
  temperature?: number;
  reasoning?: ReasoningConfig;
  verbosity?: TextVerbosity;
  store?: boolean;
  jsonMode?: boolean;
}

function useTenantQueryScope(): string {
  const pathname = usePathname() ?? "";
  return tenantFromPathname(pathname) ?? "default";
}

export const LLM_SETTINGS_KEYS = {
  root: ["llm", "settings"] as const,
  snapshot: (tenant: string) => ["llm", "settings", tenant] as const,
  gatewayModels: (tenant: string, id: string) =>
    ["llm", "gateways", tenant, id, "models"] as const,
};

export function useLlmSettings(): UseQueryResult<LlmSettingsSnapshot> {
  const tenant = useTenantQueryScope();
  const queryKey = LLM_SETTINGS_KEYS.snapshot(tenant);
  return useQuery({
    queryKey,
    queryFn: () => callV1<LlmSettingsSnapshot>("/v1/llm/settings"),
    staleTime: 10_000,
  });
}

export function useSaveLlmSettings() {
  const client = useQueryClient();
  const tenant = useTenantQueryScope();
  const queryKey = LLM_SETTINGS_KEYS.snapshot(tenant);
  return useMutation({
    mutationFn: (input: { expectedRevision: number; settings: LlmSettings }) =>
      callV1<LlmSettingsSnapshot>(
        "/v1/llm/settings",
        { method: "PUT", body: JSON.stringify(input) },
        "save-settings",
      ),
    onSuccess: (snapshot) => {
      client.setQueryData<LlmSettingsSnapshot>(queryKey, (current) => ({
        ...snapshot,
        credentials: current?.credentials,
      }));
      void client.invalidateQueries({ queryKey });
    },
  });
}

export function useResyncLlmSettings() {
  const client = useQueryClient();
  const tenant = useTenantQueryScope();
  const queryKey = LLM_SETTINGS_KEYS.snapshot(tenant);
  return useMutation({
    mutationFn: () =>
      callV1<LlmSettingsSnapshot>(
        "/v1/llm/settings/resync",
        { method: "POST" },
        "resync-settings",
      ),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey });
    },
  });
}

export function useResolveLlmRouting() {
  return useMutation({
    mutationFn: (input: { taskClass: string; explicitRoute?: string }) =>
      callV1<ResolvedLlmRouting>(
        "/v1/llm/routing/resolve",
        { method: "POST", body: JSON.stringify(input) },
        "preview-routing",
      ),
  });
}

export function useSaveGatewayKey() {
  const client = useQueryClient();
  const tenant = useTenantQueryScope();
  const queryKey = LLM_SETTINGS_KEYS.snapshot(tenant);
  return useMutation({
    mutationFn: (input: {
      id: string;
      apiKey: string;
      scope: "workspace" | "tenant";
    }) =>
      callV1<GatewayCredentialMeta>(
        `/v1/llm/gateways/${encodeURIComponent(input.id)}/key`,
        {
          method: "POST",
          body: JSON.stringify({ apiKey: input.apiKey, scope: input.scope }),
        },
        "rotate-gateway-key",
      ),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey });
    },
  });
}

export function useTestGatewayConnection() {
  return useMutation({
    mutationFn: (input: {
      id: string;
      apiKey?: string;
      instance?: GatewayInstance;
      timeoutMs?: number;
    }) =>
      callV1<GatewayConnectionResult>(
        `/v1/llm/gateways/${encodeURIComponent(input.id)}/test-connection`,
        {
          method: "POST",
          body: JSON.stringify({
            apiKey: input.apiKey || undefined,
            instance: input.instance,
            timeoutMs: input.timeoutMs,
          }),
        },
        "test-connection",
      ),
  });
}

export function useGatewayModels(
  id: string,
  enabled = true,
): UseQueryResult<GatewayModelsResult> {
  const tenant = useTenantQueryScope();
  return useQuery({
    queryKey: LLM_SETTINGS_KEYS.gatewayModels(tenant, id),
    queryFn: () =>
      callV1<GatewayModelsResult>(
        `/v1/llm/gateways/${encodeURIComponent(id)}/models`,
        {},
        "discover-models",
      ),
    enabled: enabled && id.length > 0,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
}

export function useTestLlmCall() {
  return useMutation({
    mutationFn: (input: TestCallInput) =>
      callV1<TestCallResult>(
        "/v1/llm/test-call",
        { method: "POST", body: JSON.stringify(input) },
        "test-call",
      ),
  });
}

/** Build a provider-default parameter object while dropping blank controls. */
export function compactTaskParameters(
  input: TaskModelParameters,
): TaskModelParameters {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  ) as TaskModelParameters;
}
