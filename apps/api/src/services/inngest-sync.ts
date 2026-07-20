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
 * Registration is part of runtime readiness: a failed PUT is returned as an
 * explicit failure and startup/mutating callers must reject it. A periodic
 * reconciler re-PUTs any app the Inngest server has forgotten (for example
 * after the dev server restarts) and logs failures instead of silently no-oping.
 */

import {
  appIdForTenant,
  SYSTEM_SLUG,
  tenantInngestConfigStatus,
  tenantInngestBaseUrl,
  tenantInngestControlHeaders,
  tenantInngestServeOrigin,
} from "@agentic/runtime";
import { listRegisteredApps, servePathForSlug } from "./inngest-registry";

export interface SyncLogger {
  info?: (m: string) => void;
  warn?: (m: string) => void;
}

const PUT_TIMEOUT_MS = 5000;
const PROBE_TIMEOUT_MS = 3000;

/** Origin the Inngest server PUT-syncs each app's serve URL at. */
export function serveOrigin(slug: string = SYSTEM_SLUG): string {
  return tenantInngestServeOrigin(slug);
}

/** The Inngest dev/cloud server base URL (for GraphQL health probes). */
export function inngestBaseUrl(slug: string = SYSTEM_SLUG): string {
  return tenantInngestBaseUrl(slug);
}

/**
 * Fastify-inject unit tests explicitly set INNGEST_SYNC_DISABLED=1 because no
 * HTTP server or broker exists there. NODE_ENV=test alone is deliberately not
 * enough: browser/E2E stacks also use test fixtures, but they must still prove
 * that the real broker accepted each tenant app.
 */
function syncEnabled(): boolean {
  const explicitlyDisabled = process.env.INNGEST_SYNC_DISABLED === "1";
  if (explicitlyDisabled && process.env.NODE_ENV !== "test") {
    throw new Error(
      "INNGEST_SYNC_DISABLED=1 is test-only; production/dev runtime cannot claim a deployment without broker sync",
    );
  }
  return !explicitlyDisabled;
}

export interface SyncResult {
  slug: string;
  appId: string;
  url: string;
  ok: boolean;
  status?: number;
  error?: string;
}

interface SyncEvidence {
  appId: string;
  fnCount: number;
  ok: boolean;
  syncedAt: number;
}

const syncEvidenceBySlug = new Map<string, SyncEvidence>();
const deletingApps = new Map<string, string>();
const syncInFlightBySlug = new Map<string, Promise<SyncResult>>();

/** Mark one ephemeral app as DELETING and wait for any earlier PUT to settle.
 * Subsequent manual/reconciler sync calls fail closed until deletion finishes. */
export async function beginInngestAppDeletion(slug: string, appId: string): Promise<void> {
  const existing = deletingApps.get(slug);
  if (existing && existing !== appId) {
    throw new Error(`Inngest deletion tombstone conflict for ${slug}`);
  }
  deletingApps.set(slug, appId);
  const inFlight = syncInFlightBySlug.get(slug);
  if (inFlight) await inFlight.catch(() => undefined);
}

/** Clear a tombstone only after local unregister + strict remote absence. */
export function finishInngestAppDeletion(slug: string, appId: string): void {
  if (deletingApps.get(slug) !== appId) {
    throw new Error(`Inngest deletion tombstone missing for ${slug}`);
  }
  deletingApps.delete(slug);
}

export function isInngestAppDeleting(slug: string): boolean {
  return deletingApps.has(slug);
}

function rememberSync(result: SyncResult): SyncResult {
  const registered = listRegisteredApps().find(
    (app) => app.slug === result.slug,
  );
  syncEvidenceBySlug.set(result.slug, {
    appId: result.appId,
    fnCount: registered?.fnCount ?? 0,
    ok: result.ok,
    syncedAt: Date.now(),
  });
  return result;
}

/**
 * Durable-enough process evidence for readiness: broker reachability alone is
 * not registration. The proof is valid only while app id and function count
 * still match the registry state that was PUT successfully.
 */
