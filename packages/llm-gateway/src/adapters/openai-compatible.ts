/**
 * OpenAI-compatible adapter factory. Most providers expose a `/chat/completions`
 * endpoint with the OpenAI request/response shape; we use the `openai` SDK
 * with a custom baseURL to serve all of them through one implementation.
 *
 * Per-provider differences (extra headers, default models, model-prefix
 * conventions) are passed in as config from the provider wiring file.
 */

import OpenAI, { type ClientOptions } from "openai";
import type { ProviderId } from "@agentic/contracts";
import {
  flattenContentToText,
  type ChatContentBlock,
  type ChatRequest,
  type ChatResponse,
  type ProviderAdapter,
  type ToolCall,
  type ToolDef,
  type ToolResultBlock,
  type ToolUseBlock,
} from "../types";
import { LLMError, classifyHttpError } from "../errors";

/**
 * Map a gateway-wide ChatMessage onto the OpenAI tool-aware message shape.
 *
 * Three cases the legacy `mapToOpenAIMessage` couldn't handle and now does:
 *
 *   1. Assistant turn carrying tool_use blocks — emitted by the model in
 *      the previous round of the tool-use loop. Mapped to `{ role:
 *      "assistant", content: <prose>, tool_calls: [{...}] }`.
 *   2. Tool role with tool_result blocks — our handler's reply to the
 *      model's tool_use. Mapped to N separate `{ role: "tool",
 *      tool_call_id, content }` messages (one per block; OpenAI requires
 *      a distinct message per tool_call_id).
 *   3. Plain string / text-only messages — unchanged from the legacy path.
 *
 * Returns an array so case 2 can fan out into multiple OpenAI messages.
 */
type OAIReasoningReplayFields = {
  reasoning_content?: string;
  reasoning_details?: unknown[];
};

type OAIChatMsg =
  | { role: "system" | "user"; content: string }
  | (OAIReasoningReplayFields & {
      role: "assistant";
      content: string;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    })
  | { role: "tool"; tool_call_id: string; content: string };

interface OpenRouterChatReasoningReplayEnvelope {
  provider: "openrouter";
  api: "chat";
  items: unknown[];
}

function isReasoningDetails(value: unknown): value is unknown[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        Boolean(item) &&
        typeof item === "object" &&
        !Array.isArray(item) &&
        typeof (item as { type?: unknown }).type === "string" &&
        (item as { type: string }).type.startsWith("reasoning."),
    )
  );
}

function reasoningReplayFields(
  serialized: string | undefined,
  provider: ProviderId | undefined,
): OAIReasoningReplayFields {
  if (!serialized) return {};
  if (provider !== "openrouter") {
    return { reasoning_content: serialized };
  }

  try {
    const parsed = JSON.parse(serialized) as Record<string, unknown>;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      if (
        parsed.provider === "openrouter" &&
        parsed.api === "chat" &&
        isReasoningDetails(parsed.items)
      ) {
        return { reasoning_details: parsed.items };
      }

      // Never send an internal envelope for another transport as plaintext
      // reasoning. The Responses adapter owns its item-based replay format.
      if ("provider" in parsed || "api" in parsed) return {};
    }
  } catch {
    // Plaintext reasoning is intentionally not JSON and uses the alias below.
  }

  return { reasoning_content: serialized };
}

/**
 * Capture OpenRouter Chat reasoning for opaque replay. Structured details win
 * over plaintext because encrypted/signed blocks must be returned unchanged.
 */
