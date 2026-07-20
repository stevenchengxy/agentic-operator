import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import { registerSandboxRunnerDeleteControl } from "../src/services/agent-factory/sandbox-runner-delete-control";

const TOKEN = "delete-control-secret-123456";
const PREFIX = "agentic-factory-sandbox";
const APP_ID = `${PREFIX}-af-sbx-1234abcd-5678efab-123456789abc-sb`;
const BROKER_TOKEN = "broker-control-bearer-123456";

describe("Factory sandbox runner delete control", () => {
  it("exposes a token-authenticated readiness signal without contacting the broker", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    const app = Fastify();
    await registerSandboxRunnerDeleteControl(app, {
      token: TOKEN,
      brokerOrigin: "http://sandbox-inngest:8288",
      appPrefix: PREFIX,
      fetchFn,
    });

    const denied = await app.inject({
      method: "GET",
      url: "/internal/health/delete-control",
    });
    const ready = await app.inject({
      method: "GET",
      url: "/internal/health/delete-control",
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    expect(denied.statusCode).toBe(401);
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({
      schema: "agent-factory-sandbox-delete-control-readiness/v1",
      ready: true,
    });
    expect(fetchFn).not.toHaveBeenCalled();
    await app.close();
  });

  it("deletes only a nonce sandbox app through the broker GraphQL API", async () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const fetchFn = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        schema: "agent-factory-sandbox-gateway-tombstone-ack/v1",
        appId: APP_ID,
        expiresAt,
        durable: true,
      }), { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: { apps: [{ name: APP_ID }] },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: { deleteAppByName: true },
      }), { status: 200 }));
    const app = Fastify();
    await registerSandboxRunnerDeleteControl(app, {
      token: TOKEN,
      brokerOrigin: "http://sandbox-inngest:8288",
      appPrefix: PREFIX,
      fetchFn,
      brokerAuthToken: BROKER_TOKEN,
    });

    const response = await app.inject({
      method: "DELETE",
      url: `/internal/inngest/apps/${APP_ID}`,
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "x-agentic-sandbox-tombstone-expires-at": expiresAt,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(fetchFn.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: `Bearer ${BROKER_TOKEN}`,
    });
    expect(String(fetchFn.mock.calls[0]?.[0])).toContain("/internal/factory-sandbox/tombstones/");
    expect(JSON.parse(String(fetchFn.mock.calls[2]?.[1]?.body))).toMatchObject({
      variables: { name: APP_ID },
    });
    await app.close();
  });

  it("refuses production-shaped app identities before contacting the broker", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    const app = Fastify();
    await registerSandboxRunnerDeleteControl(app, {
      token: TOKEN,
      brokerOrigin: "http://sandbox-inngest:8288",
      appPrefix: PREFIX,
      fetchFn,
    });

    const response = await app.inject({
      method: "DELETE",
      url: "/internal/inngest/apps/agentic-operator-agents-generation",
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    expect(response.statusCode).toBe(403);
    expect(fetchFn).not.toHaveBeenCalled();
    await app.close();
  });

  it("treats an already absent sandbox app as an idempotent 404", async () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const fetchFn = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        schema: "agent-factory-sandbox-gateway-tombstone-ack/v1",
        appId: APP_ID,
        expiresAt,
        durable: true,
      }), { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: { apps: [] },
      }), { status: 200 }));
    const app = Fastify();
    await registerSandboxRunnerDeleteControl(app, {
      token: TOKEN,
      brokerOrigin: "http://sandbox-inngest:8288",
      appPrefix: PREFIX,
      fetchFn,
    });

    const response = await app.inject({
      method: "DELETE",
      url: `/internal/inngest/apps/${APP_ID}`,
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "x-agentic-sandbox-tombstone-expires-at": expiresAt,
      },
    });

    expect(response.statusCode).toBe(404);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    await app.close();
  });
});
