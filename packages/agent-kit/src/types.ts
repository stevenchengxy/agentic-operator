/**
 * Shared types for agent-authoring primitives.
 *
 * These describe what a tenant author sees when writing custom tools and
 * prompts. The runtime (packages/runtime) consumes the same types via the
 * resolver chain so action.name in a manifest can map to a tenant-defined
 * implementation.
 */

import type { z } from "zod";

/**
 * Per-invocation context passed to every tool handler and prompt template.
 * Tools/prompts pluck what they need from here instead of declaring inputs
 * separately — keeps the manifest action shape simple (just `name + type`).
 */
export interface ToolContext {
  /** Agent that owns the step currently executing. */
  agentName: string;
  /** The action's `name` field from the manifest (matches the tool/prompt name). */
  actionName: string;
  /** The subject this run is operating on (e.g. a candidate id, requisition id). */
  subject?: string;
  /** Correlation id threaded through every step in this run. */
  correlationId: string;
  /** Tenant slug (e.g. "raas"). */
  tenantSlug: string;
  /** The trigger event that fired this run, if any. */
  event?: {
    name: string;
    data: Record<string, unknown>;
  };
  /**
   * Output of the previous step in the same run, if any. Lets a tool/prompt
   * pipe data forward without explicit wiring in the manifest.
   */
  lastResult?: unknown;
  /**
   * Per-tenant tool configuration, lifted from the workflow manifest's
   * `tool_use[i].config` blob and passed through verbatim. Handlers use this
   * for per-tenant credentials (e.g. `api_key_env`), per-tenant paths
   * (e.g. `subdir`), and any other knob that varies between deployments
   * but shouldn't require a code change.
   *
   * Concretely: a global tool like `robohire.parseResumeApi` can read
   * `ctx.config?.api_key_env` so tenant A and tenant B can both invoke
   * the same shared tool with different credentials, picked up from
   * different env vars, with zero TypeScript.
   *
   * `undefined` means the manifest didn't declare a config block for this
   * tool — handlers should fall back to env defaults in that case.
   */
  config?: Record<string, unknown>;
  /**
   * #P0-1 — durable, scoped memory (run / subject / tenant) so a tool can PERSIST + RECALL across
   * steps and runs. Threaded from the delivered adapter (register.ts → step-engine). Structurally
   * compatible with `@agentic/agent-sdk`'s `MemoryHandle` (kept inline so agent-kit needn't depend on
   * agent-sdk). `undefined` for pure-runtime/test callers — handlers treat memory as optional.
   */
  memory?: ToolMemoryHandle;
}

/** Minimal memory-handle surface a tool can use. A real `@agentic/agent-sdk` MemoryHandle is
 *  structurally assignable to this (get/put/delete identical; search's MemoryHit[] ⊆ unknown[]). */
export interface ToolMemoryHandle {
  get<T = unknown>(key: string, scope?: "run" | "subject" | "tenant"): Promise<T | null>;
  put<T = unknown>(key: string, value: T, scope?: "run" | "subject" | "tenant"): Promise<void>;
  delete(key: string, scope?: "run" | "subject" | "tenant"): Promise<void>;
  search(query: string, k: number): Promise<unknown[]>;
}

/**
 * What a tool handler returns. The runtime takes `data` as the step's output
 * (becomes the next step's `lastResult`), and surfaces `tokensIn`/`tokensOut`
 * on the run row for the tokens KPI.
 */
export interface ToolResult<T = unknown> {
  data: T;
  tokensIn?: number;
  tokensOut?: number;
  /** Free-form metadata for logs / debug surfaces. */
  meta?: Record<string, unknown>;
}

/**
 * A tool descriptor produced by `defineTool()`. The runtime calls
 * `descriptor.handler(ctx)` and (optionally) validates the output against
 * `descriptor.output` before storing it.
 */
export interface ToolDescriptor<TOutput = unknown> {
  readonly kind: "tool";
  readonly name: string;
  readonly description?: string;
  /** Optional Zod schema — runtime validates handler output if present. */
  readonly output?: z.ZodType<TOutput>;
  handler(ctx: ToolContext): Promise<ToolResult<TOutput>>;
}

/**
 * A prompt descriptor produced by `definePrompt()`. The runtime renders the
 * template against the live context to get a string, hands that to the LLM
 * caller, and (optionally) validates the LLM's structured output against
 * `descriptor.output`.
 */
export interface PromptDescriptor<TOutput = unknown> {
  readonly kind: "prompt";
  readonly name: string;
  readonly description?: string;
  readonly model?: string;
  readonly system?: string;
  template(ctx: ToolContext): string;
  /**
   * Optional Zod schema for structured output. When set, the runtime asks
   * the LLM for JSON matching this shape and validates the response.
   */
  readonly output?: z.ZodType<TOutput>;
}

/**
 * A tenant package's default export. Bootstrap auto-discovers `@tenants/<slug>`
 * and merges these registries with the generic tool/prompt set so manifest
 * actions can reference tenant-specific names without further wiring.
 *
 * `mcpServers` and `skills` are opt-in extensions:
 *   - When `mcpServers` is set, the runtime spins up the MCP client for
 *     each entry and folds the advertised tools into `tools` under
 *     `<serverName>.<toolName>` keys (see `@agentic/mcp`).
 *   - When `skills` is set, the runtime registers two built-in tools
 *     (`skills.list_skills` and `skills.load_skill`) so any agent in the
 *     tenant can progressively-disclose SKILL.md bodies (see `@agentic/skills`).
 */
export interface TenantRegistry {
  tools?: Record<string, ToolDescriptor>;
  prompts?: Record<string, PromptDescriptor>;
  mcpServers?: McpServerConfigLike[];
  skills?: SkillDescriptorLike[];
}

/**
 * Structural alias for `McpServerConfig` from `@agentic/mcp`. Defined here
 * to keep `@agentic/agent-kit` from importing the MCP SDK transitively
 * (tenant packages that ship zero MCP servers shouldn't pull megabytes of
 * stdio-transport deps). The runtime narrows this to the real type at
 * the bootstrap edge.
 */
export interface McpServerConfigLike {
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  allowTools?: string[];
  optional?: boolean;
}

/**
 * Structural alias for `SkillDescriptor` from `@agentic/skills`. Same
 * decoupling rationale as `McpServerConfigLike` — declared here so
 * `agent-kit` keeps zero filesystem deps.
 */
export interface SkillDescriptorLike {
  name: string;
  description: string;
  /** Absolute path to the SKILL.md body for progressive load. */
  path: string;
  /** Optional frontmatter metadata surfaced verbatim to the agent. */
  metadata?: Record<string, unknown>;
}
