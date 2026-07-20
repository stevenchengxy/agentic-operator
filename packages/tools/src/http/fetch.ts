/**
 * http.fetch — generic JSON HTTP client.
 *
 * Lets any agent talk to any HTTP API without shipping a tenant-specific
 * wrapper. The agent's manifest binds the base URL + auth scheme + default
 * headers via `tool_use[].config`; the LLM only supplies the per-call
 * `{ method, path, body?, query? }` it needs.
 *
 * Per-tenant configuration (manifest `tool_use[].config`):
 *   {
 *     base_url?:        string,           // prepended to `path` (no trailing /)
 *     timeout_ms?:      number,           // default 30000
 *     default_headers?: Record<string,string>, // merged with per-call headers
 *     api_key?:         string,           // literal key (dev/local override)
 *     api_key_env?:     string,           // env var holding the key
 *     auth_scheme?:     "bearer" | "header" | "query" | "none",
 *                                         // bearer (default) → Authorization: Bearer <key>
 *                                         // header          → uses `auth_header_name` (default "X-API-Key")
 *                                         // query           → uses `auth_query_name` (default "api_key")
 *                                         // none            → no auth
 *     auth_header_name?: string,
 *     auth_query_name?:  string,
 *     allow_methods?:   ("GET"|"POST"|"PUT"|"PATCH"|"DELETE")[],
 *                                         // safety allow-list; default any
 *     allow_host?:      string | string[], // additional hosts beyond base_url
 *   }
 *
 * LLM-provided args:
 *   {
 *     method:   "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
 *     path:     string,                    // joined to base_url
 *     query?:   Record<string, string|number|boolean>,
 *     body?:    unknown,                   // JSON-encoded
 *     headers?: Record<string, string>,    // merged on top of default_headers
 *   }
 *
 * Returns:
 *   { status, ok, headers, body }   // body is parsed JSON when content-type
 *                                   // includes "json"; otherwise raw text
 *
 * Errors:
 *   - Throws on network failure / timeout / unparseable URL.
 *   - Throws on non-2xx and includes a bounded response-body diagnostic. The
 *     LLM tool loop receives that as a real tool error and can self-correct;
 *     a declarative `type: "tool"` step also fails instead of letting a 4xx/5xx
 *     response mark the workflow run successful.
 */

import type { ToolContext } from "@agentic/agent-kit";
import { defineTool } from "@agentic/agent-kit";
import { z } from "zod";
import { assertPublicUrl, safeFetch } from "../declarative/ssrf";

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
const ALL_METHODS: HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];

interface HttpFetchConfig {
  base_url?: string;
  timeout_ms?: number;
  default_headers?: Record<string, string>;
  api_key?: string;
  api_key_env?: string;
  auth_scheme?: "bearer" | "header" | "query" | "none";
  auth_header_name?: string;
  auth_query_name?: string;
  allow_methods?: HttpMethod[];
  allow_host?: string | string[];
}

function readConfig(ctx: ToolContext): HttpFetchConfig {
  return (ctx.config ?? {}) as HttpFetchConfig;
}

function resolveApiKey(cfg: HttpFetchConfig): string | null {
  if (typeof cfg.api_key === "string" && cfg.api_key.length > 0) return cfg.api_key;
  if (typeof cfg.api_key_env === "string" && cfg.api_key_env.length > 0) {
    const v = (process.env[cfg.api_key_env] ?? "").trim();
    if (v.length > 0) return v;
  }
  return null;
}

function buildUrl(cfg: HttpFetchConfig, path: string, query?: Record<string, unknown>): URL {
  const base = (cfg.base_url ?? "").replace(/\/$/, "");
  const absoluteIncoming = /^https?:\/\//i.test(path);
  if (!absoluteIncoming && !base) {
    throw new Error("http.fetch: config.base_url is required for relative paths.");
  }
  const composed = absoluteIncoming ? path : `${base}${path.startsWith("/") ? path : `/${path}`}`;
  if (composed.length === 0) {
    throw new Error(
      "http.fetch: no URL — set tool_use[].config.base_url or pass an absolute path.",
    );
  }
  const url = assertPublicUrl(composed);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v == null) continue;
      url.searchParams.append(k, String(v));
    }
  }
  return url;
}

