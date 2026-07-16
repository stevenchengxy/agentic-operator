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
  env: ProcessEnv = (globalThis as { process?: { env?: ProcessEnv } }).process?.env ?? {},
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

  const provider: ProviderId =
    rawProvider && isProviderId(rawProvider) ? rawProvider : "mock";
  const model = rawModel && rawModel.trim().length > 0 ? rawModel : null;
  const timeoutMs = Number(env.LLM_REQUEST_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);

  return {
    gateway: {
      defaultProvider: provider,
      defaultModel: model,
      timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS,
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