export function inngestRegistrationStatus(expected = listRegisteredApps()): {
  ok: boolean;
  expectedApps: number;
  syncedApps: number;
  lastSyncAt?: number;
  unsynced: string[];
} {
  if (
    process.env.INNGEST_SYNC_DISABLED === "1" &&
    process.env.NODE_ENV === "test"
  ) {
    return {
      ok: true,
      expectedApps: expected.length,
      syncedApps: expected.length,
      unsynced: [],
    };
  }
  const unsynced: string[] = [];
  const accepted: SyncEvidence[] = [];
  for (const app of expected) {
    const evidence = syncEvidenceBySlug.get(app.slug);
    if (
      !evidence?.ok ||
      evidence.appId !== app.appId ||
      evidence.fnCount !== app.fnCount
    ) {
      unsynced.push(app.slug);
    } else {
      accepted.push(evidence);
    }
  }
  return {
    ok: expected.length > 0 && unsynced.length === 0,
    expectedApps: expected.length,
    syncedApps: accepted.length,
    ...(accepted.length > 0
      ? { lastSyncAt: Math.min(...accepted.map((entry) => entry.syncedAt)) }
      : {}),
    unsynced,
  };
}

export function inngestCloudSyncMaxAgeMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const value = Number(env.INNGEST_CLOUD_SYNC_MAX_AGE_MS ?? 180_000);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("INNGEST_CLOUD_SYNC_MAX_AGE_MS must be a positive integer");
  }
  return value;
}

export function inngestCloudRegistrationFreshness(
  slugs: readonly string[],
  maxAgeMs = inngestCloudSyncMaxAgeMs(),
): { ok: boolean; stale: string[]; lastSyncAt?: number } {
  const expectedBySlug = new Map(
    listRegisteredApps().map((app) => [app.slug, app]),
  );
  const stale: string[] = [];
  const accepted: SyncEvidence[] = [];
  const now = Date.now();
  for (const slug of new Set(slugs)) {
    const expected = expectedBySlug.get(slug);
    const evidence = syncEvidenceBySlug.get(slug);
    if (
      !expected ||
      !evidence?.ok ||
      evidence.appId !== expected.appId ||
      evidence.fnCount !== expected.fnCount ||
      now - evidence.syncedAt > maxAgeMs
    ) {
      stale.push(slug);
    } else {
      accepted.push(evidence);
    }
  }
  return {
    ok: stale.length === 0,
    stale,
    ...(accepted.length
      ? { lastSyncAt: Math.min(...accepted.map((entry) => entry.syncedAt)) }
      : {}),
  };
}

export function __resetInngestSyncEvidenceForTests(): void {
  syncEvidenceBySlug.clear();
  deletingApps.clear();
  syncInFlightBySlug.clear();
}

/** Forget one ephemeral app's sync receipt after its unregister was verified. */
export function forgetInngestSyncEvidence(slug: string): boolean {
  return syncEvidenceBySlug.delete(slug);
}

export function __recordInngestSyncEvidenceForTests(args: {
  slug: string;
  appId: string;
  fnCount: number;
  ok: boolean;
  syncedAt?: number;
}): void {
  syncEvidenceBySlug.set(args.slug, {
    appId: args.appId,
    fnCount: args.fnCount,
    ok: args.ok,
    syncedAt: args.syncedAt ?? Date.now(),
  });
}

/** PUT a single app's serve URL so Inngest (re-)introspects + registers it. */
async function syncTenantAppNow(
  slug: string,
  logger: SyncLogger = {},
): Promise<SyncResult> {
  let origin: string;
  try {
    origin = serveOrigin(slug);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn?.(`[inngest-sync] ${slug}: configuration blocked — ${message}`);
    return rememberSync({
      slug,
      appId: appIdForTenant(slug),
      url: "",
      ok: false,
      error: message,
    });
  }
  const url = `${origin}${servePathForSlug(slug)}`;
  const base = { slug, appId: appIdForTenant(slug), url };
  if (!syncEnabled()) return rememberSync({ ...base, ok: true });
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
      return rememberSync({
        ...base,
        ok: false,
        status: res.status,
        error: body.slice(0, 200),
      });
    }
    logger.info?.(`[inngest-sync] ${slug}: registered app at ${url}`);
    return rememberSync({ ...base, ok: true, status: res.status });
  } catch (e) {
    const error = (e as Error).message;
    logger.warn?.(`[inngest-sync] ${slug}: PUT ${url} failed — ${error}`);
    return rememberSync({ ...base, ok: false, error });
  }
}

