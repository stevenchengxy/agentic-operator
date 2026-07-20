/**
 * Shared types for agent-authoring primitives.
 *
 * These describe what a tenant author sees when writing custom tools and
 * prompts. The runtime (packages/runtime) consumes the same types via the
 * resolver chain so action.name in a manifest can map to a tenant-defined
 * implementation.
 */

import type { ToolConfigContract, WriteProbeSafetyContract } from "@agentic/shared";
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

export interface ToolFactoryMetadata {
  summary?: string;
  category: string;
  sideEffect: "read" | "write" | "dual" | "call";
  operation: "read" | "compute" | "write" | "read_write";
  effectScope: "none" | "sandbox_local" | "external";
  sandboxPolicy: "pure" | "sandbox_local" | "live_external" | "requires_attempt_grant";
  aliases?: string[];
  argsSchema?: Record<string, ToolFactoryFieldSchema>;
  returnsSchema?: Record<string, ToolFactoryFieldSchema>;
  configSchema?: Record<string, ToolFactoryFieldSchema>;
  configContract?: ToolConfigContract;
  credentialEnv?: string[];
  capabilities?: ToolFactoryCapability[];
  profileScope?: ToolFactoryProfileScope;
  probeSafety?: WriteProbeSafetyContract;
  source: { modulePath: string; exportName?: string; revision?: string };
}

export interface ToolFactoryFieldSchema {
  type: string;
  required?: boolean;
  description?: string;
  default?: unknown;
  allowedValues?: Array<string | number | boolean | null>;
}

export interface ToolFactoryCapability {
  systems: string[];
  /** Required for systems:["*"]: profile config key containing the exact
   * Ontology system this reusable transport is authorized to represent. */
  systemConfigKey?: string;
  kinds: string[];
  roles: string[];
  operations?: string[];
  objectTypes?: string[];
  probeRequired?: boolean;
}

export interface ToolFactoryProfileScope {
  exact?: Array<{ configKey: string; source: "tenantId" | "tenantSlug" | "domain" | "action" }>;
  allowlists?: Array<{ configKey: string; source: "tenant" | "domain" | "action" | "objects"; match: "any" | "all" }>;
}

export interface TenantRegistryFactoryMetadata {
  source: { kind: string; id: string; version: string; revision?: string };
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
  readonly factory?: ToolFactoryMetadata;
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

export interface TenantInboundEvent {
  eventName: string;
  data: Record<string, unknown>;
}

export interface TenantOutboundEvent {
  eventId: string;
  eventName: string;
  payload: Record<string, unknown>;
  subject?: string | null;
  correlationId?: string | null;
  sourceAgent?: string | null;
  emittedAt?: string | null;
}

export interface TenantEventAdapter {
  readonly name?: string;
  readonly wireEventName?: (input: {
    tenantSlug: string;
    eventName: string;
  }) => string;
  readonly subjectExpressions?: {
    trigger: string;
    cancel: string;
  };
  readonly functionId?: (input: {
    tenantSlug: string;
    agentName: string;
  }) => string;
  inbound(input: TenantInboundEvent): Record<string, unknown>;
  outbound(input: TenantOutboundEvent): Record<string, unknown>;
}

/**
 * A tenant package's default export. Bootstrap auto-discovers `@tenants/<slug>`
 * and merges these registries with the generic tool/prompt set so manifest
 * actions can reference tenant-specific names without further wiring.
 */
export interface TenantRegistry {
  tools?: Record<string, ToolDescriptor>;
  prompts?: Record<string, PromptDescriptor>;
  /** Optional broker-envelope codec. Omission means the identity adapter. */
  eventAdapter?: TenantEventAdapter;
  /** Standalone Reasoning runtime configuration; unrelated to Agent Factory. */
  reasoning?: TenantReasoningConfigLike;
  factory?: TenantRegistryFactoryMetadata;
}

export interface TenantReasoningConfigLike {
  ontology: {
    provider: "allmeta";
    domainId: string;
  };
  allowedActions?: string[];
}
