/**
 * http.fetch — tenant-configured, SSRF-hardened JSON HTTP client.
 *
 * The workflow manifest owns the endpoint and credential reference. The LLM
 * may choose only a relative path, a bounded method/body, and non-sensitive
 * query/header values. Every request and redirect resolves all DNS answers,
 * rejects non-public targets, and connects to a validated pinned address.
 */

import dns from "node:dns/promises";
import http, {
  type IncomingHttpHeaders,
  type RequestOptions,
  validateHeaderName,
  validateHeaderValue,
} from "node:http";
import https from "node:https";
import net from "node:net";
import type { ToolContext } from "@agentic/agent-kit";
import { defineTool } from "@agentic/agent-kit";
import { z } from "zod";

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
const ALL_METHODS: HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];
const MAX_REDIRECTS = 3;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;

interface HttpFetchConfig {
  base_url?: string;
  timeout_ms?: number;
  default_headers?: Record<string, string>;
  /** Legacy literal field. Persistence and runtime both reject it. */
  api_key?: string;
  api_key_env?: string;
  auth_scheme?: "bearer" | "header" | "query" | "none";
  auth_header_name?: string;
  auth_query_name?: string;
  allow_methods?: HttpMethod[];
  allow_host?: string | string[];
}

interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

interface ResolvedTarget {
  url: URL;
  hostname: string;
  pinned: ResolvedAddress;
}

interface QueryAuth {
  name: string;
  value: string;
}

interface RawResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

type DnsLookupAll = (
  hostname: string,
) => Promise<Array<{ address: string; family: number }>>;

const systemDnsLookupAll: DnsLookupAll = (hostname) =>
  dns.lookup(hostname, { all: true, verbatim: true });
let dnsLookupAll: DnsLookupAll = systemDnsLookupAll;

/** Test seam for deterministic multi-answer/rebinding regressions. */
export function _setHttpFetchDnsLookupForTests(
  implementation: DnsLookupAll | null,
): void {
  dnsLookupAll = implementation ?? systemDnsLookupAll;
}

const SENSITIVE_NAME_PATTERN =
  /(?:^|[-_.])(?:api[-_.]?key|private[-_.]?key|secret|password|passphrase|access[-_.]?token|refresh[-_.]?token|auth(?:entication)?[-_.]?token|authorization|proxy[-_.]?authorization|credential|cookie|token|auth)(?:$|[-_.])/i;
