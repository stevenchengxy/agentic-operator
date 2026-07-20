/**
 * SSRF guard for outbound `fetch-url` (and any future server-side fetch).
 *
 * Background — review S1 (BLOCKER): the v0 design said "5 MB cap and content-
 * type allow-list" but did not filter the target IP. An operator could `POST
 * { url: "http://169.254.169.254/latest/meta-data/iam/security-credentials/" }`
 * and exfiltrate AWS instance credentials, or hit RFC1918 hosts on the
 * cluster network.
 *
 * The protocol (also documented in
 * `docs/design/import-workflow-manifest.md` §"SSRF protocol for fetch-url"):
 *
 *   1. Require `https:` — or `http:` + hostname `localhost` only when
 *      `AGENTIC_FETCH_ALLOW_HTTP_LOCALHOST=1` (dev opt-in).
 *   2. Resolve every hostname address via
 *      `dns.promises.lookup({ family: 0, all: true })`. Reject the whole hop
 *      when any answer is non-public, then pin one validated answer into the
 *      HTTP(S) socket lookup so DNS cannot change between policy and connect.
 *      Reject if any resolved address is:
 *        - loopback (`127.0.0.0/8`)
 *        - RFC1918 private (`10/8`, `172.16/12`, `192.168/16`)
 *        - link-local (`169.254.0.0/16`) including AWS metadata
 *        - IPv6 loopback (`::1`), link-local (`fe80::/10`), or ULA (`fd00::/8`)
 *        - the zero address (`0.0.0.0`)
 *   3. Use the built-in HTTP(S) client with redirects disabled. Follow up to
 *      3 hops, resolving, validating, and pinning each `Location` separately.
 *   4. Stream-count body bytes; abort on > MAX_BYTES (do NOT trust
 *      `Content-Length` — a malicious server can lie or stream forever).
 *   5. Validate content-type against an allow-list before reading the body
 *      AND after (some servers chunk-update headers).
 *   6. 5 s connect timeout, 5 s body timeout (separate AbortControllers).
 *
 * Reject all non-`http(s):` schemes — `file:`, `ftp:`, `data:`, `gopher:`,
 * `dict:`, `ssh:`, etc.
 */

import dns from "node:dns/promises";
import http, {
  type IncomingHttpHeaders,
  type IncomingMessage,
} from "node:http";
import https, { type RequestOptions } from "node:https";
import net from "node:net";
import type { LookupFunction } from "node:net";

const FETCH_CONNECT_TIMEOUT_MS = Number(
  process.env.AGENTIC_FETCH_URL_CONNECT_TIMEOUT_MS ?? "5000",
);
const FETCH_BODY_TIMEOUT_MS = Number(
  process.env.AGENTIC_FETCH_URL_BODY_TIMEOUT_MS ?? "5000",
);
const FETCH_MAX_BYTES_DEFAULT = Number(
  process.env.AGENTIC_FETCH_URL_MAX_BYTES ?? String(5 * 1024 * 1024),
);
const FETCH_MAX_REDIRECTS = Number(
  process.env.AGENTIC_FETCH_URL_MAX_REDIRECTS ?? "3",
);

export class SsrfError extends Error {
  constructor(
    public readonly code:
      | "https_only"
      | "scheme_not_allowed"
      | "blocked_target"
      | "dns_resolution_failed"
      | "redirect_limit_exceeded"
      | "body_too_large"
      | "timeout"
      | "bad_url",
    message: string,
  ) {
    super(message);
    this.name = "SsrfError";
  }
}

/**
 * Decide whether an IPv4/IPv6 literal points at an internal/restricted
 * target. Conservative: when in doubt, reject.
 */
