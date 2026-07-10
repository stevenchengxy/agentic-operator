/**
 * Inngest client factory — ONE Inngest app per tenant.
 *
 * Each tenant slug maps to its own Inngest app `${APP_PREFIX}-${slug}` (default
 * prefix `agentic-operator`), served at a distinct URL:
 *   - the platform/system app `agentic-operator-__system` is served at `/inngest`
 *     (the inngest-cli `-u .../inngest` auto-discovers it), and hosts helloFn,
 *     the system-cron heartbeat, the retention sweep, code-agent functions, and
 *     the global `system/PING` event.
 *   - every tenant app `agentic-operator-<slug>` is served at `/inngest/<slug>`
 *     and is registered with the dev/cloud Inngest by an explicit PUT self-sync
 *     (`apps/api/src/services/inngest-sync.ts`) — the cli only auto-discovers the
 *     one base URL, never the per-tenant sub-paths.
 *
 * WHY one app per tenant: the app boundary is what Inngest groups, syncs, and
 * shows online/offline. It does NOT partition the event bus (events are
 * environment-wide and fan out by NAME) nor add concurrency isolation (that is
 * the per-function `concurrency.key`). So tenant isolation of routing/concurrency
 * already comes from the `${slug}/${EVENT}` namespacing + the `${slug}:subject`
 * key — splitting apps buys per-tenant sync lifecycle, dashboard health, and
 * (future) per-tenant signing keys / process isolation. See
 * `docs/design/` / the per-tenant-inngest-apps design.
 *
 * Event keys / signing keys are read from env by the SDK (shared across all
 * per-tenant clients today — apps differ by id, not key). A per-tenant key is a
 * future seam: see `keyOverridesForTenant`.
 *
 * v4 NOTE: `EventSchemas().fromRecord<EventMap>()` was removed in inngest@4. We
 * register without a global schema and rely on per-agent manifests + the
 * `${tenant}/${EVENT}` naming convention; `EventMap` below is documentation only.
 */

import { Inngest } from "inngest";

/**
 * Event-name → payload type map. Retained as documentation for what shapes
 * flow through the system; not handed to the SDK in v4.
 *
 * Tenant-namespaced event names are written as `${tenant}/${EVENT_NAME}`
 * (e.g. `zhaopin/REQUIREMENT_LOGGED`, `zhaopin/task.resolved`) per DESIGN.md §6.
 * `system/PING` is the one platform-global event (served by the __system app).
 */
export type EventMap = {
  "system/PING": { data: { from?: string } };
  [k: `${string}/${string}`]: { data: Record<string, unknown> };
};

/**
 * App-id prefix. Configurable so staging + prod can coexist on one dev Inngest
 * without app-id collisions. Defaults to `agentic-operator`.
 */
const APP_PREFIX =
  (process.env.INNGEST_APP_PREFIX ?? "").trim() || "agentic-operator";

/**
 * Legacy-main compatibility. The old AO app was hard-coded as
 * `agentic-operator-main`; assigning a tenant slug here makes the new runtime
 * appear in Inngest with that legacy app id while preserving the
 * one-app-per-tenant model for every other tenant.
 */
const MAIN_TENANT_SLUG = (process.env.INNGEST_MAIN_TENANT ?? "").trim();
const MAIN_TENANT_APP_ID =
  (process.env.INNGEST_MAIN_APP_ID ?? "").trim() || `${APP_PREFIX}-main`;

/**
 * The platform/system app slug. Hosts helloFn, the system-cron heartbeat, the
 * retention sweep, code-agent functions, and the global `system/PING` event.
 * Served at the BASE `/inngest` path (no slug) so the inngest-cli `-u` flag
 * auto-discovers it.
 */
export const SYSTEM_SLUG = "__system";

/** `agentic-operator-<slug>` — the Inngest app id for a tenant. */
export function appIdForTenant(slug: string): string {
  if (slug !== SYSTEM_SLUG && slug === MAIN_TENANT_SLUG) {
    return MAIN_TENANT_APP_ID;
  }
  return `${APP_PREFIX}-${slug}`;
}

/** Tenant slug that should occupy the legacy/base Inngest app, if configured. */
export function mainTenantSlug(): string | null {
  return MAIN_TENANT_SLUG.length > 0 ? MAIN_TENANT_SLUG : null;
}

export function isMainTenant(slug: string): boolean {
  return slug !== SYSTEM_SLUG && slug === MAIN_TENANT_SLUG;
}

/**
 * Future seam for per-tenant signing/event keys. Returns `{}` today (every app
 * shares the env-level INNGEST_EVENT_KEY / INNGEST_SIGNING_KEY the SDK reads),
 * so a tenant that later needs its own rotated key is a one-function change here
 * rather than a re-architecture. Intentionally unused-arg now.
 */
function keyOverridesForTenant(_slug: string): {
  eventKey?: string;
  signingKey?: string;
} {
  return {};
}

const clients = new Map<string, Inngest>();

/**
 * The Inngest client for a tenant app, constructed once and cached per slug.
 * Construction is cheap + side-effect-free; the app is only registered with
 * Inngest when its serve endpoint is PUT-synced.
 */
export function getTenantInngest(slug: string): Inngest {
  let c = clients.get(slug);
  if (!c) {
    c = new Inngest({
      id: appIdForTenant(slug),
      ...keyOverridesForTenant(slug),
    });
    clients.set(slug, c);
  }
  return c;
}

/**
 * Every Inngest client constructed so far — one per tenant app that has had at
 * least one function registered (or been explicitly touched at boot). Used by
 * `inngest-sync.ts` to PUT-sync each app's serve endpoint.
 */
export function allTenantClients(): Array<{ slug: string; client: Inngest }> {
  return [...clients.entries()].map(([slug, client]) => ({ slug, client }));
}

/**
 * Back-compat alias — the platform/system client (`agentic-operator-__system`).
 * Existing `import { inngest }` sites (helloFn, system-cron, retention,
 * code-agent fns) resolve to the __system app. Per-tenant agent + cron
 * functions bind via `getTenantInngest(slug)` instead.
 */
export const inngest = getTenantInngest(SYSTEM_SLUG);
