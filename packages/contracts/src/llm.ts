/**
 * API contracts for /v1/llm/* and /v1/agents/:name/invoke endpoints.
 *
 * The actual LLM gateway types live in @agentic/llm-gateway. These schemas
 * are the wire format the frontend and any external API consumer parses
 * against — kept here so both apps/api (server) and apps/web (client) reach
 * the same source of truth.
 */

import { z } from "zod";
import { PROVIDER_IDS } from "./providers";

export const ProviderIdSchema = z.enum(PROVIDER_IDS);

// P1-CON-01 — typed content blocks for multi-modal and tool-use.
// `tool` is the SDK's role for tool-result messages (matches Anthropic's
// `user` containing tool_result blocks; we keep it as a distinct role for
// easier authoring).
export const ChatRoleSchema = z.enum(["system", "user", "assistant", "tool"]);

export const TextBlockSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});

export const ToolUseBlockSchema = z.object({
  type: z.literal("tool_use"),
  id: z.string(),
  name: z.string(),
  input: z.record(z.string(), z.unknown()),
});

export const ToolResultBlockSchema = z.object({
  type: z.literal("tool_result"),
  tool_use_id: z.string(),
  content: z.string(),
  is_error: z.boolean().optional(),
});

export const ChatContentBlockSchema = z.union([
  TextBlockSchema,
  ToolUseBlockSchema,
  ToolResultBlockSchema,
]);

export const ChatMessageSchema = z.object({
  role: ChatRoleSchema,
  content: z.union([z.string(), z.array(ChatContentBlockSchema)]),
});

// P1-CON-02 — Tool advertisements + structured tool calls.
export const ToolDefSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  input_schema: z.record(z.string(), z.unknown()),
});

export const ToolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  input: z.record(z.string(), z.unknown()),
});

export type ChatRoleDTO = z.infer<typeof ChatRoleSchema>;
export type TextBlockDTO = z.infer<typeof TextBlockSchema>;
export type ToolUseBlockDTO = z.infer<typeof ToolUseBlockSchema>;
export type ToolResultBlockDTO = z.infer<typeof ToolResultBlockSchema>;
export type ChatContentBlockDTO = z.infer<typeof ChatContentBlockSchema>;
export type ChatMessageDTO = z.infer<typeof ChatMessageSchema>;
export type ToolDefDTO = z.infer<typeof ToolDefSchema>;
export type ToolCallDTO = z.infer<typeof ToolCallSchema>;

export const ProviderInfoSchema = z.object({
  id: ProviderIdSchema,
  name: z.string(),
  hasKey: z.boolean(),
  defaultModel: z.string().nullable(),
  models: z.array(z.string()),
});

export type ProviderInfoDTO = z.infer<typeof ProviderInfoSchema>;

// ─── POST /v1/agents/:name/invoke ───────────────────────────────────────────

export const InvokeAgentBody = z.object({
  input: z.unknown().optional(),
  provider: ProviderIdSchema.optional(),
  model: z.string().optional(),
  async: z.boolean().optional().default(false),
});
export type InvokeAgentBody = z.infer<typeof InvokeAgentBody>;

export const InvokeAgentResponse = z.object({
  runId: z.string(),
  status: z.enum(["ok", "failed", "queued"]),
  output: z.unknown().optional(),
  provider: ProviderIdSchema.optional(),
  model: z.string().optional(),
  tokensIn: z.number().nullable().optional(),
  tokensOut: z.number().nullable().optional(),
  durationMs: z.number().optional(),
  error: z.string().optional(),
});
export type InvokeAgentResponse = z.infer<typeof InvokeAgentResponse>;

// ─── Agent kind filter for GET /v1/agents ───────────────────────────────────

export const AgentKindSchema = z.enum(["manifest", "code", "all"]);
export type AgentKindFilter = z.infer<typeof AgentKindSchema>;
