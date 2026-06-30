/**
 * Shared HTTP wrapper for the real RoboHire.io REST API. Lives in
 * @agentic/tools so every tenant gets the same fetch behaviour without
 * re-implementing retry, auth, and timeout. Originally born in
 * `@tenants/robohire` before tools were promoted to the global registry.
 *
 * Auth / endpoint resolution order (highest precedence first):
 *   1. ToolContext.config — per-tenant binding via the workflow manifest:
 *      `tool_use[]: [{ name: "parseResumeApi", config: {
 *           api_key_env: "TENANT_X_RH_KEY", base_url: "...", timeout_ms: 60000
 *      }}]`
 *      `api_key`     — literal API key (rare; useful for local override)
 *      `api_key_env` — name of the env var to read the key from
 *      `base_url`    — overrides ROBOHIRE_BASE_URL
 *      `timeout_ms`  — overrides ROBOHIRE_TIMEOUT_MS
 *   2. Global env: ROBOHIRE_API_KEY, ROBOHIRE_BASE_URL, ROBOHIRE_TIMEOUT_MS
 *
 * The two-level scheme means one tenant can use the production key while
 * another points at a staging key, without restarting the api process or
 * juggling per-process env files.
 */

import type { ToolContext } from "@agentic/agent-kit";

/** Per-call config the manifest may pass through. All fields optional. */
export interface RoboHireToolConfig {
  api_key?: string;
  api_key_env?: string;
  base_url?: string;
  timeout_ms?: number;
}

function readConfig(ctx: ToolContext): RoboHireToolConfig {
  const c = ctx.config as Record<string, unknown> | undefined;
  if (!c || typeof c !== "object") return {};
  const out: RoboHireToolConfig = {};
  if (typeof c.api_key === "string") out.api_key = c.api_key;
  if (typeof c.api_key_env === "string") out.api_key_env = c.api_key_env;
  if (typeof c.base_url === "string") out.base_url = c.base_url;
  if (typeof c.timeout_ms === "number") out.timeout_ms = c.timeout_ms;
  return out;
}

export function rhBaseUrl(ctx: ToolContext): string {
  const c = readConfig(ctx);
  const fromConfig = (c.base_url ?? "").trim();
  if (fromConfig.length > 0) return fromConfig.replace(/\/$/, "");
  // Accept either env name (ROBOHIRE_BASE_URL or ROBOHIRE_API_BASE_URL). Default is the gohire.top
  // host (RoboHire-compatible, serves the same /api/v1/* endpoints).
  const fromEnv = (process.env.ROBOHIRE_BASE_URL ?? process.env.ROBOHIRE_API_BASE_URL ?? "").trim();
  return fromEnv.length > 0
    ? fromEnv.replace(/\/$/, "")
    : "https://api.gohire.top/api/v1";
}

export function rhAuthToken(ctx: ToolContext): string {
  const c = readConfig(ctx);
  if (c.api_key && c.api_key.trim().length > 0) return c.api_key.trim();
  if (c.api_key_env) {
    const v = (process.env[c.api_key_env] ?? "").trim();
    if (v.length > 0) return v;
  }
  const v = (process.env.ROBOHIRE_API_KEY ?? "").trim();
  if (v.length > 0) return v;
  throw new Error(
    "RoboHire credential not set. Either bind a per-tenant key via the manifest " +
      "`tool_use[].config.api_key_env`, or export ROBOHIRE_API_KEY before starting the api.",
  );
}

export function rhTimeoutMs(ctx: ToolContext): number {
  const c = readConfig(ctx);
  if (typeof c.timeout_ms === "number" && c.timeout_ms > 0) return c.timeout_ms;
  const n = Number(process.env.ROBOHIRE_TIMEOUT_MS ?? "30000");
  return Number.isFinite(n) && n > 0 ? n : 30_000;
}

export interface RoboHireResponse<T> {
  ok: true;
  status: number;
  data: T;
}

export interface RoboHireError {
  ok: false;
  status: number;
  errorBody: unknown;
  message: string;
}

/**
 * JSON-body request to a RoboHire endpoint. For multipart endpoints
 * (e.g. /parse-resume), call `fetch` directly with `FormData` — see
 * `parse-resume.ts` for the reference.
 */
export async function rhFetch<TBody = unknown>(
  ctx: ToolContext,
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH",
  path: string,
  body?: unknown,
): Promise<RoboHireResponse<TBody> | RoboHireError> {
  const url = rhBaseUrl(ctx) + (path.startsWith("/") ? path : `/${path}`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), rhTimeoutMs(ctx));
  try {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${rhAuthToken(ctx)}`,
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
        message: `RoboHire ${method} ${path} failed: ${res.status}`,
      };
    }
    return { ok: true, status: res.status, data: parsed as TBody };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      errorBody: null,
      message: `RoboHire ${method} ${path} request error: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  } finally {
    clearTimeout(timer);
  }
}
