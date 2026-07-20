/**
 * Env → GatewayConfig resolver. Called once per process at gateway
 * construction. Stores nothing globally; just maps env keys to a plain
 * config object that the adapters/registry consume.
 *
 * Backward compatibility:
 *   - LLM_DEFAULT_PROVIDER preferred; falls back to legacy LLM_PROVIDER.
 *   - LLM_DEFAULT_MODEL preferred; falls back to legacy LLM_MODEL.
 *   - One-time deprecation warning printed to stderr when only legacy is set.
 */

import type { ProviderId } from "@agentic/contracts";
import { PROVIDER_IDS } from "@agentic/contracts";
import type { GatewayConfig } from "./types";

const DEFAULT_TIMEOUT_MS = 60_000;
let deprecationWarned = false;

const IMPLEMENTED_PROVIDER_IDS = new Set<ProviderId>([
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
  "custom",
  "mock",
]);

export interface AdapterEnvSlice {
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  OPENROUTER_REFERRER?: string;
  OPENROUTER_APP_TITLE?: string;
  GOOGLE_API_KEY?: string;
  GROQ_API_KEY?: string;
  TOGETHER_API_KEY?: string;
  MISTRAL_API_KEY?: string;
  DEEPSEEK_API_KEY?: string;
  MOONSHOT_API_KEY?: string;
  ZAI_API_KEY?: string;
  QWEN_API_KEY?: string;
  AZURE_OPENAI_API_KEY?: string;
  AZURE_OPENAI_ENDPOINT?: string;
  AZURE_OPENAI_API_VERSION?: string;
  AZURE_OPENAI_DEPLOYMENT?: string;
  CUSTOM_LLM_BASE_URL?: string;
  CUSTOM_LLM_API_KEY?: string;
}

export interface ResolvedConfig {
  gateway: GatewayConfig;
  adapterEnv: AdapterEnvSlice;
}

function isProviderId(s: string): s is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(s);
}

type ProcessEnv = Record<string, string | undefined>;

export function resolveConfig(
  env: ProcessEnv = (globalThis as { process?: { env?: ProcessEnv } }).process
    ?.env ?? {},
): ResolvedConfig {
  const rawProvider = env.LLM_DEFAULT_PROVIDER ?? env.LLM_PROVIDER;
  const rawModel = env.LLM_DEFAULT_MODEL ?? env.LLM_MODEL;

  if (
    !deprecationWarned &&
    !env.LLM_DEFAULT_PROVIDER &&
    !env.LLM_DEFAULT_MODEL &&
    (env.LLM_PROVIDER || env.LLM_MODEL)
  ) {
    console.warn(
      "[llm-gateway] LLM_PROVIDER/LLM_MODEL are deprecated; use LLM_DEFAULT_PROVIDER/LLM_DEFAULT_MODEL instead.",
    );
    deprecationWarned = true;
  }

  // #NOMOCK — silent mock fallback is the root enabler of "looks-real, actually-mock" (the historical
  // "Mock response from mock-model-v1…" report bug). It is now a FAIL-CLOSED invariant, not a warning:
  //   - Normalize case/whitespace first, so "Custom" / " custom " resolve to a real provider instead
  //     of silently dropping to mock.
  //   - A recognized REAL provider id is honored.
  //   - `mock` is accepted only in NODE_ENV=test. Demo mode is intentionally
  //     NOT an exemption: a visual demo must not pretend synthetic inference is real.
  //   - An EMPTY or INVALID (typo'd) provider id THROWS outside tests — refusing to run the
  //     whole gateway on a canned echo.
  const normProvider = (rawProvider ?? "").trim().toLowerCase();
  const providerValid = isProviderId(normProvider);
  const providerImplemented = providerValid && IMPLEMENTED_PROVIDER_IDS.has(normProvider);
  const mockAllowed = env.NODE_ENV === "test";
  const requestedMock = normProvider === "mock";
  if (providerValid && !providerImplemented) {
    throw new Error(
      `[llm-gateway] Provider "${normProvider}" is catalogued but has no real adapter in this build; refusing to register a placeholder`,
    );
  }
  if ((!providerValid || requestedMock) && !mockAllowed) {
    throw new Error(
      `[llm-gateway] LLM_DEFAULT_PROVIDER 未设置、无效或指向 mock（"${rawProvider ?? ""}"）。拒绝在非 test 进程回退到 ` +
        `MOCK 提供商（回声、非真实模型）——这正是「看着像真、实为 mock」的根因。请设置一个真实 provider（如 ` +
        `custom + CUSTOM_LLM_BASE_URL）。mock 只允许在 NODE_ENV=test 中使用。`,
    );
  }
  const provider: ProviderId = providerValid && providerImplemented ? (normProvider as ProviderId) : "mock";
  const model = rawModel && rawModel.trim().length > 0 ? rawModel : null;
  const timeoutMs = Number(env.LLM_REQUEST_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  const requireUsageAttribution =
    env.LLM_REQUIRE_USAGE_ATTRIBUTION === undefined
      ? env.NODE_ENV === "production"
      : env.LLM_REQUIRE_USAGE_ATTRIBUTION === "true";

  return {
    gateway: {
      defaultProvider: provider,
      defaultModel: model,
      timeoutMs:
        Number.isFinite(timeoutMs) && timeoutMs > 0
          ? timeoutMs
          : DEFAULT_TIMEOUT_MS,
      allowMock: mockAllowed,
      requireUsageAttribution,
    },
    adapterEnv: {
      ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
      OPENAI_API_KEY: env.OPENAI_API_KEY,
      OPENROUTER_API_KEY: env.OPENROUTER_API_KEY,
      OPENROUTER_REFERRER: env.OPENROUTER_REFERRER,
      OPENROUTER_APP_TITLE: env.OPENROUTER_APP_TITLE,
      GOOGLE_API_KEY: env.GOOGLE_API_KEY,
      GROQ_API_KEY: env.GROQ_API_KEY,
      TOGETHER_API_KEY: env.TOGETHER_API_KEY,
      MISTRAL_API_KEY: env.MISTRAL_API_KEY,
      DEEPSEEK_API_KEY: env.DEEPSEEK_API_KEY,
      MOONSHOT_API_KEY: env.MOONSHOT_API_KEY,
      ZAI_API_KEY: env.ZAI_API_KEY,
      QWEN_API_KEY: env.QWEN_API_KEY,
      AZURE_OPENAI_API_KEY: env.AZURE_OPENAI_API_KEY,
      AZURE_OPENAI_ENDPOINT: env.AZURE_OPENAI_ENDPOINT,
      AZURE_OPENAI_API_VERSION: env.AZURE_OPENAI_API_VERSION,
      AZURE_OPENAI_DEPLOYMENT: env.AZURE_OPENAI_DEPLOYMENT,
      CUSTOM_LLM_BASE_URL: env.CUSTOM_LLM_BASE_URL,
      CUSTOM_LLM_API_KEY: env.CUSTOM_LLM_API_KEY,
    },
  };
}
