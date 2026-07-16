/**
 * Shared LLM provider catalog — single source of truth for both frontend
 * (Settings → Models page) and backend (LLM gateway).
 *
 * The catalog enumerates the providers the platform supports:
 *   - real providers (with adapter implementations in @agentic/llm-gateway)
 *   - 1 mock provider (always available, used for tests/dev)
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
  "moonshot",
  "zai",
  "qwen",
  "azure",
  "bedrock",
  "vertex",
  "custom",
  "mock",
] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

/**
 * Provider-neutral reasoning controls accepted by the gateway. Providers and
 * individual models support subsets of these values; `CatalogModel` advertises
 * the exact subset so callers can build valid evaluation matrices.
 */
export const REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/** Model execution mode. This is deliberately separate from service/latency tiers. */
export const REASONING_MODES = ["standard", "pro"] as const;
export type ReasoningMode = (typeof REASONING_MODES)[number];

export const REASONING_SUMMARIES = [
  "none",
  "auto",
  "concise",
  "detailed",
] as const;
export type ReasoningSummary = (typeof REASONING_SUMMARIES)[number];

export const REASONING_CONTEXTS = [
  "auto",
  "current_turn",
  "all_turns",
] as const;
export type ReasoningContext = (typeof REASONING_CONTEXTS)[number];

export const TEXT_VERBOSITIES = ["low", "medium", "high"] as const;
export type TextVerbosity = (typeof TEXT_VERBOSITIES)[number];

export interface ReasoningConfig {
  effort?: ReasoningEffort;
  mode?: ReasoningMode;
  summary?: ReasoningSummary;
  context?: ReasoningContext;
}

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
    installed: false,
    color: "#4285f4",
  },
  {
    id: "mistral",
    name: "Mistral",
    endpoint: "https://api.mistral.ai/v1",
    keyPrefix: "",
    header: "Authorization: Bearer",
    docs: "https://console.mistral.ai/api-keys/",
    installed: false,
    color: "#ff7000",
  },
  {
    id: "groq",
    name: "Groq",
    endpoint: "https://api.groq.com/openai/v1",
    keyPrefix: "gsk_",
    header: "Authorization: Bearer",
    docs: "https://console.groq.com/keys",
    installed: false,
    color: "#f55036",
  },
  {
    id: "together",
    name: "Together AI",
    endpoint: "https://api.together.xyz/v1",
    keyPrefix: "",
    header: "Authorization: Bearer",
    docs: "https://api.together.ai/settings/api-keys",
    installed: false,
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
    installed: false,
    color: "#0078d4",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    endpoint: "https://api.deepseek.com",
    keyPrefix: "sk-",
    header: "Authorization: Bearer",
    docs: "https://platform.deepseek.com/api_keys",
    installed: false,
    color: "#4d6bfe",
  },
  {
    id: "moonshot",
    name: "Moonshot AI · Kimi",
    endpoint: "https://api.moonshot.ai/v1",
    keyPrefix: "sk-",
    header: "Authorization: Bearer",
    docs: "https://platform.moonshot.ai/console/api-keys",
    installed: false,
    color: "#111827",
  },
  {
    id: "zai",
    name: "Z.AI · GLM",
    endpoint: "https://api.z.ai/api/paas/v4",
    keyPrefix: "",
    header: "Authorization: Bearer",
    docs: "https://z.ai/manage-apikey/apikey-list",
    installed: false,
    color: "#2563eb",
  },
  {
    id: "qwen",
    name: "Qwen · DashScope",
    endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    keyPrefix: "sk-",
    header: "Authorization: Bearer",
    docs: "https://dashscope.console.aliyun.com/apiKey",
    installed: false,
    color: "#615ced",
  },
  {
    id: "custom",
    name: "Custom (OpenAI-compatible)",
    endpoint: "",
    keyPrefix: "",
    header: "Authorization: Bearer",
    docs: null,
    installed: false,
    color: "#6f7178",
  },
  {
    id: "mock",
    name: "Mock (local)",
    endpoint: "internal",
    keyPrefix: "",
    header: "(no auth)",
    docs: null,
    installed: true,
    color: "#9aa0a6",
  },
];