const FORBIDDEN_CALL_HEADER_NAMES = new Set([
  "connection",
  "content-length",
  "host",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function readConfig(ctx: ToolContext): HttpFetchConfig {
  return (ctx.config ?? {}) as HttpFetchConfig;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizedHostname(value: string): string {
  return value
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase();
}

function isLoopbackAddress(address: string): boolean {
  const normalized = normalizedHostname(address).split("%")[0]!;
  if (net.isIPv4(normalized)) return normalized.split(".")[0] === "127";
  if (!net.isIPv6(normalized)) return false;
  return normalized === "::1" || normalized === "0:0:0:0:0:0:0:1";
}

function parseIpv6Words(input: string): number[] | null {
  let value = input.toLowerCase().split("%")[0]!;
  if (value.includes(".")) {
    const colon = value.lastIndexOf(":");
    if (colon < 0) return null;
    const octets = value
      .slice(colon + 1)
      .split(".")
      .map(Number);
    if (
      octets.length !== 4 ||
      octets.some(
        (octet) => !Number.isInteger(octet) || octet < 0 || octet > 255,
      )
    ) {
      return null;
    }
    value = `${value.slice(0, colon)}:${((octets[0]! << 8) | octets[1]!).toString(16)}:${((octets[2]! << 8) | octets[3]!).toString(16)}`;
  }
  if (value.indexOf("::") !== value.lastIndexOf("::")) return null;
  const compressed = value.includes("::");
  const [leftRaw, rightRaw = ""] = compressed ? value.split("::") : [value, ""];
  const parseSide = (side: string): number[] | null => {
    if (!side) return [];
    const parts = side.split(":");
    if (parts.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;
    return parts.map((part) => Number.parseInt(part, 16));
  };
  const left = parseSide(leftRaw ?? "");
  const right = parseSide(rightRaw);
  if (!left || !right) return null;
  if (!compressed) return left.length === 8 ? left : null;
  const zeroCount = 8 - left.length - right.length;
  return zeroCount >= 1
    ? [...left, ...Array<number>(zeroCount).fill(0), ...right]
    : null;
}

/** Conservative public-address predicate. Unknown and special ranges fail closed. */
function isBlockedAddress(address: string): boolean {
  const normalized = normalizedHostname(address).split("%")[0]!;
  if (net.isIPv4(normalized)) {
    const parts = normalized.split(".").map(Number);
    if (
      parts.length !== 4 ||
      parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
    ) {
      return true;
    }
    const [a, b, c] = parts as [number, number, number, number];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 192 && b === 88 && c === 99) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113) ||
      a >= 224
    );
  }
  if (!net.isIPv6(normalized)) return true;
  const words = parseIpv6Words(normalized);
  if (!words) return true;
  const mapped =
    words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff;
  if (mapped) {
    return isBlockedAddress(
      `${words[6]! >> 8}.${words[6]! & 0xff}.${words[7]! >> 8}.${words[7]! & 0xff}`,
    );
  }
  // Public IPv6 unicast is 2000::/3. Remove documented/special allocations.
  if ((words[0]! & 0xe000) !== 0x2000) return true;
  if (
    words[0] === 0x2001 &&
    (words[1] === 0x0000 ||
      (words[1] === 0x0002 && words[2] === 0) ||
      words[1] === 0x0db8 ||
      (words[1]! & 0xfff0) === 0x0010 ||
      (words[1]! & 0xfff0) === 0x0020)
  ) {
    return true;
  }
  if (words[0] === 0x2002) return true;
  if (words[0] === 0x3fff && (words[1]! & 0xf000) === 0) return true;
  return false;
}

function isInternalHostname(hostname: string): boolean {
  const host = normalizedHostname(hostname);
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "host.docker.internal" ||
    host === "metadata.google.internal" ||
    host === "kubernetes.default" ||
    host.endsWith(".internal") ||
    host.endsWith(".local") ||
    host.endsWith(".lan")
  );
}

function devLocalhostAllowed(): boolean {
  return (
    process.env.NODE_ENV !== "production" &&
    process.env.AGENTIC_FETCH_ALLOW_HTTP_LOCALHOST === "1"
  );
}

function isExplicitDevLocalhost(hostname: string): boolean {
  const host = normalizedHostname(hostname);
  return (
    devLocalhostAllowed() && (host === "localhost" || isLoopbackAddress(host))
  );
}

function normalizeAllowedHost(value: string): string | null {
  const raw = value.trim();
  if (!raw || raw.includes("*") || raw.includes("/") || raw.includes("@")) {
    return null;
  }
  const unbracketed = raw.replace(/^\[|\]$/g, "");
  if (net.isIP(unbracketed)) return unbracketed.toLowerCase();
  if (raw.includes(":")) return null;
  const host = normalizedHostname(raw);
  if (
    host.length > 253 ||
    !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host) ||
    host.split(".").some((label) => !label || label.length > 63)
  ) {
    return null;
  }
  return host;
}

