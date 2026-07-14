/**
 * P3-API-03 — Atomic Inngest function re-registration.
 *
 * Inngest's `serve()` captures the functions array at construction time, so a
 * static `app.route()` registration would freeze the set at boot. The
 * deployment + tenant code endpoints need the running process to pick up a
 * fresh function list without restart.
 *
 * Shape:
 *   - We register ONE Fastify handler at `/inngest` that delegates to a
 *     mutable serve handler held in this module.
 *   - `setHandler()` is called at boot from `bootstrap.ts` after the initial
 *     function set has been built.
 *   - `reregisterInngest({ tenantSlug?, scope })` re-runs the relevant
 *     bootstrap step and rebuilds the serve handler with the new function
 *     list. The wrapper's next request hits the new handler atomically.
 *
 * Scopes:
 *   - `"tenant"` — re-run `bootstrapAll()` (manifest tenants + dynamic code
 *      tenants) and merge with `helloFn` + `retentionSweepFn` + code agent
 *      fns held in the cache.
 *   - `"code_agent"` — re-run `bootstrapCodeAgents()` and merge.
 *
 * The current cache is kept here so a tenant-only re-register doesn't have
 * to rebuild code-agent fns and vice-versa.
 */

import type { InngestFunction, Inngest } from "inngest";
import { serve } from "inngest/fastify";
import type { FastifyReply, FastifyRequest } from "fastify";

type ServeHandler = (
  req: FastifyRequest,
  reply: FastifyReply,
) => unknown | Promise<unknown>;

interface FnSets {
  base: InngestFunction.Any[]; // helloFn + retentionSweepFn
  codeAgent: InngestFunction.Any[];
  tenant: InngestFunction.Any[];
}

const state: {
  client: Inngest.Any | null;
  fns: FnSets;
  handler: ServeHandler | null;
} = {
  client: null,
  fns: { base: [], codeAgent: [], tenant: [] },
  handler: null,
};

function rebuildHandler(): void {
  if (!state.client) return;
  const all = [...state.fns.base, ...state.fns.codeAgent, ...state.fns.tenant];
  state.handler = serve({
    client: state.client,
    functions: all as never,
  }) as unknown as ServeHandler;
}

/**
 * Boot-time initialization. Stores the function sets and builds the first
 * serve handler.
 */
export function initInngestRegistry(args: {
  client: Inngest.Any;
  base: InngestFunction.Any[];
  codeAgent: InngestFunction.Any[];
  tenant: InngestFunction.Any[];
}): void {
  state.client = args.client;
  state.fns = {
    base: [...args.base],
    codeAgent: [...args.codeAgent],
    tenant: [...args.tenant],
  };
  rebuildHandler();
}

/**
 * The mutable serve handler. The Fastify route at `/inngest` delegates here.
 * Throws if `initInngestRegistry` was never called — that's a programmer
 * error worth surfacing.
 */
export function getActiveHandler(): ServeHandler {
  if (!state.handler) {
    throw new Error(
      "[inngest-registry] handler not initialized; call initInngestRegistry first",
    );
  }
  return state.handler;
}

/**
 * P5-TEN-01 — single-slot mutex around `reregisterInngest`. Two concurrent
 * callers (e.g. workflow PUT racing tenant-code POST) used to clobber each
 * other: the second `await rebuildTenantFns()` would overwrite state set by
 * the first. We now serialize the rebuild so the second caller waits for the
 * first to complete and reads a coherent function set.
 */
let reregisterChain: Promise<unknown> = Promise.resolve();

/**
 * Re-run the relevant bootstrap step and rebuild the serve handler.
 *
 * Returns `{ fnCount, scope }` so callers can echo it back in audit
 * metadata.
 */
export async function reregisterInngest(opts: {
  /** When set, also re-runs tenant-bootstrap for this slug specifically. */
  tenantSlug?: string;
  /**
   * Which subset to refresh. Default `"tenant"` — the common case for
   * manifest deploys, tenant-code uploads, and rollbacks.
   */
  scope?: "tenant" | "code_agent" | "all";
}): Promise<{ fnCount: number; scope: string }> {
  const next = reregisterChain.then(() => _reregisterImpl(opts));
  // Swallow errors on the chain so one failed re-register doesn't poison
  // every future call. Callers still see the rejection on their own promise.
  reregisterChain = next.catch(() => undefined);
  return next;
}

async function _reregisterImpl(opts: {
  tenantSlug?: string;
  scope?: "tenant" | "code_agent" | "all";
}): Promise<{ fnCount: number; scope: string }> {
  const scope = opts.scope ?? "tenant";

  // Lazy-import to dodge a circular dep (bootstrap imports this module). The
  // dynamic-loader exports (`rebuildTenantFns`, `rebuildCodeAgentFns`) only
  // exist when the workspace is on the agent-runtime refactor branch; with
  // the HEAD bootstrap.ts they're absent and we silently no-op. The wider
  // refactor lands in a follow-on PR; until then `reregisterInngest()`
  // returns the current snapshot without rebuilding.
  const bootstrap = (await import("../bootstrap")) as Record<string, unknown>;
  const rebuildTenantFns = bootstrap.rebuildTenantFns as
    | (() => Promise<InngestFunction.Any[]>)
    | undefined;
  const rebuildCodeAgentFns = bootstrap.rebuildCodeAgentFns as
    | (() => Promise<InngestFunction.Any[]>)
    | undefined;

  if ((scope === "tenant" || scope === "all") && rebuildTenantFns) {
    state.fns.tenant = await rebuildTenantFns();
  }
  if ((scope === "code_agent" || scope === "all") && rebuildCodeAgentFns) {
    state.fns.codeAgent = await rebuildCodeAgentFns();
  }
  rebuildHandler();
  // P3 / per-tenant rebuild: the current impl rebuilds the full tenant
  // function set on every re-register. Scoped rebuild (single slug) is
  // blocked on the bootstrap-side dynamic-loader refactor that adds a
  // `rebuildTenantFns(slug?)` overload. The slug is plumbed through so
  // callers don't need to change when that lands.
  void opts.tenantSlug;
  return {
    fnCount:
      state.fns.base.length +
      state.fns.codeAgent.length +
      state.fns.tenant.length,
    scope,
  };
}

/** Test-only inspection. */
export function _inspectRegistryForTests(): {
  base: number;
  codeAgent: number;
  tenant: number;
} {
  return {
    base: state.fns.base.length,
    codeAgent: state.fns.codeAgent.length,
    tenant: state.fns.tenant.length,
  };
}

/** Snapshot the function ids currently served by the mutable handler. */
export function listInngestFunctionIds(): string[] {
  const all = [...state.fns.base, ...state.fns.codeAgent, ...state.fns.tenant];
  return all.flatMap((fn) => {
    try {
      const id = fn.id();
      return typeof id === "string" ? [id] : [];
    } catch {
      return [];
    }
  });
}

export function isInngestFunctionRegistered(id: string): boolean {
  return listInngestFunctionIds().includes(id);
}
