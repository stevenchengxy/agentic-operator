/**
 * Public types for the LLM gateway. Imported by adapters, the gateway class,
 * and any caller that wants to build a ChatRequest.
 *
 * Wire-format equivalents (Zod schemas) for these types live in
 * @agentic/contracts so the frontend can parse responses without depending
 * on this package.
 */

import type { ProviderId } from "@agentic/contracts";

export type { ProviderId };

// ─── P1-CON-01 — Typed content blocks for multi-modal / tool-use ──────────
//
// Adapter wire formats converge on three block kinds:
//   - text       : plain assistant-side text segment
//   - tool_use   : assistant emits a tool-call request
//   - tool_result: tool side reports the call's outcome
//
// All adapters that don't yet support tool blocks treat `string` content as
// before; the agent-runtime emits typed arrays only when it actually needs
// to.
export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  /** JSON-encoded result body; the adapter is free to send as a string or structured object. */
  content: string;
  is_error?: boolean;
}

export type ChatContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export interface ChatMessage {
  /** `tool` is the SDK's role for tool-result messages (a/k/a the "user-side" of a tool call). */
  role: "system" | "user" | "assistant" | "tool";
  content: string | ChatContentBlock[];
}

/**
 * Adapter helper — flatten typed content blocks into plain text for adapters
 * that don't yet speak the structured block protocol. Tool-use blocks are
 * rendered as a JSON sentinel and tool-result blocks as their content body.
 * Legacy string contents pass through untouched.
 */
export function flattenContentToText(
  content: string | ChatContentBlock[],
): string {
  if (typeof content === "string") return content;
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text") parts.push(block.text);
    else if (block.type === "tool_use")
      parts.push(`[tool_use ${block.name} ${JSON.stringify(block.input)}]`);
    else if (block.type === "tool_result") parts.push(block.content);
  }
  return parts.join("\n");
}

// ─── P1-CON-02 — Tool definitions and structured tool calls ───────────────

export interface ToolDef {
  name: string;
  description?: string;
  /** JSON Schema for the tool's input shape. Validation is the agent's responsibility. */
  input_schema: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ChatRequest {
  /** G6 telemetry tag: who/why (e.g. "agent:reportGenerator", "step-engine:matchResume"). */
  purpose?: string;
  /** Conversation history. Must contain at least one user-role message. */
  messages: ChatMessage[];
  /** Provider-native model name. Falls back to gateway default. */
  model?: string;
  /** Single provider to use. Mutually exclusive with `providers` (the array wins). */
  provider?: ProviderId;
  /** Ordered fallback chain. Tries each until one returns or all fail with non-transient errors. */
  providers?: ProviderId[];
  temperature?: number;
  maxTokens?: number;
  stop?: string[];
  /** Default 60_000 ms. */
  timeoutMs?: number;
  /** Caller-controlled abort. Combined with timeoutMs via AbortSignal.any-like helper. */
  signal?: AbortSignal;
  /** Hint the model to return JSON. Each adapter maps this to its native flag. */
  jsonMode?: boolean;
  /** P1-CON-02 — advertised tools for tool-use models. */
  tools?: ToolDef[];
  /** P1-RT-06 — caller-provided tenantId for usage attribution (optional). */
  tenantId?: string;
  /** Durable run attribution for per-call usage. Runtime callers must pass
   * the runs.id they are executing; non-run calls intentionally omit it. */
  runId?: string;
  /** Alias of `tenantId` used by some legacy callers. */
  tenantSlug?: string;
}

export interface ChatResponse {
  text: string;
  provider: ProviderId;
  model: string;
  tokensIn: number | null;
  tokensOut: number | null;
  finishReason: "stop" | "length" | "tool_calls" | "error" | "unknown";
  latencyMs: number;
  /** P1-LLM-04 — structured tool calls emitted by the model on this turn. */
  toolCalls?: ToolCall[];
  /** Provider-specific extras (e.g. tool calls). Opaque in v1. */
  raw?: unknown;
}

export interface ProviderInfo {
  id: ProviderId;
  name: string;
  hasKey: boolean;
  defaultModel: string | null;
  models: string[];
}

/**
 * Adapter contract. Each concrete provider (anthropic, openai, …) ships an
 * adapter that conforms to this. Adapters never see the env directly — they
 * receive a typed config at construction time.
 */
export interface ProviderAdapter {
  readonly id: ProviderId;
  readonly name: string;
  readonly hasKey: boolean;
  readonly defaultModel: string | null;
  chat(req: ChatRequest): Promise<ChatResponse>;
}

export interface GatewayConfig {
  defaultProvider: ProviderId;
  defaultModel: string | null;
  timeoutMs: number;
  /**
   * Test-only escape hatch for the deterministic mock adapter. Secure by
   * default: hand-constructed production gateways that omit this flag cannot
   * route a request to `mock`, even when a caller supplies it explicitly.
   */
  allowMock?: boolean;
}