function normalizedHost(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (!value) throw new Error("http.fetch: allow_host contains an empty host.");
  const parsed = assertPublicUrl(/^https?:\/\//i.test(value) ? value : `https://${value}`);
  return parsed.hostname.toLowerCase();
}

function allowedHosts(cfg: HttpFetchConfig): Set<string> {
  const allow = new Set<string>();
  if (cfg.base_url?.trim()) allow.add(assertPublicUrl(cfg.base_url.trim()).hostname.toLowerCase());
  const extra = cfg.allow_host
    ? Array.isArray(cfg.allow_host)
      ? cfg.allow_host
      : [cfg.allow_host]
    : [];
  for (const host of extra) allow.add(normalizedHost(host));
  return allow;
}

function assertHostAllowed(url: URL, allow: Set<string>): void {
  if (!allow.has(url.hostname.toLowerCase())) {
    throw new Error(
      `http.fetch: host '${url.hostname}' is not allowed; configure it as base_url or explicit allow_host (${[...allow].join(", ") || "none"}).`,
    );
  }
}

function assertMethodAllowed(method: HttpMethod, cfg: HttpFetchConfig): void {
  const allow = cfg.allow_methods ?? ALL_METHODS;
  if (!allow.includes(method)) {
    throw new Error(
      `http.fetch: method '${method}' not in allow_methods (${allow.join(", ")}).`,
    );
  }
}

function buildHeaders(cfg: HttpFetchConfig, perCall: Record<string, string> | undefined, url: URL): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (cfg.default_headers) {
    for (const [k, v] of Object.entries(cfg.default_headers)) headers[k] = v;
  }
  if (perCall) {
    for (const [k, v] of Object.entries(perCall)) headers[k] = v;
  }
  // Auth injection
  const scheme = cfg.auth_scheme ?? (resolveApiKey(cfg) ? "bearer" : "none");
  if (scheme !== "none") {
    const key = resolveApiKey(cfg);
    if (key) {
      if (scheme === "bearer") {
        headers.Authorization = `Bearer ${key}`;
      } else if (scheme === "header") {
        headers[cfg.auth_header_name ?? "X-API-Key"] = key;
      } else if (scheme === "query") {
        url.searchParams.set(cfg.auth_query_name ?? "api_key", key);
      }
    }
  }
  return headers;
}

export const httpFetchTool = defineTool({
  name: "http.fetch",
  description:
    "Generic JSON HTTP client. Pass { method, path, body?, query?, headers? }. " +
    "The base URL, auth scheme, default headers, timeout, method/host allow-lists, and " +
    "per-tenant API key are bound in the manifest's tool_use[].config block. " +
    "Returns { status, ok, headers, body } for 2xx. 4xx/5xx throw a bounded error so " +
    "both direct workflow steps and LLM tool loops observe a real failure.",
  output: z.object({
    status: z.number().int(),
    ok: z.boolean(),
    headers: z.record(z.string(), z.string()),
    body: z.unknown(),
  }),
  async handler(ctx) {
    const args = (ctx.event?.data ?? {}) as Record<string, unknown>;
    const cfg = readConfig(ctx);

    const rawMethod = typeof args.method === "string" ? args.method.toUpperCase() : "GET";
    if (!ALL_METHODS.includes(rawMethod as HttpMethod)) {
      throw new Error(
        `http.fetch: method must be one of ${ALL_METHODS.join(", ")} (got '${args.method}').`,
      );
    }
    const method = rawMethod as HttpMethod;
    assertMethodAllowed(method, cfg);

    const path =
      typeof args.path === "string"
        ? args.path
        : typeof args.url === "string"
          ? args.url
          : "";
    if (!path) {
      throw new Error("http.fetch: required arg `path` (or `url`) is missing.");
    }

    const url = buildUrl(cfg, path, (args.query ?? undefined) as Record<string, unknown> | undefined);
    const hostAllowlist = allowedHosts(cfg);
    assertHostAllowed(url, hostAllowlist);
    const headers = buildHeaders(
      cfg,
      (args.headers ?? undefined) as Record<string, string> | undefined,
      url,
    );

    let body: BodyInit | undefined;
    if (args.body !== undefined && method !== "GET") {
      if (typeof args.body === "string") {
        body = args.body;
      } else {
        body = JSON.stringify(args.body);
        if (!headers["Content-Type"] && !headers["content-type"]) {
          headers["Content-Type"] = "application/json";
        }
      }
    }

    const timeoutMs =
      typeof cfg.timeout_ms === "number" && cfg.timeout_ms > 0 ? cfg.timeout_ms : 30_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await safeFetch(url.toString(), {
        method,
        headers,
        body,
        signal: controller.signal,
      }, fetch, 3, (redirectUrl) => assertHostAllowed(redirectUrl, hostAllowlist));
    } catch (err) {
      throw new Error(
        `http.fetch: ${method} ${url.toString()} — ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    const ctype = res.headers.get("content-type") ?? "";
    let parsed: unknown = text;
    if (text.length > 0 && /json/i.test(ctype)) {
      try {
        parsed = JSON.parse(text);
      } catch {
        /* keep as text */
      }
    }

    const headerObj: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headerObj[k] = v;
    });

    if (!res.ok) {
      const diagnostic =
        typeof parsed === "string"
          ? parsed
          : (() => {
              try {
                return JSON.stringify(parsed);
              } catch {
                return "[unserializable response body]";
              }
            })();
      throw new Error(
        `http.fetch: ${method} ${url.toString()} returned HTTP ${res.status}: ${diagnostic.slice(0, 500)}`,
      );
    }

    return {
      data: {
        status: res.status,
        ok: res.ok,
        headers: headerObj,
        body: parsed,
      },
      meta: { url: url.toString(), method },
    };
  },
});
