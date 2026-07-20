import { defaultModelFor } from "@agentic/contracts";
import type { ChatRequest, ProviderAdapter } from "../types";
import type { AdapterEnvSlice } from "../config";
import { createOpenAICompatibleAdapter } from "../adapters/openai-compatible";
import { createOpenAIResponsesAdapter } from "../adapters/openai-responses";

/**
 * OpenRouter keeps its Chat Completions path for effort-only requests, while
 * controls that only exist in OpenResponses are routed to `/responses`.
 * Exported as a pure predicate so this compatibility boundary stays covered
 * without making a network request.
 */
export function shouldUseOpenRouterResponses(
  req: Pick<ChatRequest, "reasoning" | "verbosity" | "store">,
): boolean {
  return Boolean(
    req.reasoning?.mode
      || req.reasoning?.context
      || req.reasoning?.summary
      || req.verbosity
      || req.store !== undefined,
  );
}

const OPENROUTER_GPT_5_6_MODE_PAIR =
  /^(openai\/gpt-5\.6-(?:sol|terra|luna))(?:-pro)?$/;

/**
 * OpenRouter publishes Standard and Pro as paired GPT-5.6 model IDs. Map our
 * provider-neutral mode control onto that model pair, then remove `mode` from
 * the upstream parameter set. Remaining Responses-only controls still choose
 * `/responses`; a mode/effort-only call can use Chat Completions.
 */
export function resolveOpenRouterReasoningMode(req: ChatRequest): ChatRequest {
  const mode = req.reasoning?.mode;
  const match = req.model?.match(OPENROUTER_GPT_5_6_MODE_PAIR);
  if (!mode || !match) return req;

  const reasoning = { ...req.reasoning };
  delete reasoning.mode;

  return {
    ...req,
    model: mode === "pro" ? `${match[1]}-pro` : match[1],
    reasoning: Object.keys(reasoning).length > 0 ? reasoning : undefined,
  };
}

export function makeOpenRouter(env: AdapterEnvSlice): ProviderAdapter {
  const extraHeaders: Record<string, string> = {};
  if (env.OPENROUTER_REFERRER) extraHeaders["HTTP-Referer"] = env.OPENROUTER_REFERRER;
  if (env.OPENROUTER_APP_TITLE) extraHeaders["X-Title"] = env.OPENROUTER_APP_TITLE;

  const defaultModel = defaultModelFor("openrouter");
  const chatAdapter = createOpenAICompatibleAdapter({
    id: "openrouter",
    name: "OpenRouter",
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: env.OPENROUTER_API_KEY,
    extraHeaders,
    defaultModel,
    reasoningDialect: "openrouter",
  });
  const responsesAdapter = createOpenAIResponsesAdapter({
    id: "openrouter",
    name: "OpenRouter",
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: env.OPENROUTER_API_KEY,
    extraHeaders,
    defaultModel,
  });

  return {
    ...chatAdapter,
    async chat(req) {
      const resolved = resolveOpenRouterReasoningMode(req);
      const response = await (shouldUseOpenRouterResponses(resolved)
        ? responsesAdapter.chat(resolved)
        : chatAdapter.chat(resolved));

      // Model-pair resolution is itself the provider's effective mode. Keep
      // that normalized result visible even when the wire response omits it.
      return req.reasoning?.mode && resolved !== req
        ? {
            ...response,
            reasoning: {
              ...response.reasoning,
              mode: req.reasoning.mode,
            },
          }
        : response;
    },
  };
}
