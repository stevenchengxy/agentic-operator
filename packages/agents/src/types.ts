/**
 * BaseAgent + RunEngine public types.
 *
 * AgentContext is what gets passed into buildMessages() / parseOutput().
 * AgentResult is what run() returns to the caller.
 */

import type { ProviderId } from "@agentic/contracts";

export type AgentKind = "manifest" | "code";
export type AgentScope = "tenant" | "system";
/** Where run/billing/observability rows live; independent from definition ownership. */
export type AgentRunScope = "caller" | "owner";

export interface AgentContext {
  /** Tenant slug; defaults to `__system` for code-only agents with no tenant binding. */
  tenantSlug: string;
  /** Correlation id propagated across chained runs. */
  correlationId: string;
  /** Caller-provided invocation id (e.g. the API request id) for tracing. */
  invocationId?: string;
  /**
   * Explicit parent for an in-process nested agent run. The run engine verifies
   * that the parent belongs to the same tenant and correlation before writing
   * `runs.parent_run_id`.
   */
  parentRunId?: string;
  /**
   * Auditable execution role for an internal child run. This is runtime
   * metadata only; it never creates or exposes a separate Agent definition.
   */
  runtimeRole?: string;
  /** Optional override of provider/model for this invocation. */
  provider?: ProviderId;
  /** Ordered real-provider failover chain; takes precedence over `provider`. */
  providers?: ProviderId[];
  model?: string;
  /**
   * Optional caller-reserved run id (used by durable async enqueue). When a
   * queued row already exists, the engine atomically promotes it to running
   * instead of allocating a second, untrackable run.
   */
  runId?: string;
  /**
   * P2-FE-18: test-run flag. When true the run engine sets `runs.is_test=true`
   * and the broadcast `run.started` event carries `testRun: true` so SSE
   * subscribers can paint the badge without a follow-up DB read.
   */
  testRun?: boolean;
}

export interface AgentResult<TOutput> {
  runId: string;
  status: "ok" | "failed";
  output: TOutput | null;
  provider: ProviderId;
  model: string;
  tokensIn: number | null;
  tokensOut: number | null;
  durationMs: number;
  /** Total persisted runtime steps (provider turns, repairs, and tools). */
  steps?: number;
  error?: string;
  /** P2-FE-18: surfaced so the invoke route can echo it back in the envelope. */
  testRun?: boolean;
}

/** Serializable result returned by one real tool handler invocation. */
export interface ToolHandlerResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string };
  meta?: Record<string, unknown>;
}

export type ToolHandler = (
  input: Record<string, unknown>,
  ctx: AgentContext,
) => Promise<ToolHandlerResult> | ToolHandlerResult;

export type ToolHandlerMap = Record<string, ToolHandler>;
