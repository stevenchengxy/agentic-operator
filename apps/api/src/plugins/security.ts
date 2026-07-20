/**
 * Security + observability plugin (P4-API-02 / P4-API-03 / P4-OPS-05).
 *
 * Bundles four cross-cutting concerns we'd otherwise duplicate across
 * routes:
 *
 *   1. Structured request logging — every request gets a `req.id`
 *      (Fastify's `genReqId`) and the auth context (`tenantSlug`,
 *      `tenantId`, `via`) is attached to `req.log` once auth resolves so
 *      every downstream log line is correlated.
 *   2. Sensitive header redaction — pino is told to redact
 *      `req.headers.authorization` + `req.headers.cookie` so secrets
 *      never reach disk.
 *   3. Basic security headers — equivalent to a minimal `@fastify/helmet`
 *      preset. We avoid the extra dependency by setting the headers
 *      ourselves; the list mirrors helmet's defaults minus CSP (CSP is
 *      managed by the web app).
 *   4. Per-tenant rate limit — sliding-window counter keyed by tenant
 *      (or remote IP when unauthenticated). Returns 429 with a
 *      `Retry-After` hint once the cap is exceeded.
 *
 * Body-size cap is set at the Fastify factory in `server.ts#build()`
 * via `bodyLimit` so it's enforced before this plugin runs.
 *
 * Everything reads its limits from env:
 *
 *   AGENTIC_RATE_LIMIT_PER_MIN         mutation/default limit, default 100
 *   AGENTIC_RATE_LIMIT_READS_PER_MIN   GET/HEAD limit, default max(600, 6x writes)
 *   AGENTIC_RATE_LIMIT_DISABLED        truthy to disable entirely (tests)
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { metrics } from "../services/metrics";

const RATE_LIMIT_WINDOW_MS = 60_000;

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

function rateLimitKey(req: FastifyRequest): string {
  if (req.auth) return `tenant:${req.auth.tenantId}`;
  // Fastify derives `req.ip` from the socket and applies `trustProxy` when the
  // deployment explicitly enables it. Reading X-Forwarded-For directly here
  // would let any unauthenticated caller mint a fresh rate-limit bucket by
  // changing an untrusted header on every request.
  return `ip:${req.ip ?? "unknown"}`;
}

function isHealthOrMetrics(url: string): boolean {
  return url === "/live" || url === "/health" || url === "/metrics";
}

function isInngest(url: string): boolean {
  return url === "/inngest" || url.startsWith("/inngest?");
}

function isFactorySandboxModelProxy(url: string): boolean {
  return url === "/internal/factory-sandbox/model/chat";
}

function isProductionCodeActRpc(url: string): boolean {
  return url === "/internal/production-codeact/rpc";
}

function readLimit(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function isReadRequest(req: FastifyRequest): boolean {
  return req.method === "GET" || req.method === "HEAD";
}

function rateLimitDisabled(): boolean {
  // Unit tests are isolated by default; a focused security test may opt in
  // explicitly without weakening any production path.
  if (process.env.NODE_ENV === "test") {
    return process.env.AGENTIC_RATE_LIMIT_DISABLED !== "0";
  }
  return process.env.AGENTIC_RATE_LIMIT_DISABLED === "1";
}

function shouldSkipRateLimit(req: FastifyRequest): boolean {
  if (rateLimitDisabled()) return true;
  const url = req.routeOptions.url ?? req.url;
  if (isHealthOrMetrics(url)) return true;
  if (isInngest(url)) return true;
  // This exact internal service route has stronger authentication plus
  // attempt-bound atomic call/total-token quotas. The generic IP bucket would
  // otherwise reject before its auditable grant ledger. No other /internal
  // route receives this exemption.
  if (isFactorySandboxModelProxy(url)) return true;
  // The executor callback is HMAC + execution/identity/RPC-id bound and has
  // its own per-execution cap. The generic IP bucket would reject legitimate
  // long handlers before their auditable RPC ledger sees the request.
  if (isProductionCodeActRpc(url)) return true;
  return false;
}

function reserveSlot(key: string, limit: number, now: number): {
  allowed: boolean;
  remaining: number;
  resetAt: number;
} {
  let bucket = buckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    buckets.set(key, bucket);
  }
  if (bucket.count >= limit) {
    return { allowed: false, remaining: 0, resetAt: bucket.resetAt };
  }
  bucket.count += 1;
  return {
    allowed: true,
    remaining: Math.max(0, limit - bucket.count),
    resetAt: bucket.resetAt,
  };
}

function setSecurityHeaders(reply: FastifyReply): void {
  // Helmet-equivalent defaults (sans CSP — owned by web). Use safe defaults
  // suitable for an API that serves JSON only.
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("X-Frame-Options", "DENY");
  reply.header("X-DNS-Prefetch-Control", "off");
  reply.header("Referrer-Policy", "no-referrer");
  reply.header("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
  reply.header("Cross-Origin-Opener-Policy", "same-origin");
  reply.header("Cross-Origin-Resource-Policy", "same-origin");
  reply.header("Permissions-Policy", "interest-cohort=()");
}

export async function registerSecurity(app: FastifyInstance) {
  const mutationLimit = readLimit("AGENTIC_RATE_LIMIT_PER_MIN", 100);
  // A single portal view legitimately fans out to several read endpoints;
  // sharing the mutation budget made normal tab inspection self-DOS at 100
  // requests/minute. Keep write protection strict while giving authenticated
  // dashboards a separately configurable read budget.
  const readRequestLimit = readLimit(
    "AGENTIC_RATE_LIMIT_READS_PER_MIN",
    Math.max(600, mutationLimit * 6),
  );

  // 1. Security headers on every response.
  app.addHook("onSend", async (_req, reply, payload) => {
    setSecurityHeaders(reply);
    return payload;
  });

  // 2. Capture a request-start hrtime so the response hook can compute
  //    duration. Fastify already attaches `req.id` and emits it as
  //    `requestId` per `requestIdLogLabel`, so we don't need to re-bind.
  app.addHook("onRequest", async (req) => {
    (req as { _startNs?: bigint })._startNs = process.hrtime.bigint();
  });

  // 3. Attach the auth context to req.log once auth resolves so every
  //    downstream log line carries tenant correlation.
  app.addHook("preHandler", async (req) => {
    if (req.auth) {
      req.log = req.log.child({
        tenantSlug: req.auth.tenantSlug,
        tenantId: req.auth.tenantId,
      });
    }
  });

  // 4. Rate limit. Runs after auth so the bucket key is per-tenant when
  //    the caller is authenticated.
  app.addHook("onRequest", async (req, reply) => {
    if (shouldSkipRateLimit(req)) return;
    const now = Date.now();
    const read = isReadRequest(req);
    const limit = read ? readRequestLimit : mutationLimit;
    const key = `${rateLimitKey(req)}:${read ? "read" : "mutation"}`;
    const { allowed, remaining, resetAt } = reserveSlot(key, limit, now);
    reply.header("X-RateLimit-Limit", String(limit));
    reply.header("X-RateLimit-Remaining", String(remaining));
    reply.header("X-RateLimit-Reset", String(Math.ceil(resetAt / 1000)));
    if (!allowed) {
      const retryAfterS = Math.max(1, Math.ceil((resetAt - now) / 1000));
      reply.header("Retry-After", String(retryAfterS));
      reply.status(429).send({
        ok: false,
        error: {
          code: "rate_limited",
          message: "too many requests; retry later",
          hint: `retry after ${retryAfterS}s`,
        },
      });
    }
  });

  // 5. Record request metrics on response.
  app.addHook("onResponse", async (req, reply) => {
    const route = req.routeOptions.url ?? "unknown";
    if (isHealthOrMetrics(route)) return;
    const status = reply.statusCode;
    const method = req.method;
    metrics.httpRequests.inc({ route, method, status });
    const start = (req as { _startNs?: bigint })._startNs;
    if (start !== undefined) {
      const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;
      metrics.httpDuration.observe(durationMs, { route, method });
    }
  });
}

/** For tests — drop every rate-limit bucket. */
export function __resetRateLimitForTest(): void {
  buckets.clear();
}
