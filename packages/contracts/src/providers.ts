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

export interface TemperatureRange {
  min: number;
  max: number;
}

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

export const MODEL_TIERS = ["top", "mid", "low", "free"] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

export const MODEL_RELEASE_DATE_CONFIDENCES = [
  "verified",
  "corroborated",
  "unverified",
] as const;
export type ModelReleaseDateConfidence =
  (typeof MODEL_RELEASE_DATE_CONFIDENCES)[number];

export type CatalogModelStatus = "current" | "legacy" | "unverified";

/**
 * Lifecycle evidence is kept separate from mutable aliases and pricing. In
 * particular, `providerCatalogCreatedAt` is the date on which a gateway
 * catalog first listed a model; it is not asserted to be the upstream model's
 * release date.
 */
export interface CatalogModelLifecycle {
  /** Upstream model release date in ISO-8601 form, when independently sourced. */
  releaseDate?: string;
  releaseDateSource?: string;
  releaseDateConfidence?: ModelReleaseDateConfidence;
  /** Provider/gateway catalog timestamp, not an upstream release date. */
  providerCatalogCreatedAt?: string;
  deprecatedAt?: string;
  sunsetAt?: string;
  expiresAt?: string;
  /** Limited-access models must not appear as generally selectable options. */
  restricted?: boolean;
  restrictionReason?: string;
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
    endpoint: "https://api.deepseek.com",
    keyPrefix: "sk-",
    header: "Authorization: Bearer",
    docs: "https://platform.deepseek.com/api_keys",
    installed: true,
    color: "#4d6bfe",
  },
  {
    id: "moonshot",
    name: "Moonshot AI · Kimi",
    endpoint: "https://api.moonshot.ai/v1",
    keyPrefix: "sk-",
    header: "Authorization: Bearer",
    docs: "https://platform.moonshot.ai/console/api-keys",
    installed: true,
    color: "#111827",
  },
  {
    id: "zai",
    name: "Z.AI · GLM",
    endpoint: "https://api.z.ai/api/paas/v4",
    keyPrefix: "",
    header: "Authorization: Bearer",
    docs: "https://z.ai/manage-apikey/apikey-list",
    installed: true,
    color: "#2563eb",
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
    installed: true,
    color: "#9aa0a6",
  },
];

