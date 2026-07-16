/**
 * OpenResponses adapter for direct OpenAI calls and OpenRouter requests that
 * need Responses-only reasoning, summary, context, verbosity, or storage
 * controls. OpenRouter's paired GPT-5.6 Standard/Pro model IDs are resolved
 * in its provider wrapper before requests reach this transport.
 */

import OpenAI, { type ClientOptions } from "openai";
import type {
  FunctionTool,
  ResponseCreateParamsNonStreaming,
  ResponseInputItem,
} from "openai/resources/responses/responses";
import type { ProviderId } from "@agentic/contracts";
import {
  flattenContentToText,
  type ChatRequest,
  type ChatResponse,
  type ProviderAdapter,
  type ToolCall,
} from "../types";
import { LLMError, classifyHttpError } from "../errors";

export interface OpenAIResponsesAdapterConfig {
  id: ProviderId;
  name: string;
  baseURL: string;
  apiKey: string | undefined;
  extraHeaders?: Record<string, string>;
  defaultModel: string | null;
  /** Test/custom transport hook supported by the official OpenAI SDK. */
  fetch?: ClientOptions["fetch"];
}

function encodeToolName(internal: string): string {
  return internal.replace(/\./g, "__");
}

function decodeToolName(wire: string): string {
  return wire.replace(/__/g, ".");
}

interface ResponsesReasoningReplayEnvelope {
  provider: ProviderId;
  api: "responses";
  items: ResponseInputItem[];
}

function replayReasoningItems(
  serialized: string | undefined,
  provider: ProviderId,
): ResponseInputItem[] {
  if (!serialized) return [];
  try {
    const parsed = JSON.parse(serialized) as Partial<ResponsesReasoningReplayEnvelope>;
    if (
      parsed.provider !== provider ||
      parsed.api !== "responses" ||
      !Array.isArray(parsed.items)
    ) {
      return [];
    }
    return parsed.items.filter(
      (item): item is ResponseInputItem =>
        Boolean(item) &&
        typeof item === "object" &&
        (item as { type?: unknown }).type === "reasoning",
    );
  } catch {
    // Another adapter's opaque reasoning state is intentionally ignored.
    return [];
  }
}

function mapInput(req: ChatRequest, provider: ProviderId): ResponseInputItem[] {
  const input: ResponseInputItem[] = [];

  for (const message of req.messages) {
    if (message.role === "assistant") {
      input.push(...replayReasoningItems(message.reasoningContent, provider));
    }
    if (typeof message.content === "string") {
      input.push({
        role: message.role === "tool" ? "assistant" : message.role,
        content: message.content,
      });
      continue;
    }

    if (message.role === "tool") {
      for (const block of message.content) {
        if (block.type === "tool_result") {
          input.push({
            type: "function_call_output",
            call_id: block.tool_use_id,
            output: block.content,
          });
        } else if (block.type === "text") {
          input.push({ role: "assistant", content: block.text });
        }
      }
      continue;
    }

    if (message.role === "assistant") {
      const text = message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
      if (text) input.push({ role: "assistant", content: text });
      for (const block of message.content) {
        if (block.type !== "tool_use") continue;
        input.push({
          type: "function_call",
          call_id: block.id,
          name: encodeToolName(block.name),
          arguments: JSON.stringify(block.input ?? {}),
        });
      }
      continue;
    }

    input.push({
      role: message.role,
      content: flattenContentToText(message.content),
    });
  }

  return input;
}

function mapTools(req: ChatRequest): FunctionTool[] | undefined {
  if (!req.tools?.length) return undefined;
  return req.tools.map((tool) => ({
    type: "function",
    name: encodeToolName(tool.name),
    description: tool.description,
    parameters: tool.input_schema,
    strict: false,
  }));
}

/** Pure wire-shape builder exported for contract tests. */
export function buildOpenAIResponsesRequest(
  req: ChatRequest,
  model: string,
  provider: ProviderId = "openai",
): ResponseCreateParamsNonStreaming {
  if (req.stop?.length) {
    throw new LLMError(
      `${provider} Responses mode does not support stop sequences`,
      "bad_request",
      provider,
    );
  }

  // OpenRouter's OpenResponses endpoint is deliberately stateless and its
  // schema accepts only `store: false`. Rejecting `true` here is clearer than
  // forwarding a request that is guaranteed to fail upstream.
  if (provider === "openrouter" && req.store === true) {
    throw new LLMError(
      "OpenRouter Responses does not support store=true",
      "bad_request",
      provider,
    );
  }

  const reasoning = req.reasoning
    ? {
        ...(req.reasoning.effort !== undefined
          ? { effort: req.reasoning.effort }
          : {}),
        ...(req.reasoning.mode !== undefined
          ? { mode: req.reasoning.mode }
          : {}),
        ...(req.reasoning.context !== undefined
          ? { context: req.reasoning.context }
          : {}),
        ...(req.reasoning.summary !== undefined
          ? {
              summary:
                req.reasoning.summary === "none"
                  ? null
                  : req.reasoning.summary,
            }
          : {}),
      }
    : undefined;

  const text = req.jsonMode || req.verbosity
    ? {
        ...(req.jsonMode
          ? { format: { type: "json_object" as const } }
          : {}),
        ...(req.verbosity !== undefined
          ? { verbosity: req.verbosity }
          : {}),
      }
    : undefined;

  return {
    model,
    input: mapInput(req, provider),
    max_output_tokens: req.maxTokens,
    temperature: req.temperature,
    reasoning,
    tools: mapTools(req),
    include:
      req.tools?.length && req.store !== true
        ? ["reasoning.encrypted_content"]
        : undefined,
    text,
    // Chat Completions did not persist conversation state. Preserve that privacy
    // characteristic while callers continue to manage history themselves.
    store: req.store ?? false,
  };
}