function configuredAllowedHosts(cfg: HttpFetchConfig): Set<string> {
  const raw = Array.isArray(cfg.allow_host)
    ? cfg.allow_host
    : typeof cfg.allow_host === "string"
      ? [cfg.allow_host]
      : [];
  if (raw.length === 0) {
    throw new Error(
      "http.fetch: tool_use[].config.allow_host is required and must exactly match base_url.",
    );
  }
  const hosts = new Set<string>();
  for (const value of raw) {
    const host = normalizeAllowedHost(value);
    if (!host) {
      throw new Error(
        "http.fetch: allow_host entries must be exact hostnames without schemes, ports, paths, or wildcards.",
      );
    }
    if (
      (isInternalHostname(host) ||
        (net.isIP(host) > 0 && isBlockedAddress(host))) &&
      !isExplicitDevLocalhost(host)
    ) {
      throw new Error(
        `http.fetch: allow_host '${host}' is internal or non-public.`,
      );
    }
    hosts.add(host);
  }
  return hosts;
}

function pathWithin(urlPath: string, configuredPath: string): boolean {
  const prefix = configuredPath.replace(/\/+$/, "");
  return !prefix || urlPath === prefix || urlPath.startsWith(`${prefix}/`);
}

function serverEndpointAllowlisted(url: URL): boolean {
  if (isExplicitDevLocalhost(url.hostname)) return true;
  const entries = (process.env.AGENTIC_WORKFLOW_ENDPOINT_ALLOWLIST ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  for (const entry of entries) {
    try {
      const allowed = new URL(entry);
      if (
        url.origin === allowed.origin &&
        pathWithin(url.pathname, allowed.pathname)
      ) {
        return true;
      }
    } catch {
      if (
        normalizedHostname(url.hostname) === normalizedHostname(entry) ||
        url.host.toLowerCase() === entry.toLowerCase()
      ) {
        return true;
      }
    }
  }
  return false;
}

function assertNoSensitiveQuery(url: URL, permitted?: QueryAuth): void {
  for (const [name, value] of url.searchParams.entries()) {
    if (!SENSITIVE_NAME_PATTERN.test(name)) continue;
    if (permitted && name === permitted.name && value === permitted.value) {
      continue;
    }
    throw new Error(
      `http.fetch: sensitive query parameter '${name}' is not allowed; bind authentication with api_key_env.`,
    );
  }
}

function assertEndpoint(
  url: URL,
  allowedHosts: Set<string>,
  configuredBase: URL,
  permittedQuery?: QueryAuth,
): void {
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new Error(
      "http.fetch: endpoint must be an absolute HTTP(S) URL without credentials or fragments.",
    );
  }
  const host = normalizedHostname(url.hostname);
  if (!allowedHosts.has(host)) {
    throw new Error(
      `http.fetch: host '${host}' does not exactly match allow_host.`,
    );
  }
  const devLocal = isExplicitDevLocalhost(host);
  if (url.protocol !== "https:" && !devLocal) {
    throw new Error(
      "http.fetch: HTTPS is required for non-development endpoints.",
    );
  }
  if (
    (isInternalHostname(host) ||
      (net.isIP(host) > 0 && isBlockedAddress(host))) &&
    !devLocal
  ) {
    throw new Error(
      `http.fetch: endpoint host '${host}' is internal or non-public.`,
    );
  }
  if (url.origin !== configuredBase.origin) {
    throw new Error(
      `http.fetch: redirect origin '${url.origin}' differs from configured base_url origin.`,
    );
  }
  if (!pathWithin(url.pathname, configuredBase.pathname)) {
    throw new Error(
      `http.fetch: endpoint path '${url.pathname}' escapes configured base_url path.`,
    );
  }
  if (!serverEndpointAllowlisted(url)) {
    throw new Error(
      "http.fetch: endpoint is not authorized by AGENTIC_WORKFLOW_ENDPOINT_ALLOWLIST.",
    );
  }
  assertNoSensitiveQuery(url, permittedQuery);
}

function parseBaseUrl(cfg: HttpFetchConfig, allowedHosts: Set<string>): URL {
  if (typeof cfg.api_key === "string" && cfg.api_key.trim()) {
    throw new Error(
      "http.fetch: literal config.api_key is forbidden; use a tenant-owned api_key_env.",
    );
  }
  if (typeof cfg.base_url !== "string" || !cfg.base_url.trim()) {
    throw new Error("http.fetch: tool_use[].config.base_url is required.");
  }
  let url: URL;
  try {
    url = new URL(cfg.base_url);
  } catch {
    throw new Error("http.fetch: config.base_url must be an absolute URL.");
  }
  assertEndpoint(url, allowedHosts, url);
  return url;
}