export interface CatalogModel extends CatalogModelLifecycle {
  name: string;
  /** Mutable provider aliases that resolve to this concrete catalog model. */
  aliases?: string[];
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
  /**
   * Supported temperature range. `null` means the provider rejects the
   * parameter and it must be omitted; `undefined` means catalog-unknown.
   */
  temperatureRange?: TemperatureRange | null;
  /** Product-level quality/cost grouping for model comparison and evaluation. */
  tier: ModelTier;
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
      name: "claude-fable-5",
      tier: "top",
      releaseDate: "2026-06-09",
      releaseDateSource:
        "https://www.anthropic.com/news/claude-fable-5-mythos-5",
      releaseDateConfidence: "verified",
      ctx: 1_000_000,
      out: 128_000,
      inP: 10,
      outP: 50,
      vision: true,
      tools: true,
      reasoning: true,
      reasoningMandatory: true,
      added: true,
      reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
      defaultReasoningEffort: "high",
      temperatureRange: null,
      priceSource: "https://platform.claude.com/docs/en/about-claude/pricing",
      priceAsOf: "2026-07-15",
      pricing: [
        {
          input: 10,
          cachedInput: 1,
          cacheWrite5m: 12.5,
          cacheWrite1h: 20,
          output: 50,
        },
      ],
    },
    {
      name: "claude-mythos-5",
      tier: "top",
      releaseDate: "2026-06-09",
      releaseDateSource:
        "https://www.anthropic.com/news/claude-fable-5-mythos-5",
      releaseDateConfidence: "verified",
      restricted: true,
      restrictionReason: "Invitation-only limited availability",
      ctx: 1_000_000,
      out: 128_000,
      inP: 10,
      outP: 50,
      vision: true,
      tools: true,
      reasoning: true,
      reasoningMandatory: true,
      reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
      defaultReasoningEffort: "high",
      temperatureRange: null,
      priceSource: "https://platform.claude.com/docs/en/about-claude/pricing",
      priceAsOf: "2026-07-15",
      pricing: [
        {
          input: 10,
          cachedInput: 1,
          cacheWrite5m: 12.5,
          cacheWrite1h: 20,
          output: 50,
        },
      ],
    },
    {
      name: "claude-opus-4-8",
      tier: "top",
      releaseDate: "2026-05-28",
      releaseDateSource: "https://www.anthropic.com/news/claude-opus-4-8",
      releaseDateConfidence: "verified",
      ctx: 1_000_000,
      out: 128_000,
      inP: 5,
      outP: 25,
      vision: true,
      tools: true,
      reasoning: true,
      reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
      defaultReasoningEffort: "high",
      temperatureRange: null,
      priceSource: "https://platform.claude.com/docs/en/about-claude/pricing",
      priceAsOf: "2026-07-15",
      pricing: [
        {
          input: 5,
          cachedInput: 0.5,
          cacheWrite5m: 6.25,
          cacheWrite1h: 10,
          output: 25,
        },
      ],
    },
    {
      name: "claude-sonnet-5",
      tier: "mid",
      releaseDate: "2026-06-30",
      releaseDateSource: "https://www.anthropic.com/news/claude-sonnet-5",
      releaseDateConfidence: "verified",
      ctx: 1_000_000,
      out: 128_000,
      inP: 2,
      outP: 10,
      vision: true,
      tools: true,
      reasoning: true,
      reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
      defaultReasoningEffort: "high",
      temperatureRange: null,
      priceSource: "https://platform.claude.com/docs/en/about-claude/pricing",
      priceAsOf: "2026-07-15",
      pricing: [
        {
          effectiveTo: "2026-08-31T23:59:59.999Z",
          input: 2,
          cachedInput: 0.2,
          cacheWrite5m: 2.5,
          cacheWrite1h: 4,
          output: 10,
        },
        {
          effectiveFrom: "2026-09-01T00:00:00.000Z",
          input: 3,
          cachedInput: 0.3,
          cacheWrite5m: 3.75,
          cacheWrite1h: 6,
          output: 15,
        },
      ],
    },
    {
      name: "claude-haiku-4-5",
      tier: "low",
      releaseDate: "2025-10-15",
      releaseDateSource: "https://www.anthropic.com/news/claude-haiku-4-5",
      releaseDateConfidence: "verified",
      ctx: 200_000,
      out: 64_000,
      inP: 1,
      outP: 5,
      vision: true,
      tools: true,
      reasoning: true,
      priceSource: "https://platform.claude.com/docs/en/about-claude/pricing",
      priceAsOf: "2026-07-15",
      pricing: [
        {
          input: 1,
          cachedInput: 0.1,
          cacheWrite5m: 1.25,
          cacheWrite1h: 2,
          output: 5,
        },
      ],
    },
    {
      name: "claude-sonnet-4-5",
      tier: "mid",
      releaseDate: "2025-09-29",
      releaseDateSource: "https://www.anthropic.com/news/claude-sonnet-4-5",
      releaseDateConfidence: "verified",
      ctx: 200_000,
      out: 64_000,
      inP: 3,
      outP: 15,
      vision: true,
      tools: true,
      reasoning: true,
      priceSource: "https://platform.claude.com/docs/en/about-claude/pricing",
      priceAsOf: "2026-07-15",
      pricing: [
        {
          input: 3,
          cachedInput: 0.3,
          cacheWrite5m: 3.75,
          cacheWrite1h: 6,
          output: 15,
        },
      ],
    },
    {
      name: "claude-opus-4",
      tier: "top",
      releaseDate: "2025-05-22",
      releaseDateSource: "https://www.anthropic.com/news/claude-4",
      releaseDateConfidence: "verified",
      ctx: 200_000,
      out: 32_000,
      inP: 15,
      outP: 75,
      vision: true,
      tools: true,
      reasoning: true,
      priceSource: "https://platform.claude.com/docs/en/about-claude/pricing",
      priceAsOf: "2026-07-15",
      pricing: [
        {
          input: 15,
          cachedInput: 1.5,
          cacheWrite5m: 18.75,
          cacheWrite1h: 30,
          output: 75,
        },
      ],
    },
  ],
  openai: [
    {
      name: "gpt-5.6-sol",
      tier: "top",
      releaseDate: "2026-07-09",
      releaseDateSource: "https://openai.com/index/gpt-5-6/",
      releaseDateConfidence: "verified",
      aliases: ["gpt-5.6"],
      ctx: 1_050_000,
      out: 128_000,
      inP: 5,
      outP: 30,
      vision: true,
      tools: true,
      reasoning: true,
      added: true,
      reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
      defaultReasoningEffort: "medium",
      reasoningModes: ["standard", "pro"],
      defaultReasoningMode: "standard",
      reasoningSummaries: ["none", "auto", "concise", "detailed"],
      reasoningContexts: ["auto", "current_turn", "all_turns"],
      textVerbosities: ["low", "medium", "high"],
      defaultTextVerbosity: "medium",
      temperatureRange: null,
      priceSource: "https://developers.openai.com/api/docs/pricing",
      priceAsOf: "2026-07-15",
      pricing: [
        {
          input: 5,
          cachedInput: 0.5,
          cacheWrite: 6.25,
          output: 30,
          longContext: {
            inputTokensAbove: 272_000,
            input: 10,
            cachedInput: 1,
            cacheWrite: 12.5,
            output: 45,
          },
        },
      ],
    },
    {
      name: "gpt-5.6-terra",
      tier: "mid",
      releaseDate: "2026-07-09",
      releaseDateSource: "https://openai.com/index/gpt-5-6/",
      releaseDateConfidence: "verified",
      ctx: 1_050_000,
      out: 128_000,
      inP: 2.5,
      outP: 15,
      vision: true,
      tools: true,
      reasoning: true,
      reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
      defaultReasoningEffort: "medium",
      reasoningModes: ["standard", "pro"],
      defaultReasoningMode: "standard",
      reasoningSummaries: ["none", "auto", "concise", "detailed"],
      reasoningContexts: ["auto", "current_turn", "all_turns"],
      textVerbosities: ["low", "medium", "high"],
      defaultTextVerbosity: "medium",
      temperatureRange: null,
      priceSource: "https://developers.openai.com/api/docs/pricing",
      priceAsOf: "2026-07-15",
      pricing: [
        {
          input: 2.5,
          cachedInput: 0.25,
          cacheWrite: 3.125,
          output: 15,
          longContext: {
            inputTokensAbove: 272_000,
            input: 5,
            cachedInput: 0.5,
            cacheWrite: 6.25,
            output: 22.5,
          },
        },
      ],
    },
    {
      name: "gpt-5.6-luna",
      tier: "low",
      releaseDate: "2026-07-09",
      releaseDateSource: "https://openai.com/index/gpt-5-6/",
      releaseDateConfidence: "verified",
      ctx: 1_050_000,
      out: 128_000,
      inP: 1,
      outP: 6,
      vision: true,
      tools: true,
      reasoning: true,
      reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
      defaultReasoningEffort: "medium",
      reasoningModes: ["standard", "pro"],
      defaultReasoningMode: "standard",
      reasoningSummaries: ["none", "auto", "concise", "detailed"],
      reasoningContexts: ["auto", "current_turn", "all_turns"],
      textVerbosities: ["low", "medium", "high"],
      defaultTextVerbosity: "medium",
      temperatureRange: null,
      priceSource: "https://developers.openai.com/api/docs/pricing",
      priceAsOf: "2026-07-15",
      pricing: [
        {
          input: 1,
          cachedInput: 0.1,
          cacheWrite: 1.25,
          output: 6,
          longContext: {
            inputTokensAbove: 272_000,
            input: 2,
            cachedInput: 0.2,
            cacheWrite: 2.5,
            output: 9,
          },
        },
      ],
    },
    {
      name: "gpt-5.4-mini",
      tier: "low",
      releaseDate: "2026-03-17",
      releaseDateSource:
        "https://openai.com/index/introducing-gpt-5-4-mini-and-nano/",
      releaseDateConfidence: "verified",
      ctx: 400_000,
      out: 128_000,
      inP: 0.75,
      outP: 4.5,
      vision: true,
      tools: true,
      reasoning: true,
      reasoningEfforts: ["none", "low", "medium", "high", "xhigh"],
      defaultReasoningEffort: "none",
      reasoningSummaries: ["none", "auto", "concise", "detailed"],
      textVerbosities: ["low", "medium", "high"],
      defaultTextVerbosity: "medium",
      priceSource: "https://developers.openai.com/api/docs/pricing",
      priceAsOf: "2026-07-15",
      pricing: [{ input: 0.75, cachedInput: 0.075, output: 4.5 }],
    },
  ],
  openrouter: [
    {
      name: "openai/gpt-5.6-sol",
      tier: "top",
      releaseDate: "2026-07-09",
      releaseDateSource: "https://openai.com/index/gpt-5-6/",
      releaseDateConfidence: "verified",
      providerCatalogCreatedAt: "2026-07-09T09:54:10Z",
      ctx: 1_050_000,
      out: 128_000,
      inP: 5,
      outP: 30,
      vision: true,
      tools: true,
      reasoning: true,
      reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
      defaultReasoningEffort: "medium",
      reasoningModes: ["standard", "pro"],
      defaultReasoningMode: "standard",
      reasoningSummaries: ["none", "auto", "concise", "detailed"],
      reasoningContexts: ["auto", "current_turn", "all_turns"],
      textVerbosities: ["low", "medium", "high"],
      defaultTextVerbosity: "medium",
      reasoningDefaultEnabled: true,
      temperatureRange: null,
      priceSource: "https://openrouter.ai/api/v1/models",
      priceAsOf: "2026-07-15",
      pricing: [
        {
          input: 5,
          cachedInput: 0.5,
          cacheWrite: 6.25,
          output: 30,
          longContext: {
            inputTokensAbove: 272_000,
            input: 10,
            cachedInput: 1,
            cacheWrite: 12.5,
            output: 45,
          },
        },
      ],
    },
    {
      name: "openai/gpt-5.6-sol-pro",
      tier: "top",
      releaseDate: "2026-07-09",
      releaseDateSource: "https://openai.com/index/gpt-5-6/",
      releaseDateConfidence: "verified",
      providerCatalogCreatedAt: "2026-07-09T09:54:14Z",
      ctx: 1_050_000,
      out: 128_000,
      inP: 5,
      outP: 30,
      vision: true,
      tools: true,
      reasoning: true,
      reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
      defaultReasoningEffort: "medium",
      reasoningModes: ["standard", "pro"],
      defaultReasoningMode: "pro",
      reasoningSummaries: ["none", "auto", "concise", "detailed"],
      reasoningContexts: ["auto", "current_turn", "all_turns"],
      textVerbosities: ["low", "medium", "high"],
      defaultTextVerbosity: "medium",
      reasoningDefaultEnabled: true,
      temperatureRange: null,
      priceSource: "https://openrouter.ai/api/v1/models",
      priceAsOf: "2026-07-15",
      pricing: [
        {
          input: 5,
          cachedInput: 0.5,
          cacheWrite: 6.25,
          output: 30,
          longContext: {
            inputTokensAbove: 272_000,
            input: 10,
            cachedInput: 1,
            cacheWrite: 12.5,
            output: 45,
          },
        },
      ],
    },
    {
      name: "openai/gpt-5.6-terra",
      tier: "mid",
      releaseDate: "2026-07-09",
      releaseDateSource: "https://openai.com/index/gpt-5-6/",
      releaseDateConfidence: "verified",
      providerCatalogCreatedAt: "2026-07-09T09:54:17Z",
      ctx: 1_050_000,
      out: 128_000,
      inP: 2.5,
      outP: 15,
      vision: true,
      tools: true,
      reasoning: true,
      reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
      defaultReasoningEffort: "medium",
      reasoningModes: ["standard", "pro"],
      defaultReasoningMode: "standard",
      reasoningSummaries: ["none", "auto", "concise", "detailed"],
      reasoningContexts: ["auto", "current_turn", "all_turns"],
      textVerbosities: ["low", "medium", "high"],
      defaultTextVerbosity: "medium",
      reasoningDefaultEnabled: true,
      temperatureRange: null,
      priceSource: "https://openrouter.ai/api/v1/models",
      priceAsOf: "2026-07-15",
      pricing: [
        {
          input: 2.5,
          cachedInput: 0.25,
          cacheWrite: 3.125,
          output: 15,
          longContext: {
            inputTokensAbove: 272_000,
            input: 5,
            cachedInput: 0.5,
            cacheWrite: 6.25,
            output: 22.5,
          },
        },
      ],
    },
    {
      name: "openai/gpt-5.6-terra-pro",
      tier: "mid",
      releaseDate: "2026-07-09",
      releaseDateSource: "https://openai.com/index/gpt-5-6/",
      releaseDateConfidence: "verified",
      providerCatalogCreatedAt: "2026-07-09T09:54:21Z",
      ctx: 1_050_000,
      out: 128_000,
      inP: 2.5,
      outP: 15,
      vision: true,
      tools: true,
      reasoning: true,
      reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
      defaultReasoningEffort: "medium",
      reasoningModes: ["standard", "pro"],
      defaultReasoningMode: "pro",
      reasoningSummaries: ["none", "auto", "concise", "detailed"],
      reasoningContexts: ["auto", "current_turn", "all_turns"],
      textVerbosities: ["low", "medium", "high"],
      defaultTextVerbosity: "medium",
      reasoningDefaultEnabled: true,
      temperatureRange: null,
      priceSource: "https://openrouter.ai/api/v1/models",
      priceAsOf: "2026-07-15",
      pricing: [
        {
          input: 2.5,
          cachedInput: 0.25,
          cacheWrite: 3.125,
          output: 15,
          longContext: {
            inputTokensAbove: 272_000,
            input: 5,
            cachedInput: 0.5,
            cacheWrite: 6.25,
            output: 22.5,
          },
        },
      ],
    },
    {
      name: "openai/gpt-5.6-luna",
      tier: "low",
      releaseDate: "2026-07-09",
      releaseDateSource: "https://openai.com/index/gpt-5-6/",
      releaseDateConfidence: "verified",
      providerCatalogCreatedAt: "2026-07-09T09:54:24Z",
      ctx: 1_050_000,
      out: 128_000,
      inP: 1,
      outP: 6,
      vision: true,
      tools: true,
      reasoning: true,
      reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
      defaultReasoningEffort: "medium",
      reasoningModes: ["standard", "pro"],
      defaultReasoningMode: "standard",
      reasoningSummaries: ["none", "auto", "concise", "detailed"],
      reasoningContexts: ["auto", "current_turn", "all_turns"],
      textVerbosities: ["low", "medium", "high"],
      defaultTextVerbosity: "medium",
      reasoningDefaultEnabled: true,
      temperatureRange: null,
      priceSource: "https://openrouter.ai/api/v1/models",
      priceAsOf: "2026-07-15",
      pricing: [
        {
          input: 1,
          cachedInput: 0.1,
          cacheWrite: 1.25,
          output: 6,
          longContext: {
            inputTokensAbove: 272_000,
            input: 2,
            cachedInput: 0.2,
            cacheWrite: 2.5,
            output: 9,
          },
        },
      ],
    },
    {
      name: "openai/gpt-5.6-luna-pro",
      tier: "low",
      releaseDate: "2026-07-09",
      releaseDateSource: "https://openai.com/index/gpt-5-6/",
      releaseDateConfidence: "verified",
      providerCatalogCreatedAt: "2026-07-09T09:54:27Z",
      ctx: 1_050_000,
      out: 128_000,
      inP: 1,
      outP: 6,
      vision: true,
      tools: true,
      reasoning: true,
      reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
      defaultReasoningEffort: "medium",
      reasoningModes: ["standard", "pro"],
      defaultReasoningMode: "pro",
      reasoningSummaries: ["none", "auto", "concise", "detailed"],
      reasoningContexts: ["auto", "current_turn", "all_turns"],
      textVerbosities: ["low", "medium", "high"],
      defaultTextVerbosity: "medium",
      reasoningDefaultEnabled: true,
      temperatureRange: null,
      priceSource: "https://openrouter.ai/api/v1/models",
      priceAsOf: "2026-07-15",
      pricing: [
        {
          input: 1,
          cachedInput: 0.1,
          cacheWrite: 1.25,
          output: 6,
          longContext: {
            inputTokensAbove: 272_000,
            input: 2,
            cachedInput: 0.2,
            cacheWrite: 2.5,
            output: 9,
          },
        },
      ],
    },
    {
      name: "openai/gpt-oss-120b",
      tier: "low",
      releaseDate: "2025-08-05",
      releaseDateSource: "https://openai.com/index/introducing-gpt-oss/",
      releaseDateConfidence: "verified",
      providerCatalogCreatedAt: "2025-08-05T17:17:11Z",
      ctx: 131_072,
      out: 65_536,
      inP: 0.037,
      outP: 0.17,
      vision: false,
      tools: true,
      reasoning: true,
      added: true,
      reasoningEfforts: ["low", "medium", "high"],
      defaultReasoningEffort: "medium",
      priceSource: "https://openrouter.ai/api/v1/models",
      priceAsOf: "2026-07-15",
      pricing: [{ input: 0.037, output: 0.17 }],
    },
    {
      name: "google/gemini-3.1-pro-preview",
      tier: "top",
      providerCatalogCreatedAt: "2026-02-19T14:00:27Z",
      ctx: 1_048_576,
      out: 65_536,
      inP: 2,
      outP: 12,
      vision: true,
      tools: true,
      reasoning: true,
      reasoningEfforts: ["low", "medium", "high"],
      defaultReasoningEffort: "high",
      priceSource: "https://openrouter.ai/api/v1/models",
      priceAsOf: "2026-07-15",
      pricing: [
        {
          input: 2,
          cachedInput: 0.2,
          output: 12,
          longContext: {
            inputTokensAbove: 200_000,
            input: 4,
            cachedInput: 0.4,
            output: 18,
          },
        },
      ],
    },
    {
      name: "anthropic/claude-sonnet-5",
      tier: "mid",
      releaseDate: "2026-06-30",
      releaseDateSource: "https://www.anthropic.com/news/claude-sonnet-5",
      releaseDateConfidence: "verified",
      providerCatalogCreatedAt: "2026-06-30T18:11:23Z",
      ctx: 1_000_000,
      out: 128_000,
      inP: 2,
      outP: 10,
      vision: true,
      tools: true,
      reasoning: true,
      reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
      defaultReasoningEffort: "medium",
      temperatureRange: null,
      priceSource: "https://openrouter.ai/api/v1/models",
      priceAsOf: "2026-07-15",
      pricing: [
        {
          input: 2,
          cachedInput: 0.2,
          cacheWrite5m: 2.5,
          cacheWrite1h: 4,
          output: 10,
        },
      ],
    },
    {
      name: "anthropic/claude-fable-5",
      tier: "top",
      releaseDate: "2026-06-09",
      releaseDateSource:
        "https://www.anthropic.com/news/claude-fable-5-mythos-5",
      releaseDateConfidence: "verified",
      providerCatalogCreatedAt: "2026-06-09T12:18:35Z",
      ctx: 1_000_000,
      out: 128_000,
      inP: 10,
      outP: 50,
      vision: true,
      tools: true,
      reasoning: true,
      reasoningMandatory: true,
      reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
      defaultReasoningEffort: "medium",
      temperatureRange: null,
      priceSource: "https://openrouter.ai/api/v1/models",
      priceAsOf: "2026-07-15",
      pricing: [
        {
          input: 10,
          cachedInput: 1,
          cacheWrite5m: 12.5,
          cacheWrite1h: 20,
          output: 50,
        },
      ],
    },
    {
      name: "anthropic/claude-opus-4.8",
      tier: "top",
      releaseDate: "2026-05-28",
      releaseDateSource: "https://www.anthropic.com/news/claude-opus-4-8",
      releaseDateConfidence: "verified",
      providerCatalogCreatedAt: "2026-05-27T18:04:51Z",
      ctx: 1_000_000,
      out: 128_000,
      inP: 5,
      outP: 25,
      vision: true,
      tools: true,
      reasoning: true,
      reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
      defaultReasoningEffort: "medium",
      temperatureRange: null,
      priceSource: "https://openrouter.ai/api/v1/models",
      priceAsOf: "2026-07-19",
      pricing: [
        {
          input: 5,
          cachedInput: 0.5,
          cacheWrite5m: 6.25,
          cacheWrite1h: 10,
          output: 25,
        },
      ],
    },
    {
      name: "anthropic/claude-opus-4.8-fast",
      tier: "top",
      releaseDate: "2026-05-28",
      releaseDateSource: "https://www.anthropic.com/news/claude-opus-4-8",
      releaseDateConfidence: "verified",
      providerCatalogCreatedAt: "2026-05-27T20:28:23Z",
      ctx: 1_000_000,
      out: 128_000,
      inP: 10,
      outP: 50,
      vision: true,
      tools: true,
      reasoning: true,
      reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
      defaultReasoningEffort: "medium",
      temperatureRange: null,
      priceSource: "https://openrouter.ai/api/v1/models",
      priceAsOf: "2026-07-15",
      pricing: [
        {
          input: 10,
          cachedInput: 1,
          cacheWrite5m: 12.5,
          cacheWrite1h: 20,
          output: 50,
        },
      ],
    },
    {
      name: "moonshotai/kimi-k3",
      tier: "top",
      releaseDate: "2026-07-16",
      releaseDateSource: "https://www.kimi.com/blog/kimi-k3",
      releaseDateConfidence: "corroborated",
      providerCatalogCreatedAt: "2026-07-16T15:30:58Z",
      ctx: 1_048_576,
      // OpenRouter publishes the exact context window but no routed output
      // ceiling. Keep this unknown instead of copying Moonshot's direct cap.
      out: null,
      inP: 3,
      outP: 15,
      vision: true,
      tools: true,
      reasoning: true,
      reasoningMandatory: true,
      reasoningDefaultEnabled: true,
      reasoningEfforts: ["max"],
      defaultReasoningEffort: "max",
      temperatureRange: null,
      priceSource: "https://openrouter.ai/api/v1/models",
      priceAsOf: "2026-07-19",
      pricing: [{ input: 3, cachedInput: 0.3, output: 15 }],
    },
    {
      name: "moonshotai/kimi-k2.7-code",
      tier: "mid",
      releaseDate: "2026-06-25",
      releaseDateSource: "https://www.kimi.com/resources/kimi-k2-7-code",
      releaseDateConfidence: "verified",
      providerCatalogCreatedAt: "2026-06-12T12:12:41Z",
      ctx: 262_144,
      out: 262_144,
      inP: 0.719,
      outP: 3.49,
      vision: true,
      tools: true,
      reasoning: true,
      reasoningMandatory: true,
      temperatureRange: { min: 0, max: 2 },
      priceSource: "https://openrouter.ai/api/v1/models",
      priceAsOf: "2026-07-15",
      pricing: [{ input: 0.719, cachedInput: 0.149, output: 3.49 }],
    },
    {
      name: "moonshotai/kimi-k2.6",
      tier: "mid",
      releaseDate: "2026-04-20",
      releaseDateSource: "https://www.kimi.com/blog/kimi-k2-6",
      releaseDateConfidence: "verified",
      providerCatalogCreatedAt: "2026-04-20T15:36:42Z",
      ctx: 262_144,
      out: 262_144,
      inP: 0.66,
      outP: 3.41,
      vision: true,
      tools: true,
      reasoning: true,
      reasoningDefaultEnabled: true,
      reasoningEfforts: ["none"],
      temperatureRange: { min: 0, max: 2 },
      priceSource: "https://openrouter.ai/api/v1/models",
      priceAsOf: "2026-07-15",
      pricing: [{ input: 0.66, cachedInput: 0.144, output: 3.41 }],
    },
    {
      name: "z-ai/glm-5.2",
      tier: "top",
      releaseDate: "2026-06-16",
      releaseDateSource: "https://z.ai/blog/glm-5.2",
      releaseDateConfidence: "verified",
      providerCatalogCreatedAt: "2026-06-16T17:45:30Z",
      ctx: 1_048_576,
      out: 131_072,
      inP: 0.2912,
      outP: 0.9152,
      vision: false,
      tools: true,
      reasoning: true,
      reasoningDefaultEnabled: true,
      reasoningEfforts: ["high", "xhigh"],
      defaultReasoningEffort: "high",
      temperatureRange: { min: 0, max: 1 },
      priceSource: "https://openrouter.ai/api/v1/models",
      priceAsOf: "2026-07-19",
      pricing: [{ input: 0.2912, cachedInput: 0.05408, output: 0.9152 }],
    },
    {
      name: "deepseek/deepseek-v4-pro",
      tier: "top",
      releaseDate: "2026-04-24",
      releaseDateSource: "https://api-docs.deepseek.com/news/news260424/",
      releaseDateConfidence: "verified",
      providerCatalogCreatedAt: "2026-04-24T03:17:59Z",
      ctx: 1_048_576,
      out: 384_000,
      inP: 0.435,
      outP: 0.87,
      vision: false,
      tools: true,
      reasoning: true,
      reasoningEfforts: ["none", "high", "xhigh"],
      defaultReasoningEffort: "high",
      temperatureRange: { min: 0, max: 2 },
      priceSource: "https://openrouter.ai/api/v1/models",
      priceAsOf: "2026-07-15",
      pricing: [{ input: 0.435, cachedInput: 0.003625, output: 0.87 }],
    },
    {
      name: "deepseek/deepseek-v4-flash",
      tier: "mid",
      releaseDate: "2026-04-24",
      releaseDateSource: "https://api-docs.deepseek.com/news/news260424/",
      releaseDateConfidence: "verified",
      providerCatalogCreatedAt: "2026-04-24T03:17:46Z",
      ctx: 1_048_576,
      // The current routed endpoint does not advertise a completion cap.
      out: null,
      inP: 0.098,
      outP: 0.196,
      vision: false,
      tools: true,
      reasoning: true,
      reasoningEfforts: ["none", "high", "xhigh"],
      defaultReasoningEffort: "high",
      temperatureRange: { min: 0, max: 2 },
      priceSource: "https://openrouter.ai/api/v1/models",
      priceAsOf: "2026-07-15",
      pricing: [{ input: 0.098, cachedInput: 0.02, output: 0.196 }],
    },
    {
      name: "openrouter/free",
      tier: "free",
      providerCatalogCreatedAt: "2026-02-01T03:43:47Z",
      ctx: 200_000,
      out: null,
      inP: 0,
      outP: 0,
      vision: true,
      tools: true,
      reasoning: true,
      temperatureRange: { min: 0, max: 2 },
      priceSource: "https://openrouter.ai/api/v1/models",
      priceAsOf: "2026-07-18",
      pricing: [{ input: 0, output: 0 }],
    },
    {
      name: "nvidia/nemotron-3-ultra-550b-a55b:free",
      tier: "free",
      providerCatalogCreatedAt: "2026-06-04T05:33:28Z",
      ctx: 1_048_576,
      out: 65_536,
      inP: 0,
      outP: 0,
      vision: false,
      tools: true,
      reasoning: true,
      priceSource:
        "https://openrouter.ai/nvidia/nemotron-3-ultra-550b-a55b:free",
      priceAsOf: "2026-07-15",
      pricing: [{ input: 0, output: 0 }],
    },
  ],
  gemini: [
    {
      name: "gemini-3.5-flash",
      tier: "mid",
      ctx: 1_048_576,
      out: 65_536,
      inP: 0.75,
      outP: 4.5,
      vision: true,
      tools: true,
      reasoning: true,
      added: true,
      reasoningEfforts: ["minimal", "low", "medium", "high"],
      defaultReasoningEffort: "medium",
      reasoningSummaries: ["none", "auto"],
      priceSource: "https://ai.google.dev/gemini-api/docs/pricing",
      priceAsOf: "2026-07-15",
      pricing: [{ input: 0.75, cachedInput: 0.08, output: 4.5 }],
    },
    {
      name: "gemini-3.1-flash-lite",
      tier: "low",
      ctx: 1_048_576,
      out: 65_536,
      inP: 0.25,
      outP: 1.5,
      vision: true,
      tools: true,
      reasoning: true,
      reasoningEfforts: ["minimal", "low", "medium", "high"],
      defaultReasoningEffort: "minimal",
      reasoningSummaries: ["none", "auto"],
      priceSource: "https://ai.google.dev/gemini-api/docs/pricing",
      priceAsOf: "2026-07-15",
      pricing: [{ input: 0.25, cachedInput: 0.025, output: 1.5 }],
    },
    {
      name: "gemini-3.1-pro-preview",
      tier: "top",
      ctx: 1_048_576,
      out: 65_536,
      inP: 2,
      outP: 12,
      vision: true,
      tools: true,
      reasoning: true,
      reasoningEfforts: ["low", "medium", "high"],
      defaultReasoningEffort: "high",
      reasoningSummaries: ["none", "auto"],
      priceSource: "https://ai.google.dev/gemini-api/docs/pricing",
      priceAsOf: "2026-07-15",
      pricing: [
        {
          input: 2,
          cachedInput: 0.2,
          output: 12,
          longContext: {
            inputTokensAbove: 200_000,
            input: 4,
            cachedInput: 0.4,
            output: 18,
          },
        },
      ],
    },
    {
      name: "gemini-3-flash-preview",
      tier: "mid",
      ctx: 1_048_576,
      out: 65_536,
      inP: 0.5,
      outP: 3,
      vision: true,
      tools: true,
      reasoning: true,
      reasoningEfforts: ["minimal", "low", "medium", "high"],
      defaultReasoningEffort: "high",
      reasoningSummaries: ["none", "auto"],
      priceSource: "https://ai.google.dev/gemini-api/docs/pricing",
      priceAsOf: "2026-07-15",
      pricing: [{ input: 0.5, cachedInput: 0.05, output: 3 }],
    },
  ],
  mistral: [
    {
      name: "mistral-large-latest",
      tier: "top",
      ctx: 128_000,
      out: 8192,
      inP: 2,
      outP: 6,
      vision: false,
      tools: true,
      reasoning: false,
    },
    {
      name: "mistral-small-latest",
      tier: "low",
      ctx: 128_000,
      out: 8192,
      inP: 0.2,
      outP: 0.6,
      vision: false,
      tools: true,
      reasoning: false,
    },
  ],
  groq: [
    {
      name: "llama-3.3-70b-versatile",
      tier: "mid",
      ctx: 128_000,
      out: 32_768,
      inP: 0.59,
      outP: 0.79,
      vision: false,
      tools: true,
      reasoning: false,
    },
    {
      name: "llama-3.1-8b-instant",
      tier: "low",
      ctx: 128_000,
      out: 8192,
      inP: 0.05,
      outP: 0.08,
      vision: false,
      tools: true,
      reasoning: false,
    },
    {
      name: "mixtral-8x7b-32768",
      tier: "low",
      ctx: 32_768,
      out: 32_768,
      inP: 0.24,
      outP: 0.24,
      vision: false,
      tools: true,
      reasoning: false,
    },
  ],
  together: [
    {
      name: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
      tier: "mid",
      ctx: 128_000,
      out: 8192,
      inP: 0.88,
      outP: 0.88,
      vision: false,
      tools: true,
      reasoning: false,
    },
    {
      name: "Qwen/Qwen2.5-72B-Instruct-Turbo",
      tier: "mid",
      ctx: 32_768,
      out: 8192,
      inP: 1.2,
      outP: 1.2,
      vision: false,
      tools: true,
      reasoning: false,
    },
  ],
  deepseek: [
    {
      name: "deepseek-v4-pro",
      tier: "top",
      releaseDate: "2026-04-24",
      releaseDateSource: "https://api-docs.deepseek.com/news/news260424/",
      releaseDateConfidence: "verified",
      ctx: 1_048_576,
      out: 384_000,
      inP: 0.435,
      outP: 0.87,
      vision: false,
      tools: true,
      reasoning: true,
      added: true,
      reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
      defaultReasoningEffort: "high",
      reasoningDefaultEnabled: true,
      temperatureRange: { min: 0, max: 2 },
      priceSource: "https://api-docs.deepseek.com/quick_start/pricing",
      priceAsOf: "2026-07-15",
      pricing: [{ input: 0.435, cachedInput: 0.003625, output: 0.87 }],
    },
    {
      name: "deepseek-v4-flash",
      tier: "mid",
      releaseDate: "2026-04-24",
      releaseDateSource: "https://api-docs.deepseek.com/news/news260424/",
      releaseDateConfidence: "verified",
      ctx: 1_048_576,
      out: 384_000,
      inP: 0.14,
      outP: 0.28,
      vision: false,
      tools: true,
      reasoning: true,
      reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
      defaultReasoningEffort: "high",
      reasoningDefaultEnabled: true,
      temperatureRange: { min: 0, max: 2 },
      priceSource: "https://api-docs.deepseek.com/quick_start/pricing",
      priceAsOf: "2026-07-15",
      pricing: [{ input: 0.14, cachedInput: 0.0028, output: 0.28 }],
    },
  ],
  moonshot: [
    {
      name: "kimi-k3",
      tier: "top",
      releaseDate: "2026-07-16",
      releaseDateSource: "https://www.kimi.com/blog/kimi-k3",
      releaseDateConfidence: "corroborated",
      ctx: 1_048_576,
      out: 1_048_576,
      inP: 3,
      outP: 15,
      vision: true,
      tools: true,
      reasoning: true,
      reasoningMandatory: true,
      reasoningDefaultEnabled: true,
      reasoningEfforts: ["max"],
      defaultReasoningEffort: "max",
      temperatureRange: null,
      added: true,
      priceSource: "https://platform.kimi.ai/docs/pricing/chat-k3",
      priceAsOf: "2026-07-19",
      pricing: [{ input: 3, cachedInput: 0.3, output: 15 }],
    },
    {
      name: "kimi-k2.7-code",
      tier: "mid",
      releaseDate: "2026-06-25",
      releaseDateSource: "https://www.kimi.com/resources/kimi-k2-7-code",
      releaseDateConfidence: "verified",
      ctx: 262_144,
      out: null,
      inP: 0.95,
      outP: 4,
      vision: true,
      tools: true,
      reasoning: true,
      reasoningMandatory: true,
      temperatureRange: null,
      priceSource: "https://platform.kimi.ai/docs/pricing/chat-k27-code",
      priceAsOf: "2026-07-15",
      pricing: [{ input: 0.95, cachedInput: 0.19, output: 4 }],
    },
    {
      name: "kimi-k2.7-code-highspeed",
      tier: "mid",
      releaseDate: "2026-06-25",
      releaseDateSource: "https://www.kimi.com/resources/kimi-k2-7-code",
      releaseDateConfidence: "verified",
      ctx: 262_144,
      out: null,
      inP: 1.9,
      outP: 8,
      vision: true,
      tools: true,
      reasoning: true,
      reasoningMandatory: true,
      temperatureRange: null,
      priceSource: "https://platform.kimi.ai/docs/pricing/chat-k27-code",
      priceAsOf: "2026-07-15",
      pricing: [{ input: 1.9, cachedInput: 0.38, output: 8 }],
    },
    {
      name: "kimi-k2.6",
      tier: "mid",
      releaseDate: "2026-04-20",
      releaseDateSource: "https://www.kimi.com/blog/kimi-k2-6",
      releaseDateConfidence: "verified",
      ctx: 262_144,
      out: null,
      inP: 0.95,
      outP: 4,
      vision: true,
      tools: true,
      reasoning: true,
      reasoningEfforts: ["none"],
      reasoningDefaultEnabled: true,
      temperatureRange: null,
      priceSource: "https://platform.kimi.ai/docs/pricing/chat-k26",
      priceAsOf: "2026-07-15",
      pricing: [{ input: 0.95, cachedInput: 0.16, output: 4 }],
    },
  ],
  zai: [
    {
      name: "glm-5.2",
      tier: "top",
      releaseDate: "2026-06-16",
      releaseDateSource: "https://docs.z.ai/release-notes/new-released",
      releaseDateConfidence: "verified",
      // Z.AI's direct integration contract uses exactly 1,000,000 tokens.
      // OpenRouter separately advertises 1,048,576 for its routed entry.
      ctx: 1_000_000,
      out: 131_072,
      inP: 1.4,
      outP: 4.4,
      vision: false,
      tools: true,
      reasoning: true,
      added: true,
      reasoningEfforts: ["none", "high", "max"],
      defaultReasoningEffort: "max",
      reasoningDefaultEnabled: true,
      temperatureRange: { min: 0, max: 1 },
      priceSource: "https://docs.z.ai/guides/overview/pricing",
      priceAsOf: "2026-07-19",
      pricing: [{ input: 1.4, cachedInput: 0.26, output: 4.4 }],
    },
    {
      name: "glm-5.1",
      tier: "mid",
      releaseDate: "2026-04-07",
      releaseDateSource: "https://docs.z.ai/release-notes/new-released",
      releaseDateConfidence: "verified",
      ctx: 204_800,
      out: 131_072,
      inP: 1.4,
      outP: 4.4,
      vision: false,
      tools: true,
      reasoning: true,
      reasoningEfforts: ["none"],
      reasoningDefaultEnabled: true,
      temperatureRange: { min: 0, max: 1 },
      priceSource: "https://docs.z.ai/guides/overview/pricing",
      priceAsOf: "2026-07-15",
      pricing: [{ input: 1.4, cachedInput: 0.26, output: 4.4 }],
    },
    {
      name: "glm-5",
      tier: "mid",
      releaseDate: "2026-02-12",
      releaseDateSource: "https://docs.z.ai/release-notes/new-released",
      releaseDateConfidence: "verified",
      ctx: 204_800,
      out: 131_072,
      inP: 1,
      outP: 3.2,
      vision: false,
      tools: true,
      reasoning: true,
      reasoningEfforts: ["none"],
      reasoningDefaultEnabled: true,
      temperatureRange: { min: 0, max: 1 },
      priceSource: "https://docs.z.ai/guides/overview/pricing",
      priceAsOf: "2026-07-15",
      pricing: [{ input: 1, cachedInput: 0.2, output: 3.2 }],
    },
    {
      name: "glm-5-turbo",
      tier: "mid",
      releaseDate: "2026-03-15",
      releaseDateSource: "https://docs.z.ai/release-notes/new-released",
      releaseDateConfidence: "verified",
      ctx: 204_800,
      out: 131_072,
      inP: 1.2,
      outP: 4,
      vision: false,
      tools: true,
      reasoning: true,
      reasoningEfforts: ["none"],
      reasoningDefaultEnabled: true,
      temperatureRange: { min: 0, max: 1 },
      priceSource: "https://docs.z.ai/guides/overview/pricing",
      priceAsOf: "2026-07-15",
      pricing: [{ input: 1.2, cachedInput: 0.24, output: 4 }],
    },
    {
      name: "glm-4.7",
      tier: "mid",
      releaseDate: "2025-12-22",
      releaseDateSource: "https://docs.z.ai/release-notes/new-released",
      releaseDateConfidence: "verified",
      ctx: 204_800,
      out: 131_072,
      inP: 0.6,
      outP: 2.2,
      vision: false,
      tools: true,
      reasoning: true,
      reasoningEfforts: ["none"],
      reasoningDefaultEnabled: true,
      temperatureRange: { min: 0, max: 1 },
      priceSource: "https://docs.z.ai/guides/overview/pricing",
      priceAsOf: "2026-07-18",
      pricing: [{ input: 0.6, cachedInput: 0.11, output: 2.2 }],
    },
    {
      name: "glm-4.7-flashx",
      tier: "low",
      releaseDate: "2025-12-22",
      releaseDateSource: "https://docs.z.ai/release-notes/new-released",
      releaseDateConfidence: "corroborated",
      ctx: 204_800,
      out: 131_072,
      inP: 0.07,
      outP: 0.4,
      vision: false,
      tools: true,
      reasoning: true,
      reasoningEfforts: ["none"],
      reasoningDefaultEnabled: true,
      temperatureRange: { min: 0, max: 1 },
      priceSource: "https://docs.z.ai/guides/overview/pricing",
      priceAsOf: "2026-07-18",
      pricing: [{ input: 0.07, cachedInput: 0.01, output: 0.4 }],
    },
    {
      name: "glm-4.5-air",
      tier: "low",
      releaseDate: "2025-07-28",
      releaseDateSource: "https://docs.z.ai/release-notes/new-released",
      releaseDateConfidence: "verified",
      ctx: 131_072,
      out: 98_304,
      inP: 0.2,
      outP: 1.1,
      vision: false,
      tools: true,
      reasoning: true,
      reasoningEfforts: ["none"],
      reasoningDefaultEnabled: true,
      temperatureRange: { min: 0, max: 1 },
      priceSource: "https://docs.z.ai/guides/overview/pricing",
      priceAsOf: "2026-07-18",
      pricing: [{ input: 0.2, cachedInput: 0.03, output: 1.1 }],
    },
    {
      name: "glm-4.7-flash",
      tier: "free",
      releaseDate: "2026-01-19",
      releaseDateSource: "https://docs.z.ai/release-notes/new-released",
      releaseDateConfidence: "verified",
      ctx: 204_800,
      out: 131_072,
      inP: 0,
      outP: 0,
      vision: false,
      tools: true,
      reasoning: true,
      reasoningEfforts: ["none"],
      reasoningDefaultEnabled: true,
      temperatureRange: { min: 0, max: 1 },
      priceSource: "https://docs.z.ai/guides/overview/pricing",
      priceAsOf: "2026-07-18",
      pricing: [{ input: 0, cachedInput: 0, output: 0 }],
    },
    {
      name: "glm-4.5-flash",
      tier: "free",
      releaseDate: "2025-07-28",
      releaseDateSource: "https://docs.z.ai/release-notes/new-released",
      releaseDateConfidence: "corroborated",
      ctx: 131_072,
      out: 98_304,
      inP: 0,
      outP: 0,
      vision: false,
      tools: true,
      reasoning: true,
      reasoningEfforts: ["none"],
      reasoningDefaultEnabled: true,
      temperatureRange: { min: 0, max: 1 },
      priceSource: "https://docs.z.ai/guides/overview/pricing",
      priceAsOf: "2026-07-18",
      pricing: [{ input: 0, cachedInput: 0, output: 0 }],
    },
    {
      name: "glm-4.6v-flash",
      tier: "free",
      releaseDate: "2025-12-08",
      releaseDateSource: "https://docs.z.ai/release-notes/new-released",
      releaseDateConfidence: "corroborated",
      ctx: 131_072,
      out: 32_768,
      inP: 0,
      outP: 0,
      vision: true,
      tools: true,
      reasoning: true,
      reasoningEfforts: ["none"],
      reasoningDefaultEnabled: true,
      temperatureRange: { min: 0, max: 1 },
      priceSource: "https://docs.z.ai/guides/overview/pricing",
      priceAsOf: "2026-07-18",
      pricing: [{ input: 0, cachedInput: 0, output: 0 }],
    },
  ],
  qwen: [
    {
      name: "qwen-max",
      tier: "top",
      ctx: 32_768,
      out: 8192,
      inP: 2.4,
      outP: 9.6,
      vision: false,
      tools: true,
      reasoning: false,
    },
    {
      name: "qwen-plus",
      tier: "mid",
      ctx: 131_072,
      out: 8192,
      inP: 0.4,
      outP: 1.2,
      vision: false,
      tools: true,
      reasoning: false,
    },
    {
      name: "qwen-turbo",
      tier: "low",
      ctx: 1_000_000,
      out: 8192,
      inP: 0.05,
      outP: 0.2,
      vision: false,
      tools: true,
      reasoning: false,
    },
  ],
  azure: [
    {
      name: "gpt-4o",
      tier: "mid",
      ctx: 128_000,
      out: 16_384,
      inP: 2.5,
      outP: 10,
      vision: true,
      tools: true,
      reasoning: false,
    },
    {
      name: "gpt-4o-mini",
      tier: "low",
      ctx: 128_000,
      out: 16_384,
      inP: 0.15,
      outP: 0.6,
      vision: true,
      tools: true,
      reasoning: false,
    },
  ],
  bedrock: [],
  vertex: [],
  custom: [],
  mock: [
    {
      name: "mock-model-v1",
      tier: "free",
      ctx: 8192,
      out: 4096,
      inP: 0,
      outP: 0,
      vision: false,
      tools: false,
      reasoning: false,
      temperatureRange: { min: 0, max: 2 },
      pricing: [{ input: 0, output: 0 }],
    },
  ],
};

