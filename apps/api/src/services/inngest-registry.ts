/**
 * Per-tenant Inngest app registry.
 *
 * ONE Inngest app per tenant (`agentic-operator-<slug>`), plus the platform
 * `agentic-operator-__system` app. Each app is a distinct Inngest client served
 * at its own URL:
 *   - `__system`        → `/inngest`        (auto-discovered by inngest-cli `-u`)
 *   - tenant `<slug>`   → `/inngest/<slug>` (explicit PUT self-sync; see
 *                          `inngest-sync.ts`)
 *
 * Inngest's `serve()` captures one client + one flat functions array at
 * construction, so each app needs its own serve handler. This module holds a
 * mutable `Map<appId, AppEntry>` behind the `/inngest[/:slug]` routes so a
 * runtime re-register (deploy / agent enable-disable / archive / tenant
 * onboarding) swaps the served set for ONE app without a restart and WITHOUT
 * touching any other tenant's app.
 *
 * Boot seeds the registry via `initInngestRegistry`. `reregisterInngest`
 * re-runs the relevant bootstrap step and rebuilds only the affected app's
 * handler:
 *   - `{ tenantSlug, scope: "tenant" }` — scoped single-tenant rebuild (the
 *     common case for deploy / 上线·下线 / archive). Re-reads only that tenant's
 *     manifest + DB and replaces only that app's functions. If the rebuild
 *     throws (broken manifest), the tenant keeps its last-good function set — a
 *     failed deploy never drops a previously-live tenant, and one tenant's bad
 *     deploy can never affect another.
 *   - `{ scope: "tenant" }` (no slug) — full rebuild of every tenant app
 *     (archive/restore that don't carry a slug; global refresh).
 *   - `{ scope: "code_agent" }` — rebuild the code-agent functions on __system.
 *
 * The platform `__system` app is composite: `systemBase` (helloFn + cron +
 * retention) + `systemCodeAgent` (code-agent fns), tracked separately so a
 * code-agent re-register recomputes only that slice.
 */

import type { InngestFunction, Inngest } from "inngest";
import { serve } from "inngest/fastify";
import type { FastifyReply, FastifyRequest } from "fastify";
import { appIdForTenant, getTenantInngest, SYSTEM_SLUG } from "@agentic/runtime";

type ServeHandler = (
  req: FastifyRequest,
  reply: FastifyReply,
) => unknown | Promise<unknown>;

interface AppEntry {
  appId: string;
  /** Tenant slug, or `SYSTEM_SLUG` for the platform app. */
  slug: string;
  client: Inngest.Any;
  fns: InngestFunction.Any[];
  handler: ServeHandler;
}

const SYSTEM_APP_ID = appIdForTenant(SYSTEM_SLUG);

/** `/inngest` for the platform app, `/inngest/<slug>` for tenant apps. */
export function servePathForSlug(slug: string): string {
  return slug === SYSTEM_SLUG ? "/inngest" : `/inngest/${slug}`;
}

const state: {
  apps: Map<string, AppEntry>;
  /** helloFn + system-cron + retention — the non-code-agent part of __system. */
  systemBase: InngestFunction.Any[];
  /** code-agent fns, also served on the __system app. */
  systemCodeAgent: InngestFunction.Any[];
} = {
  apps: new Map(),
  systemBase: [],
  systemCodeAgent: [],
};

function buildEntry(
  slug: string,
  client: Inngest.Any,
  fns: InngestFunction.Any[],
): AppEntry {
  const handler = serve({
    client: client as never,
    functions: fns as never,
    // Explicit per-app servePath: without it the SDK auto-detects `/inngest`
    // for EVERY app and they collide on one callback URL (the dev server
    // overwrites registrations). This is the load-bearing per-app isolation.
    servePath: servePathForSlug(slug),
  }) as unknown as ServeHandler;
  return { appId: appIdForTenant(slug), slug, client, fns, handler };
}

/** Recompute the composite __system app (systemBase + systemCodeAgent). */
function setSystemApp(): void {
  const fns = [...state.systemBase, ...state.systemCodeAgent];
  state.apps.set(
    SYSTEM_APP_ID,
    buildEntry(SYSTEM_SLUG, getTenantInngest(SYSTEM_SLUG), fns),
  );
}

/**
 * Boot-time initialization. Stores the platform function slices + one entry per
 * tenant app, and builds each app's serve handler.
 */
export function initInngestRegistry(args: {
  systemBase: InngestFunction.Any[];
  systemCodeAgent: InngestFunction.Any[];
  tenants: Array<{ slug: string; fns: InngestFunction.Any[] }>;
}): void {
  state.apps.clear();
  state.systemBase = [...args.systemBase];
  state.systemCodeAgent = [...args.systemCodeAgent];
  setSystemApp();
  for (const t of args.tenants) {
    state.apps.set(
      appIdForTenant(t.slug),
      buildEntry(t.slug, getTenantInngest(t.slug), t.fns),
    );
  }
}

/**
 * The serve handler for an app id, or null if no such app is registered (the
 * route returns 404). Defaults to the platform app so a no-arg call (legacy /
 * tests) resolves the __system handler.
 */
export function getHandlerForApp(appId: string): ServeHandler | null {
  return state.apps.get(appId)?.handler ?? null;
}

/**
 * Back-compat strict lookup. Throws if the registry was never initialized
 * (programmer error) or the app id is unknown. Defaults to the __system app.
 */
export function getActiveHandler(appId: string = SYSTEM_APP_ID): ServeHandler {
  const entry = state.apps.get(appId);
  if (!entry) {
    if (state.apps.size === 0) {
      throw new Error(
        "[inngest-registry] handler not initialized; call initInngestRegistry first",
      );
    }
    throw new Error(`[inngest-registry] no app registered for ${appId}`);
  }
  return entry.handler;
}