function buildUrl(base: URL, path: string, query: unknown): URL {
  const trimmed = path.trim();
  if (!trimmed) throw new Error("http.fetch: required arg `path` is missing.");
  if (
    /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ||
    trimmed.startsWith("//") ||
    trimmed.startsWith("\\") ||
    trimmed.includes("\\")
  ) {
    throw new Error(
      "http.fetch: path must be relative to config.base_url; absolute URL overrides are forbidden.",
    );
  }
  if (trimmed.includes("#")) {
    throw new Error("http.fetch: path fragments are not allowed.");
  }

  const baseDirectory = new URL(base.origin);
  const basePath = base.pathname.replace(/\/+$/, "");
  baseDirectory.pathname = `${basePath}/`;
  const joined = new URL(trimmed.replace(/^\/+/, ""), baseDirectory);
  if (
    joined.origin !== base.origin ||
    (joined.pathname !== basePath &&
      !joined.pathname.startsWith(`${basePath}/`))
  ) {
    throw new Error("http.fetch: path may not escape config.base_url.");
  }

  const pathQuery = new URLSearchParams(joined.search);
  joined.search = base.search;
  for (const [name, value] of pathQuery)
    joined.searchParams.append(name, value);

  if (query !== undefined && query !== null) {
    if (!isRecord(query)) {
      throw new Error(
        "http.fetch: query must be an object of primitive values.",
      );
    }
    for (const [name, value] of Object.entries(query)) {
      if (value === null || value === undefined) continue;
      if (SENSITIVE_NAME_PATTERN.test(name)) {
        throw new Error(
          `http.fetch: sensitive query parameter '${name}' is not allowed; bind authentication with api_key_env.`,
        );
      }
      if (
        typeof value !== "string" &&
        typeof value !== "number" &&
        typeof value !== "boolean"
      ) {
        throw new Error(
          `http.fetch: query parameter '${name}' must be a string, number, or boolean.`,
        );
      }
      joined.searchParams.append(name, String(value));
    }
  }
  assertNoSensitiveQuery(joined);
  return joined;
}

function addSafeHeaders(
  output: Record<string, string>,
  raw: unknown,
  source: "default_headers" | "headers",
): void {
  if (raw === undefined || raw === null) return;
  if (!isRecord(raw)) {
    throw new Error(
      `http.fetch: ${source} must be an object of string values.`,
    );
  }
  for (const [name, value] of Object.entries(raw)) {
    if (typeof value !== "string") {
      throw new Error(`http.fetch: ${source}.${name} must be a string.`);
    }
    const lower = name.toLowerCase();
    if (
      SENSITIVE_NAME_PATTERN.test(name) ||
      FORBIDDEN_CALL_HEADER_NAMES.has(lower)
    ) {
      throw new Error(
        `http.fetch: ${source} may not set sensitive or connection-controlled header '${name}'.`,
      );
    }
    try {
      validateHeaderName(name);
      validateHeaderValue(name, value);
    } catch {
      throw new Error(
        `http.fetch: ${source} contains an invalid header '${name}'.`,
      );
    }
    output[name] = value;
  }
}

function tenantEnvPrefix(tenantSlug: string): string {
  return `TENANT_${tenantSlug.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_`;
}

