/**
 * Shared LLM provider catalog — single source of truth for both frontend
 * (Settings → Models page) and backend (LLM gateway).
 *
 * The catalog enumerates provider presets understood by configuration and UI. `installed` means a
 * real adapter ships in @agentic/llm-gateway; it does not mean credentials are configured. Bedrock
 * and Vertex remain discoverable roadmap presets but are unavailable until real signed adapters
 * ship. The deterministic mock is test-only and is never advertised as installed in a real UI.
 *
 * UI-specific fields (color, docs URL, keyPrefix for masked display) coexist
 * with backend-relevant fields (endpoint, header). The gateway reads only what
 * it needs and ignores the rest.
 */

export const PROVIDER_IDS = [
  "anthropic",
  "openai",
  "openrouter",
  "gemini",
  "mistral",
  "groq",
  "together",
  "deepseek",
  "qwen",
  "azure",
  "bedrock",
  "vertex",
  "custom",
  "mock",
] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

export interface ProviderPreset {
  id: ProviderId;
  name: string;
  endpoint: string;
  keyPrefix: string;
  header: string;
  docs: string | null;
  installed: boolean;
  color: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "anthropic",
    name: "Anthropic",
    endpoint: "https://api.anthropic.com",
    keyPrefix: "sk-ant-api03-",
    header: "x-api-key",
    docs: "https://console.anthropic.com/settings/keys",
    installed: true,
    color: "#d97757",
  },
  {
    id: "openai",
    name: "OpenAI",
    endpoint: "https://api.openai.com/v1",
    keyPrefix: "sk-proj-",
    header: "Authorization: Bearer",
    docs: "https://platform.openai.com/api-keys",
    installed: true,
    color: "#10a37f",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    endpoint: "https://openrouter.ai/api/v1",
    keyPrefix: "sk-or-",
    header: "Authorization: Bearer",
    docs: "https://openrouter.ai/keys",
    installed: true,
    color: "#6366f1",
  },
  {
    id: "gemini",
    name: "Google Gemini",
    endpoint: "https://generativelanguage.googleapis.com/v1beta",
    keyPrefix: "AIza",
    header: "x-goog-api-key",
    docs: "https://aistudio.google.com/app/apikey",
    installed: true,
    color: "#4285f4",
  },
  {
    id: "mistral",
    name: "Mistral",
    endpoint: "https://api.mistral.ai/v1",
    keyPrefix: "",
    header: "Authorization: Bearer",
    docs: "https://console.mistral.ai/api-keys/",
    installed: true,
    color: "#ff7000",
  },
  {
    id: "groq",
    name: "Groq",
    endpoint: "https://api.groq.com/openai/v1",
    keyPrefix: "gsk_",
    header: "Authorization: Bearer",
    docs: "https://console.groq.com/keys",
    installed: true,
    color: "#f55036",
  },
  {
    id: "together",
    name: "Together AI",
    endpoint: "https://api.together.xyz/v1",
    keyPrefix: "",
    header: "Authorization: Bearer",
    docs: "https://api.together.ai/settings/api-keys",
    installed: true,
    color: "#0f6fff",
  },
  {
    id: "bedrock",
    name: "AWS Bedrock",
    endpoint: "bedrock-runtime.<region>.amazonaws.com",
    keyPrefix: "AKIA",
    header: "AWS Sigv4",
    docs: "https://docs.aws.amazon.com/bedrock/",
    installed: false,
    color: "#ff9900",
  },
  {
    id: "vertex",
    name: "Google Vertex",
    endpoint: "<region>-aiplatform.googleapis.com",
    keyPrefix: "",
    header: "Bearer (Google ADC)",
    docs: "https://cloud.google.com/vertex-ai/docs/start/client-libraries",
    installed: false,
    color: "#34a853",
  },
  {
    id: "azure",
    name: "Azure OpenAI",
    endpoint: "https://<resource>.openai.azure.com",
    keyPrefix: "",
    header: "api-key",
    docs: "https://learn.microsoft.com/azure/ai-services/openai/",
    installed: true,
    color: "#0078d4",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    endpoint: "https://api.deepseek.com/v1",
    keyPrefix: "sk-",
    header: "Authorization: Bearer",
    docs: "https://platform.deepseek.com/api_keys",
    installed: true,
    color: "#4d6bfe",
  },
  {
    id: "qwen",
    name: "Qwen · DashScope",
    endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    keyPrefix: "sk-",
    header: "Authorization: Bearer",
    docs: "https://dashscope.console.aliyun.com/apiKey",
    installed: true,
    color: "#615ced",
  },
  {
    id: "custom",
    name: "Custom (OpenAI-compatible)",
    endpoint: "",
    keyPrefix: "",
    header: "Authorization: Bearer",
    docs: null,
    installed: true,
    color: "#6f7178",
  },
  {
    id: "mock",
    name: "Mock (local)",
    endpoint: "internal",
    keyPrefix: "",
    header: "(no auth)",
    docs: null,
    installed: false,
    color: "#9aa0a6",
  },
];