function parseIpv6Words(input: string): number[] | null {
  let value = input.toLowerCase();
  if (value.includes(".")) {
    const colon = value.lastIndexOf(":");
    if (colon < 0) return null;
    const octets = value
      .slice(colon + 1)
      .split(".")
      .map((part) => Number(part));
    if (
      octets.length !== 4 ||
      octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
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
    const words = side.split(":").map((part) => Number.parseInt(part, 16));
    return words.some(
      (word, index) =>
        !/^[0-9a-f]{1,4}$/.test(side.split(":")[index]!) ||
        !Number.isInteger(word) ||
        word < 0 ||
        word > 0xffff,
    )
      ? null
      : words;
  };
  const left = parseSide(leftRaw ?? "");
  const right = parseSide(rightRaw);
  if (!left || !right) return null;
  if (!compressed) return left.length === 8 ? left : null;
  const zeroCount = 8 - left.length - right.length;
  if (zeroCount < 1) return null;
  return [...left, ...Array<number>(zeroCount).fill(0), ...right];
}

function isBlockedAddress(address: string): boolean {
  if (!address) return true;
  const normalized = address.split("%")[0]!.toLowerCase();
  const ipVersion = net.isIP(normalized);
  if (ipVersion === 4) {
    // Reject IANA special-purpose ranges in addition to the conventional
    // private ranges. Documentation and benchmarking networks are not valid
    // production fetch targets and must fail closed.
    const parts = normalized.split(".").map((x) => Number(x));
    if (
      parts.length !== 4 ||
      parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)
    ) {
      return true;
    }
    const [a, b, c] = parts as [number, number, number, number];
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 127) return true; // 127.0.0.0/8 (loopback)
    if (a === 10) return true; // 10.0.0.0/8 (RFC1918)
    if (a === 192 && b === 168) return true; // 192.168.0.0/16 (RFC1918)
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 (RFC1918)
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 (link-local, includes AWS metadata 169.254.169.254)
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (CGNAT)
    if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24 (IETF protocol assignments)
    if (a === 192 && b === 0 && c === 2) return true; // 192.0.2.0/24 (TEST-NET-1)
    if (a === 192 && b === 88 && c === 99) return true; // deprecated 6to4 relay anycast
    if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 (benchmarking)
    if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
    if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
    if (a >= 224) return true; // 224/4 multicast + 240/4 reserved
    return false;
  }
  if (ipVersion === 6) {
    const words = parseIpv6Words(normalized);
    if (!words) return true;
    const mapped =
      words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff;
    if (mapped) {
      const high = words[6]!;
      const low = words[7]!;
      return isBlockedAddress(
        `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`,
      );
    }
    // Globally routable IPv6 unicast currently lives in 2000::/3. Reject
    // every other class, then remove non-routable special allocations inside
    // that block (documentation, benchmarking, ORCHID, Teredo, and 6to4).
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
  // Unknown format — treat as blocked.
  return true;
}

interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

interface ValidatedOutboundUrl {
  url: URL;
  hostname: string;
  addresses: ResolvedAddress[];
  pinned: ResolvedAddress;
}

function parseOutboundUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new SsrfError("bad_url", `not a valid URL: ${raw}`);
  }
  // Scheme allow-list.
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw new SsrfError(
      "scheme_not_allowed",
      `scheme "${u.protocol}" is not allowed; only https: (or http://localhost in dev) is accepted`,
    );
  }
  if (u.protocol === "http:") {
    const httpLocalhostAllowed =
      process.env.AGENTIC_FETCH_ALLOW_HTTP_LOCALHOST === "1" &&
      (u.hostname === "localhost" ||
        u.hostname === "127.0.0.1" ||
        u.hostname === "::1");
    if (!httpLocalhostAllowed) {
      throw new SsrfError(
        "https_only",
        `http: is only allowed for localhost in dev (set AGENTIC_FETCH_ALLOW_HTTP_LOCALHOST=1)`,
      );
    }
  }
  return u;
}

async function resolveSafeOutboundUrl(
  raw: string,
): Promise<ValidatedOutboundUrl> {
  const url = parseOutboundUrl(raw);
  // URL.hostname retains brackets around IPv6 literals; socket and DNS APIs
  // take the bare address while Host retains URL.host below.
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  let answers: unknown;
  try {
    answers = await dns.lookup(hostname, {
      family: 0,
      all: true,
      verbatim: true,
    });
  } catch (err) {
    throw new SsrfError(
      "dns_resolution_failed",
      `dns lookup failed for "${hostname}": ${(err as Error).message}`,
    );
  }

  // `all: true` always returns an array in Node. Normalize an object as well
  // so older embedders/test doubles cannot accidentally bypass validation.
  const rawAnswers = Array.isArray(answers) ? answers : [answers];
  const addresses: ResolvedAddress[] = [];
  const seen = new Set<string>();
  for (const answer of rawAnswers) {
    if (!answer || typeof answer !== "object") {
      throw new SsrfError(
        "dns_resolution_failed",
        `dns lookup returned an invalid answer for "${hostname}"`,
      );
    }
    const address = (answer as { address?: unknown }).address;
    const family = typeof address === "string" ? net.isIP(address) : 0;
    if (typeof address !== "string" || (family !== 4 && family !== 6)) {
      throw new SsrfError(
        "dns_resolution_failed",
        `dns lookup returned an invalid address for "${hostname}"`,
      );
    }
    if (isBlockedAddress(address)) {
      throw new SsrfError(
        "blocked_target",
        `target "${hostname}" resolves to ${address}, which is not a public address`,
      );
    }
    const key = `${family}:${address}`;
    if (!seen.has(key)) {
      seen.add(key);
      addresses.push({ address, family });
    }
  }
  if (addresses.length === 0) {
    throw new SsrfError(
      "dns_resolution_failed",
      `dns lookup returned no addresses for "${hostname}"`,
    );
  }
  return { url, hostname, addresses, pinned: addresses[0]! };
}