const REASONING_EFFORTS = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
const REASONING_MODES = new Set(["standard", "pro"]);
const REASONING_CONTEXTS = new Set(["auto", "current_turn", "all_turns"]);
const REASONING_SUMMARIES = new Set(["auto", "concise", "detailed"]);
const TEXT_VERBOSITIES = new Set(["low", "medium", "high"]);

function recognized(
  value: unknown,
  allowed: ReadonlySet<string>,
): string | undefined {
  return typeof value === "string" && allowed.has(value) ? value : undefined;
}

function effectiveReasoning(
  reported: unknown,
  requested: ChatRequest["reasoning"],
): ChatResponse["reasoning"] {
  const value = reported && typeof reported === "object"
    ? reported as Record<string, unknown>
    : undefined;
  const effort = recognized(value?.effort, REASONING_EFFORTS)
    ?? requested?.effort;
  const mode = recognized(value?.mode, REASONING_MODES)
    ?? requested?.mode;
  const context = recognized(value?.context, REASONING_CONTEXTS)
    ?? requested?.context;
  const reportedSummary = recognized(value?.summary, REASONING_SUMMARIES);
  const summary = reportedSummary
    ?? (value?.summary === null && requested?.summary === "none"
      ? "none"
      : requested?.summary);

  if (
    effort === undefined
    && mode === undefined
    && context === undefined
    && summary === undefined
  ) {
    return undefined;
  }

  return {
    ...(effort !== undefined ? { effort } : {}),
    ...(mode !== undefined ? { mode } : {}),
    ...(summary !== undefined ? { summary } : {}),
    ...(context !== undefined ? { context } : {}),
  } as NonNullable<ChatResponse["reasoning"]>;
}

function effectiveVerbosity(
  reported: unknown,
  requested: ChatRequest["verbosity"],
): ChatResponse["verbosity"] {
  const value = reported && typeof reported === "object"
    ? reported as Record<string, unknown>
    : undefined;
  return (recognized(value?.verbosity, TEXT_VERBOSITIES)
    ?? requested) as ChatResponse["verbosity"];
}

function reasoningSummaryParts(item: unknown): string[] {
  if (!item || typeof item !== "object") return [];
  const summary = (item as Record<string, unknown>).summary;
  if (!Array.isArray(summary)) return [];

  const parts: string[] = [];
  for (const part of summary) {
    // OpenAI returns `{ type: "summary_text", text }`; OpenRouter's current
    // OpenResponses shape returns the summary entries as strings.
    if (typeof part === "string") {
      if (part) parts.push(part);
      continue;
    }
    if (!part || typeof part !== "object") continue;
    const text = (part as Record<string, unknown>).text;
    if (typeof text === "string" && text) parts.push(text);
  }
  return parts;
}

function outputText(response: {
  output_text?: unknown;
  output?: unknown;
}): string {
  if (typeof response.output_text === "string") return response.output_text;
  if (!Array.isArray(response.output)) return "";

  const parts: string[] = [];
  for (const item of response.output) {
    if (!item || typeof item !== "object") continue;
    const content = (item as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const text = (block as Record<string, unknown>).text;
      if (typeof text === "string") parts.push(text);
    }
  }
  return parts.join("");
}

function number(
  record: Record<string, unknown> | undefined,
  key: string,
): number {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, value)
    : 0;
}