function resolveApiKey(
  cfg: HttpFetchConfig,
  tenantSlug: string,
): string | null {
  if (typeof cfg.api_key === "string" && cfg.api_key.trim()) {
    throw new Error(
      "http.fetch: literal config.api_key is forbidden; use a tenant-owned api_key_env.",
    );
  }
  if (typeof cfg.api_key_env !== "string" || !cfg.api_key_env.trim()) {
    return null;
  }
  const envName = cfg.api_key_env.trim();
  const shared = new Set(
    (process.env.AGENTIC_WORKFLOW_SHARED_ENV_ALLOWLIST ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
  if (
    !envName.startsWith(tenantEnvPrefix(tenantSlug)) &&
    !shared.has(envName)
  ) {
    throw new Error(
      `http.fetch: api_key_env must be tenant-owned for '${tenantSlug}' or exactly shared by server policy.`,
    );
  }
  const value = (process.env[envName] ?? "").trim();
  if (!value) {
    throw new Error(
      `http.fetch: api_key_env '${envName}' is configured but unset or empty.`,
    );
  }
  return value;
}

function buildHeadersAndAuth(
  cfg: HttpFetchConfig,
  perCallHeaders: unknown,
  tenantSlug: string,
): { headers: Record<string, string>; queryAuth?: QueryAuth } {
  const headers: Record<string, string> = { Accept: "application/json" };
  addSafeHeaders(headers, cfg.default_headers, "default_headers");
  addSafeHeaders(headers, perCallHeaders, "headers");

  const key = resolveApiKey(cfg, tenantSlug);
  const scheme = cfg.auth_scheme ?? (key ? "bearer" : "none");
  if (!(["bearer", "header", "query", "none"] as string[]).includes(scheme)) {
    throw new Error(`http.fetch: unsupported auth_scheme '${String(scheme)}'.`);
  }
  if (scheme === "none") return { headers };
  if (!key) {
    throw new Error(
      `http.fetch: auth_scheme '${scheme}' requires a configured, non-empty api_key_env.`,
    );
  }
  if (scheme === "bearer") {
    headers.Authorization = `Bearer ${key}`;
    return { headers };
  }
  if (scheme === "header") {
    const name = cfg.auth_header_name ?? "X-API-Key";
    if (FORBIDDEN_CALL_HEADER_NAMES.has(name.toLowerCase())) {
      throw new Error(`http.fetch: invalid auth_header_name '${name}'.`);
    }
    try {
      validateHeaderName(name);
      validateHeaderValue(name, key);
    } catch {
      throw new Error(`http.fetch: invalid auth_header_name '${name}'.`);
    }
    headers[name] = key;
    return { headers };
  }
  const name = cfg.auth_query_name ?? "api_key";
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(name)) {
    throw new Error(`http.fetch: invalid auth_query_name '${name}'.`);
  }
  return { headers, queryAuth: { name, value: key } };
}

function assertMethodAllowed(method: HttpMethod, cfg: HttpFetchConfig): void {
  const allowed = cfg.allow_methods ?? ALL_METHODS;
  if (!Array.isArray(allowed) || !allowed.includes(method)) {
    throw new Error(
      `http.fetch: method '${method}' not in allow_methods (${Array.isArray(allowed) ? allowed.join(", ") : "invalid"}).`,
    );
  }
}

async function resolveTarget(
  url: URL,
  allowedHosts: Set<string>,
  configuredBase: URL,
  queryAuth?: QueryAuth,
): Promise<ResolvedTarget> {
  assertEndpoint(url, allowedHosts, configuredBase, queryAuth);
  const hostname = normalizedHostname(url.hostname);
  let addresses: ResolvedAddress[];
  try {
    if (net.isIP(hostname)) {
      addresses = [{ address: hostname, family: net.isIPv4(hostname) ? 4 : 6 }];
    } else {
      const answers = await dnsLookupAll(hostname);
      addresses = answers.map((answer) => ({
        address: answer.address,
        family: answer.family as 4 | 6,
      }));
    }
  } catch (error) {
    throw new Error(
      `http.fetch: DNS resolution failed for '${hostname}': ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (addresses.length === 0) {
    throw new Error(
      `http.fetch: DNS resolution returned no addresses for '${hostname}'.`,
    );
  }
  const devLocal = isExplicitDevLocalhost(hostname);
  if (devLocal) {
    if (addresses.some((answer) => !isLoopbackAddress(answer.address))) {
      throw new Error(
        `http.fetch: development localhost '${hostname}' resolved outside loopback.`,
      );
    }
  } else {
    const blocked = addresses.find((answer) =>
      isBlockedAddress(answer.address),
    );
    if (blocked) {
      throw new Error(
        `http.fetch: endpoint '${hostname}' resolved to non-public address ${blocked.address}.`,
      );
    }
  }
  return { url, hostname, pinned: addresses[0]! };
}

function headerValue(
  headers: IncomingHttpHeaders,
  name: string,
): string | null {
  const value = headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0] ?? null;
  return typeof value === "string" ? value : null;
}

function requestOnce(
  target: ResolvedTarget,
  method: HttpMethod,
  headers: Record<string, string>,
  body: string | undefined,
  timeoutMs: number,
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const options: RequestOptions & { servername?: string } = {
      protocol: target.url.protocol,
      hostname: target.pinned.address,
      port: target.url.port || undefined,
      method,
      path: `${target.url.pathname}${target.url.search}`,
      headers: { ...headers, Host: target.url.host },
      agent: false,
      ...(target.url.protocol === "https:"
        ? { servername: target.hostname }
        : {}),
    };
    const transport = target.url.protocol === "https:" ? https : http;
    const req = transport.request(options, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        res.destroy();
        finish(() =>
          resolve({ status, headers: res.headers, body: Buffer.alloc(0) }),
        );
        return;
      }
      const chunks: Buffer[] = [];
      let received = 0;
      res.on("data", (raw: Buffer | string) => {
        const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        received += chunk.byteLength;
        if (received > MAX_RESPONSE_BYTES) {
          res.destroy(
            new Error(
              `http.fetch: response exceeded ${MAX_RESPONSE_BYTES} bytes.`,
            ),
          );
          return;
        }
        chunks.push(chunk);
      });
      res.once("end", () =>
        finish(() =>
          resolve({
            status,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        ),
      );
      res.once("error", (error) => finish(() => reject(error)));
    });
    const timer = setTimeout(() => {
      req.destroy(
        new Error(`http.fetch: request timed out after ${timeoutMs}ms.`),
      );
    }, timeoutMs);
    req.once("error", (error) => finish(() => reject(error)));
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function safeDisplayUrl(url: URL): string {
  return `${url.origin}${url.pathname}${url.search ? "?[redacted]" : ""}`;
}

async function requestWithRedirects(input: {
  initialUrl: URL;
  baseUrl: URL;
  allowedHosts: Set<string>;
  method: HttpMethod;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
  queryAuth?: QueryAuth;
}): Promise<RawResponse & { finalUrl: URL; method: HttpMethod }> {
  let current = new URL(input.initialUrl);
  let method = input.method;
  let body = input.body;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    assertNoSensitiveQuery(current, input.queryAuth);
    if (input.queryAuth) {
      current.searchParams.set(input.queryAuth.name, input.queryAuth.value);
    }
    const target = await resolveTarget(
      current,
      input.allowedHosts,
      input.baseUrl,
      input.queryAuth,
    );
    const response = await requestOnce(
      target,
      method,
      input.headers,
      body,
      input.timeoutMs,
    );
    if (response.status < 300 || response.status >= 400) {
      return { ...response, finalUrl: current, method };
    }
    const location = headerValue(response.headers, "location");
    if (!location) return { ...response, finalUrl: current, method };
    if (hop === MAX_REDIRECTS) {
      throw new Error(
        `http.fetch: redirect limit (${MAX_REDIRECTS}) exceeded.`,
      );
    }
    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      throw new Error("http.fetch: upstream returned an invalid redirect URL.");
    }
    // Validate the raw Location before adding server-owned query auth.
    assertEndpoint(next, input.allowedHosts, input.baseUrl, input.queryAuth);
    if (
      response.status === 303 ||
      ((response.status === 301 || response.status === 302) &&
        method === "POST")
    ) {
      method = "GET";
      body = undefined;
    }
    current = next;
  }
  throw new Error("http.fetch: redirect loop exited unexpectedly.");
}

function publicResponseHeaders(
  headers: IncomingHttpHeaders,
): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [name, raw] of Object.entries(headers)) {
    if (SENSITIVE_NAME_PATTERN.test(name) || name === "set-cookie") continue;
    if (Array.isArray(raw)) output[name] = raw.join(", ");
    else if (typeof raw === "string") output[name] = raw;
    else if (typeof raw === "number") output[name] = String(raw);
  }
  return output;
}

export const httpFetchTool = defineTool({
  name: "http.fetch",
  description:
    "Generic JSON HTTP client for one manifest-bound public HTTPS origin. Pass { method, path, body?, query?, headers? }; path must be relative and sensitive headers/query values are supplied only through tenant-owned config references. Returns { status, ok, headers, body }.",
  output: z.object({
    status: z.number().int(),
    ok: z.boolean(),
    headers: z.record(z.string(), z.string()),
    body: z.unknown(),
  }),
  async handler(ctx) {
    const args = (ctx.event?.data ?? {}) as Record<string, unknown>;
    const cfg = readConfig(ctx);

    const rawMethod =
      typeof args.method === "string" ? args.method.toUpperCase() : "GET";
    if (!ALL_METHODS.includes(rawMethod as HttpMethod)) {
      throw new Error(
        `http.fetch: method must be one of ${ALL_METHODS.join(", ")} (got '${String(args.method)}').`,
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
      throw new Error("http.fetch: required arg `path` is missing.");
    }

    const allowedHosts = configuredAllowedHosts(cfg);
    const baseUrl = parseBaseUrl(cfg, allowedHosts);
    const url = buildUrl(baseUrl, path, args.query);
    const { headers, queryAuth } = buildHeadersAndAuth(
      cfg,
      args.headers,
      ctx.tenantSlug,
    );

    let body: string | undefined;
    if (args.body !== undefined && method !== "GET") {
      body =
        typeof args.body === "string" ? args.body : JSON.stringify(args.body);
      if (Buffer.byteLength(body, "utf8") > MAX_REQUEST_BYTES) {
        throw new Error(
          `http.fetch: request body exceeded ${MAX_REQUEST_BYTES} bytes.`,
        );
      }
      if (
        typeof args.body !== "string" &&
        !headers["Content-Type"] &&
        !headers["content-type"]
      ) {
        headers["Content-Type"] = "application/json";
      }
    }

    const timeoutMs =
      typeof cfg.timeout_ms === "number" &&
      Number.isFinite(cfg.timeout_ms) &&
      cfg.timeout_ms > 0
        ? Math.min(Math.floor(cfg.timeout_ms), 120_000)
        : 30_000;
    let response: Awaited<ReturnType<typeof requestWithRedirects>>;
    try {
      response = await requestWithRedirects({
        initialUrl: url,
        baseUrl,
        allowedHosts,
        method,
        headers,
        body,
        timeoutMs,
        queryAuth,
      });
    } catch (error) {
      throw new Error(
        `http.fetch: ${method} ${safeDisplayUrl(url)} — ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const text = response.body.toString("utf8");
    const contentType = headerValue(response.headers, "content-type") ?? "";
    let parsed: unknown = text;
    if (text && /json/i.test(contentType)) {
      try {
        parsed = JSON.parse(text);
      } catch {
        // Keep malformed upstream JSON as text so the agent can inspect it.
      }
    }

    return {
      data: {
        status: response.status,
        ok: response.status >= 200 && response.status < 300,
        headers: publicResponseHeaders(response.headers),
        body: parsed,
      },
      meta: {
        url: safeDisplayUrl(response.finalUrl),
        method: response.method,
      },
    };
  },
});
