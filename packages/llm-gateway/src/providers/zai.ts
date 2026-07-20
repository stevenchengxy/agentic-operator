import { defaultModelFor } from "@agentic/contracts";
import type { AdapterEnvSlice } from "../config";
import { createOpenAICompatibleAdapter } from "../adapters/openai-compatible";
import type { ProviderAdapter } from "../types";

export function makeZai(env: AdapterEnvSlice): ProviderAdapter {
  return createOpenAICompatibleAdapter({
    id: "zai",
    name: "Z.AI · GLM",
    baseURL: "https://api.z.ai/api/paas/v4",
    apiKey: env.ZAI_API_KEY,
    defaultModel: defaultModelFor("zai"),
    reasoningDialect: "zai",
  });
}