export function extractOpenAICompatibleReasoningContent(
  message: unknown,
  provider: ProviderId,
): string | undefined {
  const record =
    message && typeof message === "object"
      ? (message as Record<string, unknown>)
      : undefined;

  if (provider === "openrouter") {
    const details = record?.reasoning_details;
    if (isReasoningDetails(details) && details.length > 0) {
      return JSON.stringify({
        provider: "openrouter",
        api: "chat",
        items: details,
      } satisfies OpenRouterChatReasoningReplayEnvelope);
    }

    const raw = record?.reasoning ?? record?.reasoning_content;
    return typeof raw === "string" && raw.length > 0 ? raw : undefined;
  }

  const raw = record?.reasoning_content;
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

function mapMessageToOpenAI(
  role: "system" | "user" | "assistant" | "tool",
  content: ChatRequest["messages"][number]["content"],
  reasoningContent?: string,
  provider?: ProviderId,
): OAIChatMsg[] {
  // Plain string content — legacy path.
  if (typeof content === "string") {
    if (role === "tool") {
      // String-typed tool messages don't carry a tool_call_id; fold to assistant text.
      return [{ role: "assistant", content }];
    }
    if (role === "assistant") {
      return [
        {
          role,
          content,
          ...reasoningReplayFields(reasoningContent, provider),
        },
      ];
    }
    return [{ role, content }];
  }

  // Array of structured blocks.
  if (role === "tool") {
    const out: OAIChatMsg[] = [];
    for (const block of content) {
      if (block.type === "tool_result") {
        out.push({
          role: "tool",
          tool_call_id: block.tool_use_id,
          content:
            typeof block.content === "string"
              ? block.content
              : JSON.stringify(block.content),
        });
      } else if (block.type === "text") {
        // Stray text in a tool message — emit as assistant text so nothing is dropped.
        out.push({ role: "assistant", content: block.text });
      }
    }
    return out;
  }

  if (role === "assistant") {
    let proseText = "";
    const toolCalls: Array<{
      id: string;
      type: "function";
      function: { name: string; arguments: string };
    }> = [];
    for (const block of content) {
      if (block.type === "text") proseText += block.text;
      else if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id,
          type: "function",
          function: {
            // Same dot→__ encoding so the wire echo back to the provider
            // matches what we originally advertised.
            name: encodeToolName(block.name),
            arguments: JSON.stringify(block.input ?? {}),
          },
        });
      }
    }
    if (toolCalls.length > 0) {
      return [
        {
          role: "assistant",
          content: proseText,
          ...reasoningReplayFields(reasoningContent, provider),
          tool_calls: toolCalls,
        },
      ];
    }
    return [
      {
        role: "assistant",
        content: proseText,
        ...reasoningReplayFields(reasoningContent, provider),
      },
    ];
  }

  // system / user with structured content — flatten to text.
  return [{ role, content: flattenContentToText(content) }];
}

/** Pure projector exposed for provider tool-loop compatibility tests. */
export function mapOpenAICompatibleMessages(
  messages: ChatRequest["messages"],
  provider?: ProviderId,
): unknown[] {
  return messages.flatMap((message) =>
    mapMessageToOpenAI(
      message.role,
      message.content,
      message.reasoningContent,
      provider,
    ),
  );
}

/**
 * Convert the gateway's ToolDef[] into OpenAI's `tools` request shape.
 * Returns undefined when the caller didn't advertise any tools so the
 * adapter doesn't send an empty array (some providers 400 on `tools: []`).
 *
 * **Name sanitization.** OpenAI + Anthropic (incl. via OpenRouter) reject
 * function names containing `.`. Internal callers use dot-qualified names
 * (e.g. `skills.list_skills`, `robohire-mcp.search_candidates`) so two
 * registries can't shadow each other. We encode the dot as `__` for the
 * wire and decode in the opposite direction when reading tool_calls back.
 */
function encodeToolName(internal: string): string {
  return internal.replace(/\./g, "__");
}
function decodeToolName(wire: string): string {
  return wire.replace(/__/g, ".");
}

function mapToolsForRequest(tools: ToolDef[] | undefined):
  | Array<{
      type: "function";
      function: {
        name: string;
        description?: string;
        parameters: Record<string, unknown>;
      };
    }>
  | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: encodeToolName(t.name),
      description: t.description,
      // OpenAI's strict schema validator rejects bare `{ type: "object",
      // additionalProperties: true }` for some providers; an empty
      // `properties: {}` keeps every backend (including Anthropic via
      // OpenRouter) happy while still allowing arbitrary args.
      parameters: (t.input_schema ?? {
        type: "object",
        properties: {},
        additionalProperties: true,
      }) as Record<string, unknown>,
    },
  }));
}

export interface OpenAICompatibleConfig {
  id: ProviderId;
  name: string;
  baseURL: string;
  apiKey: string | undefined;
  /** Extra HTTP headers attached to every request (e.g. OpenRouter analytics). */
  extraHeaders?: Record<string, string>;
  /** Custom transport hook supported by the official OpenAI SDK. */
  fetch?: ClientOptions["fetch"];
  /** Fallback model when caller omits one. */
  defaultModel: string | null;
  /** New OpenAI reasoning models use max_completion_tokens. */
  maxTokensParam?: "max_tokens" | "max_completion_tokens";
  /** Provider-specific wire mapping for the normalized reasoning controls. */
  reasoningDialect?:
    | "openai-chat"
    | "openrouter"
    | "deepseek"
    | "moonshot"
    | "zai"
    | "unsupported";
}

