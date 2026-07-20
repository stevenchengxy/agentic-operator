import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildSandboxBrokerGateway,
  loadSandboxBrokerGatewayConfig,
  type SandboxBrokerGatewayConfig,
} from "../src/sandbox-broker-gateway";

const TOKEN = "sandbox-broker-control-token-at-least-32-bytes";
const TOMBSTONE_KEY = "sandbox-gateway-tombstone-integrity-key-at-least-32-bytes";
const PREFIX = "agentic-factory-sandbox";
const SLUG = "af-sbx-1234abcd-5678efab-123456789abc-sb";
const APP_ID = `${PREFIX}-${SLUG}`;
const roots: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function config(): SandboxBrokerGatewayConfig {
  const root = mkdtempSync(path.join(tmpdir(), "sandbox-broker-gateway-state-"));
  roots.push(root);
  return {
    host: "127.0.0.1",
    port: 3562,
    brokerOrigin: "http://sandbox-inngest:8288",
    workloadOrigin: "http://sandbox-workload:3561",
    controlToken: TOKEN,
    appPrefix: PREFIX,
    maxBodyBytes: 1024 * 1024,
    requestTimeoutMs: 5_000,
    tombstoneDir: root,
    tombstoneIntegrityKey: TOMBSTONE_KEY,
    tombstoneMaxEntries: 128,
  };
}

function tombstoneCommand(appId = APP_ID, expiresAt = new Date(Date.now() + 60_000).toISOString()) {
  return {
    method: "POST" as const,
    url: `/internal/factory-sandbox/tombstones/${appId}`,
    headers: { authorization: `Bearer ${TOKEN}` },
    payload: {
      schema: "agent-factory-sandbox-gateway-tombstone-command/v1",
      appId,
      expiresAt,
    },
  };
}

