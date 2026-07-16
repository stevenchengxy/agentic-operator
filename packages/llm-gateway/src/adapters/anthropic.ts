/**
 * Anthropic adapter — uses the official @anthropic-ai/sdk. Notable contract
 * differences vs OpenAI:
 *   - System message is a top-level `system` param, not a role.
 *   - User/assistant must alternate; the SDK rejects malformed sequences.
 *   - finish_reason maps to `stop_reason`: "end_turn" | "max_tokens" | "tool_use" | "stop_sequence".
 */

import Anthropic from "@anthropic-ai/sdk";
import {
  flattenContentToText,
  type ChatMessage,
  type ChatRequest,
  type ChatResponse,
  type ProviderAdapter,
} from "../types";
import { LLMError, classifyHttpError } from "../errors";

const DEFAULT_MODEL = "claude-haiku-4-5";

type AnthropicReasoningWireParams = Pick<
  Anthropic.MessageCreateParamsNonStreaming,
  "thinking" | "output_config"
>;

function isModel(model: string, id: string): boolean {
  return model === id || model.startsWith(`${id}-`);
}

function badReasoningRequest(message: string): never {
  throw new LLMError(message, "bad_request", "anthropic");
}

/**
 * Convert provider-neutral reasoning controls into the Anthropic Messages API
 * shape. This stays pure so callers can validate an evaluation matrix without
 * dispatching a paid request.
 */
export function mapAnthropicRequestReasoning(
  model: string,
  reasoning: ChatRequest["reasoning"],
): AnthropicReasoningWireParams {
  if (!reasoning) return {};

  if (reasoning.mode !== undefined) {
    return badReasoningRequest(
      `Anthropic does not expose reasoning mode "${reasoning.mode}"`,
    );
  }
  if (reasoning.context !== undefined || reasoning.summary !== undefined) {
    return badReasoningRequest(
      `Anthropic does not expose normalized ${reasoning.context !== undefined ? "reasoning context" : "reasoning summaries"}`,
    );
  }

  const effort = reasoning.effort;
  if (!effort) return {};

  if (effort === "minimal") {
    return badReasoningRequest(
      'Anthropic does not support reasoning effort "minimal"; use "low" instead',
    );
  }

  const isFable5 = isModel(model, "claude-fable-5");
  const isMythos5 = isModel(model, "claude-mythos-5");
  const isMythosPreview = isModel(model, "claude-mythos-preview");
  const isAlwaysThinking = isFable5 || isMythos5 || isMythosPreview;
  const isSonnet5 = isModel(model, "claude-sonnet-5");
  const isOpus48 = isModel(model, "claude-opus-4-8");
  const isOpus47 = isModel(model, "claude-opus-4-7");
  const isOpus46 = isModel(model, "claude-opus-4-6");
  const isSonnet46 = isModel(model, "claude-sonnet-4-6");
  const supportsAdaptive =
    isAlwaysThinking || isSonnet5 || isOpus48 || isOpus47 || isOpus46 || isSonnet46;

  if (effort === "none") {
    if (isAlwaysThinking) {
      return badReasoningRequest(
        `Anthropic model "${model}" always uses adaptive thinking and cannot use reasoning effort "none"`,
      );
    }
    if (isSonnet5) return { thinking: { type: "disabled" } };
    if (supportsAdaptive) return {};
    return badReasoningRequest(
      `Anthropic reasoning effort "none" cannot be mapped safely for model "${model}"`,
    );
  }

  if (!supportsAdaptive) {
    return badReasoningRequest(
      `Anthropic adaptive reasoning is not supported for model "${model}"`,
    );
  }

  const supportsXhigh = isFable5 || isMythos5 || isSonnet5 || isOpus48 || isOpus47;
  if (effort === "xhigh" && !supportsXhigh) {
    return badReasoningRequest(
      `Anthropic reasoning effort "xhigh" is not supported for model "${model}"`,
    );
  }

  return {
    thinking: { type: "adaptive" },
    output_config: { effort },
  };
}

export interface AnthropicAdapterConfig {
  apiKey: string | undefined;
  defaultModel?: string;
}

type AnthropicReplayBlock =
  | Anthropic.TextBlockParam
  | Anthropic.ThinkingBlockParam
  | Anthropic.RedactedThinkingBlockParam
  | Anthropic.ToolUseBlockParam;

interface AnthropicReplayEnvelope {
  provider: "anthropic";
  version: 1;
  items: AnthropicReplayBlock[];
}

function encodeToolName(name: string): string {
  return name.replace(/\./g, "__");
}

