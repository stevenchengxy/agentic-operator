import { defaultModelFor } from "@agentic/contracts";
import type { AdapterEnvSlice } from "../config";
import { createOpenAICompatibleAdapter } from "../adapters/openai-compatible";
import type { ProviderAdapter } from "../types";

export function makeMoonshot(env: AdapterEnvSlice): ProviderAdapter {
  return createOpenAICompatibleAdapter({
    id: "moonshot",
    name: "Moonshot AI · Kimi",
    baseURL: "https://api.moonshot.ai/v1",
    apiKey: env.MOONSHOT_API_KEY,
    defaultModel: defaultModelFor("moonshot"),
    reasoningDialect: "moonshot",
  });
}
