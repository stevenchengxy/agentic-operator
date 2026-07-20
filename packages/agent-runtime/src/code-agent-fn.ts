/**
 * P1-RT-08 — build an Inngest function for a code-defined agent.
 *
 * Path A (per cross-review): code agents are always reachable BOTH ways:
 *   - sync inline    → `POST /v1/agents/:name/invoke`  (default)
 *   - async via Inngest → `POST /v1/agents/:name/invoke?async=1`
 *
 * The async path sends a `__system/code.<agentName>.invoke` event; the
 * function below catches it and runs `agent.run()` through Inngest's
 * durable step.run for retry semantics + worker isolation.
 *
 * The function ID is `__system.code.<agentName>` so it slots cleanly into
 * the existing `${tenant}.${agent}` namespace used by manifest agents.
 *
 * The event-payload contract:
 *   {
 *     data: {
 *       runId: string,            // pre-allocated by the API route
 *       tenantSlug: string,       // "__system" for system-scoped agents
 *       input: unknown,           // agent input
 *       provider?: ProviderId,
 *       providers?: ProviderId[],
 *       model?: string,
 *       taskClass?: string,
 *       correlationId: string,
 *       invocationId?: string,
 *     }
 *   }
 *
 * NOTE: the API route generates the `runId` BEFORE sending so the caller
 * can poll `/v1/runs/:id` immediately. The function honours that runId
 * via the engine's correlation channel — for v1 we simply re-issue a
 * fresh runId in the engine (the synthetic runId in the queue payload is
 * recorded in `correlationId` so the caller still has a handle to find
 * the run). A follow-up can wire the pre-allocated id through executeAgentRun
 * directly.
 */

import { inngest } from "@agentic/runtime";
import type { InngestFunction } from "inngest";
import type { ProviderId } from "@agentic/contracts";

import type { BaseAgent } from "./base-agent";

export interface CodeAgentEventData {
  runId: string;
  tenantSlug: string;
  input: unknown;
  provider?: ProviderId;
  providers?: ProviderId[];
  model?: string;
  /** Optional invocation-level AI-settings task category. */
  taskClass?: string;
  correlationId: string;
  invocationId?: string;
  /** P2-FE-18 — when true, persist `runs.is_test = 1` on the spawned run. */
  testRun?: boolean;
}

/** The event name an enqueueing route must send to trigger this function. */
export function codeAgentEventName(agentName: string): string {
  return `__system/code.${agentName}.invoke`;
}

/** The Inngest function id for a code agent (stable across reboots). */
export function codeAgentFnId(agentName: string): string {
  return `__system.code.${agentName}`;
}

/**
 * Build the Inngest function for one code agent. Caller adds the result to
 * the `functions` array handed to `inngest/fastify`'s `serve()` adapter.
 *
 * `agent.concurrency` is honoured at the Inngest level so the function map
 * stays consistent with the agent's declared limits.
 */
export function registerCodeAgentFn(
  agent: BaseAgent<unknown, unknown>,
): InngestFunction.Any {
  const fnId = codeAgentFnId(agent.name);
  const eventName = codeAgentEventName(agent.name);

  return inngest.createFunction(
    {
      id: fnId,
      name: `${agent.name} (code agent)`,
      concurrency: {
        limit: agent.concurrency.limit,
        ...(agent.concurrency.key ? { key: agent.concurrency.key } : {}),
      },
      // Code agents lean on the synchronous run-engine for retry; one Inngest
      // attempt is enough at the function boundary. Bump if a tenant agent
      // demands transport-level retries later.
      retries: 1,
      triggers: [{ event: eventName }],
    },
    async ({ event, step, logger }) => {
      const data = (event.data ?? {}) as Partial<CodeAgentEventData>;
      const tenantSlug =
        typeof data.tenantSlug === "string" ? data.tenantSlug : "__system";
      const correlationId =
        typeof data.correlationId === "string"
          ? data.correlationId
          : "cor-fallback";

      logger.info(`[code-agent] async invocation`, {
        agent: agent.name,
        tenantSlug,
        invocationId: data.invocationId ?? null,
      });

      // step.run memoises the actual run so Inngest replays don't double-run.
      // The synchronous engine inside handles its own run/step rows and
      // file logs; we just persist the AgentResult shape so the function
      // payload is observable in the Inngest dashboard.
      const result = await step.run("agent.run", async () => {
        const out = await agent.run(data.input as never, {
          tenantSlug,
          correlationId,
          invocationId: data.invocationId,
          provider: data.provider,
          providers: data.providers,
          model: data.model,
          taskClass: data.taskClass,
          testRun: data.testRun === true,
        });
        return out;
      });

      return { ok: true, agent: agent.name, ...result };
    },
  );
}

/**
 * Build Inngest functions for every code agent in the registry.
 * Returns the array of `InngestFunction.Any`. Idempotent — building the
 * same agent twice produces two distinct function instances but with the
 * same id; the runtime de-dupes by id at serve-time.
 *
 * The bootstrap caller composes the returned array with `helloFn` and
 * the manifest-driven tenant functions, then hands the union to
 * `inngest/fastify`'s `serve()` adapter.
 */
export function buildCodeAgentFns(
  agents: BaseAgent<unknown, unknown>[],
): InngestFunction.Any[] {
  return agents.map((a) => registerCodeAgentFn(a));
}
