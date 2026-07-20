/**
 * Google Gemini adapter — uses @google/generative-ai. Key shape differences:
 *   - System messages map to `systemInstruction`.
 *   - User/assistant alternate; the SDK uses role "user" | "model".
 *   - Token counts come from response.usageMetadata.
 */

import {
  GoogleGenerativeAI,
  SchemaType,
  type Content,
  type FunctionDeclarationSchema,
  type Part,
  type Tool,
} from "@google/generative-ai";
import { randomUUID } from "node:crypto";
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

const DEFAULT_MODEL = "gemini-2.5-flash";

export interface GeminiAdapterConfig {
  apiKey: string | undefined;
  defaultModel?: string;
}

function encodeToolName(name: string): string {
  return name.replace(/\./g, "__");
}

function decodeToolName(name: string): string {
  return name.replace(/__/g, ".");
}

function parseToolResult(content: string, isError: boolean | undefined): object {
  try {
    const value = JSON.parse(content) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return isError ? { error: value } : value;
    }
    return isError ? { error: value } : { result: value };
  } catch {
    return isError ? { error: content } : { result: content };
  }
}

function mapGeminiParts(
  role: ChatMessage["role"],
  blocks: ChatContentBlock[],
  toolNames: Map<string, string>,
): Part[] {
  const parts: Part[] = [];
  for (const block of blocks) {
    if (block.type === "text") parts.push({ text: block.text });
    else if (block.type === "tool_use" && role === "assistant") {
      toolNames.set(block.id, block.name);
      parts.push({
        functionCall: {
          name: encodeToolName(block.name),
          args: block.input,
        },
      });
    } else if (block.type === "tool_result" && role === "tool") {
      const name = toolNames.get(block.tool_use_id);
      if (!name) {
        throw new LLMError(
          `Gemini tool_result references unknown id '${block.tool_use_id}'`,
          "bad_request",
          "gemini",
        );
      }
      parts.push({
        functionResponse: {
          name: encodeToolName(name),
          response: parseToolResult(block.content, block.is_error),
        },
      });
    }
  }
  return parts;
}

function partitionForGemini(messages: ChatMessage[]): {
  systemInstruction: string | undefined;
  contents: Content[];
} {
  const systemParts: string[] = [];
  const contents: Content[] = [];
  const toolNames = new Map<string, string>();
  for (const m of messages) {
    if (m.role === "system") {
      systemParts.push(flattenContentToText(m.content));
    } else {
      contents.push({
        role: m.role === "assistant" ? "model" : "user",
        parts:
          typeof m.content === "string"
            ? [{ text: m.content }]
            : mapGeminiParts(m.role, m.content, toolNames),
      });
    }
  }
  return {
    systemInstruction: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
    contents,
  };
}

function schemaType(value: unknown): SchemaType {
  switch (String(value ?? "object").toLowerCase()) {
    case "string": return SchemaType.STRING;
    case "number": return SchemaType.NUMBER;
    case "integer": return SchemaType.INTEGER;
    case "boolean": return SchemaType.BOOLEAN;
    case "array": return SchemaType.ARRAY;
    default: return SchemaType.OBJECT;
  }
}

function toGeminiSchema(value: unknown): FunctionDeclarationSchema {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
  const propertiesSource = source.properties && typeof source.properties === "object" && !Array.isArray(source.properties)
    ? (source.properties as Record<string, unknown>)
    : {};
  const properties: FunctionDeclarationSchema["properties"] = {};
  for (const [key, child] of Object.entries(propertiesSource)) {
    const c = child && typeof child === "object" && !Array.isArray(child)
      ? (child as Record<string, unknown>)
      : {};
    properties[key] = {
      type: schemaType(c.type),
      ...(typeof c.description === "string" ? { description: c.description } : {}),
      ...(Array.isArray(c.enum) ? { enum: c.enum.map(String) } : {}),
    };
  }
  return {
    type: SchemaType.OBJECT,
    properties,
    ...(Array.isArray(source.required) ? { required: source.required.map(String) } : {}),
  };
}

function mapTools(tools: ChatRequest["tools"]): Tool[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return [{
    functionDeclarations: tools.map((tool) => ({
      name: encodeToolName(tool.name),
      description: tool.description,
      parameters: toGeminiSchema(tool.input_schema),
    })),
  }];
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

export function createGeminiAdapter(config: GeminiAdapterConfig): ProviderAdapter {
  const hasKey = Boolean(config.apiKey);
  const defaultModel = config.defaultModel ?? DEFAULT_MODEL;
  let client: GoogleGenerativeAI | null = null;

  function getClient(): GoogleGenerativeAI {
    if (!hasKey) {
      throw new LLMError("Google API key is not configured", "not_configured", "gemini");
    }
    if (!client) client = new GoogleGenerativeAI(config.apiKey!);
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
      const { systemInstruction, contents } = partitionForGemini(req.messages);

      if (contents.length === 0) {
        throw new LLMError(
          "Gemini requires at least one user message",
          "bad_request",
          "gemini",
        );
      }

      try {
        const m = c.getGenerativeModel({
          model,
          systemInstruction,
          generationConfig: {
            temperature: req.temperature,
            maxOutputTokens: req.maxTokens,
            stopSequences: req.stop,
            responseMimeType: req.jsonMode ? "application/json" : undefined,
          },
          tools: mapTools(req.tools),
        });
        const result = await m.generateContent({ contents }, { signal: req.signal });
        const response = result.response;
        const responseParts = response.candidates?.[0]?.content?.parts ?? [];
        const text = responseParts
          .filter((part): part is Extract<Part, { text: string }> => typeof part.text === "string")
          .map((part) => part.text)
          .join("");
        const toolCalls: ToolCall[] = responseParts
          .filter((part): part is Extract<Part, { functionCall: object }> => !!part.functionCall)
          .map((part) => ({
            id: `gemini_${randomUUID()}`,
            name: decodeToolName(part.functionCall.name),
            input: part.functionCall.args as Record<string, unknown>,
          }));
        const usage = response.usageMetadata;
        const finishReason = response.candidates?.[0]?.finishReason as string | undefined;

        return {
          text,
          provider: "gemini",
          model,
          tokensIn: usage?.promptTokenCount ?? null,
          tokensOut: usage?.candidatesTokenCount ?? null,
          finishReason: mapFinishReason(finishReason),
          latencyMs: Date.now() - start,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          raw: response,
        };
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
