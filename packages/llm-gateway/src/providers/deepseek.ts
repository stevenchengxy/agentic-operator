import { defaultModelFor } from "@agentic/contracts";
import type { ProviderAdapter } from "../types";
import type { AdapterEnvSlice } from "../config";
import { createOpenAICompatibleAdapter } from "../adapters/openai-compatible";

export function makeDeepSeek(env: AdapterEnvSlice): ProviderAdapter {
  return createOpenAICompatibleAdapter({
    id: "deepseek",
    name: "DeepSeek",
    baseURL: "https://api.deepseek.com",
    apiKey: env.DEEPSEEK_API_KEY,
    defaultModel: defaultModelFor("deepseek"),
    reasoningDialect: "deepseek",
  });
}