function decimal(
  record: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const value = record?.[key];
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function finishReason(
  status: string,
  hasToolCalls: boolean,
  incompleteReason: string | undefined,
): ChatResponse["finishReason"] {
  if (hasToolCalls) return "tool_calls";
  if (incompleteReason === "max_output_tokens") return "length";
  if (status === "completed") return "stop";
  if (status === "failed") return "error";
  return "unknown";
}

export function createOpenAIResponsesAdapter(
  config: OpenAIResponsesAdapterConfig,
): ProviderAdapter {
  const hasKey = Boolean(config.apiKey);
  let client: OpenAI | null = null;

  function getClient(): OpenAI {
    if (!hasKey) {
      throw new LLMError(
        `${config.name} API key is not configured`,
        "not_configured",
        config.id,
      );
    }
    if (!client) {
      client = new OpenAI({
        apiKey: config.apiKey!,
        baseURL: config.baseURL,
        defaultHeaders: config.extraHeaders,
        fetch: config.fetch,
      });
    }
    return client;
  }

  return {
    id: config.id,
    name: config.name,
    hasKey,
    defaultModel: config.defaultModel,

    async chat(req): Promise<ChatResponse> {
      const start = Date.now();
      const model = req.model ?? config.defaultModel;
      if (!model) {
        throw new LLMError(
          `${config.name}: no model specified and no default configured`,
          "bad_request",
          config.id,
        );
      }

      try {
        const response = await getClient().responses.create(
          buildOpenAIResponsesRequest(req, model, config.id),
          { signal: req.signal },
        );
        const rawUsage = response.usage as unknown as
          | Record<string, unknown>
          | undefined;
        const inputDetails = rawUsage?.input_tokens_details as
          | Record<string, unknown>
          | undefined;
        const outputDetails = rawUsage?.output_tokens_details as
          | Record<string, unknown>
          | undefined;
        const inputTokens = number(rawUsage, "input_tokens");
        const outputTokens = number(rawUsage, "output_tokens");
        const toolCalls: ToolCall[] = [];
        const reasoningSummaries: string[] = [];
        const reasoningReplayItems: ResponseInputItem[] = [];

        for (const item of response.output) {
          if (item.type === "reasoning") {
            reasoningSummaries.push(...reasoningSummaryParts(item));
            reasoningReplayItems.push(item);
            continue;
          }
          if (item.type !== "function_call") continue;
          let parsedInput: Record<string, unknown> = {};
          try {
            const parsed = item.arguments ? JSON.parse(item.arguments) : {};
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
              parsedInput = parsed as Record<string, unknown>;
            }
          } catch {
            // The tool handler will return its own schema error for `{}`.
          }
          toolCalls.push({
            id: item.call_id,
            name: decodeToolName(item.name),
            input: parsedInput,
          });
        }

        const incomplete = response.incomplete_details as
          | { reason?: string }
          | null;

        return {
          text: outputText(response),
          provider: config.id,
          model: response.model,
          tokensIn: response.usage?.input_tokens ?? null,
          tokensOut: response.usage?.output_tokens ?? null,
          usage: response.usage
            ? {
                inputTokens,
                outputTokens,
                totalTokens:
                  number(rawUsage, "total_tokens") || inputTokens + outputTokens,
                cachedInputTokens: number(inputDetails, "cached_tokens"),
                cacheWriteInputTokens: number(
                  inputDetails,
                  "cache_write_tokens",
                ),
                cacheWrite5mInputTokens: 0,
                cacheWrite1hInputTokens: 0,
                reasoningTokens: number(outputDetails, "reasoning_tokens"),
                inputAudioTokens: number(inputDetails, "audio_tokens"),
                outputAudioTokens: number(outputDetails, "audio_tokens"),
                raw: response.usage,
              }
            : undefined,
          providerReportedCostUsd:
            config.id === "openrouter"
              ? decimal(rawUsage, "cost")
              : undefined,
          providerRequestId: response.id,
          finishReason: finishReason(
            response.status ?? "unknown",
            toolCalls.length > 0,
            incomplete?.reason,
          ),
          latencyMs: Date.now() - start,
          reasoning: effectiveReasoning(response.reasoning, req.reasoning),
          verbosity: effectiveVerbosity(response.text, req.verbosity),
          reasoningSummary:
            reasoningSummaries.length > 0
              ? reasoningSummaries.join("\n\n")
              : undefined,
          reasoningContent:
            reasoningReplayItems.length > 0
              ? JSON.stringify({
                  provider: config.id,
                  api: "responses",
                  items: reasoningReplayItems,
                } satisfies ResponsesReasoningReplayEnvelope)
              : undefined,
          toolCalls: toolCalls.length ? toolCalls : undefined,
          raw: response,
        };
      } catch (error) {
        throw normalizeOpenAIError(error, config.id, config.name);
      }
    },
  };
}

function normalizeOpenAIError(
  error: unknown,
  provider: ProviderId,
  name: string,
): LLMError {
  if (error instanceof LLMError) return error;
  const value = error as { status?: number; message?: string; name?: string };
  const message = value.message ?? String(error);
  if (
    value.name === "AbortError" ||
    message.toLowerCase().includes("aborted")
  ) {
    return new LLMError(
      `${name} Responses request aborted/timeout`,
      "timeout",
      provider,
      error,
    );
  }
  if (value.status !== undefined) {
    return classifyHttpError(value.status, provider, message, error);
  }
  if (
    message.toLowerCase().includes("network") ||
    message.toLowerCase().includes("fetch")
  ) {
    return new LLMError(
      `${name} network error: ${message}`,
      "network",
      provider,
      error,
    );
  }
  return new LLMError(
    `${name} Responses error: ${message}`,
    "provider_error",
    provider,
    error,
  );
}
