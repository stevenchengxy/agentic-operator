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
import type { MemoryHandle } from "@agentic/agent-sdk";

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
  reasoning?: ReasoningConfig;
  verbosity?: TextVerbosity;
  store?: boolean;
  /**
   * Failover chain (P1-RT-06). When set, the agent passes this through to
   * `gateway.chat({providers})` so callers can override the agent's
   * `defaultProvider` with an ordered fallback list. Equivalent to
   * `req.providers` on the LLM gateway request.
   */
  providers?: ProviderId[];
  /**
   * P2-FE-18 — when true, persist `runs.is_test = 1` so the portal renders
   * the TEST badge.
   */
  testRun?: boolean;
  /**
   * P3-RT-06 — Memory handle. The run engine constructs one per run, bound
   * to (tenantId, agentName, subject, runId). Marked optional so ad-hoc
   * callers (tests, replays) can omit it.
   */
  memory?: MemoryHandle;
  /** P3-RT-06 — Per-subject identifier (e.g. candidate id). */
  subject?: string;
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
  /** Number of LLM turns the engine executed (1 for single-shot agents). */
  steps?: number;
  error?: string;
  /** P2-FE-18 — echo of `ctx.testRun`. */
  testRun?: boolean;
}

/**
 * Result returned by a tool handler. The engine serialises `data` to JSON
 * for the next `tool_result` block. `ok: false` signals a tool-side error;
 * the engine surfaces it as `is_error: true` so the model can recover.
 */
export interface ToolHandlerResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string };
  meta?: Record<string, unknown>;
}

/**
 * Tool handler signature. Called once per `tool_use` block emitted by the
 * model. `input` is the parsed args object (already JSON-decoded); the
 * handler is responsible for any further schema validation.
 */
export type ToolHandler = (
  input: Record<string, unknown>,
  ctx: AgentContext,
) => Promise<ToolHandlerResult> | ToolHandlerResult;

export type ToolHandlerMap = Record<string, ToolHandler>;
