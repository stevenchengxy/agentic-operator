/** Production truthfulness guards and the durable code-agent enqueue path. */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getDb, runs } from "@agentic/db";
import { eq } from "drizzle-orm";
import { getTenantInngest } from "@agentic/runtime";
import { buildTestEnv, type TestEnv } from "./harness";

describe("real-runtime provider guards", () => {
  let env: TestEnv;

  beforeAll(async () => {
    env = await buildTestEnv();
  });

  afterAll(async () => {
    await env.cleanup();
  });

  async function requestAsRunnableProcess(
    path: string,
    init?: RequestInit,
  ): Promise<Response> {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    try {
      return await env.fetch(path, init);
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
  }

  it("hides non-operational providers from production discovery", async () => {
    const response = await requestAsRunnableProcess("/v1/llm/providers");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: Array<{ id: string }> };
    const ids = body.data.map((provider) => provider.id);
    expect(ids).not.toContain("mock");
    expect(ids).not.toContain("bedrock");
    expect(ids).not.toContain("vertex");
  });

  it.each([
    ["connection test", "/v1/llm/providers/mock/test", "POST"],
    ["model discovery", "/v1/llm/providers/mock/available-models", "GET"],
    ["key write", "/v1/llm/providers/mock/key", "POST"],
  ])("rejects mock provider %s outside a test process", async (_label, path, method) => {
    const response = await requestAsRunnableProcess(path, {
      method,
      headers: { "content-type": "application/json" },
      body: method === "POST" ? JSON.stringify({ apiKey: "mock-key-value", scope: "workspace" }) : undefined,
    });
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("provider_unavailable");
  });

  it("rejects a tenant-scoped key until that scope affects runtime routing", async () => {
    const response = await requestAsRunnableProcess(
      "/v1/llm/providers/openrouter/key",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          apiKey: "sk-or-real-scope-test-value",
          scope: "tenant",
        }),
      },
    );
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("tenant_key_scope_unavailable");
  });

  it("never lets a portal test-run flag opt into mock inference", async () => {
    const response = await requestAsRunnableProcess(
      "/v1/agents/testAgent/invoke?testRun=1",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "mock" }),
      },
    );
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("mock_provider_forbidden");
  });
});

describe("durable async code-agent invocation", () => {
  let env: TestEnv;
  let runId: string | undefined;

  beforeAll(async () => {
    env = await buildTestEnv();
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    if (runId) getDb().delete(runs).where(eq(runs.id, runId)).run();
    await env.cleanup();
  });

  it("persists one queued run and sends an Inngest event carrying the same run id", async () => {
    const client = getTenantInngest("__system");
    const send = vi.spyOn(client, "send").mockResolvedValue({ ids: ["evt-test"] } as never);

    const response = await env.fetch("/v1/agents/testAgent/invoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        async: true,
        input: { subject: "ASYNC-REAL-1", prompt: "health check" },
      }),
    });
    expect(response.status).toBe(202);
    const body = (await response.json()) as {
      data: { runId: string; status: string; correlationId: string };
    };
    runId = body.data.runId;
    expect(body.data.status).toBe("queued");

    const row = getDb().select().from(runs).where(eq(runs.id, runId)).all()[0];
    expect(row).toMatchObject({
      id: runId,
      status: "queued",
      correlationId: body.data.correlationId,
      subject: "ASYNC-REAL-1",
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      name: "__system/code.testAgent.invoke",
      data: { runId, correlationId: body.data.correlationId },
    });
  });
});
