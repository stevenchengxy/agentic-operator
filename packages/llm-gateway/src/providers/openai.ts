import { defaultModelFor } from "@agentic/contracts";
import type { ProviderAdapter } from "../types";
import type { AdapterEnvSlice } from "../config";
import { createOpenAIResponsesAdapter } from "../adapters/openai-responses";

export function makeOpenAI(env: AdapterEnvSlice): ProviderAdapter {
  const defaultModel = defaultModelFor("openai");
  return createOpenAIResponsesAdapter({
    id: "openai",
    name: "OpenAI",
    baseURL: "https://api.openai.com/v1",
    apiKey: env.OPENAI_API_KEY,
    defaultModel,
  });
}
