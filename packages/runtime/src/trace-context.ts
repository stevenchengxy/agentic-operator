// #SCALE-TRACE — ambient trace context via AsyncLocalStorage: correlationId/agentName/tenantSlug/runId
// propagate to nested tools + logs WITHOUT threading them through every signature. The delivered
// adapter (register.ts) wraps each action's execution; any code on that async path can call
// getTraceContext() — including deeply nested tool helpers that never received a ctx.
import { AsyncLocalStorage } from "node:async_hooks";

export interface TraceContext {
  correlationId: string;
  agentName: string;
  tenantSlug: string;
  runId: string;
}

const als = new AsyncLocalStorage<TraceContext>();

export function runWithTraceContext<T>(ctx: TraceContext, fn: () => Promise<T>): Promise<T> {
  return als.run(ctx, fn);
}

/** The ambient trace context of the current async path, or null outside a traced run. */
export function getTraceContext(): TraceContext | null {
  return als.getStore() ?? null;
}
