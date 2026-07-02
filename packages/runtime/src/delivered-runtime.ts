// #REDESIGN FU1 — the DELIVERED-tier adapter for the power-strip contract.
//
// The runtime tier (codeact.ts) already builds an `AgentRuntime` socket for a CodeAct handler. This
// is its DELIVERED-tier twin: the AgentRuntime that the durable Inngest path (register.ts) provides.
// Same socket, different plug. Its durable capabilities are INJECTED (the caller wires them to the
// real Inngest primitives) so this module stays free of an `inngest` import and is unit-testable with
// fakes — proving both tiers expose the identical capability surface (`isAgentRuntime`).
//
// TIER SEMANTICS (see docs/design/agent-factory-redesign.md):
//   · memory  → the REAL, durable MemoryHandle (createMemoryHandle) — persists across runs.
//   · emit    → routed by the caller to `step.sendEvent` (idempotent, exactly-once across replays).
//   · invoke  → routed by the caller to `step.invoke` of a resolved sibling deployed function.
//   · spawn   → there is no ephemeral code-gen on the delivered tier; a decomposition is a durable
//               call of a sibling function, so spawn() DECOMPOSES VIA invoke and wraps the result.
//
// Inngest nesting rule: `step.*` primitives may not be called from inside a `step.run(...)` body. So
// the durable emit/invoke a caller injects here are meant for the ACTION / finalize level (where
// register.ts already runs them); generated code executing *inside* a step.run receives only the
// step-safe capabilities (real memory + collected emit) — see codeact.ts.

import type { AgentRuntime, MemoryHandle, SpawnResult } from "@agentic/agent-sdk";

export interface DeliveredRuntimeDeps {
  agentName: string;
  tenantSlug: string;
  correlationId: string;
  subject?: string;
  /** REAL durable memory — build with `createMemoryHandle({ tenantId, agentName, subject, runId })`. */
  memory: MemoryHandle;
  /** LLM reasoning: system prompt + input → parsed JSON (or `{ text }`). */
  reason: (systemPrompt: string, input: unknown) => Promise<unknown>;
  /** tool dispatch (resolved tenant → global → MCP by the caller). */
  toolRun: (name: string, args?: unknown) => Promise<unknown>;
  /** DURABLE downstream emit — the caller routes this to `step.sendEvent`. */
  emit: (event: string, payload: Record<string, unknown>) => void;
  /** DURABLE synchronous sub-agent call — the caller routes this to `step.invoke`. */
  invoke: (agentRef: string, input?: unknown) => Promise<unknown>;
  log?: (level: "info" | "warn" | "error", msg: string, data?: unknown) => void;
}

/** Build the delivered-tier `AgentRuntime` from injected durable primitives. */
export function makeDeliveredRuntime(deps: DeliveredRuntimeDeps): AgentRuntime {
  const log =
    deps.log ??
    ((level: "info" | "warn" | "error", msg: string, data?: unknown) => {
      try {
        (console[level] ?? console.log)(`[delivered:${deps.agentName}] ${msg}`, data ?? "");
      } catch {
        /* best-effort */
      }
    });

  const rt: AgentRuntime = {
    agentName: deps.agentName,
    tenantSlug: deps.tenantSlug,
    correlationId: deps.correlationId,
    subject: deps.subject,
    memory: deps.memory,
    reason: deps.reason,
    tool: deps.toolRun,
    tools: { run: deps.toolRun },
    emit: deps.emit,
    invoke: deps.invoke,
    log,
    // On the delivered tier a "spawn" is not an ephemeral code-gen — it is a durable call of a sibling
    // deployed function. Decompose via invoke and wrap as a SpawnResult so tier-agnostic generated code
    // that calls ctx.spawn(...) still works (it gets a real sub-agent result, not a generated one).
    spawn: async (task: string, input?: unknown): Promise<SpawnResult> => {
      try {
        const data = await deps.invoke(task, input);
        return data == null
          ? { ok: false, error: `无法通过 invoke 解析子 agent「${task}」（delivered 层没有临时代码生成）` }
          : { ok: true, data: (typeof data === "object" ? data : { result: data }) as Record<string, unknown> };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
  };
  return rt;
}
