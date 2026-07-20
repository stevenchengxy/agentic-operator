/**
 * Live model discovery — calls a provider's "list models" endpoint with the
 * tenant's stored key and returns the parsed model IDs.
 *
 * Separate from `provider-test.ts` (which throws away the body to report a
 * count) because callers want the names + any metadata the provider ships
 * (context length, ownership). The Settings "browse models" picker uses
 * this; the connectivity test still uses provider-test.ts.
 *
 * Providers that need SDK-level auth (Bedrock, Vertex) or per-deployment
 * config (Azure) report `source: "unsupported"` so the UI can fall back to
 * the hardcoded catalog or a free-text input.
 */
import {
  REASONING_EFFORTS,
  type GatewayInstance,
  type ProviderId,
  type ReasoningEffort,
} from "@agentic/contracts";
import {
  assertSafeGatewayBaseUrl,
  gatewayApiUrl,
} from "./gateway-network-safety";

export interface DiscoveredModel {
  /** Provider-native model ID, e.g. "claude-sonnet-4-5", "openai/gpt-4.1". */
  id: string;
  /** Context window when the upstream response carries it. */
  contextLength?: number;
  /** Input price in $/MTok (OpenRouter returns per-token strings; we convert). */
  inputPricePerMTok?: number;
  /** Output price in $/MTok. */
  outputPricePerMTok?: number;
  /** Accepts image input (derived from architecture.input_modalities). */
  vision?: boolean;
  /** Supports tool/function calling (derived from supported_parameters). */
  tools?: boolean;
  /** Supports a reasoning/thinking control. */
  reasoning?: boolean;
  /**
   * Live provider declaration for the temperature parameter. `undefined`
   * means the upstream model list did not publish parameter capabilities.
   */
  temperatureSupported?: boolean;
  /** Exact normalized effort values advertised by a live catalog. */
  reasoningEfforts?: ReasoningEffort[];
  defaultReasoningEffort?: ReasoningEffort;
  /** True when the upstream model cannot disable thinking. */
  reasoningMandatory?: boolean;
  reasoningDefaultEnabled?: boolean;
  /** Upstream/gateway catalog timestamp; never treated as a release date. */
  providerCatalogCreatedAt?: string;
  /** Live catalog expiry, when advertised (common for preview/free routes). */
  expiresAt?: string;
}

export type DiscoverySource = "live" | "unsupported";

export interface DiscoveryResult {
  source: DiscoverySource;
  models: DiscoveredModel[];
  /** Operator-facing message when source is "unsupported" or fetch failed. */
  message: string | null;
}

const TIMEOUT_MS = 10_000;

export function parseProviderCatalogTimestamp(
  value: unknown,
): string | undefined {
  let date: Date;
  if (typeof value === "number" && Number.isFinite(value)) {
    date = new Date(value > 10_000_000_000 ? value : value * 1000);
  } else if (typeof value === "string" && value.trim()) {
    const trimmed = value.trim();
    if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
      const numeric = Number(trimmed);
      date = new Date(numeric > 10_000_000_000 ? numeric : numeric * 1000);
    } else {
      date = new Date(trimmed);
    }
  } else {
    return undefined;
  }
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

async function fetchJson(
  url: string,
  init: RequestInit,
): Promise<{ status: number; body: unknown }> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      ...init,
      redirect: "error",
      signal: ac.signal,
    });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      // some upstreams return HTML error pages — ignore
    }
    return { status: res.status, body };
  } finally {
    clearTimeout(t);
  }
}

/** Whether this provider has a real list-models implementation in this build.
 * A temporary fetch/auth failure does not change capability: callers that
 * require provider confirmation must fail closed rather than relabel it as an
 * unsupported free-text provider. */
export function supportsLiveModelDiscovery(provider: ProviderId): boolean {
  return (
    provider === "mock" ||
    provider === "anthropic" ||
    provider === "gemini" ||
    provider === "custom" ||
    OPENAI_COMPAT[provider] !== undefined
  );
}

interface OpenAICompatConfig {
  baseURL: string;
  /** Path appended to baseURL. Defaults to `/models`. */
  path?: string;
  /** Some upstreams don't actually require auth on /models (openrouter).
   *  Setting this true lets us still query even when key is empty. */
  keyOptional?: boolean;
}

