import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { httpFetchTool } from "@agentic/tools/http";
import { _setHttpFetchDnsLookupForTests } from "../../../packages/tools/src/http/fetch";
import { findWorkflowSecretPolicyIssues } from "../src/services/workflow-secret-policy";

const TENANT = "tenant-test";

function workflow(config?: Record<string, unknown>): unknown {
  return [
    {
      id: "fetch-agent",
      tool_use: [
        {
          name: "http.fetch",
          ...(config === undefined ? {} : { config }),
        },
      ],
    },
  ];
}

function policy(config?: Record<string, unknown>) {
  return findWorkflowSecretPolicyIssues(workflow(config), undefined, {
    tenantSlug: TENANT,
  });
}

function invoke(
  config: Record<string, unknown>,
  data: Record<string, unknown>,
) {
  return httpFetchTool.handler({
    agentName: "fetchAgent",
    actionName: "fetch",
    correlationId: "cor-http-security",
    tenantSlug: TENANT,
    config,
    event: { name: "tool:http.fetch", data },
  });
}

describe("workflow http.fetch persistence policy", () => {
  const previousAllowlist = process.env.AGENTIC_WORKFLOW_ENDPOINT_ALLOWLIST;
  const previousLocalhost = process.env.AGENTIC_FETCH_ALLOW_HTTP_LOCALHOST;

  afterEach(() => {
    if (previousAllowlist === undefined)
      delete process.env.AGENTIC_WORKFLOW_ENDPOINT_ALLOWLIST;
    else process.env.AGENTIC_WORKFLOW_ENDPOINT_ALLOWLIST = previousAllowlist;
    if (previousLocalhost === undefined)
      delete process.env.AGENTIC_FETCH_ALLOW_HTTP_LOCALHOST;
    else process.env.AGENTIC_FETCH_ALLOW_HTTP_LOCALHOST = previousLocalhost;
  });

  it("requires base_url, exact allow_host, and independent server authorization", () => {
    expect(policy().map((issue) => issue.path)).toEqual(
      expect.arrayContaining([
        "agents[0].tool_use[0].config.base_url",
        "agents[0].tool_use[0].config.allow_host",
      ]),
    );

    const unapproved = policy({
      base_url: "https://api.example.com/v1",
      allow_host: "api.example.com",
    });
    expect(
      unapproved.some((issue) => issue.message.includes("ENDPOINT_ALLOWLIST")),
    ).toBe(true);

    process.env.AGENTIC_WORKFLOW_ENDPOINT_ALLOWLIST =
      "https://api.example.com/v1";
    expect(
      policy({
        base_url: "https://api.example.com/v1",
        allow_host: "*.example.com",
      }).some((issue) => issue.path.endsWith("allow_host")),
    ).toBe(true);
    expect(
      policy({
        base_url: "https://api.example.com/v1",
        allow_host: "api.example.com",
      }),
    ).toEqual([]);
  });

  it("rejects private endpoints and credential-bearing endpoint queries", () => {
    process.env.AGENTIC_WORKFLOW_ENDPOINT_ALLOWLIST =
      "https://127.0.0.1,https://api.example.com";
    expect(
      policy({
        base_url: "https://127.0.0.1/private",
        allow_host: "127.0.0.1",
      }).some((issue) => issue.message.includes("public")),
    ).toBe(true);
    expect(
      policy({
        base_url: "https://api.example.com/v1?api_key=literal",
        allow_host: "api.example.com",
      }).some((issue) => issue.message.includes("query")),
    ).toBe(true);
  });

  it("detects generic token/auth and private-key literals without rejecting name metadata", () => {
    process.env.AGENTIC_WORKFLOW_ENDPOINT_ALLOWLIST =
      "https://api.example.com/v1";
    const issues = policy({
      base_url: "https://api.example.com/v1",
      allow_host: "api.example.com",
      auth_scheme: "header",
      auth_header_name: "X-Auth-Token",
      auth_query_name: "private_key",
      default_headers: {
        "X-Auth": "opaque-auth",
        token: "opaque-token",
      },
      private_key: "opaque-private-key",
    });
    expect(
      issues
        .filter((issue) => issue.code === "literal_secret")
        .map((issue) => issue.path),
    ).toEqual(
      expect.arrayContaining([
        "agents[0].tool_use[0].config.default_headers.X-Auth",
        "agents[0].tool_use[0].config.default_headers.token",
        "agents[0].tool_use[0].config.private_key",
      ]),
    );
    expect(
      issues.some((issue) => issue.path.endsWith("auth_header_name")),
    ).toBe(false);
    expect(issues.some((issue) => issue.path.endsWith("auth_query_name"))).toBe(
      false,
    );
    expect(issues.some((issue) => issue.path.endsWith("auth_scheme"))).toBe(
      false,
    );
  });
});