export interface CatalogModel {
  name: string;
  ctx: number;
  out: number;
  inP: number;
  outP: number;
  vision: boolean;
  tools: boolean;
  reasoning: boolean;
  added?: boolean;
}

/**
 * Models catalog keyed by provider id. The gateway uses just `name`; the
 * frontend Settings UI uses the full record. Provider entries without a
 * native SDK adapter (custom, bedrock, vertex) ship with an empty list and
 * the UI prompts the operator to provide a model string at invocation time.
 */
export const PROVIDER_MODEL_CATALOG: Record<ProviderId, CatalogModel[]> = {
  anthropic: [
    { name: "claude-opus-4",     ctx: 200_000, out: 8192,    inP: 15,  outP: 75,  vision: true,  tools: true,  reasoning: true  },
    { name: "claude-sonnet-4-5", ctx: 200_000, out: 8192,    inP: 3,   outP: 15,  vision: true,  tools: true,  reasoning: true,  added: true },
    { name: "claude-haiku-4-5",  ctx: 200_000, out: 8192,    inP: 0.8, outP: 4,   vision: true,  tools: true,  reasoning: false, added: true },
  ],
  openai: [
    { name: "gpt-4.1",      ctx: 1_000_000, out: 32_000,  inP: 5,   outP: 20,  vision: true,  tools: true,  reasoning: false },
    { name: "gpt-4.1-mini", ctx: 128_000,   out: 16_384,  inP: 0.4, outP: 1.6, vision: true,  tools: true,  reasoning: false, added: true },
    // gpt-5.6 series (sol > terra > luna by strength/price; `-pro` = extended-reasoning variant at the
    // same token price). Ordered after the pinned default (gpt-4.1-mini) so defaultModelFor is unchanged.
    { name: "gpt-5.6-sol",       ctx: 400_000, out: 128_000, inP: 5,   outP: 30, vision: true,  tools: true,  reasoning: true, added: true },
    { name: "gpt-5.6-sol-pro",   ctx: 400_000, out: 128_000, inP: 5,   outP: 30, vision: true,  tools: true,  reasoning: true, added: true },
    { name: "gpt-5.6-terra",     ctx: 400_000, out: 128_000, inP: 2.5, outP: 15, vision: true,  tools: true,  reasoning: true, added: true },
    { name: "gpt-5.6-terra-pro", ctx: 400_000, out: 128_000, inP: 2.5, outP: 15, vision: true,  tools: true,  reasoning: true, added: true },
    { name: "gpt-5.6-luna",      ctx: 400_000, out: 128_000, inP: 1,   outP: 6,  vision: true,  tools: true,  reasoning: true, added: true },
    { name: "gpt-5.6-luna-pro",  ctx: 400_000, out: 128_000, inP: 1,   outP: 6,  vision: true,  tools: true,  reasoning: true, added: true },
    { name: "gpt-4o",       ctx: 128_000,   out: 16_384,  inP: 2.5, outP: 10,  vision: true,  tools: true,  reasoning: false },
    { name: "gpt-4o-mini",  ctx: 128_000,   out: 16_384,  inP: 0.15, outP: 0.6, vision: true, tools: true,  reasoning: false },
    { name: "o1-pro",       ctx: 200_000,   out: 100_000, inP: 150, outP: 600, vision: false, tools: false, reasoning: true  },
  ],
  openrouter: [
    { name: "anthropic/claude-sonnet-4-5",   ctx: 200_000,   out: 8192,   inP: 3,     outP: 15,   vision: true,  tools: true,  reasoning: true  },
    { name: "anthropic/claude-haiku-4-5",    ctx: 200_000,   out: 8192,   inP: 0.8,   outP: 4,    vision: true,  tools: true,  reasoning: false },
    { name: "openai/gpt-4.1",                ctx: 1_000_000, out: 32_000, inP: 5,     outP: 20,   vision: true,  tools: true,  reasoning: false },
    { name: "openai/gpt-4.1-mini",           ctx: 128_000,   out: 16_384, inP: 0.4,   outP: 1.6,  vision: true,  tools: true,  reasoning: false },
    { name: "openai/gpt-5.6-sol",            ctx: 400_000,   out: 128_000, inP: 5,    outP: 30,   vision: true,  tools: true,  reasoning: true,  added: true },
    { name: "openai/gpt-5.6-sol-pro",        ctx: 400_000,   out: 128_000, inP: 5,    outP: 30,   vision: true,  tools: true,  reasoning: true,  added: true },
    { name: "openai/gpt-5.6-terra",          ctx: 400_000,   out: 128_000, inP: 2.5,  outP: 15,   vision: true,  tools: true,  reasoning: true,  added: true },
    { name: "openai/gpt-5.6-terra-pro",      ctx: 400_000,   out: 128_000, inP: 2.5,  outP: 15,   vision: true,  tools: true,  reasoning: true,  added: true },
    { name: "openai/gpt-5.6-luna",           ctx: 400_000,   out: 128_000, inP: 1,    outP: 6,    vision: true,  tools: true,  reasoning: true,  added: true },
    { name: "openai/gpt-5.6-luna-pro",       ctx: 400_000,   out: 128_000, inP: 1,    outP: 6,    vision: true,  tools: true,  reasoning: true,  added: true },
    { name: "openai/gpt-oss-120b",           ctx: 128_000,   out: 16_384, inP: 0.15,  outP: 0.6,  vision: false, tools: true,  reasoning: false },
    { name: "google/gemini-2.5-flash",       ctx: 1_000_000, out: 8192,   inP: 0.075, outP: 0.3,  vision: true,  tools: true,  reasoning: false },
    { name: "google/gemini-3-flash-preview", ctx: 1_000_000, out: 8192,   inP: 0.1,   outP: 0.4,  vision: true,  tools: true,  reasoning: false },
    { name: "deepseek/deepseek-v4-pro",      ctx: 128_000,   out: 8192,   inP: 0.55,  outP: 2.19, vision: false, tools: true,  reasoning: true  },
    { name: "deepseek/deepseek-v4-flash",    ctx: 128_000,   out: 8192,   inP: 0.14,  outP: 0.28, vision: false, tools: true,  reasoning: false },
    { name: "minimax/minimax-m2.7",          ctx: 200_000,   out: 8192,   inP: 0.3,   outP: 1.2,  vision: false, tools: true,  reasoning: false },
    { name: "meta-llama/llama-3.3-70b",      ctx: 128_000,   out: 8192,   inP: 0.6,   outP: 0.6,  vision: false, tools: true,  reasoning: false },
  ],
  gemini: [
    { name: "gemini-2.5-pro",   ctx: 1_000_000, out: 8192, inP: 1.25,  outP: 5.0, vision: true, tools: true, reasoning: true  },
    { name: "gemini-2.5-flash", ctx: 1_000_000, out: 8192, inP: 0.075, outP: 0.3, vision: true, tools: true, reasoning: false },
  ],
  mistral: [
    { name: "mistral-large-latest", ctx: 128_000, out: 8192, inP: 2,   outP: 6,   vision: false, tools: true, reasoning: false },
    { name: "mistral-small-latest", ctx: 128_000, out: 8192, inP: 0.2, outP: 0.6, vision: false, tools: true, reasoning: false },
  ],
  groq: [
    { name: "llama-3.3-70b-versatile",  ctx: 128_000, out: 32_768, inP: 0.59, outP: 0.79, vision: false, tools: true, reasoning: false },
    { name: "llama-3.1-8b-instant",     ctx: 128_000, out: 8192,   inP: 0.05, outP: 0.08, vision: false, tools: true, reasoning: false },
    { name: "mixtral-8x7b-32768",       ctx: 32_768,  out: 32_768, inP: 0.24, outP: 0.24, vision: false, tools: true, reasoning: false },
  ],
  together: [
    { name: "meta-llama/Llama-3.3-70B-Instruct-Turbo", ctx: 128_000, out: 8192, inP: 0.88, outP: 0.88, vision: false, tools: true, reasoning: false },
    { name: "Qwen/Qwen2.5-72B-Instruct-Turbo",         ctx: 32_768,  out: 8192, inP: 1.2,  outP: 1.2,  vision: false, tools: true, reasoning: false },
  ],
  deepseek: [
    { name: "deepseek-chat",     ctx: 128_000, out: 8192, inP: 0.14, outP: 0.28, vision: false, tools: true, reasoning: false },
    { name: "deepseek-reasoner", ctx: 128_000, out: 8192, inP: 0.55, outP: 2.19, vision: false, tools: true, reasoning: true  },
  ],
  qwen: [
    { name: "qwen-max",   ctx: 32_768, out: 8192, inP: 2.4, outP: 9.6, vision: false, tools: true, reasoning: false },
    { name: "qwen-plus",  ctx: 131_072, out: 8192, inP: 0.4, outP: 1.2, vision: false, tools: true, reasoning: false },
    { name: "qwen-turbo", ctx: 1_000_000, out: 8192, inP: 0.05, outP: 0.2, vision: false, tools: true, reasoning: false },
  ],
  azure: [
    { name: "gpt-4o",       ctx: 128_000, out: 16_384, inP: 2.5, outP: 10,  vision: true, tools: true, reasoning: false },
    { name: "gpt-4o-mini",  ctx: 128_000, out: 16_384, inP: 0.15, outP: 0.6, vision: true, tools: true, reasoning: false },
  ],
  bedrock: [],
  vertex: [],
  custom: [],
  mock: [{ name: "mock-model-v1", ctx: 8192, out: 4096, inP: 0, outP: 0, vision: false, tools: false, reasoning: false }],
};

/**
 * Default model per provider — used when a request omits `model` and the
 * env's `LLM_DEFAULT_MODEL` is also unset. Returns `null` for providers
 * without a sensible default (custom, stubs).
 */
export function defaultModelFor(provider: ProviderId): string | null {
  const list = PROVIDER_MODEL_CATALOG[provider];
  if (!list || list.length === 0) return null;
  const added = list.find((m) => m.added);
  return (added ?? list[0])?.name ?? null;
}
