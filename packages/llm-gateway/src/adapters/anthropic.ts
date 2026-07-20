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
  type ChatContentBlock,
  type ChatMessage,
  type ChatRequest,
  type ChatResponse,
  type ProviderAdapter,
  type ToolCall,
} from "../types";
import { LLMError, classifyHttpError } from "../errors";

const DEFAULT_MODEL = "claude-haiku-4-5";

export interface AnthropicAdapterConfig {
  apiKey: string | undefined;
  defaultModel?: string;
}

function partitionSystem(messages: ChatMessage[]): { system: string | undefined; rest: ChatMessage[] } {
  const systemParts: string[] = [];
  const rest: ChatMessage[] = [];
  for (const m of messages) {
    if (m.role === "system") systemParts.push(flattenContentToText(m.content));
    else rest.push(m);
  }
  return {
    system: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
    rest,
  };
}

function encodeToolName(name: string): string {
  return name.replace(/\./g, "__");
}

function decodeToolName(name: string): string {
  return name.replace(/__/g, ".");
}

function mapContentBlocks(
  role: ChatMessage["role"],
  content: ChatContentBlock[],
): Anthropic.Messages.ContentBlockParam[] {
  const out: Anthropic.Messages.ContentBlockParam[] = [];
  for (const block of content) {
    if (block.type === "text") {
      out.push({ type: "text", text: block.text });
    } else if (block.type === "tool_use" && role === "assistant") {
      out.push({
        type: "tool_use",
        id: block.id,
        name: encodeToolName(block.name),
        input: block.input,
      });
    } else if (block.type === "tool_result" && role === "tool") {
      out.push({
        type: "tool_result",
        tool_use_id: block.tool_use_id,
        content: block.content,
        is_error: block.is_error,
      });
    }
  }
  return out;
}

function mapMessages(messages: ChatMessage[]): Anthropic.Messages.MessageParam[] {
  const out: Anthropic.Messages.MessageParam[] = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    const role: "user" | "assistant" = message.role === "assistant" ? "assistant" : "user";
    const content = typeof message.content === "string"
      ? message.content
      : mapContentBlocks(message.role, message.content);
    out.push({ role, content });
  }
  return out;
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
      const { system, rest } = partitionSystem(req.messages);

      if (rest.length === 0) {
        throw new LLMError(
          "Anthropic requires at least one user message",
          "bad_request",
          "anthropic",
        );
      }

      try {
        const response = await c.messages.create(
          {
            model,
            max_tokens: req.maxTokens ?? 1024,
            temperature: req.temperature,
            stop_sequences: req.stop,
            system,
            messages: mapMessages(rest),
            ...(req.tools && req.tools.length > 0
              ? {
                  tools: req.tools.map((tool) => ({
                    name: encodeToolName(tool.name),
                    description: tool.description,
                    input_schema: {
                      type: "object" as const,
                      ...tool.input_schema,
                    },
                  })),
                }
              : {}),
          },
          {
            signal: req.signal,
          },
        );

        const textBlocks = response.content
          .filter((b): b is Anthropic.TextBlock => b.type === "text")
          .map((b) => b.text);
        const text = textBlocks.join("");
        const toolCalls: ToolCall[] = response.content
          .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
          .map((b) => ({
            id: b.id,
            name: decodeToolName(b.name),
            input:
              b.input && typeof b.input === "object" && !Array.isArray(b.input)
                ? (b.input as Record<string, unknown>)
                : { value: b.input },
          }));

        return {
          text,
          provider: "anthropic",
          model: response.model,
          tokensIn: response.usage.input_tokens,
          tokensOut: response.usage.output_tokens,
          finishReason: mapStopReason(response.stop_reason),
          latencyMs: Date.now() - start,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          raw: response,
        };
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