describe("sandbox broker gateway", () => {
  it("loads its bearer from a file and rejects ambiguous secret sources", () => {
    const root = mkdtempSync(path.join(tmpdir(), "sandbox-broker-gateway-"));
    roots.push(root);
    const secret = path.join(root, "control-token");
    const tombstoneSecret = path.join(root, "tombstone-key");
    writeFileSync(secret, `${TOKEN}\n`, { mode: 0o600 });
    writeFileSync(tombstoneSecret, `${TOMBSTONE_KEY}\n`, { mode: 0o600 });
    const env = {
      SANDBOX_BROKER_UPSTREAM_ORIGIN: "http://sandbox-inngest:8288",
      SANDBOX_WORKLOAD_UPSTREAM_ORIGIN: "http://sandbox-workload:3561",
      SANDBOX_INNGEST_CONTROL_BEARER_FILE: secret,
      SANDBOX_INNGEST_APP_PREFIX: PREFIX,
      SANDBOX_GATEWAY_TOMBSTONE_HMAC_FILE: tombstoneSecret,
      AGENTIC_DATA_ROOT: root,
    };
    expect(loadSandboxBrokerGatewayConfig(env)).toMatchObject({
      controlToken: TOKEN,
      brokerOrigin: "http://sandbox-inngest:8288",
      workloadOrigin: "http://sandbox-workload:3561",
      tombstoneIntegrityKey: TOMBSTONE_KEY,
    });
    expect(() => loadSandboxBrokerGatewayConfig({
      ...env,
      SANDBOX_INNGEST_CONTROL_BEARER: TOKEN,
    })).toThrow(/cannot both be set/);
  });

  it("authenticates and allowlists authoritative app readback", async () => {
    const fetchFn = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBeNull();
      return new Response(JSON.stringify({ data: { apps: [{ name: "one" }] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const app = await buildSandboxBrokerGateway({ config: config(), fetchFn });

    const unauthorized = await app.inject({
      method: "POST",
      url: "/v0/gql",
      payload: { query: "{ apps { name } }" },
    });
    expect(unauthorized.statusCode).toBe(401);
    expect(fetchFn).not.toHaveBeenCalled();

    const forbidden = await app.inject({
      method: "POST",
      url: "/v0/gql",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { query: "{ events { id } }" },
    });
    expect(forbidden.statusCode).toBe(403);
    expect(fetchFn).not.toHaveBeenCalled();

    const allowed = await app.inject({
      method: "POST",
      url: "/v0/gql",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { query: "{ apps { name } }" },
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toEqual({ data: { apps: [{ name: "one" }] } });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("permits deletion only after a durable Factory nonce tombstone", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({
      data: { deleteAppByName: true },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
    const app = await buildSandboxBrokerGateway({ config: config(), fetchFn });
    const query = "mutation DeleteFactorySandboxApp($name: String!) { deleteAppByName(name: $name) }";

    const production = await app.inject({
      method: "POST",
      url: "/v0/gql",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { query, variables: { name: "agentic-operator-main" } },
    });
    expect(production.statusCode).toBe(403);
    expect(fetchFn).not.toHaveBeenCalled();

    const unfenced = await app.inject({
      method: "POST",
      url: "/v0/gql",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { query, variables: { name: APP_ID } },
    });
    expect(unfenced.statusCode).toBe(409);
    expect(fetchFn).not.toHaveBeenCalled();

    const fenced = await app.inject(tombstoneCommand());
    expect(fenced.statusCode).toBe(202);
    expect(fenced.json()).toMatchObject({ appId: APP_ID, durable: true });

    const ephemeral = await app.inject({
      method: "POST",
      url: "/v0/gql",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: {
        query,
        variables: { name: APP_ID },
      },
    });
    expect(ephemeral.statusCode).toBe(200);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("routes signed callbacks to workload and SDK traffic to broker without leaking the gateway bearer", async () => {
    const seen: Array<{ url: string; body: string; authorization: string | null }> = [];
    const fetchFn = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      seen.push({
        url: String(url),
        body: init?.body instanceof ArrayBuffer
          ? Buffer.from(init.body).toString("utf8")
          : Buffer.isBuffer(init?.body)
            ? init.body.toString("utf8")
            : String(init?.body ?? ""),
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return new Response("ok", { status: 202, headers: { "content-type": "text/plain" } });
    }) as unknown as typeof fetch;
    const app = await buildSandboxBrokerGateway({ config: config(), fetchFn });

    const callbackBytes = '{"b":2, "a":1}';
    const callback = await app.inject({
      method: "POST",
      url: `/inngest/${SLUG}?step=1`,
      headers: {
        "content-type": "application/json",
        "x-inngest-signature": "signed-callback",
      },
      payload: callbackBytes,
    });
    expect(callback.statusCode).toBe(202);
    expect(seen[0]).toMatchObject({
      url: `http://sandbox-workload:3561/inngest/${SLUG}?step=1`,
      body: callbackBytes,
    });

    const event = await app.inject({
      method: "POST",
      url: "/e/sandbox-event-key",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TOKEN}`,
      },
      payload: '{"name":"sandbox/event"}',
    });
    expect(event.statusCode).toBe(202);
    expect(seen[1]).toMatchObject({
      url: "http://sandbox-inngest:8288/e/sandbox-event-key",
      authorization: null,
    });

    const unknown = await app.inject({
      method: "POST",
      url: "/debug/arbitrary-broker-endpoint",
      payload: "{}",
    });
    expect(unknown.statusCode).toBe(404);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    await app.close();
  });

  it("persists a tombstone across restart and rejects late registration and callbacks", async () => {
    const shared = config();
    const firstFetch = vi.fn(async () => new Response("ok", { status: 202 })) as unknown as typeof fetch;
    const first = await buildSandboxBrokerGateway({ config: shared, fetchFn: firstFetch });
    const fenced = await first.inject(tombstoneCommand());
    expect(fenced.statusCode).toBe(202);
    await first.close();

    const restartedFetch = vi.fn(async () => new Response("should-not-forward", { status: 202 })) as unknown as typeof fetch;
    const restarted = await buildSandboxBrokerGateway({ config: shared, fetchFn: restartedFetch });
    const registration = await restarted.inject({
      method: "PUT",
      url: "/fn/register",
      payload: { appName: APP_ID, url: `http://sandbox-workload:3561/inngest/${SLUG}` },
    });
    expect(registration.statusCode).toBe(410);
    const callback = await restarted.inject({
      method: "POST",
      url: `/inngest/${SLUG}`,
      payload: "{}",
    });
    expect(callback.statusCode).toBe(410);
    expect(restartedFetch).not.toHaveBeenCalled();
    await restarted.close();
  });

  it("rejects malformed/non-Factory registrations and waits for earlier exact-App traffic before fencing", async () => {
    let releaseRegistration!: () => void;
    const registrationGate = new Promise<void>((resolve) => { releaseRegistration = resolve; });
    const fetchFn = vi.fn(async (url: URL | RequestInfo) => {
      if (String(url).includes("/fn/register")) await registrationGate;
      return new Response("ok", { status: 202 });
    }) as unknown as typeof fetch;
    const app = await buildSandboxBrokerGateway({ config: config(), fetchFn });

    const malformed = await app.inject({ method: "PUT", url: "/fn/register", payload: {} });
    expect(malformed.statusCode).toBe(403);
    const production = await app.inject({
      method: "PUT",
      url: "/fn/register",
      payload: { appName: "agentic-operator-production" },
    });
    expect(production.statusCode).toBe(403);

    const earlier = app.inject({
      method: "PUT",
      url: "/fn/register",
      payload: { appName: APP_ID },
    });
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));
    let fenceSettled = false;
    const fencing = app.inject(tombstoneCommand()).then((value) => {
      fenceSettled = true;
      return value;
    });
    await Promise.resolve();
    expect(fenceSettled).toBe(false);
    releaseRegistration();
    expect((await earlier).statusCode).toBe(202);
    expect((await fencing).statusCode).toBe(202);

    const late = await app.inject({
      method: "PUT",
      url: "/fn/register",
      payload: { appName: APP_ID },
    });
    expect(late.statusCode).toBe(410);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("releases only after retention, clean-owner proof, and exact broker absence", async () => {
    let brokerContainsApp = true;
    const fetchFn = vi.fn(async (url: URL | RequestInfo) => {
      if (String(url).endsWith("/v0/gql")) {
        return new Response(JSON.stringify({
          data: { apps: brokerContainsApp ? [{ name: APP_ID }] : [] },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("ok", { status: 202 });
    }) as unknown as typeof fetch;
    const app = await buildSandboxBrokerGateway({ config: config(), fetchFn });
    const expiresAt = new Date(Date.now() + 100).toISOString();
    expect((await app.inject(tombstoneCommand(APP_ID, expiresAt))).statusCode).toBe(202);

    const release = () => app.inject({
      method: "DELETE",
      url: `/internal/factory-sandbox/tombstones/${APP_ID}`,
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: {
        schema: "agent-factory-sandbox-gateway-tombstone-release/v1",
        appId: APP_ID,
        workloadClean: true,
        candidateClean: true,
      },
    });
    expect((await release()).statusCode).toBe(409);
    await new Promise((resolve) => setTimeout(resolve, 125));
    const dirtyRelease = await app.inject({
      method: "DELETE",
      url: `/internal/factory-sandbox/tombstones/${APP_ID}`,
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: {
        schema: "agent-factory-sandbox-gateway-tombstone-release/v1",
        appId: APP_ID,
        workloadClean: true,
        candidateClean: false,
      },
    });
    expect(dirtyRelease.statusCode).toBe(400);
    expect((await release()).statusCode).toBe(409);
    brokerContainsApp = false;
    const released = await release();
    expect(released.statusCode).toBe(200);
    expect(released.json()).toMatchObject({ appId: APP_ID, released: true });

    const registration = await app.inject({
      method: "PUT",
      url: "/fn/register",
      payload: { appName: APP_ID },
    });
    expect(registration.statusCode).toBe(202);
    await app.close();
  });

  it("fails closed at bounded tombstone capacity", async () => {
    const bounded = config();
    bounded.tombstoneMaxEntries = 1;
    const app = await buildSandboxBrokerGateway({
      config: bounded,
      fetchFn: vi.fn() as unknown as typeof fetch,
    });
    expect((await app.inject(tombstoneCommand())).statusCode).toBe(202);
    const secondSlug = "af-sbx-aaaaaaaa-bbbbbbbb-cccccccccccc-sb";
    const secondApp = `${PREFIX}-${secondSlug}`;
    const refused = await app.inject(tombstoneCommand(secondApp));
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toMatch(/capacity/);
    await app.close();
  });

  it("fails restart closed when persisted tombstone integrity is corrupted", async () => {
    const shared = config();
    const app = await buildSandboxBrokerGateway({
      config: shared,
      fetchFn: vi.fn() as unknown as typeof fetch,
    });
    expect((await app.inject(tombstoneCommand())).statusCode).toBe(202);
    await app.close();

    const filename = path.join(shared.tombstoneDir, `${APP_ID}.json`);
    const persisted = JSON.parse(readFileSync(filename, "utf8")) as { expiresAt: string };
    persisted.expiresAt = new Date(Date.parse(persisted.expiresAt) + 1_000).toISOString();
    writeFileSync(filename, `${JSON.stringify(persisted)}\n`);
    await expect(buildSandboxBrokerGateway({
      config: shared,
      fetchFn: vi.fn() as unknown as typeof fetch,
    })).rejects.toThrow(/integrity check failed/);
  });
});