export async function syncTenantApp(
  slug: string,
  logger: SyncLogger = {},
): Promise<SyncResult> {
  const appId = appIdForTenant(slug);
  if (deletingApps.has(slug)) {
    return {
      slug,
      appId,
      url: "",
      ok: false,
      error: "Inngest app is deleting; sync is blocked by tombstone",
    };
  }
  const prior = syncInFlightBySlug.get(slug);
  if (prior) await prior.catch(() => undefined);
  if (deletingApps.has(slug)) {
    return {
      slug,
      appId,
      url: "",
      ok: false,
      error: "Inngest app is deleting; sync is blocked by tombstone",
    };
  }
  const task = syncTenantAppNow(slug, logger);
  syncInFlightBySlug.set(slug, task);
  try {
    return await task;
  } finally {
    if (syncInFlightBySlug.get(slug) === task) syncInFlightBySlug.delete(slug);
  }
}

/** PUT every registered app's serve URL (boot + manual full re-sync). */
export async function syncAllApps(
  logger: SyncLogger = {},
): Promise<SyncResult[]> {
  if (!syncEnabled()) return [];
  const out = await Promise.all(
    listRegisteredApps().map((a) => syncTenantApp(a.slug, logger)),
  );
  const ok = out.filter((r) => r.ok).length;
  logger.info?.(`[inngest-sync] synced ${ok}/${out.length} app(s)`);
  return out;
}