export interface CatalogModel {
  name: string;
  ctx: number;
  /** Maximum output tokens, or null when the provider does not publish one. */
  out: number | null;
  inP: number;
  outP: number;
  vision: boolean;
  tools: boolean;
  reasoning: boolean;
  /** Exact normalized effort values accepted for this provider/model pair. */
  reasoningEfforts?: ReasoningEffort[];
  /** Exact execution modes accepted for this provider/model pair. */
  reasoningModes?: ReasoningMode[];
  /** Reasoning summary styles accepted by the provider for this model. */
  reasoningSummaries?: ReasoningSummary[];
  /** Reasoning-context persistence modes accepted by the provider/model. */
  reasoningContexts?: ReasoningContext[];
  /** Provider/model defaults when the caller omits an explicit control. */
  defaultReasoningEffort?: ReasoningEffort;
  defaultReasoningMode?: ReasoningMode;
  /** True when reasoning cannot be disabled for this model. */
  reasoningMandatory?: boolean;
  /** Native thinking defaults on even when no normalized effort is supplied. */
  reasoningDefaultEnabled?: boolean;
  /** Model output verbosity controls, when exposed by the provider. */
  textVerbosities?: TextVerbosity[];
  defaultTextVerbosity?: TextVerbosity;
  added?: boolean;
  /** Official price source and the date on which this snapshot was checked. */
  priceSource?: string;
  priceAsOf?: string;
  /**
   * USD per million tokens. Multiple entries allow scheduled price changes
   * without rewriting historical cost calculations.
   */
  pricing?: CatalogPricing[];
}

export interface CatalogPricing {
  effectiveFrom?: string;
  effectiveTo?: string;
  input: number;
  cachedInput?: number;
  cacheWrite?: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
  output: number;
  /** Some providers price the entire request differently above a threshold. */
  longContext?: {
    inputTokensAbove: number;
    input: number;
    cachedInput?: number;
    cacheWrite?: number;
    output: number;
  };
}

/**
 * Models catalog keyed by provider id. The gateway uses just `name`; the
 * frontend Settings UI uses the full record. Provider entries without a
 * native SDK adapter (custom, bedrock, vertex) ship with an empty list and
 * the UI prompts the operator to provide a model string at invocation time.
 */