function decodeToolName(name: string): string {
  return name.replace(/__/g, ".");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isReplayBlock(value: unknown): value is AnthropicReplayBlock {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  switch (value.type) {
    case "text":
      return typeof value.text === "string";
    case "thinking":
      return typeof value.thinking === "string" && typeof value.signature === "string";
    case "redacted_thinking":
      return typeof value.data === "string";
    case "tool_use":
      return typeof value.id === "string" && typeof value.name === "string" && "input" in value;
    default:
      return false;
  }
}

function parseAnthropicReplayState(reasoningContent: string | undefined): AnthropicReplayBlock[] | undefined {
  if (!reasoningContent) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(reasoningContent);
  } catch {
    // Opaque state from another provider may not use JSON. Ignore it during
    // cross-provider failover instead of leaking it onto Anthropic's wire.
    return undefined;
  }
  if (!isRecord(parsed) || parsed.provider !== "anthropic") return undefined;
  if (
    parsed.version !== 1 ||
    !Array.isArray(parsed.items) ||
    !parsed.items.every(isReplayBlock)
  ) {
    throw new LLMError(
      "Anthropic reasoning replay state is malformed",
      "bad_request",
      "anthropic",
    );
  }
  return parsed.items;
}

function serializeAnthropicReplayState(
  content: Anthropic.Message["content"],
): string | undefined {
  const hasThinking = content.some(
    (block) => block.type === "thinking" || block.type === "redacted_thinking",
  );
  if (!hasThinking) return undefined;
  const items = content.filter(
    (block): block is
      | Anthropic.TextBlock
      | Anthropic.ThinkingBlock
      | Anthropic.RedactedThinkingBlock
      | Anthropic.ToolUseBlock =>
      block.type === "text" ||
      block.type === "thinking" ||
      block.type === "redacted_thinking" ||
      block.type === "tool_use",
  ) as unknown as AnthropicReplayBlock[];
  const envelope: AnthropicReplayEnvelope = {
    provider: "anthropic",
    version: 1,
    items,
  };
  return JSON.stringify(envelope);
}

function mapMessageToAnthropic(message: ChatMessage): Anthropic.MessageParam {
  const role = message.role === "assistant" ? "assistant" : "user";
  if (message.role !== "assistant" && message.reasoningContent) {
    throw new LLMError(
      "Anthropic reasoning replay state is only valid on assistant messages",
      "bad_request",
      "anthropic",
    );
  }

  if (message.role === "assistant") {
    const replay = parseAnthropicReplayState(message.reasoningContent);
    if (replay) return { role, content: replay };
  }

  if (typeof message.content === "string") {
    return { role, content: message.content };
  }

  const content: Anthropic.ContentBlockParam[] = [];
  for (const block of message.content) {
    if (block.type === "text") {
      content.push({ type: "text", text: block.text });
    } else if (block.type === "tool_use") {
      if (message.role !== "assistant") {
        throw new LLMError(
          "Anthropic tool_use blocks require an assistant message",
          "bad_request",
          "anthropic",
        );
      }
      content.push({
        type: "tool_use",
        id: block.id,
        name: encodeToolName(block.name),
        input: block.input,
      });
    } else {
      if (message.role === "assistant") {
        throw new LLMError(
          "Anthropic tool_result blocks require a user/tool message",
          "bad_request",
          "anthropic",
        );
      }
      content.push({
        type: "tool_result",
        tool_use_id: block.tool_use_id,
        content: block.content,
        is_error: block.is_error,
      });
    }
  }
  return { role, content };
}

/** Pure message projector used by native Anthropic tool/reasoning loops. */
export function mapAnthropicMessages(messages: ChatMessage[]): {
  system: string | undefined;
  messages: Anthropic.MessageParam[];
} {
  const systemParts: string[] = [];
  const rest: Anthropic.MessageParam[] = [];
  for (const m of messages) {
    if (m.role === "system") systemParts.push(flattenContentToText(m.content));
    else rest.push(mapMessageToAnthropic(m));
  }
  return {
    system: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
    messages: rest,
  };
}

/** Pure tool-definition projector; empty lists stay omitted. */
export function mapAnthropicTools(
  tools: ChatRequest["tools"],
): Anthropic.Tool[] | undefined {
  if (!tools?.length) return undefined;
  return tools.map((tool) => ({
    name: encodeToolName(tool.name),
    description: tool.description,
    input_schema: tool.input_schema as Anthropic.Tool.InputSchema,
  }));
}

function mapStopReason(r: string | null | undefined): ChatResponse["finishReason"] {
  switch (r) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_calls";
    default:
      return "unknown";
  }
}

