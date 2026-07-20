import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearFactorySandboxModelGrants,
  factorySandboxModelProxyRoutes,
  factorySandboxModelUsageLedgerIssues,
  readFactorySandboxModelUsageEvidence,
  registerFactorySandboxModelGrant,
} from "../src/services/agent-factory/factory-sandbox-model-proxy";
import {
  clearSandboxModelExecutionContexts,
  createSandboxModelProxyGateway,
  installSandboxModelExecutionContext,
} from "../src/services/agent-factory/sandbox-model-client";
import { _setLLMGatewayForTests } from "../src/services/llm";
import {
  sandboxModelRequestDigest,
  sandboxModelResponseSignature,
} from "../src/services/agent-factory/sandbox-model-protocol";

const token = "sandbox-model-proxy-test-token-with-32-bytes-minimum";

afterEach(() => {
  clearFactorySandboxModelGrants();
  clearSandboxModelExecutionContexts();
  _setLLMGatewayForTests(null);
  delete process.env.FACTORY_SB_MODEL_PROXY_TOKEN;
  delete process.env.FACTORY_SB_MODEL_PROXY_TOKEN_FILE;
});

describe("Factory sandbox semantic model proxy", () => {
  it("binds a real gateway call to the exact active attempt and target tenant", async () => {
    process.env.FACTORY_SB_MODEL_PROXY_TOKEN = token;
    const chat = vi.fn(async () => ({
      text: "{\"emit\":\"DONE\"}",
      provider: "openai" as const,
      model: "gpt-test",
      tokensIn: 12,
      tokensOut: 6,
      finishReason: "stop" as const,
      latencyMs: 10,
      raw: { secretProviderDetail: true },
    }));
    _setLLMGatewayForTests({
      defaultProvider: "openai",
      defaultModel: "gpt-test",
      listProviders: () => [{ id: "openai", name: "OpenAI", hasKey: true, defaultModel: "gpt-test", models: [] }],
      chat,
    } as never);
    const revoke = registerFactorySandboxModelGrant({
      attemptId: "attempt-1",
      bundleHash: "bundle-1",
      tenantId: "tenant-1",
      tenantSlug: "agents-generation",
      expiresAt: Date.now() + 60_000,
      maxCalls: 1,
      maxTotalTokens: 100_000,
    });
    const app = Fastify();
    await app.register(factorySandboxModelProxyRoutes);
    const response = await app.inject({
      method: "POST",
      url: "/internal/factory-sandbox/model/chat",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        attemptId: "attempt-1",
        bundleHash: "bundle-1",
        tenantId: "tenant-1",
        tenantSlug: "agents-generation",
        requestId: "request-attempt-1-first",
        request: {
          messages: [{ role: "user", content: "decide" }],
          provider: "mock",
          model: "unreviewed-model",
          purpose: "agent:test/reason",
          jsonMode: true,
        },
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(expect.objectContaining({
      text: "{\"emit\":\"DONE\"}",
      provider: "openai",
    }));
    expect(response.body).not.toContain("secretProviderDetail");
    expect(chat).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: "tenant-1",
      tenantSlug: "agents-generation",
      purpose: "factory-sandbox:attempt-1:agent:test/reason",
      jsonMode: true,
    }));
    expect(chat.mock.calls[0]![0]).not.toHaveProperty("provider");
    expect(chat.mock.calls[0]![0]).not.toHaveProperty("model");

    const replay = await app.inject({
      method: "POST",
      url: "/internal/factory-sandbox/model/chat",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        attemptId: "attempt-1",
        bundleHash: "bundle-1",
        tenantId: "tenant-1",
        tenantSlug: "agents-generation",
        requestId: "request-attempt-1-replay",
        request: { messages: [{ role: "user", content: "again" }] },
      },
    });
    expect(replay.statusCode).toBe(429);
    expect(readFactorySandboxModelUsageEvidence("attempt-1", "bundle-1")).toMatchObject({
      calls: 2,
      successfulCalls: 1,
      failedCalls: 0,
      rejectedCalls: 1,
      agentCalls: expect.arrayContaining([expect.objectContaining({ agentRef: "test", successfulCalls: 1 })]),
      budget: expect.objectContaining({ enforced: true, maxCalls: 1, maxTotalTokens: 100_000 }),
    });
    revoke();
    await app.close();
  });

  it("keeps the service token and target identity out of candidate requests", async () => {
    const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(init?.headers).toEqual(expect.objectContaining({ authorization: `Bearer ${token}` }));
      expect(body).toMatchObject({
        attemptId: "attempt-client",
        bundleHash: "bundle-client",
        tenantId: "tenant-target",
        tenantSlug: "target-slug",
      });
      const requestDigest = sandboxModelRequestDigest({
        attemptId: String(body.attemptId),
        bundleHash: String(body.bundleHash),
        targetTenantId: String(body.tenantId),
        targetTenantSlug: String(body.tenantSlug),
        requestId: String(body.requestId),
        request: body.request,
      });
      const responseBody = {
        text: "{}",
        provider: "openai",
        model: "gpt-test",
        tokensIn: 1,
        tokensOut: 1,
        finishReason: "stop",
        latencyMs: 1,
      };
      return new Response(JSON.stringify(responseBody), { status: 200, headers: {
        "content-type": "application/json",
        "x-agentic-sandbox-model-total-reservation": "2048",
        "x-agentic-sandbox-model-max-calls": "4",
        "x-agentic-sandbox-model-max-total-tokens": "10000",
        "x-agentic-sandbox-model-response-signature": sandboxModelResponseSignature(token, {
          attemptId: "attempt-client",
          bundleHash: "bundle-client",
          targetTenantId: "tenant-target",
          targetTenantSlug: "target-slug",
          requestDigest,
          statusCode: 200,
          reservation: 2_048,
          maxCalls: 4,
          maxTotalTokens: 10_000,
          body: responseBody,
        }),
      } });
    });
    const remove = installSandboxModelExecutionContext({
      sandboxTenantSlug: "af-sbx-client-sb",
      attemptId: "attempt-client",
      bundleHash: "bundle-client",
      targetTenantId: "tenant-target",
      targetTenantSlug: "target-slug",
      maxCalls: 4,
      maxTotalTokens: 10_000,
    });
    const gateway = createSandboxModelProxyGateway({
      NODE_ENV: "test",
      SANDBOX_RUNNER_EGRESS_MODE: "deny_all",
      SANDBOX_MODEL_PROXY_ORIGIN: "http://api.internal",
      SANDBOX_MODEL_PROXY_TOKEN: token,
    } as NodeJS.ProcessEnv, fetchFn as typeof fetch);
    await gateway.chat({
      tenantId: "ephemeral-tenant-id",
      tenantSlug: "af-sbx-client-sb",
      messages: [{ role: "user", content: "reason" }],
      purpose: "agent:ClientAgent/codeact:reason",
    });
    expect(fetchFn).toHaveBeenCalledOnce();
    const evidence = remove();
    expect(evidence).toMatchObject({
      successfulCalls: 1,
      rejectedCalls: 0,
      agentCalls: [expect.objectContaining({ agentRef: "ClientAgent", successfulCalls: 1 })],
      budget: { enforced: true, maxCalls: 4, maxTotalTokens: 10_000, reservedTotalTokens: 2_048 },
    });
    await expect(gateway.chat({
      tenantSlug: "af-sbx-client-sb",
      messages: [{ role: "user", content: "late" }],
    })).rejects.toThrow(/No active model grant/);
  });

  it("rejects an oversized input before provider spend and records the policy rejection", async () => {
    process.env.FACTORY_SB_MODEL_PROXY_TOKEN = token;
    const chat = vi.fn();
    _setLLMGatewayForTests({
      defaultProvider: "openai",
      defaultModel: "gpt-test",
      listProviders: () => [{ id: "openai", name: "OpenAI", hasKey: true, defaultModel: "gpt-test", models: [] }],
      chat,
    } as never);
    registerFactorySandboxModelGrant({
      attemptId: "attempt-budget",
      bundleHash: "bundle-budget",
      tenantId: "tenant-budget",
      tenantSlug: "budget",
      expiresAt: Date.now() + 60_000,
      maxCalls: 4,
      maxTotalTokens: 2_000,
    });
    const app = Fastify();
    await app.register(factorySandboxModelProxyRoutes);
    const response = await app.inject({
      method: "POST",
      url: "/internal/factory-sandbox/model/chat",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        attemptId: "attempt-budget",
        bundleHash: "bundle-budget",
        tenantId: "tenant-budget",
        tenantSlug: "budget",
        requestId: "request-budget-rejected",
        request: {
          messages: [{ role: "user", content: "x".repeat(1_500) }],
          maxTokens: 1,
          purpose: "agent:BudgetAgent/codeact:reason",
        },
      },
    });
    expect(response.statusCode).toBe(429);
    expect(chat).not.toHaveBeenCalled();
    expect(readFactorySandboxModelUsageEvidence("attempt-budget", "bundle-budget")).toMatchObject({
      calls: 1,
      successfulCalls: 0,
      failedCalls: 0,
      rejectedCalls: 1,
      rejectedReasons: [expect.objectContaining({
        agentRef: "BudgetAgent",
        reasonCode: "grant_budget_exhausted",
        count: 1,
      })],
      budget: expect.objectContaining({ reservedTotalTokens: 0 }),
    });
    await app.close();
  });

  it("requires an explicit hostname allowlist for production plain HTTP", () => {
    const env = {
      NODE_ENV: "production",
      AGENTIC_PROCESS_ROLE: "sandbox-runner-workload",
      SANDBOX_RUNNER_EGRESS_MODE: "deny_all",
      SANDBOX_MODEL_PROXY_ORIGIN: "http://api.internal:3501",
      SANDBOX_MODEL_PROXY_TOKEN: token,
    } as NodeJS.ProcessEnv;
    expect(() => createSandboxModelProxyGateway(env)).toThrow(/HTTP_ALLOWED_HOSTS/);
    expect(() => createSandboxModelProxyGateway({
      ...env,
      SANDBOX_MODEL_PROXY_HTTP_ALLOWED_HOSTS: "other.internal",
    })).toThrow(/HTTP_ALLOWED_HOSTS/);
    expect(() => createSandboxModelProxyGateway({
      ...env,
      SANDBOX_MODEL_PROXY_HTTP_ALLOWED_HOSTS: "api.internal",
    })).not.toThrow();
  });

  it("records an authenticated policy rejection on both sides of the process boundary", async () => {
    process.env.FACTORY_SB_MODEL_PROXY_TOKEN = token;
    _setLLMGatewayForTests({
      defaultProvider: "openai",
      defaultModel: "gpt-test",
      listProviders: () => [{ id: "openai", name: "OpenAI", hasKey: true, defaultModel: "gpt-test", models: [] }],
      chat: vi.fn(),
    } as never);
    registerFactorySandboxModelGrant({
      attemptId: "attempt-cross-process-reject",
      bundleHash: "bundle-cross-process-reject",
      tenantId: "tenant-cross-process-reject",
      tenantSlug: "target-reject",
      expiresAt: Date.now() + 60_000,
      maxCalls: 2,
      maxTotalTokens: 1_500,
    });
    const app = Fastify();
    await app.register(factorySandboxModelProxyRoutes);
    const remove = installSandboxModelExecutionContext({
      sandboxTenantSlug: "af-sbx-cross-process-reject",
      attemptId: "attempt-cross-process-reject",
      bundleHash: "bundle-cross-process-reject",
      targetTenantId: "tenant-cross-process-reject",
      targetTenantSlug: "target-reject",
      maxCalls: 2,
      maxTotalTokens: 1_500,
    });
    const gateway = createSandboxModelProxyGateway({
      NODE_ENV: "test",
      SANDBOX_MODEL_PROXY_ORIGIN: "http://api.internal",
      SANDBOX_MODEL_PROXY_TOKEN: token,
    } as NodeJS.ProcessEnv, (async (_url, init) => {
      const injected = await app.inject({
        method: "POST",
        url: "/internal/factory-sandbox/model/chat",
        headers: init?.headers as Record<string, string>,
        payload: String(init?.body),
      });
      const headers = new Headers();
      for (const [name, value] of Object.entries(injected.headers)) {
        if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(",") : String(value));
      }
      return new Response(injected.body, { status: injected.statusCode, headers });
    }) as typeof fetch);
    await expect(gateway.chat({
      tenantSlug: "af-sbx-cross-process-reject",
      messages: [{ role: "user", content: "x".repeat(1_000) }],
      maxTokens: 1,
      purpose: "agent:RejectedAgent/codeact:reason",
    })).rejects.toThrow(/allowance|exhausted/i);
    const evidence = remove();
    expect(evidence).toMatchObject({
      calls: 1,
      successfulCalls: 0,
      failedCalls: 0,
      rejectedCalls: 1,
      rejectedReasons: [expect.objectContaining({ agentRef: "RejectedAgent", reasonCode: "grant_budget_exhausted" })],
    });
    expect(factorySandboxModelUsageLedgerIssues(evidence)).toEqual([]);
    await app.close();
  });

  it.each(["body", "reservation-header"] as const)(
    "rejects a model response whose signed %s was changed in transit",
    async (tamper) => {
      process.env.FACTORY_SB_MODEL_PROXY_TOKEN = token;
      _setLLMGatewayForTests({
        defaultProvider: "openai",
        defaultModel: "gpt-test",
        listProviders: () => [{ id: "openai", name: "OpenAI", hasKey: true, defaultModel: "gpt-test", models: [] }],
        chat: vi.fn(async () => ({
          text: "original",
          provider: "openai" as const,
          model: "gpt-test",
          tokensIn: 2,
          tokensOut: 1,
          finishReason: "stop" as const,
          latencyMs: 1,
        })),
      } as never);
      const attemptId = `attempt-response-tamper-${tamper}`;
      const bundleHash = `bundle-response-tamper-${tamper}`;
      registerFactorySandboxModelGrant({
        attemptId,
        bundleHash,
        tenantId: "tenant-response-tamper",
        tenantSlug: "target-response-tamper",
        expiresAt: Date.now() + 60_000,
        maxCalls: 1,
        maxTotalTokens: 20_000,
      });
      const app = Fastify();
      await app.register(factorySandboxModelProxyRoutes);
      const remove = installSandboxModelExecutionContext({
        sandboxTenantSlug: `af-sbx-response-tamper-${tamper}`,
        attemptId,
        bundleHash,
        targetTenantId: "tenant-response-tamper",
        targetTenantSlug: "target-response-tamper",
        maxCalls: 1,
        maxTotalTokens: 20_000,
      });
      const gateway = createSandboxModelProxyGateway({
        NODE_ENV: "test",
        SANDBOX_MODEL_PROXY_ORIGIN: "http://api.internal",
        SANDBOX_MODEL_PROXY_TOKEN: token,
      } as NodeJS.ProcessEnv, (async (_url, init) => {
        const injected = await app.inject({
          method: "POST",
          url: "/internal/factory-sandbox/model/chat",
          headers: init?.headers as Record<string, string>,
          payload: String(init?.body),
        });
        const headers = new Headers();
        for (const [name, value] of Object.entries(injected.headers)) {
          if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(",") : String(value));
        }
        let responseBody = injected.body;
        if (tamper === "body") {
          responseBody = JSON.stringify({ ...JSON.parse(responseBody), text: "changed-in-transit" });
        } else {
          headers.set("x-agentic-sandbox-model-total-reservation", "9999");
        }
        return new Response(responseBody, { status: injected.statusCode, headers });
      }) as typeof fetch);
      await expect(gateway.chat({
        tenantSlug: `af-sbx-response-tamper-${tamper}`,
        messages: [{ role: "user", content: "reason" }],
        purpose: "agent:tamper-agent/codeact:reason",
      })).rejects.toThrow(/signature/i);
      const workloadEvidence = remove();
      expect(factorySandboxModelUsageLedgerIssues(workloadEvidence)).not.toEqual([]);
      await app.close();
    },
  );

  it("atomically admits only one concurrent request at a one-call grant", async () => {
    process.env.FACTORY_SB_MODEL_PROXY_TOKEN = token;
    _setLLMGatewayForTests({
      defaultProvider: "openai",
      defaultModel: "gpt-test",
      listProviders: () => [{ id: "openai", name: "OpenAI", hasKey: true, defaultModel: "gpt-test", models: [] }],
      chat: vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return {
          text: "ok",
          provider: "openai" as const,
          model: "gpt-test",
          tokensIn: 1,
          tokensOut: 1,
          finishReason: "stop" as const,
          latencyMs: 1,
        };
      }),
    } as never);
    registerFactorySandboxModelGrant({
      attemptId: "attempt-atomic",
      bundleHash: "bundle-atomic",
      tenantId: "tenant-atomic",
      tenantSlug: "target-atomic",
      expiresAt: Date.now() + 60_000,
      maxCalls: 1,
      maxTotalTokens: 100_000,
    });
    const app = Fastify();
    await app.register(factorySandboxModelProxyRoutes);
    const request = (agent: string) => app.inject({
      method: "POST",
      url: "/internal/factory-sandbox/model/chat",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        attemptId: "attempt-atomic",
        bundleHash: "bundle-atomic",
        tenantId: "tenant-atomic",
        tenantSlug: "target-atomic",
        requestId: `request-${agent}`,
        request: {
          messages: [{ role: "user", content: "reason" }],
          maxTokens: 1,
          purpose: `agent:${agent}/codeact:reason`,
        },
      },
    });
    const responses = await Promise.all([request("atomic-a"), request("atomic-b")]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 429]);
    expect(readFactorySandboxModelUsageEvidence("attempt-atomic", "bundle-atomic")).toMatchObject({
      calls: 2,
      successfulCalls: 1,
      rejectedCalls: 1,
      budget: expect.objectContaining({ maxCalls: 1 }),
    });
    await app.close();
  });

  it("does not attribute a bad bearer token to a candidate attempt", async () => {
    process.env.FACTORY_SB_MODEL_PROXY_TOKEN = token;
    registerFactorySandboxModelGrant({
      attemptId: "attempt-bad-bearer",
      bundleHash: "bundle-bad-bearer",
      tenantId: "tenant-bad-bearer",
      tenantSlug: "target-bad-bearer",
      expiresAt: Date.now() + 60_000,
      maxCalls: 1,
      maxTotalTokens: 10_000,
    });
    const app = Fastify();
    await app.register(factorySandboxModelProxyRoutes);
    const response = await app.inject({
      method: "POST",
      url: "/internal/factory-sandbox/model/chat",
      headers: { authorization: "Bearer definitely-not-the-service-token" },
      payload: {
        attemptId: "attempt-bad-bearer",
        bundleHash: "bundle-bad-bearer",
        tenantId: "tenant-bad-bearer",
        tenantSlug: "target-bad-bearer",
        requestId: "request-bad-bearer",
        request: { messages: [{ role: "user", content: "reason" }] },
      },
    });
    expect(response.statusCode).toBe(401);
    expect(readFactorySandboxModelUsageEvidence("attempt-bad-bearer", "bundle-bad-bearer")).toMatchObject({
      calls: 0,
      successfulCalls: 0,
      failedCalls: 0,
      rejectedCalls: 0,
    });
    await app.close();
  });
});