function isKimiK3Model(model: string): boolean {
  return model === "kimi-k3" || model.endsWith("/kimi-k3");
}

function isGlm52Model(model: string): boolean {
  return model === "glm-5.2" || model.endsWith("/glm-5.2");
}

/**
 * Translate normalized reasoning controls into an OpenAI-compatible request
 * body. Compatibility at the HTTP-shape level does not imply parameter
 * compatibility, so every provider opts into an explicit dialect.
 */
export function mapOpenAICompatibleReasoning(
  dialect: OpenAICompatibleConfig["reasoningDialect"],
  req: Pick<ChatRequest, "reasoning" | "verbosity" | "store" | "tools">,
  provider: ProviderId,
  model: string,
): Record<string, unknown> {
  if (req.verbosity !== undefined || req.store !== undefined) {
    const control =
      req.verbosity !== undefined ? "text verbosity" : "response storage";
    throw new LLMError(
      `${provider}/${model} does not expose normalized ${control} through Chat Completions`,
      "bad_request",
      provider,
    );
  }
  const reasoning = req.reasoning;
  if (!reasoning) {
    if (
      dialect === "moonshot" &&
      model.startsWith("kimi-k2.6") &&
      req.tools?.length
    ) {
      return { thinking: { type: "enabled", keep: "all" } };
    }
    if (dialect === "zai" && req.tools?.length) {
      return { thinking: { type: "enabled", clear_thinking: false } };
    }
    return {};
  }

  if (reasoning.mode !== undefined) {
    throw new LLMError(
      `${provider}/${model} does not accept reasoning mode on Chat Completions`,
      "bad_request",
      provider,
    );
  }
  if (reasoning.context !== undefined || reasoning.summary !== undefined) {
    const control =
      reasoning.context !== undefined
        ? "reasoning context"
        : "reasoning summary";
    throw new LLMError(
      `${provider}/${model} does not expose ${control} through Chat Completions`,
      "bad_request",
      provider,
    );
  }

  if (!reasoning.effort) return {};

  if (dialect === "openai-chat") {
    return { reasoning_effort: reasoning.effort };
  }

  if (dialect === "openrouter") {
    return { reasoning: { effort: reasoning.effort } };
  }

  if (dialect === "deepseek") {
    if (reasoning.effort === "none") {
      return { thinking: { type: "disabled" } };
    }
    if (reasoning.effort === "minimal") {
      throw new LLMError(
        `DeepSeek ${model} does not support minimal reasoning effort`,
        "bad_request",
        provider,
      );
    }
    const effort =
      reasoning.effort === "xhigh" || reasoning.effort === "max"
        ? "max"
        : "high";
    return {
      thinking: { type: "enabled" },
      reasoning_effort: effort,
    };
  }

  if (dialect === "moonshot") {
    if (isKimiK3Model(model)) {
      if (reasoning.effort === "max") {
        return { reasoning_effort: "max" };
      }
      throw new LLMError(
        `Kimi K3 supports only reasoning.effort=max; omit the control to use its provider default`,
        "bad_request",
        provider,
      );
    }
    if (model.startsWith("kimi-k2.6") && reasoning.effort === "none") {
      return { thinking: { type: "disabled" } };
    }
    const detail = model.startsWith("kimi-k2.7")
      ? "Kimi K2.7 has mandatory thinking and no effort selector"
      : "Moonshot exposes only an on/off thinking control, not effort levels";
    throw new LLMError(
      `${detail}; omit reasoning.effort${model.startsWith("kimi-k2.6") ? ' or use "none" to disable K2.6 thinking' : ""}`,
      "bad_request",
      provider,
    );
  }

  if (dialect === "zai") {
    if (reasoning.effort === "none") {
      return { thinking: { type: "disabled" } };
    }
    if (isGlm52Model(model)) {
      if (reasoning.effort === "high" || reasoning.effort === "max") {
        return {
          thinking: { type: "enabled" },
          reasoning_effort: reasoning.effort,
        };
      }
      throw new LLMError(
        `Z.AI ${model} supports only reasoning.effort=high, max, or none`,
        "bad_request",
        provider,
      );
    }
    throw new LLMError(
      `Z.AI ${model} exposes thinking on/off but no native effort level; omit reasoning.effort or use "none" to disable thinking`,
      "bad_request",
      provider,
    );
  }

  throw new LLMError(
    `${provider}/${model} does not expose a normalized reasoning-effort control`,
    "bad_request",
    provider,
  );
}

