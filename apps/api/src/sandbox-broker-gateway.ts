import { randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";

import {
  SandboxGatewayTombstoneStore,
} from "./services/agent-factory/sandbox-gateway-tombstone";

const APPS_READ = new Set([
  "{ apps { name } }",
  "{ apps { name url error connected functionCount } }",
]);
const APP_DELETE =
  "mutation DeleteFactorySandboxApp($name: String!) { deleteAppByName(name: $name) }";
const HOP_BY_HOP = new Set([
  "connection",
  "content-length",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export interface SandboxBrokerGatewayConfig {
  host: string;
  port: number;
  brokerOrigin: string;
  workloadOrigin: string;
  controlToken: string;
  appPrefix: string;
  maxBodyBytes: number;
  requestTimeoutMs: number;
  tombstoneDir: string;
  tombstoneIntegrityKey: string;
  tombstoneMaxEntries: number;
}

function positiveInt(name: string, value: string | undefined, fallback: number): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function valueOrFile(
  name: string,
  env: Record<string, string | undefined>,
  minBytes: number,
): string {
  const direct = env[name]?.trim();
  const filename = env[`${name}_FILE`]?.trim();
  if (direct && filename) throw new Error(`${name} and ${name}_FILE cannot both be set`);
  const value = filename ? readFileSync(filename, "utf8").trim() : direct;
  if (!value || Buffer.byteLength(value, "utf8") < minBytes) {
    throw new Error(`${name} is missing or too short`);
  }
  return value;
}

function exactOrigin(value: string | undefined, label: string): string {
  if (!value?.trim()) throw new Error(`${label} is required`);
  const parsed = new URL(value.trim());
  if (
    !["http:", "https:"].includes(parsed.protocol)
    || parsed.username
    || parsed.password
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash
  ) {
    throw new Error(`${label} must be an absolute HTTP(S) origin`);
  }
  return parsed.origin;
}

export function loadSandboxBrokerGatewayConfig(
  env: Record<string, string | undefined> = process.env,
): SandboxBrokerGatewayConfig {
  const appPrefix = valueOrFile("SANDBOX_INNGEST_APP_PREFIX", env, 3);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/.test(appPrefix)) {
    throw new Error("SANDBOX_INNGEST_APP_PREFIX is invalid");
  }
  return {
    host: env.HOST?.trim() || "0.0.0.0",
    port: positiveInt("PORT", env.PORT, 3562),
    brokerOrigin: exactOrigin(env.SANDBOX_BROKER_UPSTREAM_ORIGIN, "SANDBOX_BROKER_UPSTREAM_ORIGIN"),
    workloadOrigin: exactOrigin(env.SANDBOX_WORKLOAD_UPSTREAM_ORIGIN, "SANDBOX_WORKLOAD_UPSTREAM_ORIGIN"),
    controlToken: valueOrFile("SANDBOX_INNGEST_CONTROL_BEARER", env, 32),
    appPrefix,
    maxBodyBytes: positiveInt("SANDBOX_BROKER_GATEWAY_MAX_BODY_BYTES", env.SANDBOX_BROKER_GATEWAY_MAX_BODY_BYTES, 32 * 1024 * 1024),
    requestTimeoutMs: positiveInt("SANDBOX_BROKER_GATEWAY_TIMEOUT_MS", env.SANDBOX_BROKER_GATEWAY_TIMEOUT_MS, 120_000),
    tombstoneDir: path.resolve(
      env.AGENTIC_DATA_ROOT || "/sandbox/gateway",
      "broker-gateway-tombstones",
    ),
    tombstoneIntegrityKey: valueOrFile("SANDBOX_GATEWAY_TOMBSTONE_HMAC", env, 32),
    tombstoneMaxEntries: positiveInt(
      "SANDBOX_GATEWAY_TOMBSTONE_MAX_ENTRIES",
      env.SANDBOX_GATEWAY_TOMBSTONE_MAX_ENTRIES,
      10_000,
    ),
  };
}

function exactBearer(actual: string | undefined, expected: string): boolean {
  const supplied = actual?.startsWith("Bearer ") ? actual.slice(7) : "";
  const left = Buffer.from(supplied, "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

function sandboxTenantSlugForApp(appId: string, prefix: string): string | undefined {
  const marker = `${prefix}-`;
  if (!appId.startsWith(marker) || !/^[A-Za-z0-9][A-Za-z0-9._-]{2,190}$/.test(appId)) {
    return undefined;
  }
  const slug = appId.slice(marker.length);
  return /^af-sbx-[a-f0-9]{8}-[a-f0-9]{8}-[a-f0-9]{12}-sb$/.test(slug)
    ? slug
    : undefined;
}

function sandboxAppId(appId: string, prefix: string): boolean {
  return sandboxTenantSlugForApp(appId, prefix) !== undefined;
}

function sdkEventKey(value: string): boolean {
  return /^[A-Za-z0-9._-]{8,256}$/.test(value);
}

function normalizedGraphql(query: unknown): string {
  return typeof query === "string" ? query.replace(/\s+/g, " ").trim() : "";
}

function requestBody(request: FastifyRequest): Buffer | undefined {
  if (request.body === undefined || request.body === null) return undefined;
  if (!Buffer.isBuffer(request.body)) throw new Error("gateway body parser did not preserve bytes");
  return request.body;
}

function forwardedHeaders(
  headers: FastifyRequest["headers"],
  includeAuthorization: boolean,
  controlToken?: string,
): Headers {
  const forwarded = new Headers();
  for (const [name, raw] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (
      HOP_BY_HOP.has(key)
      || key === "host"
      || (!includeAuthorization && key === "authorization")
      || raw === undefined
    ) continue;
    for (const value of Array.isArray(raw) ? raw : [raw]) forwarded.append(name, value);
  }
  if (
    controlToken
    && forwarded.get("authorization") === `Bearer ${controlToken}`
  ) forwarded.delete("authorization");
  return forwarded;
}

async function proxy(input: {
  request: FastifyRequest;
  destinationOrigin: string;
  fetchFn: typeof fetch;
  timeoutMs: number;
  includeAuthorization: boolean;
  controlToken?: string;
}): Promise<Response> {
  const destination = new URL(input.request.raw.url || "/", input.destinationOrigin);
  const body = requestBody(input.request);
  const wireBody = body
    ? body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer
    : undefined;
  return await input.fetchFn(destination, {
    method: input.request.method,
    headers: forwardedHeaders(
      input.request.headers,
      input.includeAuthorization,
      input.controlToken,
    ),
    ...(wireBody && wireBody.byteLength > 0 ? { body: wireBody } : {}),
    redirect: "error",
    signal: AbortSignal.timeout(input.timeoutMs),
  });
}

async function relay(response: Response, reply: FastifyReply) {
  reply.code(response.status);
  response.headers.forEach((value, name) => {
    if (!HOP_BY_HOP.has(name.toLowerCase())) reply.header(name, value);
  });
  return reply.send(Buffer.from(await response.arrayBuffer()));
}

/**
 * A two-sided mediation point for the dedicated sandbox broker.
 *
 * - Workload SDK/event traffic is forwarded to Inngest.
 * - Inngest callbacks are forwarded byte-for-byte to the workload.
 * - GraphQL is never a generic proxy: only the exact app read/delete
 *   operations required for readiness and cleanup are accepted, under a
 *   separate bearer.  Candidate code receives neither this bearer nor a
 *   network primitive.
 */
export async function buildSandboxBrokerGateway(input: {
  config: SandboxBrokerGatewayConfig;
  fetchFn?: typeof fetch;
}): Promise<FastifyInstance> {
  const fetchFn = input.fetchFn ?? fetch;
  const tombstones = new SandboxGatewayTombstoneStore(
    input.config.tombstoneDir,
    input.config.tombstoneIntegrityKey,
    input.config.tombstoneMaxEntries,
  );
  const inFlightByApp = new Map<string, Set<Promise<void>>>();
  const track = <T>(appId: string, operation: Promise<T>): Promise<T> => {
    const settled = operation.then(() => undefined, () => undefined);
    const current = inFlightByApp.get(appId) ?? new Set<Promise<void>>();
    current.add(settled);
    inFlightByApp.set(appId, current);
    void settled.finally(() => {
      const live = inFlightByApp.get(appId);
      live?.delete(settled);
      if (live?.size === 0) inFlightByApp.delete(appId);
    });
    return operation;
  };
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? "info" },
    bodyLimit: input.config.maxBodyBytes,
    genReqId: () => randomUUID(),
  });
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", { parseAs: "buffer" }, (_request, body, done) => done(null, body));

  app.get("/health", async (request, reply) => {
    if (!exactBearer(request.headers.authorization, input.config.controlToken)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    try {
      const upstream = await fetchFn(`${input.config.brokerOrigin}/health`, {
        redirect: "error",
        signal: AbortSignal.timeout(Math.min(5_000, input.config.requestTimeoutMs)),
      });
      const ok = upstream.ok;
      return reply.code(ok ? 200 : 503).send({
        schema: "agent-factory-sandbox-broker-gateway-health/v1",
        ok,
        broker: ok ? "ready" : "unavailable",
        tombstones: tombstones.size,
      });
    } catch {
      return reply.code(503).send({
        schema: "agent-factory-sandbox-broker-gateway-health/v1",
        ok: false,
        broker: "unavailable",
      });
    }
  });

  app.post<{ Params: { appId: string } }>(
    "/internal/factory-sandbox/tombstones/:appId",
    async (request, reply) => {
      if (!exactBearer(request.headers.authorization, input.config.controlToken)) {
        return reply.code(401).send({ error: "unauthorized" });
      }
      const appId = request.params.appId;
      const sandboxTenantSlug = sandboxTenantSlugForApp(appId, input.config.appPrefix);
      if (!sandboxTenantSlug) {
        return reply.code(403).send({ error: "non-sandbox app identity refused" });
      }
      let command: { schema?: unknown; appId?: unknown; expiresAt?: unknown };
      try {
        command = JSON.parse(requestBody(request)?.toString("utf8") || "") as typeof command;
      } catch {
        return reply.code(400).send({ error: "invalid tombstone envelope" });
      }
      const expiresAt = typeof command.expiresAt === "string"
        ? Date.parse(command.expiresAt)
        : Number.NaN;
      if (
        command.schema !== "agent-factory-sandbox-gateway-tombstone-command/v1"
        || command.appId !== appId
        || !Number.isFinite(expiresAt)
        || expiresAt <= Date.now()
        || expiresAt > Date.now() + 30 * 24 * 60 * 60_000
      ) {
        return reply.code(400).send({ error: "tombstone identity/expiry is invalid" });
      }
      let tombstone;
      try {
        // fence() fsyncs file + directory before this handler can ACK.
        tombstone = tombstones.fence({
          appId,
          sandboxTenantSlug,
          expiresAt: command.expiresAt as string,
        });
      } catch (error) {
        return reply.code(409).send({
          error: String((error as Error)?.message ?? error).slice(0, 240),
        });
      }
      // A registration/callback that passed policy before fencing must finish
      // before the delete-control performs its authoritative query+delete.
      // New operations observe the tombstone and cannot enter this set.
      await Promise.all([...(inFlightByApp.get(appId) ?? [])]);
      return reply.code(202).send({
        schema: "agent-factory-sandbox-gateway-tombstone-ack/v1",
        appId: tombstone.appId,
        sandboxTenantSlug: tombstone.sandboxTenantSlug,
        fencedAt: tombstone.fencedAt,
        expiresAt: tombstone.expiresAt,
        durable: true,
      });
    },
  );

  app.get("/internal/factory-sandbox/tombstones", async (request, reply) => {
    if (!exactBearer(request.headers.authorization, input.config.controlToken)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    return reply.send({
      schema: "agent-factory-sandbox-gateway-tombstones/v1",
      tombstones: tombstones.expired().map((entry) => ({
        appId: entry.appId,
        sandboxTenantSlug: entry.sandboxTenantSlug,
        expiresAt: entry.expiresAt,
      })),
    });
  });

  app.delete<{ Params: { appId: string } }>(
    "/internal/factory-sandbox/tombstones/:appId",
    async (request, reply) => {
      if (!exactBearer(request.headers.authorization, input.config.controlToken)) {
        return reply.code(401).send({ error: "unauthorized" });
      }
      const appId = request.params.appId;
      if (!sandboxAppId(appId, input.config.appPrefix)) {
        return reply.code(403).send({ error: "non-sandbox app identity refused" });
      }
      let evidence: {
        schema?: unknown;
        appId?: unknown;
        workloadClean?: unknown;
        candidateClean?: unknown;
      };
      try {
        evidence = JSON.parse(requestBody(request)?.toString("utf8") || "") as typeof evidence;
      } catch {
        return reply.code(400).send({ error: "invalid tombstone release envelope" });
      }
      if (
        evidence.schema !== "agent-factory-sandbox-gateway-tombstone-release/v1"
        || evidence.appId !== appId
        || evidence.workloadClean !== true
        || evidence.candidateClean !== true
      ) {
        return reply.code(400).send({ error: "clean workload/candidate proof is required" });
      }
      const tombstone = tombstones.get(appId);
      if (!tombstone) return reply.code(404).send({ alreadyAbsent: true });
      if (Date.parse(tombstone.expiresAt) > Date.now()) {
        return reply.code(409).send({ error: "tombstone retention has not expired" });
      }
      let payload: { data?: { apps?: Array<{ name?: string }> }; errors?: unknown[] };
      try {
        const upstream = await fetchFn(`${input.config.brokerOrigin}/v0/gql`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ query: "{ apps { name } }" }),
          redirect: "error",
          signal: AbortSignal.timeout(Math.min(5_000, input.config.requestTimeoutMs)),
        });
        if (!upstream.ok) throw new Error(`broker returned ${upstream.status}`);
        payload = await upstream.json() as typeof payload;
      } catch {
        return reply.code(503).send({ error: "broker absence could not be proved" });
      }
      if (payload.errors?.length) {
        return reply.code(503).send({ error: "broker absence query failed" });
      }
      if ((payload.data?.apps ?? []).some((entry) => entry.name === appId)) {
        return reply.code(409).send({ error: "broker still contains the sandbox app" });
      }
      if (!tombstones.removeVerifiedExpired(appId)) {
        return reply.code(409).send({ error: "tombstone is not eligible for release" });
      }
      return reply.send({
        schema: "agent-factory-sandbox-gateway-tombstone-release-ack/v1",
        appId,
        released: true,
      });
    },
  );

  app.post("/v0/gql", async (request, reply) => {
    if (!exactBearer(request.headers.authorization, input.config.controlToken)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    let payload: { query?: unknown; variables?: unknown };
    try {
      payload = JSON.parse(requestBody(request)?.toString("utf8") || "") as typeof payload;
    } catch {
      return reply.code(400).send({ error: "invalid GraphQL envelope" });
    }
    const query = normalizedGraphql(payload.query);
    if (APPS_READ.has(query)) {
      if (payload.variables !== undefined && payload.variables !== null) {
        return reply.code(400).send({ error: "variables are not accepted for app readback" });
      }
    } else if (query === APP_DELETE) {
      const variables = payload.variables;
      const name = variables && typeof variables === "object" && !Array.isArray(variables)
        ? (variables as { name?: unknown }).name
        : undefined;
      if (typeof name !== "string" || !sandboxAppId(name, input.config.appPrefix)) {
        return reply.code(403).send({ error: "non-sandbox app identity refused" });
      }
      if (!tombstones.get(name)) {
        return reply.code(409).send({ error: "durable deletion tombstone is required" });
      }
    } else {
      return reply.code(403).send({ error: "GraphQL operation is not allowlisted" });
    }
    const upstream = await proxy({
      request,
      destinationOrigin: input.config.brokerOrigin,
      fetchFn,
      timeoutMs: input.config.requestTimeoutMs,
      includeAuthorization: false,
    });
    return relay(upstream, reply);
  });

  app.all("/inngest", async (_request, reply) =>
    reply.code(404).send({ error: "callback App identity is required" }));
  app.all("/inngest/*", async (request, reply) => {
    const rawPath = new URL(request.raw.url || "/", "http://gateway.invalid").pathname;
    const encodedSlug = rawPath.startsWith("/inngest/")
      ? rawPath.slice("/inngest/".length)
      : "";
    let slug = "";
    try {
      slug = decodeURIComponent(encodedSlug);
    } catch {
      return reply.code(404).send({ error: "callback App identity is invalid" });
    }
    const appId = `${input.config.appPrefix}-${slug}`;
    if (
      encodedSlug !== slug
      || encodedSlug.includes("/")
      || sandboxTenantSlugForApp(appId, input.config.appPrefix) !== slug
    ) {
      return reply.code(404).send({ error: "callback App identity is invalid" });
    }
    if (tombstones.get(appId)) {
      return reply.code(410).send({ error: "sandbox App is deleting" });
    }
    // There is no await between the tombstone check and track(): install can
    // therefore either see this callback in-flight or make this check fail.
    return await track(appId, (async () => relay(await proxy({
      request,
      destinationOrigin: input.config.workloadOrigin,
      fetchFn,
      timeoutMs: input.config.requestTimeoutMs,
      includeAuthorization: true,
      controlToken: input.config.controlToken,
    }), reply))());
  });

  const relaySdk = async (request: FastifyRequest, reply: FastifyReply) => relay(await proxy({
    request,
    destinationOrigin: input.config.brokerOrigin,
    fetchFn,
    timeoutMs: input.config.requestTimeoutMs,
    // Broker event/signing keys authenticate the forwarded SDK paths. The
    // gateway-specific bearer is never forwarded to Inngest.
    includeAuthorization: true,
    controlToken: input.config.controlToken,
  }), reply);
  // Exact SDK surface used by the disposable workload. This used to be a
  // catch-all broker proxy, which exposed every current/future Inngest admin
  // path to a compromised workload process.
  app.post<{ Params: { eventKey: string } }>("/e/:eventKey", async (request, reply) => {
    if (!sdkEventKey(request.params.eventKey)) {
      return reply.code(404).send({ error: "SDK event path is not allowlisted" });
    }
    return relaySdk(request, reply);
  });
  const register = async (request: FastifyRequest, reply: FastifyReply) => {
    let registration: { appName?: unknown };
    try {
      registration = JSON.parse(requestBody(request)?.toString("utf8") || "") as typeof registration;
    } catch {
      return reply.code(400).send({ error: "invalid App registration envelope" });
    }
    const appId = registration?.appName;
    if (typeof appId !== "string" || !sandboxAppId(appId, input.config.appPrefix)) {
      return reply.code(403).send({ error: "non-sandbox App registration refused" });
    }
    if (tombstones.get(appId)) {
      return reply.code(410).send({ error: "sandbox App is deleting" });
    }
    return await track(appId, relaySdk(request, reply));
  };
  app.post("/fn/register", register);
  app.put("/fn/register", register);
  app.all("/*", async (_request, reply) =>
    reply.code(404).send({ error: "broker path is not allowlisted" }));
  return app;
}

async function main(): Promise<void> {
  const config = loadSandboxBrokerGatewayConfig();
  const app = await buildSandboxBrokerGateway({ config });
  const close = async () => app.close();
  process.once("SIGINT", () => void close().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void close().finally(() => process.exit(0)));
  await app.listen({ host: config.host, port: config.port });
  app.log.info(`sandbox broker gateway listening on ${config.host}:${config.port}`);
}

const isMain = Boolean(process.argv[1])
  && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  main().catch((error) => {
    console.error(`[sandbox-broker-gateway] ${String((error as Error)?.message ?? error).slice(0, 400)}`);
    process.exitCode = 1;
  });
}
