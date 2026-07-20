import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ToolContext } from "@agentic/agent-kit";
import { httpFetchTool, _setHttpFetchDnsLookupForTests } from "./fetch";

function ctx(path: string, config: Record<string, unknown>): ToolContext {
  return {
    agentName: "agent",
    actionName: "fetch",
    correlationId: "cor-1",
    tenantSlug: "tenant",
    event: { name: "HTTP", data: { method: "GET", path } },
    config,
  } as ToolContext;
}

// The merged http.fetch uses node:http transports with DNS pinning (not
// global fetch), so the behavioural tests drive a real loopback server via
// the explicit dev-localhost gate.
let server: http.Server;
let base = "";
const prevEnv: Record<string, string | undefined> = {};

function restoreEnv(name: string): void {
  if (prevEnv[name] === undefined) delete process.env[name];
  else process.env[name] = prevEnv[name];
}

beforeAll(async () => {
  prevEnv.AGENTIC_FETCH_ALLOW_HTTP_LOCALHOST =
    process.env.AGENTIC_FETCH_ALLOW_HTTP_LOCALHOST;
  process.env.AGENTIC_FETCH_ALLOW_HTTP_LOCALHOST = "1";
  server = http.createServer((req, res) => {
    if (req.url?.startsWith("/v1/jobs")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, path: req.url }));
      return;
    }
    if (req.url?.startsWith("/redirect-evil")) {
      res.writeHead(302, { location: "https://evil.example/steal" });
      res.end();
      return;
    }
    if (req.url?.startsWith("/vendor-reject")) {
      res.writeHead(422, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "vendor rejected request" }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  restoreEnv("AGENTIC_FETCH_ALLOW_HTTP_LOCALHOST");
});

afterEach(() => _setHttpFetchDnsLookupForTests(null));

function loopbackConfig(): Record<string, unknown> {
  return { base_url: base, allow_host: ["127.0.0.1"] };
}

describe("http.fetch egress boundaries", () => {
  it("serves a relative path inside the configured base_url", async () => {
    const result = await httpFetchTool.handler(ctx("/v1/jobs", loopbackConfig()));
    const data = result.data as { status: number; ok: boolean; body: unknown };
    expect(data.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.body).toMatchObject({ ok: true });
  });

  it("rejects an LLM-supplied absolute URL override", async () => {
    await expect(
      httpFetchTool.handler(ctx("https://evil.example/steal", loopbackConfig())),
    ).rejects.toThrow(/relative|forbidden/i);
  });

  it("still blocks private/metadata targets even when used as base_url", async () => {
    await expect(
      httpFetchTool.handler(
        ctx("/latest/meta-data", {
          base_url: "http://169.254.169.254",
          allow_host: ["169.254.169.254"],
        }),
      ),
    ).rejects.toThrow(/internal|non-public/i);
  });

  it("revalidates redirect hosts before following them", async () => {
    await expect(
      httpFetchTool.handler(ctx("/redirect-evil", loopbackConfig())),
    ).rejects.toThrow(/allow_host|origin/i);
  });

  it("rejects hostnames whose DNS answers include a non-public address", async () => {
    prevEnv.AGENTIC_WORKFLOW_ENDPOINT_ALLOWLIST =
      process.env.AGENTIC_WORKFLOW_ENDPOINT_ALLOWLIST;
    process.env.AGENTIC_WORKFLOW_ENDPOINT_ALLOWLIST =
      "https://rebind.example.com";
    _setHttpFetchDnsLookupForTests(async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.8", family: 4 },
    ]);
    try {
      await expect(
        httpFetchTool.handler(
          ctx("/v1/jobs", {
            base_url: "https://rebind.example.com",
            allow_host: ["rebind.example.com"],
          }),
        ),
      ).rejects.toThrow(/non-public/i);
    } finally {
      restoreEnv("AGENTIC_WORKFLOW_ENDPOINT_ALLOWLIST");
    }
  });

  it("fails a direct workflow tool call on non-2xx instead of returning a false-success payload", async () => {
    await expect(
      httpFetchTool.handler(ctx("/vendor-reject", loopbackConfig())),
    ).rejects.toThrow(/HTTP 422.*vendor rejected request/);
  });
});