/**
 * Parse + validate a URL for outbound fetch. Every DNS answer must be public.
 * `safeFetch` uses the richer internal result to pin the selected address;
 * external validation callers retain the historical URL return value.
 */
export async function assertSafeOutboundUrl(raw: string): Promise<URL> {
  return (await resolveSafeOutboundUrl(raw)).url;
}

function createPinnedLookup(pinned: ResolvedAddress): LookupFunction {
  return (_hostname, options, callback) => {
    const requestedFamily = options.family;
    if (
      typeof requestedFamily === "number" &&
      requestedFamily !== 0 &&
      requestedFamily !== pinned.family
    ) {
      const error = Object.assign(
        new Error(
          `validated address family ${pinned.family} does not satisfy requested family ${requestedFamily}`,
        ),
        { code: "EAI_ADDRFAMILY" },
      ) as NodeJS.ErrnoException;
      callback(error, "", 0);
      return;
    }
    if (options.all) {
      callback(null, [{ ...pinned }]);
      return;
    }
    callback(null, pinned.address, pinned.family);
  };
}

function outboundHeaders(
  url: URL,
  supplied: Record<string, string> | undefined,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(
    supplied ?? { accept: "application/json, text/plain" },
  )) {
    if (name.toLowerCase() !== "host") headers[name] = value;
  }
  // Never let a forwarded Host disagree with the hostname whose DNS and TLS
  // identity were validated. URL.host includes a non-default explicit port.
  headers.host = url.host;
  return headers;
}

function pinnedRequestOptions(
  target: ValidatedOutboundUrl,
  headers: Record<string, string> | undefined,
  signal?: AbortSignal,
): RequestOptions {
  return {
    protocol: target.url.protocol,
    hostname: target.hostname,
    port: target.url.port || undefined,
    path: `${target.url.pathname}${target.url.search}`,
    method: "GET",
    headers: outboundHeaders(target.url, headers),
    lookup: createPinnedLookup(target.pinned),
    family: target.pinned.family,
    // Do not reuse a process-global socket whose connection predates this
    // hop's validation and pinning decision.
    agent: false,
    ...(target.url.protocol === "https:" && net.isIP(target.hostname) === 0
      ? { servername: target.hostname }
      : {}),
    ...(signal ? { signal } : {}),
  };
}

function requestPinnedHop(
  target: ValidatedOutboundUrl,
  headers: Record<string, string> | undefined,
  signal: AbortSignal,
): Promise<IncomingMessage> {
  const transport = target.url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const request = transport.request(
      pinnedRequestOptions(target, headers, signal),
      resolve,
    );
    request.once("error", reject);
    request.end();
  });
}

