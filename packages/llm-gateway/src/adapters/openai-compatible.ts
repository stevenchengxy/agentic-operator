/**
 * OpenAI-compatible adapter factory. Most providers expose a `/chat/completions`
 * endpoint with the OpenAI request/response shape; we use the `openai` SDK
 * with a custom baseURL to serve all of them through one implementation.
 *
 * Per-provider differences (extra headers, default models, model-prefix
 * conventions) are passed in as config from the provider wiring file.
 */

import OpenAI from "openai";
import type { ProviderId } from "@agentic/contracts";
import {
  flattenContentToText,
  type ChatRequest,
  type ChatResponse,
  type ProviderAdapter,
  type ToolCall,
  type ToolDef,
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
type OAIChatMsg =
  | { role: "system" | "user" | "assistant"; content: string }
  | {
      role: "assistant";
      content: string;
      tool_calls: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    }
  | { role: "tool"; tool_call_id: string; content: string };

function mapMessageToOpenAI(
  role: "system" | "user" | "assistant" | "tool",
  content: ChatRequest["messages"][number]["content"],
): OAIChatMsg[] {
  // Plain string content — legacy path.
  if (typeof content === "string") {
    if (role === "tool") {
      // String-typed tool messages don't carry a tool_call_id; fold to assistant text.
      return [{ role: "assistant", content }];
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
        { role: "assistant", content: proseText, tool_calls: toolCalls },
      ];
    }
    return [{ role: "assistant", content: proseText }];
  }

  // system / user with structured content — flatten to text.
  return [{ role, content: flattenContentToText(content) }];
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
  /** Fallback model when caller omits one. */
  defaultModel: string | null;
}

function mapFinishReason(reason: string | null | undefined): ChatResponse["finishReason"] {
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
        // upstream model sees a real tool-use loop instead of prose.
        const flatMessages = req.messages.flatMap((m) =>
          mapMessageToOpenAI(m.role, m.content),
        );
        const oaTools = mapToolsForRequest(req.tools);

        const completion = await c.chat.completions.create(
          {
            model,
            messages: flatMessages as Parameters<
              typeof c.chat.completions.create
            >[0]["messages"],
            temperature: req.temperature,
            max_tokens: req.maxTokens,
            stop: req.stop,
            ...(oaTools ? { tools: oaTools } : {}),
            ...(req.jsonMode ? { response_format: { type: "json_object" as const } } : {}),
          },
          {
            signal: req.signal,
          },
        );

        const choice = completion.choices[0];
        const text = choice?.message?.content ?? "";
        const usage = completion.usage;

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
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
              parsedInput = parsed as Record<string, unknown>;
            }
          } catch {
            throw new LLMError(
              `${config.name} returned invalid JSON arguments for tool '${c.function.name}'`,
              "provider_error",
              config.id,
            );
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
          finishReason: mapFinishReason(choice?.finish_reason),
          latencyMs: Date.now() - start,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          raw: completion,
        };
      } catch (err) {
        throw normalizeError(err, config.id, config.name);
      }
    },
  };
}

function normalizeError(err: unknown, provider: ProviderId, name: string): LLMError {
  if (err instanceof LLMError) return err;

  // openai SDK throws APIError subclasses with .status
  const anyErr = err as { status?: number; message?: string; name?: string };

  if (anyErr.name === "AbortError" || (anyErr.message ?? "").toLowerCase().includes("aborted")) {
    return new LLMError(`${name} request aborted/timeout`, "timeout", provider, err);
  }
  if (anyErr.status !== undefined) {
    return classifyHttpError(anyErr.status, provider, anyErr.message ?? String(err), err);
  }
  if ((anyErr.message ?? "").toLowerCase().includes("network") || (anyErr.message ?? "").toLowerCase().includes("fetch")) {
    return new LLMError(`${name} network error: ${anyErr.message}`, "network", provider, err);
  }
  return new LLMError(
    `${name} error: ${anyErr.message ?? String(err)}`,
    "provider_error",
    provider,
    err,
  );
}
