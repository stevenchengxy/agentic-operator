/**
 * Shared HTTP wrapper for the configured real RoboHire-compatible REST API. Lives in
 * @agentic/tools so every tenant gets the same fetch behaviour without
 * re-implementing retry, auth, and timeout. Originally born in
 * `@tenants/robohire` before tools were promoted to the global registry.
 *
 * Auth and endpoint are always explicit environment references supplied by a
 * confirmed integration profile. Literal credentials/URLs and hardcoded
 * endpoint fallbacks are forbidden:
 *   { api_key_env: "ROBOHIRE_API_KEY",
 *     base_url_env: "ROBOHIRE_API_BASE_URL", timeout_ms: 60000 }
 */

import type { ToolContext } from "@agentic/agent-kit";

/** Non-secret profile config. Environment *values* never enter this object. */
export interface RoboHireToolConfig {
  api_key_env?: string;
  base_url_env?: string;
  timeout_ms?: number;
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

function readConfig(ctx: ToolContext): RoboHireToolConfig {
  const c = ctx.config as Record<string, unknown> | undefined;
  if (!c || typeof c !== "object") return {};
  for (const literal of ["api_key", "base_url", "token", "authorization", "password", "secret"]) {
    if (literal in c) {
      throw new Error(`RoboHire literal config '${literal}' is forbidden; use api_key_env/base_url_env.`);
    }
  }
  const out: RoboHireToolConfig = {};
  if (typeof c.api_key_env === "string") out.api_key_env = c.api_key_env;
  if (typeof c.base_url_env === "string") out.base_url_env = c.base_url_env;
  if (typeof c.timeout_ms === "number") out.timeout_ms = c.timeout_ms;
  return out;
}

function requiredEnvReference(name: string | undefined, label: string): string {
  const envName = name?.trim() ?? "";
  if (!ENV_NAME.test(envName)) {
    throw new Error(`RoboHire ${label} must be an explicit valid environment variable name.`);
  }
  const value = (process.env[envName] ?? "").trim();
  if (!value) throw new Error(`RoboHire environment reference ${envName} is not configured.`);
  return value;
}

export function rhBaseUrl(ctx: ToolContext): string {
  const c = readConfig(ctx);
  const value = requiredEnvReference(c.base_url_env, "base_url_env");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`RoboHire base URL environment reference ${c.base_url_env} is not a valid absolute URL.`);
  }
  if (!new Set(["http:", "https:"]).has(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error(`RoboHire base URL environment reference ${c.base_url_env} must be an http(s) URL without credentials.`);
  }
  return value.replace(/\/$/, "");
}

export function rhAuthToken(ctx: ToolContext): string {
  const c = readConfig(ctx);
  return requiredEnvReference(c.api_key_env, "api_key_env");
}

export function rhTimeoutMs(ctx: ToolContext): number {
  const c = readConfig(ctx);
  if (c.timeout_ms === undefined) return 30_000;
  if (!Number.isFinite(c.timeout_ms) || c.timeout_ms <= 0) {
    throw new Error("RoboHire timeout_ms must be a positive finite number.");
  }
  return c.timeout_ms;
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