/**
 * Build the provider wire request as a pure operation so model-specific
 * compatibility rules remain testable without issuing a network request.
 *
 * Kimi K3 is deliberately special-cased here instead of in the Moonshot
 * provider registration: its API accepts `max_completion_tokens` and has
 * fixed sampling defaults, while older Kimi models on the same endpoint use
 * the conventional OpenAI-compatible request fields.
 */
export function buildOpenAICompatibleRequest(
  config: Pick<
    OpenAICompatibleConfig,
    "id" | "reasoningDialect" | "maxTokensParam"
  >,
  req: ChatRequest,
  model: string,
): OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming {
  const flatMessages = mapOpenAICompatibleMessages(req.messages, config.id);
  const oaTools = mapToolsForRequest(req.tools);
  const reasoning = mapOpenAICompatibleReasoning(
    config.reasoningDialect,
    req,
    config.id,
    model,
  );
  const kimiK3 = config.reasoningDialect === "moonshot" && isKimiK3Model(model);
  const useMaxCompletionTokens =
    kimiK3 || config.maxTokensParam === "max_completion_tokens";

  return {
    model,
    stream: false,
    messages:
      flatMessages as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
    // Kimi K3 fixes temperature=1 and top_p=.95. Omitting sampling fields is
    // the only safe provider-default behavior; sending any caller value can
    // produce a 400 or accidentally diverge from the documented contract.
    ...(!kimiK3 && req.temperature !== undefined
      ? { temperature: req.temperature }
      : {}),
    ...(req.maxTokens !== undefined
      ? useMaxCompletionTokens
        ? { max_completion_tokens: req.maxTokens }
        : { max_tokens: req.maxTokens }
      : {}),
    ...(req.stop !== undefined ? { stop: req.stop } : {}),
    ...(oaTools ? { tools: oaTools } : {}),
    ...(req.jsonMode
      ? { response_format: { type: "json_object" as const } }
      : {}),
    ...reasoning,
  };
}

// Legacy single-string projector retained for non-tool-aware callers — the
// new code path uses `mapMessageToOpenAI` (above) which preserves tool_use
// + tool_result block shape end-to-end. This helper is kept only because a
// handful of internal call sites in this package still pass plain prose.
function mapToOpenAIMessage(
  role: "system" | "user" | "assistant" | "tool",
  content: ChatRequest["messages"][number]["content"],
): { role: "system" | "user" | "assistant"; content: string } {
  const text = flattenContentToText(content);
  const projectedRole: "system" | "user" | "assistant" =
    role === "tool" ? "assistant" : role;
  return { role: projectedRole, content: text };
}
void mapToOpenAIMessage;
void ([] as ChatContentBlock[]);
void ([] as ToolUseBlock[]);
void ([] as ToolResultBlock[]);

function mapFinishReason(
  reason: string | null | undefined,
): ChatResponse["finishReason"] {
  switch (reason) {
    case "stop":
    case "length":
    case "tool_calls":
      return reason;
    case null:
    case undefined:
      return "unknown";
    default:
      return "unknown";
  }
}

function usageNumber(
  record: Record<string, unknown> | undefined,
  key: string,
): number {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, value)
    : 0;
}

