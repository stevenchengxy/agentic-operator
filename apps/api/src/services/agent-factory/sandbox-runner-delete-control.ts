import { timingSafeEqual } from "node:crypto";

import type { FastifyInstance } from "fastify";

interface BrokerAppsResponse {
  data?: { apps?: Array<{ name?: string }> };
  errors?: unknown[];
}

interface BrokerDeleteResponse {
  data?: { deleteAppByName?: boolean };
  errors?: unknown[];
}

interface GatewayTombstoneAck {
  schema?: string;
  appId?: string;
  expiresAt?: string;
  durable?: boolean;
}

export const SANDBOX_DELETE_CONTROL_READINESS_SCHEMA =
  "agent-factory-sandbox-delete-control-readiness/v1" as const;

function secretEqual(actual: string, expected: string): boolean {
  const left = Buffer.from(actual, "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

function requiredOrigin(value: string | undefined, label: string): string {
  if (!value?.trim()) throw new Error(`${label} is required`);
  const parsed = new URL(value.trim());
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${label} must be an absolute http(s) origin`);
  }
  if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error(`${label} must contain only an origin`);
  }
  return parsed.origin;
}

function sandboxAppId(appId: string, prefix: string): boolean {
  const marker = `${prefix}-`;
  return appId.startsWith(marker)
    && /^[A-Za-z0-9][A-Za-z0-9._-]{2,190}$/.test(appId)
    && /^af-sbx-[a-f0-9]{8}-[a-f0-9]{8}-[a-f0-9]{12}-sb$/.test(appId.slice(marker.length));
}

async function brokerGraphql<T>(input: {
  brokerOrigin: string;
  query: string;
  variables?: Record<string, unknown>;
  fetchFn: typeof fetch;
  authToken?: string;
}): Promise<T> {
  const response = await input.fetchFn(`${input.brokerOrigin}/v0/gql`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(input.authToken ? { authorization: `Bearer ${input.authToken}` } : {}),
    },
    body: JSON.stringify({ query: input.query, variables: input.variables }),
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`sandbox broker GraphQL returned ${response.status}`);
  return await response.json() as T;
}

async function installGatewayTombstone(input: {
  brokerOrigin: string;
  appId: string;
  expiresAt: string;
  fetchFn: typeof fetch;
  authToken?: string;
}): Promise<void> {
  const response = await input.fetchFn(
    `${input.brokerOrigin}/internal/factory-sandbox/tombstones/${encodeURIComponent(input.appId)}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(input.authToken ? { authorization: `Bearer ${input.authToken}` } : {}),
      },
      body: JSON.stringify({
        schema: "agent-factory-sandbox-gateway-tombstone-command/v1",
        appId: input.appId,
        expiresAt: input.expiresAt,
      }),
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    },
  );
  if (!response.ok) throw new Error(`sandbox gateway tombstone returned ${response.status}`);
  const ack = await response.json() as GatewayTombstoneAck;
  if (
    ack.schema !== "agent-factory-sandbox-gateway-tombstone-ack/v1"
    || ack.appId !== input.appId
    || typeof ack.expiresAt !== "string"
    || !Number.isFinite(Date.parse(ack.expiresAt))
    || Date.parse(ack.expiresAt) < Date.parse(input.expiresAt)
    || ack.durable !== true
  ) throw new Error("sandbox gateway tombstone acknowledgement is invalid");
}

/**
 * Operator-owned, deliberately narrow deletion endpoint used by
 * `deleteFactorySandboxApp`.  It cannot delete a production app: both the
 * configured sandbox prefix and Factory nonce slug shape are required, and a
 * successful mutation is followed by the deployer's independent absence
 * readback before cleanup evidence is issued.
 */
export async function registerSandboxRunnerDeleteControl(
  app: FastifyInstance,
  options: {
    token?: string;
    brokerOrigin?: string;
    appPrefix?: string;
    fetchFn?: typeof fetch;
    brokerAuthToken?: string;
  } = {},
): Promise<void> {
  const token = options.token ?? process.env.FACTORY_SB_DELETE_TOKEN?.trim() ?? "";
  const appPrefix = options.appPrefix ?? process.env.FACTORY_SB_APP_PREFIX?.trim() ?? "";
  const brokerOrigin = requiredOrigin(
    options.brokerOrigin ?? process.env.FACTORY_SB_BASE_URL,
    "FACTORY_SB_BASE_URL",
  );
  const fetchFn = options.fetchFn ?? fetch;
  if (token.length < 16) throw new Error("FACTORY_SB_DELETE_TOKEN must contain at least 16 characters");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/.test(appPrefix)) {
    throw new Error("FACTORY_SB_APP_PREFIX is invalid");
  }

  // This is intentionally narrower than the signed, deep `/health` route on
  // the control service. The workload needs only proof that the authenticated
  // delete endpoint is installed before it starts durable orphan recovery;
  // full cleanup readiness still depends on the workload and therefore cannot
  // be used as this Compose dependency without creating a health cycle.
  app.get("/internal/health/delete-control", async (request, reply) => {
    const auth = request.headers.authorization ?? "";
    const supplied = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!secretEqual(supplied, token)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    return reply.send({
      schema: SANDBOX_DELETE_CONTROL_READINESS_SCHEMA,
      ready: true,
    });
  });

  app.delete("/internal/inngest/apps/:appId", async (request, reply) => {
    const auth = request.headers.authorization ?? "";
    const supplied = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!secretEqual(supplied, token)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const appId = (request.params as { appId: string }).appId;
    if (!sandboxAppId(appId, appPrefix)) {
      return reply.code(403).send({ error: "non-sandbox app identity refused" });
    }
    const expiryHeader = request.headers["x-agentic-sandbox-tombstone-expires-at"];
    const expiresAt = Array.isArray(expiryHeader) ? undefined : expiryHeader;
    const expiryMs = typeof expiresAt === "string" ? Date.parse(expiresAt) : Number.NaN;
    if (
      typeof expiresAt !== "string"
      || !Number.isFinite(expiryMs)
      || expiryMs <= Date.now()
      || expiryMs > Date.now() + 30 * 24 * 60 * 60_000
    ) {
      return reply.code(400).send({ error: "sandbox tombstone expiry is required" });
    }
    // This must be the first broker-side operation.  The gateway persists and
    // fsyncs the anti-resurrection fence, blocks new register/callback traffic,
    // and joins earlier in-flight traffic before acknowledging.
    await installGatewayTombstone({
      brokerOrigin,
      appId,
      expiresAt,
      fetchFn,
      authToken: options.brokerAuthToken,
    });
    const before = await brokerGraphql<BrokerAppsResponse>({
      brokerOrigin,
      query: "{ apps { name } }",
      fetchFn,
      authToken: options.brokerAuthToken,
    });
    if (before.errors?.length) throw new Error("sandbox broker app query failed");
    const exists = (before.data?.apps ?? []).some((entry) => entry.name === appId);
    if (!exists) return reply.code(404).send({ alreadyAbsent: true });

    const deleted = await brokerGraphql<BrokerDeleteResponse>({
      brokerOrigin,
      query: "mutation DeleteFactorySandboxApp($name: String!) { deleteAppByName(name: $name) }",
      variables: { name: appId },
      fetchFn,
      authToken: options.brokerAuthToken,
    });
    if (deleted.errors?.length || deleted.data?.deleteAppByName !== true) {
      throw new Error("sandbox broker refused app deletion");
    }
    return reply.send({ deleted: true });
  });
}