export async function syncAllAppsWithRetry(
  logger: SyncLogger = {},
  opts: { attempts?: number; delayMs?: number } = {},
): Promise<SyncResult[]> {
  const attempts = opts.attempts ?? 8;
  const delayMs = opts.delayMs ?? 1500;
  if (!Number.isSafeInteger(attempts) || attempts < 1) {
    throw new Error("Inngest sync attempts must be a positive integer");
  }
  if (!Number.isSafeInteger(delayMs) || delayMs < 0) {
    throw new Error("Inngest sync delay must be a non-negative integer");
  }
  let last: SyncResult[] = [];
  for (let i = 1; i <= attempts; i++) {
    last = await syncAllApps(logger);
    if (last.length === 0 || last.every((r) => r.ok)) return last;
    if (i < attempts) {
      logger.warn?.(
        `[inngest-sync] retrying app sync (${i}/${attempts}) after ${delayMs}ms`,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return last;
}

export interface AppProbe {
  appId: string;
  connected: boolean | null;
  functionCount: number | null;
  url: string | null;
  error: string | null;
  healthy: boolean;
}

export interface TenantAppRegistrationVerification {
  slug: string;
  appId: string;
  expectedFunctionCount: number;
  observedFunctionCount: number | null;
  connected: boolean;
  verified: boolean;
  evidence: "dev_graphql" | "cloud_sync_acceptance" | "test_only_bypass";
  checkedAt: string;
  error?: string;
}

/**
 * Probe the Inngest server for one app's registration status via the dev-server
 * GraphQL API (`{ apps { name url error connected functionCount } }`). Powers
 * the per-tenant "is this app healthy?" status endpoint + the reconciler.
 */
export async function probeApp(
  appId: string,
  tenantSlug?: string,
): Promise<AppProbe> {
  try {
    const slug =
      tenantSlug ??
      listRegisteredApps().find((app) => app.appId === appId)?.slug ??
      SYSTEM_SLUG;
    const configured = listRegisteredApps().find((app) => app.slug === slug);
    if (tenantInngestConfigStatus(slug).mode === "cloud") {
      // Inngest Cloud does not expose the local Dev Server's `/v0/gql` app
      // registry. The signed PUT sync accepted by Cloud is the authoritative
      // process evidence, and is invalidated whenever app id/fn count changes.
      const evidence = syncEvidenceBySlug.get(slug);
      const current = Boolean(
        configured &&
        evidence?.ok &&
        evidence.appId === configured.appId &&
        evidence.fnCount === configured.fnCount,
      );
      return {
        appId,
        connected: current,
        functionCount: current ? configured!.fnCount : null,
        url: null,
        error: current
          ? null
          : "No current Inngest Cloud sync acceptance proof",
        healthy: current,
      };
    }
    const res = await fetch(`${inngestBaseUrl(slug)}/v0/gql`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...tenantInngestControlHeaders(slug),
      },
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
      errors?: unknown;
      data?: {
        apps?: unknown;
      };
    };
    if (Array.isArray(body.errors) && body.errors.length > 0) {
      return {
        appId,
        connected: null,
        functionCount: null,
        url: null,
        error: "Inngest GraphQL returned errors",
        healthy: false,
      };
    }
    if (!body.data || !Array.isArray(body.data.apps)) {
      return {
        appId,
        connected: null,
        functionCount: null,
        url: null,
        error: "Inngest GraphQL apps payload is missing or malformed",
        healthy: false,
      };
    }
    const validApps: Array<{
          name: string;
          url?: string | null;
          error?: string | null;
          connected: boolean;
          functionCount: number;
    }> = [];
    for (const row of body.data.apps) {
      if (
        !row || typeof row !== "object" || Array.isArray(row) ||
        typeof (row as { name?: unknown }).name !== "string" ||
        typeof (row as { connected?: unknown }).connected !== "boolean" ||
        typeof (row as { functionCount?: unknown }).functionCount !== "number" ||
        !Number.isSafeInteger((row as { functionCount: number }).functionCount) ||
        (row as { functionCount: number }).functionCount < 0 ||
        ((row as { url?: unknown }).url !== undefined && (row as { url?: unknown }).url !== null && typeof (row as { url?: unknown }).url !== "string") ||
        ((row as { error?: unknown }).error !== undefined && (row as { error?: unknown }).error !== null && typeof (row as { error?: unknown }).error !== "string")
      ) {
        return {
          appId,
          connected: null,
          functionCount: null,
          url: null,
          error: "Inngest GraphQL app row is malformed",
          healthy: false,
        };
      }
      validApps.push(row as typeof validApps[number]);
    }
    const app = validApps.find((a) => a.name === appId);
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
 * Confirm that the broker-facing app identity has the exact function count
 * currently served by the target tenant registry. A successful PUT alone is
 * only transport acceptance; local/self-hosted Inngest is therefore polled
 * through its independent app registry before a deployment can commit. Cloud
 * does not expose that GraphQL registry, so its fresh SDK sync acceptance is
 * the strongest available control-plane receipt.
 */
export async function verifyTenantAppRegistration(
  slug: string,
  expectedFunctionCount?: number,
  options: { attempts?: number; delayMs?: number; signal?: AbortSignal } = {},
): Promise<TenantAppRegistrationVerification> {
  options.signal?.throwIfAborted();
  const configured = listRegisteredApps().find((app) => app.slug === slug);
  const expected = expectedFunctionCount ?? configured?.fnCount;
  if (!configured || expected === undefined || expected !== configured.fnCount) {
    return {
      slug,
      appId: configured?.appId ?? appIdForTenant(slug),
      expectedFunctionCount: expected ?? -1,
      observedFunctionCount: configured?.fnCount ?? null,
      connected: false,
      verified: false,
      evidence: tenantInngestConfigStatus(slug).mode === "cloud"
        ? "cloud_sync_acceptance"
        : "dev_graphql",
      checkedAt: new Date().toISOString(),
      error: "local tenant registry identity/function count changed before broker verification",
    };
  }
  if (process.env.INNGEST_SYNC_DISABLED === "1" && process.env.NODE_ENV === "test") {
    return {
      slug,
      appId: configured.appId,
      expectedFunctionCount: expected,
      observedFunctionCount: configured.fnCount,
      connected: true,
      verified: true,
      evidence: "test_only_bypass",
      checkedAt: new Date().toISOString(),
    };
  }

  const attempts = options.attempts ?? Number(
    process.env.INNGEST_REGISTRATION_VERIFY_ATTEMPTS ?? 12,
  );
  const delayMs = options.delayMs ?? Number(
    process.env.INNGEST_REGISTRATION_VERIFY_DELAY_MS ?? 250,
  );
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 120) {
    throw new Error("Inngest registration verification attempts must be 1..120");
  }
  if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 5_000) {
    throw new Error("Inngest registration verification delay must be 0..5000ms");
  }
  const mode = tenantInngestConfigStatus(slug).mode;
  let last: AppProbe | undefined;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    options.signal?.throwIfAborted();
    last = await probeApp(configured.appId, slug);
    if (
      last.healthy &&
      last.connected === true &&
      last.functionCount === expected
    ) {
      return {
        slug,
        appId: configured.appId,
        expectedFunctionCount: expected,
        observedFunctionCount: last.functionCount,
        connected: true,
        verified: true,
        evidence: mode === "cloud" ? "cloud_sync_acceptance" : "dev_graphql",
        checkedAt: new Date().toISOString(),
      };
    }
    if (attempt < attempts && delayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          clearTimeout(timer);
          reject(options.signal?.reason ?? new Error("aborted"));
        };
        const timer = setTimeout(() => {
          options.signal?.removeEventListener("abort", onAbort);
          resolve();
        }, delayMs);
        options.signal?.addEventListener("abort", onAbort, { once: true });
        if (options.signal?.aborted) onAbort();
      });
    }
  }
  return {
    slug,
    appId: configured.appId,
    expectedFunctionCount: expected,
    observedFunctionCount: last?.functionCount ?? null,
    connected: last?.connected === true,
    verified: false,
    evidence: mode === "cloud" ? "cloud_sync_acceptance" : "dev_graphql",
    checkedAt: new Date().toISOString(),
    error:
      last?.error ??
      `broker function count did not converge to ${expected}`,
  };
}