/** Apps currently registered — used by `inngest-sync.ts` to PUT each one. */
export function listRegisteredApps(): Array<{
  appId: string;
  slug: string;
  servePath: string;
  fnCount: number;
}> {
  return [...state.apps.values()].map((e) => ({
    appId: e.appId,
    slug: e.slug,
    servePath: servePathForSlug(e.slug),
    fnCount: e.fns.length,
  }));
}

function totalFnCount(): number {
  let n = 0;
  for (const e of state.apps.values()) n += e.fns.length;
  return n;
}

/**
 * P5-TEN-01 — single-slot mutex around `reregisterInngest`. Two concurrent
 * callers (e.g. workflow PUT racing tenant-code POST) used to clobber each
 * other. We serialize the rebuild so each caller reads a coherent app set.
 */
let reregisterChain: Promise<unknown> = Promise.resolve();

export interface ReregisterResult {
  /** Total functions served across all apps after the rebuild. */
  fnCount: number;
  scope: string;
  /** For a scoped single-tenant rebuild: the affected app + its function count. */
  appId?: string;
  appFnCount?: number;
}

/**
 * Re-run the relevant bootstrap step and rebuild the affected app handler(s).
 * Serialized via `reregisterChain` so concurrent callers don't clobber state.
 */
export async function reregisterInngest(opts: {
  /** Scoped single-tenant rebuild when set — the common, cheap path. */
  tenantSlug?: string;
  /** Which subset to refresh. Default `"tenant"`. */
  scope?: "tenant" | "code_agent" | "all";
}): Promise<ReregisterResult> {
  const next = reregisterChain.then(() => _reregisterImpl(opts));
  // Swallow errors on the chain so one failed re-register doesn't poison every
  // future call. Callers still see the rejection on their own promise.
  reregisterChain = next.catch(() => undefined);
  return next;
}

async function _reregisterImpl(opts: {
  tenantSlug?: string;
  scope?: "tenant" | "code_agent" | "all";
}): Promise<ReregisterResult> {
  const scope = opts.scope ?? "tenant";

  // Lazy-import to dodge the circular dep (bootstrap imports this module).
  const bootstrap = (await import("../bootstrap")) as {
    rebuildTenantFns?: (slug: string) => Promise<InngestFunction.Any[]>;
    rebuildAllTenantFnsByTenant?: () => Promise<
      Map<string, InngestFunction.Any[]>
    >;
    rebuildCodeAgentFns?: () => Promise<InngestFunction.Any[]>;
  };

  let scopedAppId: string | undefined;
  let scopedAppFnCount: number | undefined;

  if (scope === "tenant" || scope === "all") {
    if (opts.tenantSlug && bootstrap.rebuildTenantFns) {
      // ── Scoped single-tenant rebuild. ──────────────────────────────────
      // A throw here (broken manifest) propagates WITHOUT mutating
      // state.apps, so the tenant keeps its last-good function set.
      const slug = opts.tenantSlug;
      const fns = await bootstrap.rebuildTenantFns(slug);
      const appId = appIdForTenant(slug);
      // fns === [] means archived / unknown / all-agents-disabled → serve zero
      // functions but KEEP the app entry so `/inngest/<slug>` still responds
      // and Inngest shows the app offline (functionCount 0).
      state.apps.set(appId, buildEntry(slug, getTenantInngest(slug), fns));
      scopedAppId = appId;
      scopedAppFnCount = fns.length;
    } else if (bootstrap.rebuildAllTenantFnsByTenant) {
      // ── Full rebuild of every tenant app (no slug). ───────────────────
      const byTenant = await bootstrap.rebuildAllTenantFnsByTenant();
      const liveSlugs = new Set(byTenant.keys());
      // Drop tenant apps that no longer have a model folder (tenant removed).
      for (const [appId, entry] of [...state.apps.entries()]) {
        if (entry.slug === SYSTEM_SLUG) continue;
        if (!liveSlugs.has(entry.slug)) state.apps.delete(appId);
      }
      for (const [slug, fns] of byTenant) {
        state.apps.set(
          appIdForTenant(slug),
          buildEntry(slug, getTenantInngest(slug), fns),
        );
      }
    }
  }

  if (scope === "code_agent" || scope === "all") {
    if (bootstrap.rebuildCodeAgentFns) {
      state.systemCodeAgent = await bootstrap.rebuildCodeAgentFns();
      setSystemApp();
    }
  }

  return {
    fnCount: totalFnCount(),
    scope,
    appId: scopedAppId,
    appFnCount: scopedAppFnCount,
  };
}

/** Test-only inspection. Keeps `base`/`codeAgent`/`tenant` aliases so older
 *  assertions (tc-26) keep working alongside the new per-app fields. */
export function _inspectRegistryForTests(): {
  base: number;
  codeAgent: number;
  tenant: number;
  systemBase: number;
  systemCodeAgent: number;
  appCount: number;
  tenantAppCount: number;
  totalFns: number;
} {
  const tenantApps = [...state.apps.values()].filter(
    (e) => e.slug !== SYSTEM_SLUG,
  );
  const tenantFns = tenantApps.reduce((n, e) => n + e.fns.length, 0);
  return {
    base: state.systemBase.length,
    codeAgent: state.systemCodeAgent.length,
    tenant: tenantFns,
    systemBase: state.systemBase.length,
    systemCodeAgent: state.systemCodeAgent.length,
    appCount: state.apps.size,
    tenantAppCount: tenantApps.length,
    totalFns: totalFnCount(),
  };
}
