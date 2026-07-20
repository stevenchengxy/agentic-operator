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
 * config (Azure) report `source: "unsupported"`; the UI may accept an
 * explicitly unverified provider model id, but never presents a static row
 * as provider-confirmed availability.
 */
import type { ProviderId } from "@agentic/contracts";

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
}

export type DiscoverySource = "live" | "unsupported";

export interface DiscoveryResult {
  source: DiscoverySource;
  models: DiscoveredModel[];
  /** Operator-facing message when source is "unsupported" or fetch failed. */
  message: string | null;
}

const TIMEOUT_MS = 10_000;

async function fetchJson(
  url: string,
  init: RequestInit,
): Promise<{ status: number; body: unknown }> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: ac.signal });
    let body: unknown;
    try {
      body = await res.json();
    } catch (error) {
      throw new Error(`model catalog returned non-JSON content (HTTP ${res.status})`, {
        cause: error,
      });
    }
    return { status: res.status, body };
  } finally {
    clearTimeout(t);
  }
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
  deepseek: { baseURL: "https://api.deepseek.com/v1" },
  qwen: { baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
};

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

/**
 * OpenAI's /models returns `{ data: [{ id, owned_by, ... }, ...] }`.
 * OpenRouter extends it with `context_length`, `pricing`, `architecture`,
 * `supported_parameters`. Together / Mistral / Groq / DeepSeek / Qwen match
 * the bare OpenAI shape — they return `id` and sometimes `context_length`
 * only, so the price/capability fields are undefined and the picker falls
 * back to the curated catalog for those rows.
 */
function parseOpenAICompatBody(body: unknown): DiscoveredModel[] {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new TypeError("model catalog payload must be an object");
  }
  const data = (body as Record<string, unknown>).data;
  if (!Array.isArray(data)) throw new TypeError("model catalog payload is missing data[]");
  const out: DiscoveredModel[] = [];
  for (const [index, item] of data.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new TypeError(`model catalog data[${index}] must be an object`);
    }
    const obj = item as Record<string, unknown>;
    const id = typeof obj.id === "string" ? obj.id.trim() : "";
    if (!id) throw new TypeError(`model catalog data[${index}].id is required`);
    const entry: DiscoveredModel = { id };
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
    const { status, body } = await fetchJson(`${cfg.baseURL}${path}`, { headers });
    if (status < 200 || status >= 300) {
      return {
        source: "unsupported",
        models: [],
        message: `Upstream returned ${status} when listing models`,
      };
    }
    return { source: "live", models: parseOpenAICompatBody(body), message: null };
  } catch (err) {
    return {
      source: "unsupported",
      models: [],
      message: `Live model discovery failed: ${(err as Error).message}`,
    };
  }
}

/**
 * Anthropic /v1/models — `{ data: [{ id, display_name, created_at }, ...] }`.
 * No context_length in the response; the Settings UI uses the catalog's
 * value when the discovered id matches.
 */
function parseAnthropicBody(body: unknown): DiscoveredModel[] {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new TypeError("Anthropic model catalog payload must be an object");
  }
  const data = (body as Record<string, unknown>).data;
  if (!Array.isArray(data)) throw new TypeError("Anthropic model catalog payload is missing data[]");
  const out: DiscoveredModel[] = [];
  for (const [index, item] of data.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new TypeError(`Anthropic model catalog data[${index}] must be an object`);
    }
    const id = (item as Record<string, unknown>).id;
    if (typeof id !== "string" || !id.trim()) {
      throw new TypeError(`Anthropic model catalog data[${index}].id is required`);
    }
    out.push({ id: id.trim() });
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

async function listAnthropic(apiKey: string): Promise<DiscoveryResult> {
  try {
    const { status, body } = await fetchJson("https://api.anthropic.com/v1/models", {
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        Accept: "application/json",
      },
    });
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
      message: `Live model discovery failed: ${(err as Error).message}`,
    };
  }
}

/**
 * Gemini /v1beta/models — `{ models: [{ name: "models/gemini-2.5-flash",
 * inputTokenLimit, ... }, ...] }`. Strip the "models/" prefix so the IDs
 * match what the contracts catalog uses ("gemini-2.5-flash").
 */
function parseGeminiBody(body: unknown): DiscoveredModel[] {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new TypeError("Gemini model catalog payload must be an object");
  }
  const models = (body as Record<string, unknown>).models;
  if (!Array.isArray(models)) throw new TypeError("Gemini model catalog payload is missing models[]");
  const out: DiscoveredModel[] = [];
  for (const [index, item] of models.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new TypeError(`Gemini model catalog models[${index}] must be an object`);
    }
    const obj = item as Record<string, unknown>;
    const rawName = obj.name;
    if (typeof rawName !== "string" || !rawName.trim()) {
      throw new TypeError(`Gemini model catalog models[${index}].name is required`);
    }
    const id = rawName.startsWith("models/") ? rawName.slice("models/".length) : rawName;
    const ctxRaw = obj.inputTokenLimit;
    const contextLength =
      typeof ctxRaw === "number" && Number.isFinite(ctxRaw) ? ctxRaw : undefined;
    out.push(contextLength !== undefined ? { id, contextLength } : { id });
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

async function listGemini(apiKey: string): Promise<DiscoveryResult> {
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`;
    const { status, body } = await fetchJson(url, { headers: { Accept: "application/json" } });
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
      message: `Live model discovery failed: ${(err as Error).message}`,
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
    if (process.env.NODE_ENV !== "test") {
      return {
        source: "unsupported",
        models: [],
        message: "The mock provider is available only inside NODE_ENV=test",
      };
    }
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
    const baseURL = (process.env.CUSTOM_LLM_BASE_URL ?? "").trim().replace(/\/+$/, "");
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
  // SDK-level credentials that do not fit this generic flow. The UI exposes
  // an explicitly unverified free-text model id instead of a fabricated
  // "available" catalog.
  return {
    source: "unsupported",
    models: [],
    message: `Live model discovery for ${provider} requires SDK-specific auth — enter the exact provider model ID manually`,
  };
}
