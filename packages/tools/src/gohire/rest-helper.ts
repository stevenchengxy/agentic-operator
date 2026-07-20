/**
 * Shared HTTP wrapper for the GoHire ATS REST API. Mirrors the RoboHire
 * `rest-helper.ts` so a tenant can swap one ATS for the other by changing
 * which tool name they list in `tool_use[]` — same auth + timeout behaviour,
 * same tolerant error envelope.
 *
 * Credential / endpoint resolution order (highest precedence first):
 *   1. ToolContext.config — per-agent binding from the workflow manifest:
 *      `tool_use[]: [{ name: "gohireMatchResumeApi", config: {
 *           api_key_env: "TENANT_X_GOHIRE_KEY", base_url_env: "GOHIRE_API_BASE_URL"
 *      }}]`
 *      `api_key`      — literal key (rare; local override)
 *      `api_key_env`  — name of the env var holding the key (fail-closed:
 *                       if named but unset, the call THROWS — it never falls
 *                       back to the store or a global key)
 *      `base_url_env` — name of the env var holding the endpoint (fail-closed
 *                       the same way; this is how legacy RoboHire-named
 *                       manifests `{api_key_env, base_url_env}` keep working)
 *      `base_url`     — literal endpoint override
 *      `timeout_ms`   — overrides GOHIRE_TIMEOUT_MS
 *   2. DB integration store — the GoHire row the operator configured in
 *      Settings → Integrations (base URL + encrypted API key), resolved via
 *      the injected `resolveIntegrationCreds` seam. THIS is the normal path.
 *   3. Global env: GOHIRE_API_KEY; GOHIRE_BASE_URL (or the documented
 *      GOHIRE_API_BASE_URL mirror), GOHIRE_TIMEOUT_MS
 *
 * The DB layer between (1) and (3) is what makes the Settings UI functional:
 * an operator types a base URL + key, it's encrypted at rest, and every
 * GoHire tool call for that tenant picks it up with no manifest edit.
 */

import type { ToolContext } from "@agentic/agent-kit";
import { resolveIntegrationCreds } from "../integrations/host";

/** Provider key used to look the tenant's row up in the integration store. */
export const GOHIRE_PROVIDER = "gohire";

/** Default base URL when nothing is configured. Always overridable — the
 *  whole point of the Settings integration is that the operator sets this. */
export const GOHIRE_DEFAULT_BASE_URL = "https://api.gohire.io/v1";
const GOHIRE_PROVIDER_HOST = "api.gohire.io";