describe("http.fetch runtime SSRF boundary", () => {
  let server: Server;
  let port = 0;
  const previousLocalhost = process.env.AGENTIC_FETCH_ALLOW_HTTP_LOCALHOST;
  const previousAllowlist = process.env.AGENTIC_WORKFLOW_ENDPOINT_ALLOWLIST;
  const keyEnv = "TENANT_TENANT_TEST_HTTP_KEY";
  const previousKey = process.env[keyEnv];

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/v1/redirect-private") {
        res.writeHead(302, { Location: "http://169.254.169.254/latest" });
        res.end();
        return;
      }
      if (req.url === "/v1/redirect-ok") {
        res.writeHead(302, { Location: "/v1/ok" });
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          path: req.url,
          auth: req.headers["x-auth-token"] ?? null,
        }),
      );
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("missing port");
    port = address.port;
  });

  afterEach(() => {
    _setHttpFetchDnsLookupForTests(null);
    process.env.AGENTIC_FETCH_ALLOW_HTTP_LOCALHOST = "1";
    process.env.AGENTIC_WORKFLOW_ENDPOINT_ALLOWLIST = "";
    delete process.env[keyEnv];
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    if (previousLocalhost === undefined)
      delete process.env.AGENTIC_FETCH_ALLOW_HTTP_LOCALHOST;
    else process.env.AGENTIC_FETCH_ALLOW_HTTP_LOCALHOST = previousLocalhost;
    if (previousAllowlist === undefined)
      delete process.env.AGENTIC_WORKFLOW_ENDPOINT_ALLOWLIST;
    else process.env.AGENTIC_WORKFLOW_ENDPOINT_ALLOWLIST = previousAllowlist;
    if (previousKey === undefined) delete process.env[keyEnv];
    else process.env[keyEnv] = previousKey;
  });

  function localConfig(extra: Record<string, unknown> = {}) {
    return {
      base_url: `http://127.0.0.1:${port}/v1`,
      allow_host: "127.0.0.1",
      ...extra,
    };
  }

  it("requires the explicit localhost gate and rejects absolute overrides", async () => {
    delete process.env.AGENTIC_FETCH_ALLOW_HTTP_LOCALHOST;
    await expect(invoke(localConfig(), { path: "/ok" })).rejects.toThrow(
      /internal|non-public|HTTPS/,
    );
    process.env.AGENTIC_FETCH_ALLOW_HTTP_LOCALHOST = "1";
    await expect(
      invoke(localConfig(), { path: "https://example.com/escape" }),
    ).rejects.toThrow(/absolute URL overrides/);
  });

  it("rejects model-controlled sensitive headers and query parameters", async () => {
    process.env.AGENTIC_FETCH_ALLOW_HTTP_LOCALHOST = "1";
    await expect(
      invoke(localConfig(), { path: "/ok", query: { token: "opaque" } }),
    ).rejects.toThrow(/sensitive query/);
    await expect(
      invoke(localConfig(), {
        path: "/ok",
        headers: { "X-Auth-Token": "opaque" },
      }),
    ).rejects.toThrow(/may not set sensitive/);
  });

  it("pins an explicitly gated localhost request and validates every redirect", async () => {
    process.env.AGENTIC_FETCH_ALLOW_HTTP_LOCALHOST = "1";
    const direct = await invoke(localConfig(), { path: "/ok" });
    expect(direct.data).toMatchObject({ status: 200, ok: true });
    const redirected = await invoke(localConfig(), { path: "/redirect-ok" });
    expect(redirected.data).toMatchObject({ status: 200, ok: true });
    await expect(
      invoke(localConfig(), { path: "/redirect-private" }),
    ).rejects.toThrow(/allow_host|origin|non-public/);
  });

  it("allows a configured auth header name but never silently downgrades an empty env", async () => {
    process.env.AGENTIC_FETCH_ALLOW_HTTP_LOCALHOST = "1";
    await expect(
      invoke(
        localConfig({
          api_key_env: keyEnv,
          auth_scheme: "header",
          auth_header_name: "X-Auth-Token",
        }),
        { path: "/ok" },
      ),
    ).rejects.toThrow(/unset or empty/);

    process.env[keyEnv] = "server-owned-test-key";
    const response = await invoke(
      localConfig({
        api_key_env: keyEnv,
        auth_scheme: "header",
        auth_header_name: "X-Auth-Token",
      }),
      { path: "/ok" },
    );
    expect(response.data.body).toMatchObject({ auth: "server-owned-test-key" });
  });

  it("rejects the whole DNS hop when any answer is private", async () => {
    process.env.AGENTIC_WORKFLOW_ENDPOINT_ALLOWLIST =
      "https://public.example.test/v1";
    _setHttpFetchDnsLookupForTests(async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.5", family: 4 },
    ]);
    await expect(
      invoke(
        {
          base_url: "https://public.example.test/v1",
          allow_host: "public.example.test",
        },
        { path: "/ok" },
      ),
    ).rejects.toThrow(/non-public address 10\.0\.0\.5/);
  });
});