function headerValue(headers: IncomingHttpHeaders, name: string): string {
  const value = headers[name];
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

export interface SafeFetchOptions {
  /** Hard cap on the response body in bytes. Defaults to 5 MB. */
  maxBytes?: number;
  /** Allowed content-types (lowercased, sans `;charset=…`). */
  allowedContentTypes?: ReadonlySet<string>;
  /** Custom abort signal (chained to the internal one). */
  signal?: AbortSignal;
  /** Forwarded request headers. */
  headers?: Record<string, string>;
}

export interface SafeFetchResult {
  /** Final URL after any redirects (already validated). */
  finalUrl: URL;
  /** Lowercased content-type without parameters. */
  contentType: string;
  /** Raw body bytes. */
  body: Buffer;
}

/**
 * Outbound fetch with SSRF guard, manual redirect handling, byte cap, and
 * content-type allow-list. Throws `SsrfError` on policy violation,
 * `Error("upstream_status_<N>")` on non-2xx response, `Error("body_too_large")`
 * on body cap.
 */
export async function safeFetch(
  raw: string,
  opts: SafeFetchOptions = {},
): Promise<SafeFetchResult> {
  const maxBytes = opts.maxBytes ?? FETCH_MAX_BYTES_DEFAULT;
  const allowed = opts.allowedContentTypes;

  let current = await resolveSafeOutboundUrl(raw);
  for (let hop = 0; hop <= FETCH_MAX_REDIRECTS; hop += 1) {
    const ac = new AbortController();
    let timeoutPhase: "connect" | "body" | null = null;
    const connectTimer = setTimeout(() => {
      timeoutPhase = "connect";
      ac.abort(new SsrfError("timeout", "connect timeout"));
    }, FETCH_CONNECT_TIMEOUT_MS);
    // Chain user abort.
    const userSignal = opts.signal;
    const userAbortListener = userSignal
      ? () => ac.abort(userSignal.reason ?? new Error("aborted"))
      : null;
    if (userSignal && userAbortListener) {
      if (userSignal.aborted)
        ac.abort(userSignal.reason ?? new Error("aborted"));
      else
        userSignal.addEventListener("abort", userAbortListener, { once: true });
    }

    let res: IncomingMessage;
    try {
      res = await requestPinnedHop(current, opts.headers, ac.signal);
    } catch (err) {
      clearTimeout(connectTimer);
      if (userSignal && userAbortListener) {
        userSignal.removeEventListener("abort", userAbortListener);
      }
      if (timeoutPhase === "connect") {
        throw new SsrfError(
          "timeout",
          `connect timed out after ${FETCH_CONNECT_TIMEOUT_MS}ms`,
        );
      }
      throw err;
    }
    clearTimeout(connectTimer);

    // Raw 3xx responses require a new all-address validation and a fresh
    // pinned socket decision for the next hop.
    const status = res.statusCode ?? 0;
    if (status >= 300 && status < 400) {
      const loc = headerValue(res.headers, "location");
      res.destroy();
      if (!loc) {
        if (userSignal && userAbortListener) {
          userSignal.removeEventListener("abort", userAbortListener);
        }
        throw new Error(`upstream_status_${status}`);
      }
      if (hop >= FETCH_MAX_REDIRECTS) {
        if (userSignal && userAbortListener) {
          userSignal.removeEventListener("abort", userAbortListener);
        }
        throw new SsrfError(
          "redirect_limit_exceeded",
          `more than ${FETCH_MAX_REDIRECTS} redirects`,
        );
      }
      const nextRaw = new URL(loc, current.url).toString();
      if (userSignal && userAbortListener) {
        userSignal.removeEventListener("abort", userAbortListener);
      }
      current = await resolveSafeOutboundUrl(nextRaw);
      continue;
    }

    if (status < 200 || status >= 300) {
      res.destroy();
      if (userSignal && userAbortListener) {
        userSignal.removeEventListener("abort", userAbortListener);
      }
      throw new Error(`upstream_status_${status || 502}`);
    }

    // Content-type check #1 (before body).
    const ctRaw = headerValue(res.headers, "content-type")
      .split(";")[0]!
      .trim()
      .toLowerCase();
    if (allowed && !allowed.has(ctRaw)) {
      res.destroy();
      if (userSignal && userAbortListener) {
        userSignal.removeEventListener("abort", userAbortListener);
      }
      throw new Error(
        `content_type_not_allowed: "${ctRaw}" not in {${[...allowed].join(", ")}}`,
      );
    }

    // Stream-count the body. We do NOT trust the Content-Length header — a
    // malicious server can omit it or lie about it. Re-arm the abort timer
    // for the body phase.
    const bodyTimer = setTimeout(() => {
      timeoutPhase = "body";
      ac.abort(new SsrfError("timeout", "body timeout"));
    }, FETCH_BODY_TIMEOUT_MS);
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      for await (const value of res) {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        total += chunk.byteLength;
        if (total > maxBytes) {
          res.destroy();
          throw new SsrfError(
            "body_too_large",
            `body exceeded ${maxBytes} bytes (read ${total})`,
          );
        }
        chunks.push(chunk);
      }
    } catch (err) {
      if (timeoutPhase === "body") {
        throw new SsrfError(
          "timeout",
          `body timed out after ${FETCH_BODY_TIMEOUT_MS}ms`,
        );
      }
      throw err;
    } finally {
      clearTimeout(bodyTimer);
      if (userSignal && userAbortListener) {
        userSignal.removeEventListener("abort", userAbortListener);
      }
    }

    // Content-type check #2 (after body — some servers update headers in
    // trailers; cheap defense in depth).
    const ctAfter = headerValue(res.headers, "content-type")
      .split(";")[0]!
      .trim()
      .toLowerCase();
    if (allowed && !allowed.has(ctAfter)) {
      throw new Error(
        `content_type_not_allowed_after_body: "${ctAfter}" not in {${[...allowed].join(", ")}}`,
      );
    }
    return {
      finalUrl: current.url,
      contentType: ctAfter || ctRaw,
      body: Buffer.concat(chunks),
    };
  }
  // The loop returns or throws; unreachable in practice.
  throw new SsrfError(
    "redirect_limit_exceeded",
    "redirect loop exited unexpectedly",
  );
}

/** Focused test surfaces for address policy and pinned socket construction. */
export const __test = {
  isBlockedAddress,
  pinnedRequestOptions(
    raw: string,
    address: string,
    family: 4 | 6,
    headers?: Record<string, string>,
  ): RequestOptions {
    const url = new URL(raw);
    const pinned = { address, family };
    return pinnedRequestOptions(
      {
        url,
        hostname: url.hostname.replace(/^\[|\]$/g, ""),
        addresses: [pinned],
        pinned,
      },
      headers,
    );
  },
};
