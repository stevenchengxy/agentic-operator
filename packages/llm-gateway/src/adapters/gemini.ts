/**
 * Google Gemini adapter — uses the current @google/genai SDK. Key shape differences:
 *   - System messages map to `systemInstruction`.
 *   - User/assistant alternate; the SDK uses role "user" | "model".
 *   - Token counts come from response.usageMetadata.
 */

import {
  GoogleGenAI,
  ThinkingLevel,
  type Content,
  type GenerateContentParameters,
  type GenerateContentResponse,
  type Part,
} from "@google/genai";
import {
  flattenContentToText,
  type ChatMessage,
  type ChatRequest,
  type ChatResponse,
  type ProviderAdapter,
} from "../types";
import { LLMError, classifyHttpError } from "../errors";

const DEFAULT_MODEL = "gemini-3.5-flash";

export interface GeminiAdapterConfig {
  apiKey: string | undefined;
  defaultModel?: string;
}

/** Map the normalized effort vocabulary to Gemini's thinking-level control. */
export function mapGeminiThinking(
  reasoning: ChatRequest["reasoning"],
): { thinkingLevel?: ThinkingLevel; includeThoughts?: boolean } | undefined {
  if (!reasoning) return undefined;
  if (reasoning.mode !== undefined) {
    throw new LLMError(
      `Gemini does not expose reasoning mode "${reasoning.mode}"; select a thinking effort instead`,
      "bad_request",
      "gemini",
    );
  }
  if (reasoning.context) {
    throw new LLMError(
      "Gemini does not expose reasoning-context persistence through generateContent",
      "bad_request",
      "gemini",
    );
  }
  if (reasoning.effort === "none" || reasoning.effort === "max" || reasoning.effort === "xhigh") {
    throw new LLMError(
      `Gemini does not support reasoning effort "${reasoning.effort}"; use minimal, low, medium, or high`,
      "bad_request",
      "gemini",
    );
  }
  if (
    reasoning.summary !== undefined &&
    reasoning.summary !== "none" &&
    reasoning.summary !== "auto"
  ) {
    throw new LLMError(
      `Gemini does not expose reasoning summary style "${reasoning.summary}"; use auto or none`,
      "bad_request",
      "gemini",
    );
  }
  const thinkingLevel = reasoning.effort === "minimal"
    ? ThinkingLevel.MINIMAL
    : reasoning.effort === "low"
      ? ThinkingLevel.LOW
      : reasoning.effort === "medium"
        ? ThinkingLevel.MEDIUM
        : reasoning.effort === "high"
          ? ThinkingLevel.HIGH
          : undefined;
  return {
    thinkingLevel,
    includeThoughts:
      reasoning.summary === undefined ? undefined : reasoning.summary !== "none",
  };
}

function parseToolResult(content: string, isError: boolean | undefined): Record<string, unknown> {
  let value: unknown = content;
  try {
    value = JSON.parse(content);
  } catch {
    // Non-JSON tool output is still valid; send it as a string value.
  }
  if (isError) return { error: value };
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return { output: value };
}

function partitionForGemini(messages: ChatMessage[]): {
  systemInstruction: string | undefined;
  contents: Content[];
} {
  const systemParts: string[] = [];
  const contents: Content[] = [];
  const toolNamesById = new Map<string, string>();
  for (const m of messages) {
    if (m.role === "system") {
      systemParts.push(flattenContentToText(m.content));
      continue;
    }

    const parts: Part[] = [];
    if (typeof m.content === "string") {
      parts.push({ text: m.content });
    } else {
      for (const block of m.content) {
        if (block.type === "text") {
          parts.push({ text: block.text });
        } else if (block.type === "tool_use") {
          toolNamesById.set(block.id, block.name);
          parts.push({
            functionCall: {
              id: block.id,
              name: block.name,
              args: block.input,
            },
          });
        } else {
          const name = toolNamesById.get(block.tool_use_id);
          if (!name) {
            throw new LLMError(
              `Gemini tool result "${block.tool_use_id}" has no preceding tool call`,
              "bad_request",
              "gemini",
            );
          }
          parts.push({
            functionResponse: {
              id: block.tool_use_id,
              name,
              response: parseToolResult(block.content, block.is_error),
            },
          });
        }
      }
    }
    contents.push({
      role: m.role === "assistant" ? "model" : "user",
      parts,
    });
  }
  return {
    systemInstruction: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
    contents,
  };
}

/** Build the exact @google/genai request without dispatching it. */
export function mapGeminiGenerateContentRequest(
  req: ChatRequest,
  model: string,
): GenerateContentParameters {
  const { systemInstruction, contents } = partitionForGemini(req.messages);
  const thinkingConfig = mapGeminiThinking(req.reasoning);

  if (req.verbosity !== undefined) {
    throw new LLMError(
      "Gemini does not expose the normalized text-verbosity control",
      "bad_request",
      "gemini",
    );
  }
  if (req.store !== undefined) {
    throw new LLMError(
      "Gemini generateContent does not expose response storage",
      "bad_request",
      "gemini",
    );
  }
  if (contents.length === 0) {
    throw new LLMError(
      "Gemini requires at least one user message",
      "bad_request",
      "gemini",
    );
  }

  const functionDeclarations = req.tools?.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parametersJsonSchema: tool.input_schema,
  }));

  return {
    model,
    contents,
    config: {
      systemInstruction,
      temperature: req.temperature,
      maxOutputTokens: req.maxTokens,
      stopSequences: req.stop,
      responseMimeType: req.jsonMode ? "application/json" : undefined,
      thinkingConfig,
      tools: functionDeclarations?.length ? [{ functionDeclarations }] : undefined,
      abortSignal: req.signal,
    },
  };
}

