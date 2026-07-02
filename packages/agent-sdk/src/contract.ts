/**
 * #REDESIGN P2 — the "power-strip" contract.
 *
 * The Agent Factory produces TWO kinds of agents (see docs/design/agent-factory-redesign.md):
 *   - DELIVERED functions — durable, event-triggered, registered on Inngest (the product).
 *   - RUNTIME task-agents — ephemeral CodeAct handlers spawned mid-run to do a subtask.
 *
 * They have different STANDARDS but plug into ONE socket: `AgentRuntime`. Any generated agent,
 * written against `UnifiedAgentContract`, receives the same capabilities regardless of tier — the
 * two ADAPTERS (the Inngest `register.ts` step engine; the CodeAct `codeact.ts` executor) each
 * provide an `AgentRuntime`. Different plugs, same socket.
 *
 * This module is interface-only (no runtime deps) so both the runtime adapters and the factory can
 * import it without a cycle.
 */

import type { MemoryHandle } from "./memory";

/** Result of spawning a runtime sub-agent (CodeAct). `ok:false` on any failure — never throws. */
export interface SpawnResult {
  ok: boolean;
  data?: Record<string, unknown>;
  emitted?: Array<{ event: string; payload: Record<string, unknown> }>;
  /** the generated sub-agent's code, captured so the factory can PROMOTE it to a deployable spec. */
  code?: string;
  error?: string;
}

/** The capabilities every agent gets, identical on both tiers — THE SOCKET. An adapter may make a
 *  capability a graceful no-op where it doesn't apply (e.g. `spawn` on the delivered tier decomposes
 *  via `invoke` instead), but the SHAPE is uniform so generated code is tier-agnostic. */
export interface AgentRuntime {
  /** identity / tracing */
  agentName: string;
  tenantSlug: string;
  correlationId: string;
  subject?: string;

  /** LLM reasoning over an input with a system prompt → parsed JSON (or `{ text }`). */
  reason(systemPrompt: string, input: unknown): Promise<unknown>;
  /** call a registered tool by name (resolved: tenant → global → MCP), args default to the event. */
  tool(name: string, args?: unknown): Promise<unknown>;
  /** back-compat alias for `tool` — rendered code emits `ctx.tools.run(name, args)`. */
  tools?: { run(name: string, args?: unknown): Promise<unknown> };
  /** emit a downstream event (queued; the runtime finalizes exactly one on the delivered tier). */
  emit(event: string, payload?: Record<string, unknown>): void;
  /** vector-recall memory (run / subject / tenant scopes) — the real MemoryDriver. */
  memory: MemoryHandle;
  /** synchronously call another DEPLOYED agent (durable tier: step.invoke; runtime tier: a spawn). */
  invoke(agentRef: string, input?: unknown): Promise<unknown>;
  /** spawn an EPHEMERAL sub-agent by generating+running its code (runtime tier; depth-capped). */
  spawn(task: string, input?: unknown, opts?: { tools?: string[] }): Promise<SpawnResult>;
  /** structured log line (surfaced in the run trace). */
  log(level: "info" | "warn" | "error", msg: string, data?: unknown): void;
}

/** Which standard an agent is held to (see the acceptance bars in the design doc). */
export type AgentTier = "delivered" | "runtime";

/** The unified plug: a generated agent implements this and runs on either adapter. */
export interface UnifiedAgentContract {
  name: string;
  tier: AgentTier;
  /** declared typed I/O (from the ontology event_data / the subtask contract). */
  io?: { input?: Array<{ field: string; type: string }>; output?: Array<{ field: string; type: string }> };
  /** the agent's body: input → (reason/tool/emit/spawn via ctx) → structured output. */
  handler(input: Record<string, unknown>, ctx: AgentRuntime): Promise<Record<string, unknown>>;
}

/** Runtime guard: does an object satisfy the AgentRuntime socket? Used by adapters + tests to prove
 *  both tiers provide the same capabilities. */
export function isAgentRuntime(x: unknown): x is AgentRuntime {
  const c = x as Partial<AgentRuntime> | null;
  return (
    !!c &&
    typeof c.agentName === "string" &&
    typeof c.tenantSlug === "string" &&
    typeof c.correlationId === "string" &&
    typeof c.reason === "function" &&
    typeof c.tool === "function" &&
    typeof c.emit === "function" &&
    typeof c.invoke === "function" &&
    typeof c.spawn === "function" &&
    typeof c.log === "function" &&
    !!c.memory
  );
}