/** Build a native Anthropic request without dispatching it. */
export function mapAnthropicRequest(
  req: ChatRequest,
  model: string,
): Anthropic.MessageCreateParamsNonStreaming {
  const projected = mapAnthropicMessages(req.messages);
  const reasoningParams = mapAnthropicRequestReasoning(model, req.reasoning);

  if (req.verbosity !== undefined || req.store !== undefined) {
    throw new LLMError(
      `Anthropic does not expose normalized ${req.verbosity !== undefined ? "text verbosity" : "response storage"}`,
      "bad_request",
      "anthropic",
    );
  }
  if (projected.messages.length === 0) {
    throw new LLMError(
      "Anthropic requires at least one user message",
      "bad_request",
      "anthropic",
    );
  }

  return {
    model,
    max_tokens: req.maxTokens ?? 1024,
    temperature: req.temperature,
    stop_sequences: req.stop,
    system: projected.system,
    messages: projected.messages,
    tools: mapAnthropicTools(req.tools),
    ...reasoningParams,
  };
}

/** Normalize a native Anthropic response, including opaque replay state. */
export function mapAnthropicResponse(
  response: Anthropic.Message,
  reasoning: ChatRequest["reasoning"],
  latencyMs: number,
): ChatResponse {
  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");

  const toolCalls: NonNullable<ChatResponse["toolCalls"]> = [];
  for (const block of response.content) {
    if (block.type !== "tool_use") continue;
    toolCalls.push({
      id: block.id,
      name: decodeToolName(block.name),
      input: isRecord(block.input) ? block.input : {},
    });
  }

  const rawUsage = response.usage as unknown as Record<string, unknown>;
  const number = (record: Record<string, unknown> | undefined, key: string): number => {
    const value = record?.[key];
    return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
  };
  const creation = rawUsage.cache_creation as Record<string, unknown> | undefined;
  const outputDetails = rawUsage.output_tokens_details as Record<string, unknown> | undefined;
  const baseInput = number(rawUsage, "input_tokens");
  const cachedInput = number(rawUsage, "cache_read_input_tokens");
  const cacheWrite = number(rawUsage, "cache_creation_input_tokens");
  const outputTokens = number(rawUsage, "output_tokens");
  const inputTokens = baseInput + cachedInput + cacheWrite;
  const reasoningContent = toolCalls.length > 0
    ? serializeAnthropicReplayState(response.content)
    : undefined;

  return {
    text,
    provider: "anthropic",
    model: response.model,
    tokensIn: inputTokens,
    tokensOut: outputTokens,
    usage: {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      cachedInputTokens: cachedInput,
      cacheWriteInputTokens: cacheWrite,
      cacheWrite5mInputTokens: number(creation, "ephemeral_5m_input_tokens"),
      cacheWrite1hInputTokens: number(creation, "ephemeral_1h_input_tokens"),
      reasoningTokens: number(outputDetails, "thinking_tokens"),
      inputAudioTokens: 0,
      outputAudioTokens: 0,
      raw: response.usage,
    },
    providerRequestId: response.id,
    finishReason: toolCalls.length > 0 ? "tool_calls" : mapStopReason(response.stop_reason),
    latencyMs,
    reasoning,
    reasoningContent,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    raw: response,
  };
}

export function createAnthropicAdapter(config: AnthropicAdapterConfig): ProviderAdapter {
  const hasKey = Boolean(config.apiKey);
  const defaultModel = config.defaultModel ?? DEFAULT_MODEL;
  let client: Anthropic | null = null;

  function getClient(): Anthropic {
    if (!hasKey) {
      throw new LLMError(
        "Anthropic API key is not configured",
        "not_configured",
        "anthropic",
      );
    }
    if (!client) client = new Anthropic({ apiKey: config.apiKey! });
    return client;
  }

  return {
    id: "anthropic",
    name: "Anthropic",
    hasKey,
    defaultModel,

    async chat(req: ChatRequest): Promise<ChatResponse> {
      const start = Date.now();
      const c = getClient();
      const model = req.model ?? defaultModel;
      const params = mapAnthropicRequest(req, model);

      try {
        const response = await c.messages.create(
          params,
          {
            signal: req.signal,
          },
        );
        return mapAnthropicResponse(response, req.reasoning, Date.now() - start);
      } catch (err) {
        throw normalizeAnthropicError(err);
      }
    },
  };
}

function normalizeAnthropicError(err: unknown): LLMError {
  if (err instanceof LLMError) return err;
  const anyErr = err as { status?: number; message?: string; name?: string };
  if (anyErr.name === "AbortError" || (anyErr.message ?? "").toLowerCase().includes("aborted")) {
    return new LLMError("Anthropic request aborted/timeout", "timeout", "anthropic", err);
  }
  if (anyErr.status !== undefined) {
    return classifyHttpError(anyErr.status, "anthropic", anyErr.message ?? String(err), err);
  }
  return new LLMError(
    `Anthropic error: ${anyErr.message ?? String(err)}`,
    "provider_error",
    "anthropic",
    err,
  );
}
