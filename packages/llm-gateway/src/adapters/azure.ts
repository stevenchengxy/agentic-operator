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
  type ChatContentBlock,
  type ChatRequest,
  type ChatResponse,
  type ProviderAdapter,
  type ToolCall,
  type ToolDef,
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

function encodeToolName(name: string): string {
  return name.replace(/\./g, "__");
}

function decodeToolName(name: string): string {
  return name.replace(/__/g, ".");
}

type AzureMessage =
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

function mapStructuredMessage(
  role: ChatRequest["messages"][number]["role"],
  content: ChatContentBlock[],
): AzureMessage[] {
  if (role === "tool") {
    return content
      .filter((block) => block.type === "tool_result")
      .map((block) => ({
        role: "tool" as const,
        tool_call_id: block.tool_use_id,
        content: block.content,
      }));
  }
  if (role === "assistant") {
    const text = content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
    const toolCalls = content
      .filter((block) => block.type === "tool_use")
      .map((block) => ({
        id: block.id,
        type: "function" as const,
        function: {
          name: encodeToolName(block.name),
          arguments: JSON.stringify(block.input),
        },
      }));
    return toolCalls.length > 0
      ? [{ role: "assistant", content: text, tool_calls: toolCalls }]
      : [{ role: "assistant", content: text }];
  }
  return [{ role, content: flattenContentToText(content) }];
}

function mapMessages(messages: ChatRequest["messages"]): AzureMessage[] {
  return messages.flatMap((message) =>
    typeof message.content === "string"
      ? [{
          role: message.role === "tool" ? "assistant" as const : message.role,
          content: message.content,
        }]
      : mapStructuredMessage(message.role, message.content),
  );
}

function mapTools(tools: ToolDef[] | undefined) {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: encodeToolName(tool.name),
      description: tool.description,
      parameters: tool.input_schema,
    },
  }));
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
            messages: mapMessages(req.messages) as Parameters<
              typeof c.chat.completions.create
            >[0]["messages"],
            temperature: req.temperature,
            max_tokens: req.maxTokens,
            stop: req.stop,
            ...(mapTools(req.tools) ? { tools: mapTools(req.tools) } : {}),
            ...(req.jsonMode ? { response_format: { type: "json_object" as const } } : {}),
          },
          {
            signal: req.signal,
          },
        );

        const choice = completion.choices[0];
        const text = choice?.message?.content ?? "";
        const usage = completion.usage;
        const toolCalls: ToolCall[] = [];
        for (const call of choice?.message?.tool_calls ?? []) {
          if (call.type !== "function") continue;
          let input: Record<string, unknown> = {};
          try {
            const value = JSON.parse(call.function.arguments) as unknown;
            if (value && typeof value === "object" && !Array.isArray(value)) {
              input = value as Record<string, unknown>;
            }
          } catch {
            throw new LLMError(
              `Azure OpenAI returned invalid JSON arguments for tool '${call.function.name}'`,
              "provider_error",
              "azure",
            );
          }
          toolCalls.push({
            id: call.id,
            name: decodeToolName(call.function.name),
            input,
          });
        }

        return {
          text,
          provider: "azure",
          model: deployment,
          tokensIn: usage?.prompt_tokens ?? null,
          tokensOut: usage?.completion_tokens ?? null,
          finishReason: mapFinishReason(choice?.finish_reason),
          latencyMs: Date.now() - start,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
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
