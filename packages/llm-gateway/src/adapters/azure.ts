/**
 * Azure OpenAI adapter. Azure deployments are URL-encoded into the path
 * (`/openai/deployments/<deployment>/chat/completions`) and require an
 * `api-version` query string plus an `api-key` header (not Bearer).
 *
 * The openai SDK supports Azure via its dedicated `AzureOpenAI` client.
 * Caller-provided `model` is interpreted as the deployment name.
 */

import { AzureOpenAI } from "openai";
import {
  flattenContentToText,
  type ChatRequest,
  type ChatResponse,
  type ProviderAdapter,
} from "../types";
import { LLMError, classifyHttpError } from "../errors";

export interface AzureAdapterConfig {
  apiKey: string | undefined;
  endpoint: string | undefined;
  apiVersion: string | undefined;
  defaultDeployment: string | undefined;
}

function mapFinishReason(reason: string | null | undefined): ChatResponse["finishReason"] {
  switch (reason) {
    case "stop":
    case "length":
    case "tool_calls":
      return reason;
    default:
      return reason ? "unknown" : "stop";
  }
}

export function createAzureAdapter(config: AzureAdapterConfig): ProviderAdapter {
  const ready = Boolean(config.apiKey && config.endpoint && config.apiVersion);
  let client: AzureOpenAI | null = null;

  function getClient(): AzureOpenAI {
    if (!ready) {
      throw new LLMError(
        "Azure OpenAI requires AZURE_OPENAI_API_KEY, AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_VERSION",
        "not_configured",
        "azure",
      );
    }
    if (!client) {
      client = new AzureOpenAI({
        apiKey: config.apiKey!,
        endpoint: config.endpoint!,
        apiVersion: config.apiVersion!,
      });
    }
    return client;
  }

  return {
    id: "azure",
    name: "Azure OpenAI",
    hasKey: ready,
    defaultModel: config.defaultDeployment ?? null,

    async chat(req: ChatRequest): Promise<ChatResponse> {
      const start = Date.now();
      const c = getClient();
      const deployment = req.model ?? config.defaultDeployment ?? null;
      if (!deployment) {
        throw new LLMError(
          "Azure OpenAI: no deployment specified (set AZURE_OPENAI_DEPLOYMENT or pass `model`)",
          "bad_request",
          "azure",
        );
      }

      try {
        const completion = await c.chat.completions.create(
          {
            model: deployment,
            messages: req.messages.map((m) => ({
              role: m.role === "tool" ? "assistant" : m.role,
              content: flattenContentToText(m.content),
            })),
            temperature: req.temperature,
            max_tokens: req.maxTokens,
            stop: req.stop,
            ...(req.jsonMode ? { response_format: { type: "json_object" as const } } : {}),
          },
          {
            signal: req.signal,
          },
        );

        const choice = completion.choices[0];
        const text = choice?.message?.content ?? "";
        const usage = completion.usage;
        const usageRecord = usage as unknown as Record<string, unknown> | undefined;
        const promptDetails = usageRecord?.prompt_tokens_details as Record<string, unknown> | undefined;
        const completionDetails = usageRecord?.completion_tokens_details as Record<string, unknown> | undefined;
        const number = (record: Record<string, unknown> | undefined, key: string): number => {
          const value = record?.[key];
          return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
        };
        const inputTokens = number(usageRecord, "prompt_tokens");
        const outputTokens = number(usageRecord, "completion_tokens");

        return {
          text,
          provider: "azure",
          model: deployment,
          tokensIn: usage?.prompt_tokens ?? null,
          tokensOut: usage?.completion_tokens ?? null,
          usage: usage ? {
            inputTokens,
            outputTokens,
            totalTokens: number(usageRecord, "total_tokens") || inputTokens + outputTokens,
            cachedInputTokens: number(promptDetails, "cached_tokens"),
            cacheWriteInputTokens: number(promptDetails, "cache_write_tokens"),
            cacheWrite5mInputTokens: number(promptDetails, "cache_write_tokens_5m"),
            cacheWrite1hInputTokens: number(promptDetails, "cache_write_tokens_1h"),
            reasoningTokens: number(completionDetails, "reasoning_tokens"),
            inputAudioTokens: number(promptDetails, "audio_tokens"),
            outputAudioTokens: number(completionDetails, "audio_tokens"),
            raw: usage,
          } : undefined,
          providerRequestId: completion.id,
          finishReason: mapFinishReason(choice?.finish_reason),
          latencyMs: Date.now() - start,
          raw: completion,
        };
      } catch (err) {
        throw normalizeAzureError(err);
      }
    },
  };
}

function normalizeAzureError(err: unknown): LLMError {
  if (err instanceof LLMError) return err;
  const anyErr = err as { status?: number; message?: string; name?: string };
  if (anyErr.name === "AbortError" || (anyErr.message ?? "").toLowerCase().includes("aborted")) {
    return new LLMError("Azure request aborted/timeout", "timeout", "azure", err);
  }
  if (anyErr.status !== undefined) {
    return classifyHttpError(anyErr.status, "azure", anyErr.message ?? String(err), err);
  }
  return new LLMError(
    `Azure error: ${anyErr.message ?? String(err)}`,
    "provider_error",
    "azure",
    err,
  );
}
