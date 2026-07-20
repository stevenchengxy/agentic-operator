/**
 * BaseAgent + RunEngine public types.
 *
 * AgentContext is what gets passed into buildMessages() / parseOutput().
 * AgentResult is what run() returns to the caller.
 */

import type {
  ProviderId,
  ReasoningConfig,
  TextVerbosity,
} from "@agentic/contracts";

export type AgentKind = "manifest" | "code";

export interface AgentContext {
  /** Tenant slug; defaults to `__system` for code-only agents with no tenant binding. */
  tenantSlug: string;
  /** Correlation id propagated across chained runs. */
  correlationId: string;
  /** Caller-provided invocation id (e.g. the API request id) for tracing. */
  invocationId?: string;
  /** Optional override of provider/model for this invocation. */
  provider?: ProviderId;
  model?: string;
  /**
   * AI-settings task category for this invocation. When omitted, the agent's
   * `taskClass` is used (which defaults to `tool.loop`).
   */
  taskClass?: string;
  reasoning?: ReasoningConfig;
  verbosity?: TextVerbosity;
  store?: boolean;
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
  error?: string;
  /** P2-FE-18: surfaced so the invoke route can echo it back in the envelope. */
  testRun?: boolean;
}
