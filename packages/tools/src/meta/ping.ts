/**
 * meta.ping — context-introspection smoke test.
 *
 * Returns a snapshot of the ToolContext fields the runtime populated.
 * Use this to:
 *   - Smoke-test that a new tenant's manifest is wired up — drop
 *     `{ "name": "meta.ping" }` into any agent's tool_use[], publish the
 *     trigger event, and read the run's tool-call output.
 *   - Debug ctx.subject / ctx.event / ctx.lastResult propagation when
 *     a downstream tool isn't seeing what you expect.
 *
 * Originally born as RAAS's `pingProbe` tool. Promoted to a global
 * `meta.ping` 2026-05-27; the original `pingProbe` symbol remains a
 * back-compat alias. Business-action names are deliberately not aliases:
 * a missing real integration must fail closed instead of returning pong.
 */

import { defineTool } from "@agentic/agent-kit";
import { z } from "zod";

export const ping = defineTool({
  name: "meta.ping",
  description:
    "Context-introspection smoke test. Returns the ToolContext snapshot so " +
    "the operator can verify manifest wiring + downstream propagation.",
  output: z.object({
    pong: z.literal(true),
    agentName: z.string(),
    actionName: z.string(),
    tenantSlug: z.string(),
    subject: z.string().nullable(),
    seenEvent: z.string().nullable(),
    hasLastResult: z.boolean(),
    hasConfig: z.boolean(),
    ts: z.string(),
  }),
  async handler(ctx) {
    return {
      data: {
        pong: true as const,
        agentName: ctx.agentName,
        actionName: ctx.actionName,
        tenantSlug: ctx.tenantSlug,
        subject: ctx.subject ?? null,
        seenEvent: ctx.event?.name ?? null,
        hasLastResult: ctx.lastResult != null,
        hasConfig: ctx.config != null && Object.keys(ctx.config).length > 0,
        ts: new Date().toISOString(),
      },
      meta: { tool: "meta.ping", correlationId: ctx.correlationId },
    };
  },
});