/**
 * Re-PUT any app whose broker registration is disconnected or differs from
 * the local registry's exact function count. Exactness is important: stale
 * reasoning/report consumers must not remain deployed beside the six RAAS
 * business functions.
 */
export async function reconcileApps(logger: SyncLogger = {}): Promise<number> {
  if (!syncEnabled()) return 0;
  let repaired = 0;
  const failures: string[] = [];
  for (const a of listRegisteredApps()) {
    if (isInngestAppDeleting(a.slug)) continue;
    if (tenantInngestConfigStatus(a.slug).mode === "cloud") {
      const result = await syncTenantApp(a.slug, logger);
      if (result.ok) repaired++;
      else failures.push(`${a.slug}: Cloud sync was not accepted`);
      continue;
    }
    const probe = await probeApp(a.appId, a.slug);
    // Broker state and process acceptance evidence are two halves of the same
    // readiness proof.  A transient PUT timeout can leave the broker with the
    // correct durable registration while rememberSync() records a failed local
    // receipt.  Looking only at the broker in that state makes the reconciler a
    // permanent no-op and health can never recover until the API restarts.
    const evidence = syncEvidenceBySlug.get(a.slug);
    const localEvidenceStale =
      !evidence?.ok ||
      evidence.appId !== a.appId ||
      evidence.fnCount !== a.fnCount;
    const stale =
      probe.connected !== true ||
      probe.functionCount !== a.fnCount ||
      localEvidenceStale;
    if (stale) {
      const r = await syncTenantApp(a.slug, logger);
      if (r.ok) repaired++;
      else
        failures.push(
          `${a.slug}: ${r.error ?? `HTTP ${r.status ?? "unknown"}`}`,
        );
    }
  }
  if (failures.length)
    throw new Error(
      `Inngest app reconciliation failed: ${failures.join("; ")}`,
    );
  if (repaired > 0)
    logger.info?.(`[inngest-sync] reconciler re-synced ${repaired} app(s)`);
  return repaired;
}

let activeReconciler: { stop: () => void } | null = null;

/**
 * Start a periodic reconciler (singleton). Unref'd so it never holds the
 * process open. Disabled under test, when sync is off, or when
 * `INNGEST_RECONCILE_MS=0`. Default cadence 60s. Stops any prior instance.
 */
export function startAppReconciler(logger: SyncLogger = {}): {
  stop: () => void;
} {
  stopAppReconciler();
  if (!syncEnabled()) return { stop: () => {} };
  const ms = Number(process.env.INNGEST_RECONCILE_MS ?? 60_000);
  if (!Number.isSafeInteger(ms) || ms < 0) {
    throw new Error("INNGEST_RECONCILE_MS must be 0 or a positive integer");
  }
  const hasCloudApps = listRegisteredApps().some(
    (app) => tenantInngestConfigStatus(app.slug).mode === "cloud",
  );
  const cloudMaxAgeMs = inngestCloudSyncMaxAgeMs();
  if (hasCloudApps && ms === 0) {
    throw new Error(
      "INNGEST_RECONCILE_MS=0 is not allowed for Inngest Cloud readiness",
    );
  }
  if (hasCloudApps && cloudMaxAgeMs <= ms) {
    throw new Error(
      "INNGEST_CLOUD_SYNC_MAX_AGE_MS must be greater than INNGEST_RECONCILE_MS",
    );
  }
  if (ms === 0) return { stop: () => {} };
  const timer = setInterval(() => {
    void reconcileApps(logger).catch((error) => {
      logger.warn?.(
        `[inngest-sync] reconciler failed — ${error instanceof Error ? error.message : String(error)}`,
      );
    });
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