const OPENAI_COMPAT: Partial<Record<ProviderId, OpenAICompatConfig>> = {
  openai: { baseURL: "https://api.openai.com/v1" },
  openrouter: { baseURL: "https://openrouter.ai/api/v1", keyOptional: true },
  groq: { baseURL: "https://api.groq.com/openai/v1" },
  together: { baseURL: "https://api.together.xyz/v1" },
  mistral: { baseURL: "https://api.mistral.ai/v1" },
  deepseek: { baseURL: "https://api.deepseek.com" },
  moonshot: { baseURL: "https://api.moonshot.ai/v1" },
  zai: { baseURL: "https://api.z.ai/api/paas/v4" },
  qwen: { baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
};

/**
 * OpenAI's /models returns `{ data: [{ id, owned_by, ... }, ...] }`.
 * OpenRouter extends it with `context_length`, `pricing`, `architecture`,
 * `supported_parameters`. Together / Mistral / Groq / DeepSeek / Qwen match
 * the bare OpenAI shape — they return `id` and sometimes `context_length`
 * only, so the price/capability fields are undefined and the picker falls
 * back to the curated catalog for those rows.
 */
export function parseOpenAICompatBody(body: unknown): DiscoveredModel[] {
  if (!body || typeof body !== "object") return [];
  const data = (body as Record<string, unknown>).data;
  if (!Array.isArray(data)) return [];
  const out: DiscoveredModel[] = [];
  for (const item of data) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const id = typeof obj.id === "string" ? obj.id : null;
    if (!id) continue;
    const entry: DiscoveredModel = { id };
    const providerCatalogCreatedAt = parseProviderCatalogTimestamp(
      obj.created_at ?? obj.created,
    );
    if (providerCatalogCreatedAt) {
      entry.providerCatalogCreatedAt = providerCatalogCreatedAt;
    }
    const expiresAt = parseProviderCatalogTimestamp(obj.expiration_date);
    if (expiresAt) entry.expiresAt = expiresAt;
    const ctxRaw = obj.context_length;
    if (typeof ctxRaw === "number" && Number.isFinite(ctxRaw)) {
      entry.contextLength = ctxRaw;
    }
    // OpenRouter pricing is per-token as strings — convert to $/MTok so the
    // UI can display "$0.15 → $0.60" the same way the static catalog does.
    const pricing = obj.pricing;
    if (pricing && typeof pricing === "object") {
      const p = pricing as Record<string, unknown>;
      const inP = parseFloat(String(p.prompt ?? ""));
      const outP = parseFloat(String(p.completion ?? ""));
      if (Number.isFinite(inP) && inP >= 0) {
        entry.inputPricePerMTok = round4(inP * 1_000_000);
      }
      if (Number.isFinite(outP) && outP >= 0) {
        entry.outputPricePerMTok = round4(outP * 1_000_000);
      }
    }
    const arch = obj.architecture;
    if (arch && typeof arch === "object") {
      const a = arch as Record<string, unknown>;
      const inputs = a.input_modalities;
      if (Array.isArray(inputs)) {
        entry.vision = inputs.some(
          (m) => typeof m === "string" && (m === "image" || m === "file"),
        );
      }
    }
    const supported = obj.supported_parameters;
    if (Array.isArray(supported)) {
      entry.tools = supported.some(
        (s) => typeof s === "string" && (s === "tools" || s === "tool_choice"),
      );
      entry.temperatureSupported = supported.some(
        (s) => typeof s === "string" && s === "temperature",
      );
      entry.reasoning = supported.some(
        (s) =>
          typeof s === "string" &&
          (s === "reasoning" ||
            s === "reasoning_effort" ||
            s === "include_reasoning"),
      );
    }

    // OpenRouter publishes a provider-normalized reasoning capability object
    // on each live model row. Keep this metadata instead of guessing from a
    // model-name suffix so newly released models become immediately testable.
    const reasoning = obj.reasoning;
    if (reasoning && typeof reasoning === "object") {
      const r = reasoning as Record<string, unknown>;
      const rawEfforts = Array.isArray(r.supported_efforts)
        ? r.supported_efforts
        : Array.isArray(r.efforts)
          ? r.efforts
          : [];
      const efforts = rawEfforts.filter(
        (value): value is ReasoningEffort =>
          typeof value === "string" &&
          (REASONING_EFFORTS as readonly string[]).includes(value),
      );
      entry.reasoning = true;
      if (efforts.length > 0) entry.reasoningEfforts = efforts;

      const defaultEffort = r.default_effort;
      if (
        typeof defaultEffort === "string" &&
        (REASONING_EFFORTS as readonly string[]).includes(defaultEffort)
      ) {
        entry.defaultReasoningEffort = defaultEffort as ReasoningEffort;
      }
      if (typeof r.mandatory === "boolean") {
        entry.reasoningMandatory = r.mandatory;
      }
      if (typeof r.default_enabled === "boolean") {
        entry.reasoningDefaultEnabled = r.default_enabled;
      }
    }
    out.push(entry);
  }
  // Stable alphabetical so the UI doesn't shuffle between fetches.
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

async function listOpenAICompat(
  apiKey: string,
  cfg: OpenAICompatConfig,
): Promise<DiscoveryResult> {
  const path = cfg.path ?? "/models";
  const headers: Record<string, string> = { Accept: "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  try {
    const { status, body } = await fetchJson(`${cfg.baseURL}${path}`, {
      headers,
    });
    if (status < 200 || status >= 300) {
      return {
        source: "unsupported",
        models: [],
        message: `Upstream returned ${status} when listing models`,
      };
    }
    return {
      source: "live",
      models: parseOpenAICompatBody(body),
      message: null,
    };
  } catch (err) {
    return {
      source: "unsupported",
      models: [],
      message: `Network error listing models: ${(err as Error).message}`,
    };
  }
}

/** Discover models from a configured gateway instance, including NewAPI. */
export async function listGatewayModels(
  instance: GatewayInstance,
  apiKey: string,
): Promise<DiscoveryResult> {
  if (instance.kind === "mock") {
    return listAvailableModels("mock", "");
  }
  if (instance.kind === "direct" && instance.providerId) {
    return listAvailableModels(instance.providerId, apiKey);
  }
  if (instance.kind === "openrouter") {
    return listAvailableModels("openrouter", apiKey);
  }
  if (!instance.baseUrl) {
    return {
      source: "unsupported",
      models: [],
      message: `Gateway ${instance.id} has no base URL`,
    };
  }
  try {
    await assertSafeGatewayBaseUrl(instance.baseUrl);
    const modelsUrl = gatewayApiUrl(
      instance.baseUrl,
      "/models",
      instance.kind === "newapi",
    );
    const url = new URL(modelsUrl);
    return listOpenAICompat(apiKey, {
      baseURL: `${url.protocol}//${url.host}${url.pathname.replace(/\/models$/, "")}`,
      keyOptional: false,
    });
  } catch (error) {
    return {
      source: "unsupported",
      models: [],
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Anthropic /v1/models — `{ data: [{ id, display_name, created_at }, ...] }`.
 * No context_length in the response; the Settings UI uses the catalog's
 * value when the discovered id matches.
 */
export function parseAnthropicBody(body: unknown): DiscoveredModel[] {
  if (!body || typeof body !== "object") return [];
  const data = (body as Record<string, unknown>).data;
  if (!Array.isArray(data)) return [];
  const out: DiscoveredModel[] = [];
  for (const item of data) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const id = obj.id;
    if (typeof id !== "string") continue;
    const providerCatalogCreatedAt = parseProviderCatalogTimestamp(
      obj.created_at ?? obj.created,
    );
    out.push(
      providerCatalogCreatedAt ? { id, providerCatalogCreatedAt } : { id },
    );
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

async function listAnthropic(apiKey: string): Promise<DiscoveryResult> {
  try {
    const { status, body } = await fetchJson(
      "https://api.anthropic.com/v1/models",
      {
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          Accept: "application/json",
        },
      },
    );
    if (status < 200 || status >= 300) {
      return {
        source: "unsupported",
        models: [],
        message: `Anthropic returned ${status} when listing models`,
      };
    }
    return { source: "live", models: parseAnthropicBody(body), message: null };
  } catch (err) {
    return {
      source: "unsupported",
      models: [],
      message: `Network error listing models: ${(err as Error).message}`,
    };
  }
}

/**
 * Gemini /v1beta/models — `{ models: [{ name: "models/gemini-2.5-flash",
 * inputTokenLimit, ... }, ...] }`. Strip the "models/" prefix so the IDs
 * match what the contracts catalog uses ("gemini-2.5-flash").
 */
function parseGeminiBody(body: unknown): DiscoveredModel[] {
  if (!body || typeof body !== "object") return [];
  const models = (body as Record<string, unknown>).models;
  if (!Array.isArray(models)) return [];
  const out: DiscoveredModel[] = [];
  for (const item of models) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const rawName = obj.name;
    if (typeof rawName !== "string") continue;
    const id = rawName.startsWith("models/")
      ? rawName.slice("models/".length)
      : rawName;
    const ctxRaw = obj.inputTokenLimit;
    const contextLength =
      typeof ctxRaw === "number" && Number.isFinite(ctxRaw)
        ? ctxRaw
        : undefined;
    out.push(contextLength !== undefined ? { id, contextLength } : { id });
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

async function listGemini(apiKey: string): Promise<DiscoveryResult> {
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`;
    const { status, body } = await fetchJson(url, {
      headers: { Accept: "application/json" },
    });
    if (status < 200 || status >= 300) {
      return {
        source: "unsupported",
        models: [],
        message: `Gemini returned ${status} when listing models`,
      };
    }
    return { source: "live", models: parseGeminiBody(body), message: null };
  } catch (err) {
    return {
      source: "unsupported",
      models: [],
      message: `Network error listing models: ${(err as Error).message}`,
    };
  }
}

/**
 * Fetch the live model list for `provider`. `apiKey` may be empty for
 * providers that expose `/models` publicly (openrouter); other providers
 * return source="unsupported" if the key is missing.
 */
export async function listAvailableModels(
  provider: ProviderId,
  apiKey: string,
): Promise<DiscoveryResult> {
  const trimmed = (apiKey ?? "").trim();

  if (provider === "mock") {
    return {
      source: "live",
      models: [{ id: "mock-model-v1", contextLength: 8192 }],
      message: null,
    };
  }

  const oai = OPENAI_COMPAT[provider];
  if (oai) {
    if (!trimmed && !oai.keyOptional) {
      return {
        source: "unsupported",
        models: [],
        message: "No API key configured — add one to list live models",
      };
    }
    return listOpenAICompat(trimmed, oai);
  }

  if (provider === "anthropic") {
    if (!trimmed) {
      return {
        source: "unsupported",
        models: [],
        message: "No API key configured — add one to list live models",
      };
    }
    return listAnthropic(trimmed);
  }

  if (provider === "gemini") {
    if (!trimmed) {
      return {
        source: "unsupported",
        models: [],
        message: "No API key configured — add one to list live models",
      };
    }
    return listGemini(trimmed);
  }

  if (provider === "custom") {
    // env-configured OpenAI-compatible endpoint (e.g. a New-api pool). Kept in
    // sync with supportsLiveModelDiscovery("custom") — callers that require
    // provider confirmation fail closed on config absence, not capability.
    const baseURL = (process.env.CUSTOM_LLM_BASE_URL ?? "")
      .trim()
      .replace(/\/+$/, "");
    if (!baseURL) {
      return {
        source: "unsupported",
        models: [],
        message: "CUSTOM_LLM_BASE_URL is not configured",
      };
    }
    if (!trimmed) {
      return {
        source: "unsupported",
        models: [],
        message: "No API key configured — add one to list live models",
      };
    }
    return listOpenAICompat(trimmed, { baseURL });
  }

  // azure / bedrock / vertex: discovery needs per-deployment or
  // SDK-level credentials that don't fit this generic flow. The UI falls
  // back to the hardcoded catalog (or a free-text input for empty catalogs).
  return {
    source: "unsupported",
    models: [],
    message: `Live model discovery for ${provider} requires SDK-specific auth — see catalog or enter the model ID manually`,
  };
}