export const CURRENT_MODEL_MAX_AGE_DAYS = 365;

export interface CatalogModelPolicy {
  status: CatalogModelStatus;
  selectable: boolean;
  reason:
    | "current"
    | "unverified"
    | "older_than_365_days"
    | "deprecated"
    | "sunset"
    | "expired"
    | "restricted";
  /** Date used for the rolling-age decision, without changing its provenance. */
  ageEvidenceDate: string | null;
}

function parseLifecycleDate(value: string | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function startOfUtcDay(value: Date): Date {
  return new Date(
    Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()),
  );
}

function hasReached(value: string | undefined, asOf: Date): boolean {
  const date = parseLifecycleDate(value);
  return date !== null && date.getTime() <= asOf.getTime();
}

/**
 * Apply the rolling 365-day selection policy at a caller-supplied instant.
 * Date-only release values are compared as UTC calendar days, so a model
 * released exactly 365 days ago remains current for the whole boundary day.
 *
 * A provider catalog timestamp is only a conservative age signal: when it is
 * older than the cutoff, the model necessarily existed outside the window and
 * is legacy. It remains separately identified as provider-catalog evidence.
 */
export function catalogModelPolicy(
  model: CatalogModelLifecycle,
  asOf: Date = new Date(),
): CatalogModelPolicy {
  const cutoff = startOfUtcDay(asOf);
  cutoff.setUTCDate(cutoff.getUTCDate() - CURRENT_MODEL_MAX_AGE_DAYS);
  const releaseDate = parseLifecycleDate(model.releaseDate);
  const providerCatalogDate = parseLifecycleDate(
    model.providerCatalogCreatedAt,
  );
  const ageEvidenceDate = releaseDate
    ? (model.releaseDate ?? null)
    : providerCatalogDate
      ? (model.providerCatalogCreatedAt ?? null)
      : null;
  const evidenceDate = releaseDate ?? providerCatalogDate;
  let agePolicy: CatalogModelPolicy;
  if (!ageEvidenceDate || !evidenceDate) {
    agePolicy = {
      status: "unverified",
      selectable: true,
      reason: "unverified",
      ageEvidenceDate: null,
    };
  } else if (startOfUtcDay(evidenceDate).getTime() < cutoff.getTime()) {
    agePolicy = {
      status: "legacy",
      selectable: false,
      reason: "older_than_365_days",
      ageEvidenceDate,
    };
  } else if (releaseDate) {
    agePolicy = {
      status: "current",
      selectable: true,
      reason: "current",
      ageEvidenceDate,
    };
  } else {
    // A recent gateway listing proves availability but not upstream recency.
    agePolicy = {
      status: "unverified",
      selectable: true,
      reason: "unverified",
      ageEvidenceDate,
    };
  }

  if (model.restricted) {
    return {
      ...agePolicy,
      selectable: false,
      reason: "restricted",
    };
  }
  if (hasReached(model.deprecatedAt, asOf)) {
    return {
      ...agePolicy,
      status: "legacy",
      selectable: false,
      reason: "deprecated",
    };
  }
  if (hasReached(model.sunsetAt, asOf)) {
    return {
      ...agePolicy,
      status: "legacy",
      selectable: false,
      reason: "sunset",
    };
  }
  if (hasReached(model.expiresAt, asOf)) {
    return {
      ...agePolicy,
      status: "legacy",
      selectable: false,
      reason: "expired",
    };
  }
  return agePolicy;
}