/** Per-call config the manifest may pass through. All fields optional. */
export interface GoHireToolConfig {
  api_key?: string;
  api_key_env?: string;
  base_url?: string;
  base_url_env?: string;
  timeout_ms?: number;
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

function readConfig(ctx: ToolContext): GoHireToolConfig {
  const c = ctx.config as Record<string, unknown> | undefined;
  if (!c || typeof c !== "object") return {};
  const out: GoHireToolConfig = {};
  if (typeof c.api_key === "string") out.api_key = c.api_key;
  if (typeof c.api_key_env === "string") out.api_key_env = c.api_key_env;
  if (typeof c.base_url === "string") out.base_url = c.base_url;
  if (typeof c.base_url_env === "string") out.base_url_env = c.base_url_env;
  if (typeof c.timeout_ms === "number") out.timeout_ms = c.timeout_ms;
  return out;
}

export function ghBaseUrl(ctx: ToolContext): string {
  const c = readConfig(ctx);

  // Explicit env reference wins and fails closed: legacy RoboHire-named
  // manifests bind `base_url_env: "ROBOHIRE_API_BASE_URL"` (or the GOHIRE_*
  // mirror) and must never silently fall through to the integration store or
  // the provider default when that variable is missing.
  if (c.base_url_env !== undefined) {
    const envName = c.base_url_env.trim();
    if (!ENV_NAME.test(envName)) {
      throw new Error(
        "GoHire base_url_env must be an explicit valid environment variable name.",
      );
    }
    const value = (process.env[envName] ?? "").trim();
    if (!value) {
      throw new Error(
        `GoHire endpoint environment variable ${envName} is not set; refusing to fall back to the integration store or a default endpoint.`,
      );
    }
    return value.replace(/\/$/, "");
  }

  const fromConfig = (c.base_url ?? "").trim();
  if (fromConfig.length > 0) return fromConfig.replace(/\/$/, "");

  const integration = resolveIntegrationCreds(ctx.tenantSlug, GOHIRE_PROVIDER);
  const fromStore = (integration?.base_url ?? "").trim();
  if (fromStore.length > 0) return fromStore.replace(/\/$/, "");

  // GOHIRE_BASE_URL is the primary global name; GOHIRE_API_BASE_URL is the
  // documented mirror in .env.example — honour both so an env-configured
  // deployment keeps pointing at its real vendor host instead of the default.
  const fromEnv = (process.env.GOHIRE_BASE_URL ?? "").trim()
    || (process.env.GOHIRE_API_BASE_URL ?? "").trim();
  return fromEnv.length > 0
    ? fromEnv.replace(/\/$/, "")
    : GOHIRE_DEFAULT_BASE_URL;
}

function usesCustomManifestEndpoint(config: GoHireToolConfig): boolean {
  const raw = config.base_url?.trim();
  if (!raw) return false;
  try {
    const url = new URL(raw);
    return !(
      url.protocol === "https:" &&
      !url.port &&
      url.hostname === GOHIRE_PROVIDER_HOST
    );
  } catch {
    // Invalid manifest endpoints must never unlock an integration/global
    // credential fallback before fetch eventually rejects the URL.
    return true;
  }
}

export function ghAuthToken(ctx: ToolContext): string {
  const c = readConfig(ctx);
  if (c.api_key && c.api_key.trim().length > 0) return c.api_key.trim();
  if (c.api_key_env !== undefined) {
    const envName = c.api_key_env.trim();
    const v = envName ? (process.env[envName] ?? "").trim() : "";
    if (v.length > 0) return v;
    throw new Error(
      `GoHire credential environment variable ${envName || "<empty>"} is not set; refusing to fall back to the integration store or GOHIRE_API_KEY.`,
    );
  }
  if (usesCustomManifestEndpoint(c)) {
    throw new Error(
      "GoHire custom base_url requires an explicit api_key_env; refusing to send an integration or GOHIRE_API_KEY credential to a manifest-configured endpoint.",
    );
  }

  const integration = resolveIntegrationCreds(ctx.tenantSlug, GOHIRE_PROVIDER);
  if (integration?.api_key && integration.api_key.trim().length > 0) {
    return integration.api_key.trim();
  }

  const v = (process.env.GOHIRE_API_KEY ?? "").trim();
  if (v.length > 0) return v;

  throw new Error(
    "GoHire credential not set. Configure it in Settings → Integrations " +
      "(base URL + API key), bind a per-tenant key via the manifest " +
      "`tool_use[].config.api_key_env`, or export GOHIRE_API_KEY before starting the api.",
  );
}

export function ghTimeoutMs(ctx: ToolContext): number {
  const c = readConfig(ctx);
  if (typeof c.timeout_ms === "number" && c.timeout_ms > 0) return c.timeout_ms;
  const n = Number(process.env.GOHIRE_TIMEOUT_MS ?? "30000");
  return Number.isFinite(n) && n > 0 ? n : 30_000;
}

export interface GoHireResponse<T> {
  ok: true;
  status: number;
  data: T;
}

export interface GoHireError {
  ok: false;
  status: number;
  errorBody: unknown;
  message: string;
}

/**
 * JSON-body request to a GoHire endpoint. For multipart endpoints
 * (e.g. /parse-resume) call `fetch` directly with FormData — see
 * `parse-resume.ts` for the reference.
 */
export async function ghFetch<TBody = unknown>(
  ctx: ToolContext,
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH",
  path: string,
  body?: unknown,
): Promise<GoHireResponse<TBody> | GoHireError> {
  const url = ghBaseUrl(ctx) + (path.startsWith("/") ? path : `/${path}`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ghTimeoutMs(ctx));
  try {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${ghAuthToken(ctx)}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    let parsed: unknown = text;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        /* keep as text */
      }
    }
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        errorBody: parsed,
        message: `GoHire ${method} ${path} failed: ${res.status}`,
      };
    }
    return { ok: true, status: res.status, data: parsed as TBody };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      errorBody: null,
      message: `GoHire ${method} ${path} request error: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  } finally {
    clearTimeout(timer);
  }
}