function usageDecimal(
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

export function createOpenAICompatibleAdapter(
  config: OpenAICompatibleConfig,
): ProviderAdapter {
  const hasKey = Boolean(config.apiKey);
  // Lazy-init: only create the SDK client when first used so providers
  // without keys cost nothing.
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

    async chat(req: ChatRequest): Promise<ChatResponse> {
      const start = Date.now();
      const c = getClient();
      const model = req.model ?? config.defaultModel ?? null;
      if (!model) {
        throw new LLMError(
          `${config.name}: no model specified and no default configured`,
          "bad_request",
          config.id,
        );
      }

      try {
        // Fan out structured messages into the OpenAI shape, preserving
        // tool_use → tool_calls and tool_result → role:"tool" so the
        // upstream model sees a real tool-use loop instead of prose. The pure
        // builder also owns model-specific parameter compatibility.
        const params = buildOpenAICompatibleRequest(config, req, model);
        const completion = await c.chat.completions.create(params, {
          signal: req.signal,
        });

        const choice = completion.choices[0];
        const text = choice?.message?.content ?? "";
        const reasoningContent = extractOpenAICompatibleReasoningContent(
          choice?.message,
          config.id,
        );
        const usage = completion.usage;
        const usageRecord = usage as unknown as
          | Record<string, unknown>
          | undefined;
        const promptDetails = usageRecord?.prompt_tokens_details as
          | Record<string, unknown>
          | undefined;
        const completionDetails = usageRecord?.completion_tokens_details as
          | Record<string, unknown>
          | undefined;
        const inputTokens = usageNumber(usageRecord, "prompt_tokens");
        const outputTokens = usageNumber(usageRecord, "completion_tokens");
        const cachedInputTokens = Math.max(
          usageNumber(promptDetails, "cached_tokens"),
          usageNumber(usageRecord, "prompt_cache_hit_tokens"),
        );
        const cacheWriteInputTokens = usageNumber(
          promptDetails,
          "cache_write_tokens",
        );
        const providerCostUsd = usageDecimal(usageRecord, "cost");

        // Parse tool_calls back into the gateway's typed ToolCall[] so the
        // step engine's tool-use loop can dispatch them. The OpenAI SDK
        // delivers `function.arguments` as a JSON-encoded string; we parse
        // here so callers get structured input. A parse failure surfaces as
        // an empty-object input — better than crashing the whole turn.
        const rawCalls = choice?.message?.tool_calls ?? [];
        const toolCalls: ToolCall[] = [];
        for (const c of rawCalls) {
          if (c.type !== "function") continue;
          let parsedInput: Record<string, unknown> = {};
          try {
            const argsRaw = c.function.arguments;
            const parsed = argsRaw ? JSON.parse(argsRaw) : {};
            if (
              parsed &&
              typeof parsed === "object" &&
              !Array.isArray(parsed)
            ) {
              parsedInput = parsed as Record<string, unknown>;
            }
          } catch {
            // Leave parsedInput empty; the tool handler will surface a clear
            // validation error if it expected fields.
          }
          toolCalls.push({
            id: c.id,
            // Decode the wire `__` back into the internal dot-qualified
            // tool name so the step engine's lookup matches the
            // `tenantRegistry.tools[name]` key.
            name: decodeToolName(c.function.name),
            input: parsedInput,
          });
        }

        return {
          text,
          provider: config.id,
          model: completion.model ?? model,
          tokensIn: usage?.prompt_tokens ?? null,
          tokensOut: usage?.completion_tokens ?? null,
          usage: usage
            ? {
                inputTokens,
                outputTokens,
                totalTokens:
                  usageNumber(usageRecord, "total_tokens") ||
                  inputTokens + outputTokens,
                cachedInputTokens,
                cacheWriteInputTokens,
                cacheWrite5mInputTokens: usageNumber(
                  promptDetails,
                  "cache_write_tokens_5m",
                ),
                cacheWrite1hInputTokens: usageNumber(
                  promptDetails,
                  "cache_write_tokens_1h",
                ),
                reasoningTokens: Math.max(
                  usageNumber(completionDetails, "reasoning_tokens"),
                  usageNumber(usageRecord, "reasoning_tokens"),
                ),
                inputAudioTokens: usageNumber(promptDetails, "audio_tokens"),
                outputAudioTokens: usageNumber(
                  completionDetails,
                  "audio_tokens",
                ),
                raw: usage,
              }
            : undefined,
          providerReportedCostUsd: providerCostUsd,
          providerRequestId: completion.id,
          finishReason: mapFinishReason(choice?.finish_reason),
          latencyMs: Date.now() - start,
          reasoning: req.reasoning,
          verbosity: req.verbosity,
          reasoningContent,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          raw: completion,
        };
      } catch (err) {
        throw normalizeError(err, config.id, config.name);
      }
    },
  };
}

function normalizeError(
  err: unknown,
  provider: ProviderId,
  name: string,
): LLMError {
  if (err instanceof LLMError) return err;

  // openai SDK throws APIError subclasses with .status
  const anyErr = err as { status?: number; message?: string; name?: string };

  if (
    anyErr.name === "AbortError" ||
    (anyErr.message ?? "").toLowerCase().includes("aborted")
  ) {
    return new LLMError(
      `${name} request aborted/timeout`,
      "timeout",
      provider,
      err,
    );
  }
  if (anyErr.status !== undefined) {
    return classifyHttpError(
      anyErr.status,
      provider,
      anyErr.message ?? String(err),
      err,
    );
  }
  if (
    (anyErr.message ?? "").toLowerCase().includes("network") ||
    (anyErr.message ?? "").toLowerCase().includes("fetch")
  ) {
    return new LLMError(
      `${name} network error: ${anyErr.message}`,
      "network",
      provider,
      err,
    );
  }
  return new LLMError(
    `${name} error: ${anyErr.message ?? String(err)}`,
    "provider_error",
    provider,
    err,
  );
}