export function catalogModelStatus(
  model: CatalogModelLifecycle,
  asOf: Date = new Date(),
): CatalogModelStatus {
  return catalogModelPolicy(model, asOf).status;
}

export function isCatalogModelSelectable(
  model: CatalogModelLifecycle,
  asOf: Date = new Date(),
): boolean {
  return catalogModelPolicy(model, asOf).selectable;
}

/** Only explicit zero-priced rows qualify as genuine free inference. */
export function isFreeTierModel(
  model: Pick<CatalogModel, "tier" | "inP" | "outP">,
): boolean {
  return model.tier === "free" && model.inP === 0 && model.outP === 0;
}

export function classifyCatalogModelTier(model: {
  tier?: ModelTier;
  inP: number;
  outP: number;
}): ModelTier | null {
  if (model.tier) return model.tier;
  return model.inP === 0 && model.outP === 0 ? "free" : null;
}

export function groupCatalogModelsByTier(
  models: readonly CatalogModel[],
): Record<ModelTier, CatalogModel[]> {
  const grouped: Record<ModelTier, CatalogModel[]> = {
    top: [],
    mid: [],
    low: [],
    free: [],
  };
  for (const model of models) grouped[model.tier].push(model);
  return grouped;
}

export function selectableModelsForProvider(
  provider: ProviderId,
  asOf: Date = new Date(),
): CatalogModel[] {
  return (PROVIDER_MODEL_CATALOG[provider] ?? []).filter((model) =>
    isCatalogModelSelectable(model, asOf),
  );
}