function mapFinishReason(r: string | undefined): ChatResponse["finishReason"] {
  switch (r) {
    case "STOP":
      return "stop";
    case "MAX_TOKENS":
      return "length";
    case "SAFETY":
    case "RECITATION":
      return "error";
    default:
      return r ? "unknown" : "stop";
  }
}

/** Normalize an @google/genai response into the gateway response contract. */
export function mapGeminiGenerateContentResponse(
  response: GenerateContentResponse,
  requestedModel: string,
  reasoning: ChatRequest["reasoning"],
  latencyMs: number,
): ChatResponse {
  const usage = response.usageMetadata;
  const usageRecord = usage as unknown as Record<string, unknown> | undefined;
  const usageNumber = (key: string): number => {
    const value = usageRecord?.[key];
    return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
  };
  const inputTokens = usageNumber("promptTokenCount");
  const candidateTokens = usageNumber("candidatesTokenCount");
  const reasoningTokens = usageNumber("thoughtsTokenCount");
  // Gemini reports generated thoughts separately from candidate text; both
  // categories are billable output.
  const outputTokens = candidateTokens + reasoningTokens;

  const toolCalls: NonNullable<ChatResponse["toolCalls"]> = [];
  for (const [index, call] of (response.functionCalls ?? []).entries()) {
    if (!call.name) {
      throw new LLMError(
        "Gemini returned a function call without a name",
        "provider_error",
        "gemini",
      );
    }
    toolCalls.push({
      id: call.id ?? `gemini-tool-${index + 1}`,
      name: call.name,
      input: call.args ?? {},
    });
  }

  const rawFinishReason = response.candidates?.[0]?.finishReason as string | undefined;
  const reasoningSummary = response.candidates?.[0]?.content?.parts
    ?.filter((part) => part.thought === true && typeof part.text === "string")
    .map((part) => part.text!)
    .join("\n\n");

  return {
    text: response.text ?? "",
    provider: "gemini",
    model: response.modelVersion ?? requestedModel,
    tokensIn: usage ? inputTokens : null,
    tokensOut: usage ? outputTokens : null,
    usage: usage ? {
      inputTokens,
      outputTokens,
      totalTokens: usageNumber("totalTokenCount") || inputTokens + outputTokens,
      cachedInputTokens: usageNumber("cachedContentTokenCount"),
      cacheWriteInputTokens: 0,
      cacheWrite5mInputTokens: 0,
      cacheWrite1hInputTokens: 0,
      reasoningTokens,
      inputAudioTokens: 0,
      outputAudioTokens: 0,
      raw: usage,
    } : undefined,
    finishReason: toolCalls.length > 0 ? "tool_calls" : mapFinishReason(rawFinishReason),
    latencyMs,
    providerRequestId: response.responseId,
    reasoning,
    reasoningSummary: reasoningSummary || undefined,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    raw: response,
  };
}

export function createGeminiAdapter(config: GeminiAdapterConfig): ProviderAdapter {
  const hasKey = Boolean(config.apiKey);
  const defaultModel = config.defaultModel ?? DEFAULT_MODEL;
  let client: GoogleGenAI | null = null;

  function getClient(): GoogleGenAI {
    if (!hasKey) {
      throw new LLMError("Google API key is not configured", "not_configured", "gemini");
    }
    if (!client) client = new GoogleGenAI({ apiKey: config.apiKey! });
    return client;
  }

  return {
    id: "gemini",
    name: "Google Gemini",
    hasKey,
    defaultModel,

    async chat(req: ChatRequest): Promise<ChatResponse> {
      const start = Date.now();
      const c = getClient();
      const model = req.model ?? defaultModel;
      const params = mapGeminiGenerateContentRequest(req, model);

      try {
        const response = await c.models.generateContent(params);
        return mapGeminiGenerateContentResponse(
          response,
          model,
          req.reasoning,
          Date.now() - start,
        );
      } catch (err) {
        throw normalizeGeminiError(err);
      }
    },
  };
}

function normalizeGeminiError(err: unknown): LLMError {
  if (err instanceof LLMError) return err;
  const anyErr = err as { status?: number; message?: string; name?: string };
  if (anyErr.name === "AbortError" || (anyErr.message ?? "").toLowerCase().includes("aborted")) {
    return new LLMError("Gemini request aborted/timeout", "timeout", "gemini", err);
  }
  if (anyErr.status !== undefined) {
    return classifyHttpError(anyErr.status, "gemini", anyErr.message ?? String(err), err);
  }
  const msg = (anyErr.message ?? "").toLowerCase();
  if (msg.includes("api key") || msg.includes("permission")) {
    return new LLMError(`Gemini auth: ${anyErr.message}`, "auth", "gemini", err);
  }
  return new LLMError(
    `Gemini error: ${anyErr.message ?? String(err)}`,
    "provider_error",
    "gemini",
    err,
  );
}