export const PROVIDER_MODEL_CATALOG: Record<ProviderId, CatalogModel[]> = {
  anthropic: [
    {
      name: "claude-fable-5", ctx: 1_000_000, out: 128_000, inP: 10, outP: 50,
      vision: true, tools: true, reasoning: true, reasoningMandatory: true, added: true,
      reasoningEfforts: ["low", "medium", "high", "xhigh", "max"], defaultReasoningEffort: "high",
      priceSource: "https://platform.claude.com/docs/en/about-claude/pricing", priceAsOf: "2026-07-15",
      pricing: [{ input: 10, cachedInput: 1, cacheWrite5m: 12.5, cacheWrite1h: 20, output: 50 }],
    },
    {
      name: "claude-mythos-5", ctx: 1_000_000, out: 128_000, inP: 10, outP: 50,
      vision: true, tools: true, reasoning: true, reasoningMandatory: true,
      reasoningEfforts: ["low", "medium", "high", "xhigh", "max"], defaultReasoningEffort: "high",
      priceSource: "https://platform.claude.com/docs/en/about-claude/pricing", priceAsOf: "2026-07-15",
      pricing: [{ input: 10, cachedInput: 1, cacheWrite5m: 12.5, cacheWrite1h: 20, output: 50 }],
    },
    {
      name: "claude-opus-4-8", ctx: 1_000_000, out: 128_000, inP: 5, outP: 25,
      vision: true, tools: true, reasoning: true,
      reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"], defaultReasoningEffort: "high",
      priceSource: "https://platform.claude.com/docs/en/about-claude/pricing", priceAsOf: "2026-07-15",
      pricing: [{ input: 5, cachedInput: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10, output: 25 }],
    },
    {
      name: "claude-sonnet-5", ctx: 1_000_000, out: 128_000, inP: 2, outP: 10,
      vision: true, tools: true, reasoning: true,
      reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"], defaultReasoningEffort: "high",
      priceSource: "https://platform.claude.com/docs/en/about-claude/pricing", priceAsOf: "2026-07-15",
      pricing: [
        { effectiveTo: "2026-08-31T23:59:59.999Z", input: 2, cachedInput: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4, output: 10 },
        { effectiveFrom: "2026-09-01T00:00:00.000Z", input: 3, cachedInput: 0.3, cacheWrite5m: 3.75, cacheWrite1h: 6, output: 15 },
      ],
    },
    {
      name: "claude-haiku-4-5", ctx: 200_000, out: 64_000, inP: 1, outP: 5,
      vision: true, tools: true, reasoning: true,
      priceSource: "https://platform.claude.com/docs/en/about-claude/pricing", priceAsOf: "2026-07-15",
      pricing: [{ input: 1, cachedInput: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2, output: 5 }],
    },
    {
      name: "claude-sonnet-4-5", ctx: 200_000, out: 64_000, inP: 3, outP: 15,
      vision: true, tools: true, reasoning: true,
      priceSource: "https://platform.claude.com/docs/en/about-claude/pricing", priceAsOf: "2026-07-15",
      pricing: [{ input: 3, cachedInput: 0.3, cacheWrite5m: 3.75, cacheWrite1h: 6, output: 15 }],
    },
    {
      name: "claude-opus-4", ctx: 200_000, out: 32_000, inP: 15, outP: 75,
      vision: true, tools: true, reasoning: true,
      priceSource: "https://platform.claude.com/docs/en/about-claude/pricing", priceAsOf: "2026-07-15",
      pricing: [{ input: 15, cachedInput: 1.5, cacheWrite5m: 18.75, cacheWrite1h: 30, output: 75 }],
    },
  ],
  openai: [
    {
      name: "gpt-5.6-sol", ctx: 1_050_000, out: 128_000, inP: 5, outP: 30,
      vision: true, tools: true, reasoning: true, added: true,
      reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"], defaultReasoningEffort: "medium",
      reasoningModes: ["standard", "pro"], defaultReasoningMode: "standard",
      reasoningSummaries: ["none", "auto", "concise", "detailed"],
      reasoningContexts: ["auto", "current_turn", "all_turns"],
      textVerbosities: ["low", "medium", "high"], defaultTextVerbosity: "medium",
      priceSource: "https://developers.openai.com/api/docs/pricing", priceAsOf: "2026-07-15",
      pricing: [{ input: 5, cachedInput: 0.5, cacheWrite: 6.25, output: 30, longContext: { inputTokensAbove: 272_000, input: 10, cachedInput: 1, cacheWrite: 12.5, output: 45 } }],
    },
    {
      name: "gpt-5.6-terra", ctx: 1_050_000, out: 128_000, inP: 2.5, outP: 15,
      vision: true, tools: true, reasoning: true,
      reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"], defaultReasoningEffort: "medium",
      reasoningModes: ["standard", "pro"], defaultReasoningMode: "standard",
      reasoningSummaries: ["none", "auto", "concise", "detailed"],
      reasoningContexts: ["auto", "current_turn", "all_turns"],
      textVerbosities: ["low", "medium", "high"], defaultTextVerbosity: "medium",
      priceSource: "https://developers.openai.com/api/docs/pricing", priceAsOf: "2026-07-15",
      pricing: [{ input: 2.5, cachedInput: 0.25, cacheWrite: 3.125, output: 15, longContext: { inputTokensAbove: 272_000, input: 5, cachedInput: 0.5, cacheWrite: 6.25, output: 22.5 } }],
    },
    {
      name: "gpt-5.6-luna", ctx: 1_050_000, out: 128_000, inP: 1, outP: 6,
      vision: true, tools: true, reasoning: true,
      reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"], defaultReasoningEffort: "medium",
      reasoningModes: ["standard", "pro"], defaultReasoningMode: "standard",
      reasoningSummaries: ["none", "auto", "concise", "detailed"],
      reasoningContexts: ["auto", "current_turn", "all_turns"],
      textVerbosities: ["low", "medium", "high"], defaultTextVerbosity: "medium",
      priceSource: "https://developers.openai.com/api/docs/pricing", priceAsOf: "2026-07-15",
      pricing: [{ input: 1, cachedInput: 0.1, cacheWrite: 1.25, output: 6, longContext: { inputTokensAbove: 272_000, input: 2, cachedInput: 0.2, cacheWrite: 2.5, output: 9 } }],
    },
    {
      name: "gpt-5.4-mini", ctx: 400_000, out: 128_000, inP: 0.75, outP: 4.5,
      vision: true, tools: true, reasoning: true,
      reasoningEfforts: ["none", "low", "medium", "high", "xhigh"], defaultReasoningEffort: "none",
      reasoningSummaries: ["none", "auto", "concise", "detailed"],
      textVerbosities: ["low", "medium", "high"], defaultTextVerbosity: "medium",
      priceSource: "https://developers.openai.com/api/docs/pricing", priceAsOf: "2026-07-15",
      pricing: [{ input: 0.75, cachedInput: 0.075, output: 4.5 }],
    },
  ],
  openrouter: [
    {
      name: "openai/gpt-5.6-sol", ctx: 1_050_000, out: 128_000, inP: 5, outP: 30,
      vision: true, tools: true, reasoning: true,
      reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"], defaultReasoningEffort: "medium",
      reasoningModes: ["standard", "pro"], defaultReasoningMode: "standard",
      reasoningSummaries: ["none", "auto", "concise", "detailed"],
      reasoningContexts: ["auto", "current_turn", "all_turns"],
      textVerbosities: ["low", "medium", "high"], defaultTextVerbosity: "medium",
      reasoningDefaultEnabled: true,
      priceSource: "https://openrouter.ai/api/v1/models", priceAsOf: "2026-07-15",
      pricing: [{ input: 5, cachedInput: 0.5, cacheWrite: 6.25, output: 30, longContext: { inputTokensAbove: 272_000, input: 10, cachedInput: 1, cacheWrite: 12.5, output: 45 } }],
    },
    {
      name: "openai/gpt-5.6-sol-pro", ctx: 1_050_000, out: 128_000, inP: 5, outP: 30,
      vision: true, tools: true, reasoning: true,
      reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"], defaultReasoningEffort: "medium",
      reasoningModes: ["standard", "pro"], defaultReasoningMode: "pro",
      reasoningSummaries: ["none", "auto", "concise", "detailed"],
      reasoningContexts: ["auto", "current_turn", "all_turns"],
      textVerbosities: ["low", "medium", "high"], defaultTextVerbosity: "medium",
      reasoningDefaultEnabled: true,
      priceSource: "https://openrouter.ai/api/v1/models", priceAsOf: "2026-07-15",
      pricing: [{ input: 5, cachedInput: 0.5, cacheWrite: 6.25, output: 30, longContext: { inputTokensAbove: 272_000, input: 10, cachedInput: 1, cacheWrite: 12.5, output: 45 } }],
    },
    {
      name: "openai/gpt-5.6-terra", ctx: 1_050_000, out: 128_000, inP: 2.5, outP: 15,
      vision: true, tools: true, reasoning: true,
      reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"], defaultReasoningEffort: "medium",
      reasoningModes: ["standard", "pro"], defaultReasoningMode: "standard",
      reasoningSummaries: ["none", "auto", "concise", "detailed"],
      reasoningContexts: ["auto", "current_turn", "all_turns"],
      textVerbosities: ["low", "medium", "high"], defaultTextVerbosity: "medium",
      reasoningDefaultEnabled: true,
      priceSource: "https://openrouter.ai/api/v1/models", priceAsOf: "2026-07-15",
      pricing: [{ input: 2.5, cachedInput: 0.25, cacheWrite: 3.125, output: 15, longContext: { inputTokensAbove: 272_000, input: 5, cachedInput: 0.5, cacheWrite: 6.25, output: 22.5 } }],
    },
    {
      name: "openai/gpt-5.6-terra-pro", ctx: 1_050_000, out: 128_000, inP: 2.5, outP: 15,
      vision: true, tools: true, reasoning: true,
      reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"], defaultReasoningEffort: "medium",
      reasoningModes: ["standard", "pro"], defaultReasoningMode: "pro",
      reasoningSummaries: ["none", "auto", "concise", "detailed"],
      reasoningContexts: ["auto", "current_turn", "all_turns"],
      textVerbosities: ["low", "medium", "high"], defaultTextVerbosity: "medium",
      reasoningDefaultEnabled: true,
      priceSource: "https://openrouter.ai/api/v1/models", priceAsOf: "2026-07-15",
      pricing: [{ input: 2.5, cachedInput: 0.25, cacheWrite: 3.125, output: 15, longContext: { inputTokensAbove: 272_000, input: 5, cachedInput: 0.5, cacheWrite: 6.25, output: 22.5 } }],
    },
    {
      name: "openai/gpt-5.6-luna", ctx: 1_050_000, out: 128_000, inP: 1, outP: 6,
      vision: true, tools: true, reasoning: true,
      reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"], defaultReasoningEffort: "medium",
      reasoningModes: ["standard", "pro"], defaultReasoningMode: "standard",
      reasoningSummaries: ["none", "auto", "concise", "detailed"],
      reasoningContexts: ["auto", "current_turn", "all_turns"],
      textVerbosities: ["low", "medium", "high"], defaultTextVerbosity: "medium",
      reasoningDefaultEnabled: true,
      priceSource: "https://openrouter.ai/api/v1/models", priceAsOf: "2026-07-15",
      pricing: [{ input: 1, cachedInput: 0.1, cacheWrite: 1.25, output: 6, longContext: { inputTokensAbove: 272_000, input: 2, cachedInput: 0.2, cacheWrite: 2.5, output: 9 } }],
    },
    {
      name: "openai/gpt-5.6-luna-pro", ctx: 1_050_000, out: 128_000, inP: 1, outP: 6,
      vision: true, tools: true, reasoning: true,
      reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"], defaultReasoningEffort: "medium",
      reasoningModes: ["standard", "pro"], defaultReasoningMode: "pro",
      reasoningSummaries: ["none", "auto", "concise", "detailed"],
      reasoningContexts: ["auto", "current_turn", "all_turns"],
      textVerbosities: ["low", "medium", "high"], defaultTextVerbosity: "medium",
      reasoningDefaultEnabled: true,
      priceSource: "https://openrouter.ai/api/v1/models", priceAsOf: "2026-07-15",
      pricing: [{ input: 1, cachedInput: 0.1, cacheWrite: 1.25, output: 6, longContext: { inputTokensAbove: 272_000, input: 2, cachedInput: 0.2, cacheWrite: 2.5, output: 9 } }],
    },
    {
      name: "openai/gpt-oss-120b", ctx: 131_072, out: 65_536, inP: 0.037, outP: 0.17,
      vision: false, tools: true, reasoning: true, added: true,
      reasoningEfforts: ["low", "medium", "high"], defaultReasoningEffort: "medium",
      priceSource: "https://openrouter.ai/api/v1/models", priceAsOf: "2026-07-15",
      pricing: [{ input: 0.037, output: 0.17 }],
    },
    {
      name: "google/gemini-3.1-pro-preview", ctx: 1_048_576, out: 65_536, inP: 2, outP: 12,
      vision: true, tools: true, reasoning: true,
      reasoningEfforts: ["low", "medium", "high"], defaultReasoningEffort: "high",
      priceSource: "https://openrouter.ai/api/v1/models", priceAsOf: "2026-07-15",
      pricing: [{ input: 2, cachedInput: 0.2, output: 12, longContext: { inputTokensAbove: 200_000, input: 4, cachedInput: 0.4, output: 18 } }],
    },
    {
      name: "anthropic/claude-sonnet-5", ctx: 1_000_000, out: 128_000, inP: 2, outP: 10,
      vision: true, tools: true, reasoning: true,
      reasoningEfforts: ["low", "medium", "high", "xhigh", "max"], defaultReasoningEffort: "medium",
      priceSource: "https://openrouter.ai/api/v1/models", priceAsOf: "2026-07-15",
      pricing: [{ input: 2, cachedInput: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4, output: 10 }],
    },
    {
      name: "anthropic/claude-fable-5", ctx: 1_000_000, out: 128_000, inP: 10, outP: 50,
      vision: true, tools: true, reasoning: true, reasoningMandatory: true,
      reasoningEfforts: ["low", "medium", "high", "xhigh", "max"], defaultReasoningEffort: "medium",
      priceSource: "https://openrouter.ai/api/v1/models", priceAsOf: "2026-07-15",
      pricing: [{ input: 10, cachedInput: 1, cacheWrite5m: 12.5, cacheWrite1h: 20, output: 50 }],
    },
    {
      name: "anthropic/claude-opus-4.8", ctx: 1_000_000, out: 128_000, inP: 5, outP: 25,
      vision: true, tools: true, reasoning: true,
      reasoningEfforts: ["low", "medium", "high", "xhigh", "max"], defaultReasoningEffort: "medium",
      priceSource: "https://openrouter.ai/api/v1/models", priceAsOf: "2026-07-15",
      pricing: [{ input: 5, cachedInput: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10, output: 25 }],
    },
    {
      name: "anthropic/claude-opus-4.8-fast", ctx: 1_000_000, out: 128_000, inP: 10, outP: 50,
      vision: true, tools: true, reasoning: true,
      reasoningEfforts: ["low", "medium", "high", "xhigh", "max"], defaultReasoningEffort: "medium",
      priceSource: "https://openrouter.ai/api/v1/models", priceAsOf: "2026-07-15",
      pricing: [{ input: 10, cachedInput: 1, cacheWrite5m: 12.5, cacheWrite1h: 20, output: 50 }],
    },
    {
      name: "moonshotai/kimi-k2.7-code", ctx: 262_144, out: 262_144, inP: 0.719, outP: 3.49,
      vision: true, tools: true, reasoning: true, reasoningMandatory: true,
      priceSource: "https://openrouter.ai/api/v1/models", priceAsOf: "2026-07-15",
      pricing: [{ input: 0.719, cachedInput: 0.149, output: 3.49 }],
    },
    {
      name: "moonshotai/kimi-k2.6", ctx: 262_144, out: 262_144, inP: 0.66, outP: 3.41,
      vision: true, tools: true, reasoning: true, reasoningDefaultEnabled: true,
      reasoningEfforts: ["none"],
      priceSource: "https://openrouter.ai/api/v1/models", priceAsOf: "2026-07-15",
      pricing: [{ input: 0.66, cachedInput: 0.144, output: 3.41 }],
    },
    {
      name: "z-ai/glm-5.2", ctx: 1_048_576, out: 131_072, inP: 0.8694, outP: 2.7324,
      vision: false, tools: true, reasoning: true, reasoningDefaultEnabled: true,
      reasoningEfforts: ["none", "high", "xhigh"], defaultReasoningEffort: "high",
      priceSource: "https://openrouter.ai/api/v1/models", priceAsOf: "2026-07-15",
      pricing: [{ input: 0.8694, cachedInput: 0.16146, output: 2.7324 }],
    },
    {
      name: "deepseek/deepseek-v4-pro", ctx: 1_048_576, out: 393_216, inP: 0.435, outP: 0.87,
      vision: false, tools: true, reasoning: true,
      reasoningEfforts: ["none", "high", "xhigh"], defaultReasoningEffort: "high",
      priceSource: "https://openrouter.ai/api/v1/models", priceAsOf: "2026-07-15",
      pricing: [{ input: 0.435, cachedInput: 0.003625, output: 0.87 }],
    },
    {
      name: "deepseek/deepseek-v4-flash", ctx: 1_048_576, out: 393_216, inP: 0.098, outP: 0.196,
      vision: false, tools: true, reasoning: true,
      reasoningEfforts: ["none", "high", "xhigh"], defaultReasoningEffort: "high",
      priceSource: "https://openrouter.ai/api/v1/models", priceAsOf: "2026-07-15",
      pricing: [{ input: 0.098, cachedInput: 0.02, output: 0.196 }],
    },
    {
      name: "nvidia/nemotron-3-ultra-550b-a55b:free", ctx: 1_048_576, out: 65_536, inP: 0, outP: 0,
      vision: false, tools: true, reasoning: true,
      priceSource: "https://openrouter.ai/nvidia/nemotron-3-ultra-550b-a55b:free", priceAsOf: "2026-07-15",
      pricing: [{ input: 0, output: 0 }],
    },
  ],
  gemini: [
    {
      name: "gemini-3.5-flash", ctx: 1_048_576, out: 65_536, inP: 0.75, outP: 4.5,
      vision: true, tools: true, reasoning: true, added: true,
      reasoningEfforts: ["minimal", "low", "medium", "high"], defaultReasoningEffort: "medium",
      reasoningSummaries: ["none", "auto"],
      priceSource: "https://ai.google.dev/gemini-api/docs/pricing", priceAsOf: "2026-07-15",
      pricing: [{ input: 0.75, cachedInput: 0.08, output: 4.5 }],
    },
    {
      name: "gemini-3.1-flash-lite", ctx: 1_048_576, out: 65_536, inP: 0.25, outP: 1.5,
      vision: true, tools: true, reasoning: true,
      reasoningEfforts: ["minimal", "low", "medium", "high"], defaultReasoningEffort: "minimal",
      reasoningSummaries: ["none", "auto"],
      priceSource: "https://ai.google.dev/gemini-api/docs/pricing", priceAsOf: "2026-07-15",
      pricing: [{ input: 0.25, cachedInput: 0.025, output: 1.5 }],
    },
    {
      name: "gemini-3.1-pro-preview", ctx: 1_048_576, out: 65_536, inP: 2, outP: 12,
      vision: true, tools: true, reasoning: true,
      reasoningEfforts: ["low", "medium", "high"], defaultReasoningEffort: "high",
      reasoningSummaries: ["none", "auto"],
      priceSource: "https://ai.google.dev/gemini-api/docs/pricing", priceAsOf: "2026-07-15",
      pricing: [{ input: 2, cachedInput: 0.2, output: 12, longContext: { inputTokensAbove: 200_000, input: 4, cachedInput: 0.4, output: 18 } }],
    },
    {
      name: "gemini-3-flash-preview", ctx: 1_048_576, out: 65_536, inP: 0.5, outP: 3,
      vision: true, tools: true, reasoning: true,
      reasoningEfforts: ["minimal", "low", "medium", "high"], defaultReasoningEffort: "high",
      reasoningSummaries: ["none", "auto"],
      priceSource: "https://ai.google.dev/gemini-api/docs/pricing", priceAsOf: "2026-07-15",
      pricing: [{ input: 0.5, cachedInput: 0.05, output: 3 }],
    },
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
    {
      name: "deepseek-v4-pro", ctx: 1_048_576, out: 393_216, inP: 0.435, outP: 0.87,
      vision: false, tools: true, reasoning: true, added: true,
      reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"], defaultReasoningEffort: "high",
      reasoningDefaultEnabled: true,
      priceSource: "https://api-docs.deepseek.com/quick_start/pricing", priceAsOf: "2026-07-15",
      pricing: [{ input: 0.435, cachedInput: 0.003625, output: 0.87 }],
    },
    {
      name: "deepseek-v4-flash", ctx: 1_048_576, out: 393_216, inP: 0.14, outP: 0.28,
      vision: false, tools: true, reasoning: true,
      reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"], defaultReasoningEffort: "high",
      reasoningDefaultEnabled: true,
      priceSource: "https://api-docs.deepseek.com/quick_start/pricing", priceAsOf: "2026-07-15",
      pricing: [{ input: 0.14, cachedInput: 0.0028, output: 0.28 }],
    },
  ],
  moonshot: [
    {
      name: "kimi-k2.7-code", ctx: 262_144, out: null, inP: 0.95, outP: 4,
      vision: true, tools: true, reasoning: true, reasoningMandatory: true,
      priceSource: "https://platform.kimi.ai/docs/pricing/chat-k27-code", priceAsOf: "2026-07-15",
      pricing: [{ input: 0.95, cachedInput: 0.19, output: 4 }],
    },
    {
      name: "kimi-k2.7-code-highspeed", ctx: 262_144, out: null, inP: 1.9, outP: 8,
      vision: true, tools: true, reasoning: true, reasoningMandatory: true,
      priceSource: "https://platform.kimi.ai/docs/pricing/chat-k27-code", priceAsOf: "2026-07-15",
      pricing: [{ input: 1.9, cachedInput: 0.38, output: 8 }],
    },
    {
      name: "kimi-k2.6", ctx: 262_144, out: null, inP: 0.95, outP: 4,
      vision: true, tools: true, reasoning: true, added: true,
      reasoningEfforts: ["none"], reasoningDefaultEnabled: true,
      priceSource: "https://platform.kimi.ai/docs/pricing/chat-k26", priceAsOf: "2026-07-15",
      pricing: [{ input: 0.95, cachedInput: 0.16, output: 4 }],
    },
  ],
  zai: [
    {
      name: "glm-5.2", ctx: 1_048_576, out: 131_072, inP: 1.4, outP: 4.4,
      vision: false, tools: true, reasoning: true, added: true,
      reasoningEfforts: ["none"], reasoningDefaultEnabled: true,
      priceSource: "https://docs.z.ai/guides/overview/pricing", priceAsOf: "2026-07-15",
      pricing: [{ input: 1.4, cachedInput: 0.26, output: 4.4 }],
    },
    {
      name: "glm-5.1", ctx: 204_800, out: 131_072, inP: 1.4, outP: 4.4,
      vision: false, tools: true, reasoning: true,
      reasoningEfforts: ["none"], reasoningDefaultEnabled: true,
      priceSource: "https://docs.z.ai/guides/overview/pricing", priceAsOf: "2026-07-15",
      pricing: [{ input: 1.4, cachedInput: 0.26, output: 4.4 }],
    },
    {
      name: "glm-5", ctx: 204_800, out: 131_072, inP: 1, outP: 3.2,
      vision: false, tools: true, reasoning: true,
      reasoningEfforts: ["none"], reasoningDefaultEnabled: true,
      priceSource: "https://docs.z.ai/guides/overview/pricing", priceAsOf: "2026-07-15",
      pricing: [{ input: 1, cachedInput: 0.2, output: 3.2 }],
    },
    {
      name: "glm-5-turbo", ctx: 204_800, out: 131_072, inP: 1.2, outP: 4,
      vision: false, tools: true, reasoning: true,
      reasoningEfforts: ["none"], reasoningDefaultEnabled: true,
      priceSource: "https://docs.z.ai/guides/overview/pricing", priceAsOf: "2026-07-15",
      pricing: [{ input: 1.2, cachedInput: 0.24, output: 4 }],
    },
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
  mock: [{ name: "mock-model-v1", ctx: 8192, out: 4096, inP: 0, outP: 0, vision: false, tools: false, reasoning: false, pricing: [{ input: 0, output: 0 }] }],
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