export function selectableProviderModelCatalog(
  asOf: Date = new Date(),
): Record<ProviderId, CatalogModel[]> {
  return Object.fromEntries(
    PROVIDER_IDS.map((provider) => [
      provider,
      selectableModelsForProvider(provider, asOf),
    ]),
  ) as Record<ProviderId, CatalogModel[]>;
}

/**
 * Resolve exact ids, mutable aliases, provider-qualified direct ids, and
 * dated snapshots to the checked-in provider/model capability record.
 */
export function findCatalogModel(
  provider: ProviderId,
  modelName: string,
): CatalogModel | undefined {
  const withoutSentinel = modelName.startsWith("~")
    ? modelName.slice(1)
    : modelName;
  const normalized =
    provider === "openrouter"
      ? withoutSentinel
      : withoutSentinel.replace(new RegExp(`^${provider}/`), "");
  const models = PROVIDER_MODEL_CATALOG[provider] ?? [];
  const names = (model: CatalogModel): string[] => [
    model.name,
    ...(model.aliases ?? []),
  ];
  return (
    models.find((model) => names(model).includes(normalized)) ??
    models.find((model) =>
      names(model).some((name) => normalized.startsWith(`${name}-20`)),
    )
  );
}

/**
 * Default model per provider — used when a request omits `model` and the
 * env's `LLM_DEFAULT_MODEL` is also unset. Returns `null` for providers
 * without a sensible default (custom, stubs).
 */
export function defaultModelFor(provider: ProviderId): string | null {
  const list = selectableModelsForProvider(provider);
  if (!list || list.length === 0) return null;
  const added = list.find((m) => m.added);
  return (added ?? list[0])?.name ?? null;
}
