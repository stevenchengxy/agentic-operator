/** Durable Inngest functions for code-defined agents. */

import { inngest, type InngestFunction } from "@agentic/runtime";
import type { ProviderId } from "@agentic/contracts";

import type { BaseAgent } from "./base-agent";
import { RunCancelledError } from "./run-engine";

export interface CodeAgentEventData {
  /** Pre-allocated runs.id, persisted as status=queued by the API. */
  runId: string;
  tenantSlug: string;
  input: unknown;
  provider?: ProviderId;
  providers?: ProviderId[];
  model?: string;
  correlationId: string;
  invocationId: string;
  testRun?: boolean;
}

export function codeAgentEventName(agentName: string): string {
  return `__system/code.${agentName}.invoke`;
}

export function codeAgentFnId(agentName: string): string {
  return `__system.code.${agentName}`;
}

function requiredString(
  data: Partial<CodeAgentEventData>,
  key: "runId" | "tenantSlug" | "correlationId" | "invocationId",
): string {
  const value = data[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`code-agent event is missing required data.${key}`);
  }
  return value;
}

export function registerCodeAgentFn(
  agent: BaseAgent<unknown, unknown>,
): InngestFunction.Any {
  if (!agent.enabled) {
    throw new Error(
      `Code agent '${agent.name}' is disabled and cannot be deployed as an Inngest function`,
    );
  }
  if (!agent.inngestEnabled) {
    throw new Error(
      `Code agent '${agent.name}' is a direct runtime capability and is not opted into Inngest deployment`,
    );
  }
  return inngest.createFunction(
    {
      id: codeAgentFnId(agent.name),
      name: `${agent.name} (code agent)`,
      concurrency: {
        limit: agent.concurrency.limit,
        ...(agent.concurrency.key ? { key: agent.concurrency.key } : {}),
      },
      retries: 1,
      triggers: [{ event: codeAgentEventName(agent.name) }],
    },
    async ({ event, step, logger }) => {
      const data = (event.data ?? {}) as Partial<CodeAgentEventData>;
      const runId = requiredString(data, "runId");
      const tenantSlug = requiredString(data, "tenantSlug");
      const correlationId = requiredString(data, "correlationId");
      const invocationId = requiredString(data, "invocationId");

      logger.info("[code-agent] durable invocation", {
        agent: agent.name,
        runId,
        tenantSlug,
        invocationId,
      });

      try {
        return await step.run("agent.run", async () => {
          const result = await agent.run(data.input as never, {
            runId,
            tenantSlug,
            correlationId,
            invocationId,
            provider: data.provider,
            providers: data.providers,
            model: data.model,
            testRun: data.testRun === true,
          });
          return { ok: true, agent: agent.name, ...result };
        });
      } catch (err) {
        if (err instanceof RunCancelledError) {
          return {
            ok: true,
            agent: agent.name,
            runId: err.runId,
            status: "cancelled" as const,
          };
        }
        throw err;
      }
    },
  );
}

export function buildCodeAgentFns(
  agents: BaseAgent<unknown, unknown>[],
): InngestFunction.Any[] {
  return agents
    .filter((agent) => agent.enabled && agent.inngestEnabled)
    .map(registerCodeAgentFn);
}
