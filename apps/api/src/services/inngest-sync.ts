/**
 * Per-tenant Inngest app self-sync + health probe.
 *
 * The inngest-cli `-u http://localhost:3540/inngest` auto-discovers ONLY the
 * base `__system` app. Each tenant app served at `/inngest/<slug>` must be
 * registered with the Inngest dev/cloud server explicitly: we PUT the serve URL
 * and the SDK self-introspects + registers its functions (the older
 * `POST /fn/register {url}` is rejected by current Inngest with "App ID
 * required"). This mirrors the old AO `postRegister`.
 *
 * Everything here is best-effort: a failed PUT is logged, never fatal. The api's
 * in-process handler already serves the correct functions immediately; the PUT
 * only updates the Inngest server's view. A periodic reconciler re-PUTs any app
 * the Inngest server has forgotten (e.g. after the dev server restarts — the
 * api didn't restart, so it never otherwise re-syncs).
 */

import { listRegisteredApps, servePathForSlug } from "./inngest-registry";

export interface SyncLogger {
  info?: (m: string) => void;
  warn?: (m: string) => void;
}

const PUT_TIMEOUT_MS = 5000;
const PROBE_TIMEOUT_MS = 3000;

/** Origin the Inngest server PUT-syncs each app's serve URL at. */
export function serveOrigin(): string {
  const explicit = (process.env.INNGEST_SERVE_ORIGIN ?? "").trim();
  if (explicit) {
    try {
      return new URL(explicit).origin;
    } catch {
      /* fall through to PORT-derived default */
    }
  }
  const port = (process.env.PORT ?? "").trim() || "3540";
  return `http://localhost:${port}`;
}

/** The Inngest dev/cloud server base URL (for GraphQL health probes). */
export function inngestBaseUrl(): string {
  return (process.env.INNGEST_BASE_URL ?? "").trim() || "http://localhost:8488";
}

/**
 * Sync is disabled under vitest: those runs don't start the inngest-cli and the
 * api isn't listening on a real port (fastify inject), so a PUT would just fail.
 * Real dispatch in dev / e2e relies on the cli + a listening api.
 */
function syncEnabled(): boolean {
  return process.env.NODE_ENV !== "test";
}

export interface SyncResult {
  slug: string;
  appId: string;
  url: string;
  ok: boolean;
  status?: number;
  error?: string;
}

/** PUT a single app's serve URL so Inngest (re-)introspects + registers it. */
export async function syncTenantApp(
  slug: string,
  logger: SyncLogger = {},
): Promise<SyncResult> {
  const url = `${serveOrigin()}${servePathForSlug(slug)}`;
  const base = { slug, appId: `app:${slug}`, url };
  if (!syncEnabled()) return { ...base, ok: true };
  try {
    const res = await fetch(url, {
      method: "PUT",
      signal: AbortSignal.timeout(PUT_TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.warn?.(
        `[inngest-sync] ${slug}: PUT ${url} → ${res.status} ${body.slice(0, 200)}`,
      );
      return { ...base, ok: false, status: res.status, error: body.slice(0, 200) };
    }
    logger.info?.(`[inngest-sync] ${slug}: registered app at ${url}`);
    return { ...base, ok: true, status: res.status };
  } catch (e) {
    const error = (e as Error).message;
    logger.warn?.(`[inngest-sync] ${slug}: PUT ${url} failed — ${error}`);
    return { ...base, ok: false, error };
  }
}

/** PUT every registered app's serve URL (boot + manual full re-sync). */
export async function syncAllApps(logger: SyncLogger = {}): Promise<SyncResult[]> {
  if (!syncEnabled()) return [];
  const out: SyncResult[] = [];
  for (const a of listRegisteredApps()) {
    out.push(await syncTenantApp(a.slug, logger));
  }
  const ok = out.filter((r) => r.ok).length;
  logger.info?.(
    `[inngest-sync] synced ${ok}/${out.length} app(s) at ${serveOrigin()}`,
  );
  return out;
}

export interface AppProbe {
  appId: string;
  connected: boolean | null;
  functionCount: number | null;
  url: string | null;
  error: string | null;
  healthy: boolean;
}

/**
 * Probe the Inngest server for one app's registration status via the dev-server
 * GraphQL API (`{ apps { name url error connected functionCount } }`). Powers
 * the per-tenant "is this app healthy?" status endpoint + the reconciler.
 */
export async function probeApp(appId: string): Promise<AppProbe> {
  try {
    const res = await fetch(`${inngestBaseUrl()}/v0/gql`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: "{ apps { name url error connected functionCount } }",
      }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) {
      return {
        appId,
        connected: null,
        functionCount: null,
        url: null,
        error: `Inngest GraphQL ${res.status}`,
        healthy: false,
      };
    }
    const body = (await res.json()) as {
      data?: {
        apps?: Array<{
          name: string;
          url?: string | null;
          error?: string | null;
          connected: boolean;
          functionCount: number;
        }>;
      };
    };
    const app = body.data?.apps?.find((a) => a.name === appId);
    if (!app) {
      return {
        appId,
        connected: false,
        functionCount: null,
        url: null,
        error: "App not registered in Inngest",
        healthy: false,
      };
    }
    const error =
      typeof app.error === "string" && app.error.length > 0 ? app.error : null;
    return {
      appId,
      connected: app.connected,
      functionCount: app.functionCount,
      url: app.url ?? null,
      error,
      healthy: error === null && app.connected,
    };
  } catch (e) {
    return {
      appId,
      connected: null,
      functionCount: null,
      url: null,
      error: (e as Error).message,
      healthy: false,
    };
  }
}

/**
 * Re-PUT any app the Inngest server has forgotten (not connected / 0 functions
 * when it should have some). Best-effort; protects against the dev server
 * restarting out from under a still-running api.
 */
export async function reconcileApps(logger: SyncLogger = {}): Promise<number> {
  if (!syncEnabled()) return 0;
  let repaired = 0;
  for (const a of listRegisteredApps()) {
    const probe = await probeApp(a.appId);
    const stale =
      probe.connected !== true || (a.fnCount > 0 && probe.functionCount === 0);
    if (stale) {
      const r = await syncTenantApp(a.slug, logger);
      if (r.ok) repaired++;
    }
  }
  if (repaired > 0) logger.info?.(`[inngest-sync] reconciler re-synced ${repaired} app(s)`);
  return repaired;
}

let activeReconciler: { stop: () => void } | null = null;

/**
 * Start a periodic reconciler (singleton). Unref'd so it never holds the
 * process open. Disabled under test, when sync is off, or when
 * `INNGEST_RECONCILE_MS=0`. Default cadence 60s. Stops any prior instance.
 */
export function startAppReconciler(logger: SyncLogger = {}): { stop: () => void } {
  stopAppReconciler();
  if (!syncEnabled()) return { stop: () => {} };
  const ms = Number(process.env.INNGEST_RECONCILE_MS ?? 60_000);
  if (!Number.isFinite(ms) || ms <= 0) return { stop: () => {} };
  const timer = setInterval(() => {
    reconcileApps(logger).catch(() => {});
  }, ms);
  timer.unref?.();
  activeReconciler = { stop: () => clearInterval(timer) };
  return activeReconciler;
}

/** Stop the periodic reconciler (called from the Fastify onClose drain). */
export function stopAppReconciler(): void {
  activeReconciler?.stop();
  activeReconciler = null;
}
