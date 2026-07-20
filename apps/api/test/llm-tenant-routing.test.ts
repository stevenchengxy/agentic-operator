import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inArray } from "drizzle-orm";
import {
  GatewayInstanceSchema,
  TaskRouteCandidateSchema,
} from "@agentic/contracts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

type ProviderKeysService = typeof import("../src/services/provider-keys");
type LLMService = typeof import("../src/services/llm");
type DbPackage = typeof import("@agentic/db");

interface CapturedProviderRequest {
  authorization: string | null;
  model: string | null;
}

describe("tenant-routing LLM gateway", () => {
  const temporaryDirectory = mkdtempSync(
    join(tmpdir(), "agentic-tenant-routing-"),
  );
  const vaultPath = join(temporaryDirectory, "provider-keys.json");
  const exportRoot = join(temporaryDirectory, "usage");
  const tenantAId = `ten-route-a-${randomUUID()}`;
  const tenantBId = `ten-route-b-${randomUUID()}`;
  const purpose = `test.tenant-routing.${randomUUID()}`;
  const tenantAKey = "sk-tenant-route-a-1111111111111111";
  const tenantBKey = "sk-tenant-route-b-2222222222222222";
  const rotatedTenantAKey = "sk-tenant-route-a-rotated-3333333333";
  const environmentKey = "sk-environment-fallback-444444444444";
  const originalFetch = globalThis.fetch;
  const previousEnv = new Map<string, string | undefined>();
  const captured: CapturedProviderRequest[] = [];
  let providerKeys: ProviderKeysService;
  let llmService: LLMService;
  let dbPackage: DbPackage;
  let tenantACredentialId: string;
  let tenantBCredentialId: string;

  beforeAll(async () => {
    for (const name of [
      "AGENTIC_KEY_VAULT_PATH",
      "AGENTIC_KEY_VAULT_SECRET",
      "AGENTIC_USAGE_EXPORT_ROOT",
      "OPENROUTER_API_KEY",
      "LLM_DEFAULT_PROVIDER",
      "LLM_DEFAULT_MODEL",
      "LLM_REQUIRE_USAGE_ATTRIBUTION",
    ]) {
      previousEnv.set(name, process.env[name]);
    }
    process.env.AGENTIC_KEY_VAULT_PATH = vaultPath;
    process.env.AGENTIC_KEY_VAULT_SECRET =
      "tenant-routing-regression-test-secret";
    process.env.AGENTIC_USAGE_EXPORT_ROOT = exportRoot;
    process.env.OPENROUTER_API_KEY = environmentKey;
    process.env.LLM_DEFAULT_PROVIDER = "openrouter";
    process.env.LLM_DEFAULT_MODEL = "test/tenant-router";
    process.env.LLM_REQUIRE_USAGE_ATTRIBUTION = "true";

    // provider-keys computes its vault path at module load. Reset before the
    // dynamic imports so this suite cannot read or write a developer vault.
    vi.resetModules();
    providerKeys = await import("../src/services/provider-keys");
    llmService = await import("../src/services/llm");
    dbPackage = await import("@agentic/db");

    dbPackage
      .getDb()
      .insert(dbPackage.tenants)
      .values([
        {
          id: tenantAId,
          slug: `llm-route-a-${randomUUID()}`,
          name: "Tenant routing A",
        },
        {
          id: tenantBId,
          slug: `llm-route-b-${randomUUID()}`,
          name: "Tenant routing B",
        },
      ])
      .run();

    tenantACredentialId = providerKeys.setProviderKey("openrouter", {
      apiKey: tenantAKey,
      scope: "tenant",
      tenantId: tenantAId,
      setBy: "tenant-a-admin",
    }).credentialId!;
    tenantBCredentialId = providerKeys.setProviderKey("openrouter", {
      apiKey: tenantBKey,
      scope: "tenant",
      tenantId: tenantBId,
      setBy: "tenant-b-admin",
    }).credentialId!;

    globalThis.fetch = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const request =
          input instanceof Request ? input : new Request(input, init);
        const authorization = request.headers.get("authorization");
        const body = (await request.json()) as { model?: unknown };
        const model = typeof body.model === "string" ? body.model : null;
        captured.push({ authorization, model });

        return new Response(
          JSON.stringify({
            id: `provider-request-${captured.length}`,
            object: "chat.completion",
            created: 1_790_000_000,
            model: model ?? "test/tenant-router",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: authorization,
                },
                finish_reason: "stop",
              },
            ],
            usage: {
              prompt_tokens: 3,
              completion_tokens: 2,
              total_tokens: 5,
              cost: 0,
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      },
    ) as typeof fetch;
  });

  afterAll(() => {
    try {
      llmService?._setLLMGatewayForTests(null);
      llmService?.resetLLMGateway();
      if (dbPackage) {
        dbPackage
          .getDb()
          .delete(dbPackage.tenants)
          .where(inArray(dbPackage.tenants.id, [tenantAId, tenantBId]))
          .run();
        dbPackage.closeDb();
      }
    } finally {
      globalThis.fetch = originalFetch;
      for (const [name, value] of previousEnv) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      rmSync(temporaryDirectory, { recursive: true, force: true });
      vi.resetModules();
    }
  });

  it("uses isolated tenant credentials on the wire and persists their public IDs", async () => {
    expect(
      providerKeys.getProviderKeyEnvOverlay(tenantAId).OPENROUTER_API_KEY,
    ).toBe(tenantAKey);
    expect(
      providerKeys.getProviderKeyEnvOverlay(tenantBId).OPENROUTER_API_KEY,
    ).toBe(tenantBKey);
    expect(
      providerKeys.getProviderKeyEnvOverlay("tenant-without-vault-key")
        .OPENROUTER_API_KEY,
    ).toBe(environmentKey);

    const gateway = llmService.getLLMGateway();
    const [tenantAResponse, tenantBResponse] = await Promise.all([
      gateway.chat({
        tenantId: tenantAId,
        provider: "openrouter",
        model: "test/tenant-router",
        purpose,
        messages: [{ role: "user", content: "tenant A" }],
      }),
      gateway.chat({
        tenantId: tenantBId,
        provider: "openrouter",
        model: "test/tenant-router",
        purpose,
        messages: [{ role: "user", content: "tenant B" }],
      }),
    ]);

    expect(tenantAResponse.text).toBe(`Bearer ${tenantAKey}`);
    expect(tenantBResponse.text).toBe(`Bearer ${tenantBKey}`);
    expect(captured.map((request) => request.authorization)).toEqual(
      expect.arrayContaining([`Bearer ${tenantAKey}`, `Bearer ${tenantBKey}`]),
    );
    expect(captured.map((request) => request.model)).toEqual([
      "test/tenant-router",
      "test/tenant-router",
    ]);

    const calls = dbPackage
      .getDb()
      .select()
      .from(dbPackage.llmCalls)
      .all()
      .filter((call) => call.purpose === purpose);
    expect(calls).toHaveLength(2);
    expect(
      Object.fromEntries(
        calls.map((call) => [call.tenantId, call.providerCredentialId]),
      ),
    ).toEqual({
      [tenantAId]: tenantACredentialId,
      [tenantBId]: tenantBCredentialId,
    });
    expect(
      Object.fromEntries(
        calls.map((call) => [call.tenantId, call.billingAccountId]),
      ),
    ).toEqual({
      [tenantAId]: tenantAId,
      [tenantBId]: tenantBId,
    });
  });

  it("rebuilds a credential-bound adapter only after the gateway cache resets", async () => {
    const gateway = llmService.getLLMGateway();
    const rotated = providerKeys.setProviderKey("openrouter", {
      apiKey: rotatedTenantAKey,
      scope: "tenant",
      tenantId: tenantAId,
      setBy: "tenant-a-admin",
    });
    expect(rotated.credentialId).toBe(tenantACredentialId);

    const cachedResponse = await gateway.chat({
      tenantId: tenantAId,
      provider: "openrouter",
      model: "test/tenant-router",
      purpose,
      messages: [{ role: "user", content: "before reset" }],
    });
    expect(cachedResponse.text).toBe(`Bearer ${tenantAKey}`);

    llmService.resetLLMGateway();
    expect(llmService.getLLMGateway()).toBe(gateway);
    const rebuiltResponse = await gateway.chat({
      tenantId: tenantAId,
      provider: "openrouter",
      model: "test/tenant-router",
      purpose,
      messages: [{ role: "user", content: "after reset" }],
    });
    expect(rebuiltResponse.text).toBe(`Bearer ${rotatedTenantAKey}`);
    expect(captured.slice(-2).map((request) => request.authorization)).toEqual([
      `Bearer ${tenantAKey}`,
      `Bearer ${rotatedTenantAKey}`,
    ]);
  });

  it("prunes incompatible shared controls before a heterogeneous fallback", () => {
    const anthropic = GatewayInstanceSchema.parse({
      id: "anthropic",
      displayName: "Anthropic",
      kind: "direct",
      providerId: "anthropic",
    });
    const candidate = TaskRouteCandidateSchema.parse({
      route: "anthropic/claude-opus-4-8",
      parameters: {
        reasoning: { effort: "max" },
        timeoutMs: 180_000,
      },
    });

    expect(
      llmService.taskPolicyParametersForCandidate(
        {
          reasoning: {
            mode: "pro",
            effort: "high",
            summary: "auto",
            context: "all_turns",
          },
          verbosity: "high",
          temperature: 0.2,
          store: false,
          maxTokens: 8_192,
        },
        candidate,
        anthropic,
      ),
    ).toEqual({
      reasoning: { effort: "max" },
      maxTokens: 8_192,
      timeoutMs: 180_000,
    });

    expect(
      llmService.normalizeRoutedRequestForCandidate(
        {
          messages: [{ role: "user", content: "fallback" }],
          reasoning: { mode: "pro", effort: "high", summary: "auto" },
          verbosity: "high",
          temperature: 0.2,
          store: false,
        },
        candidate,
        anthropic,
      ),
    ).toMatchObject({
      reasoning: { effort: "max" },
      maxTokens: undefined,
      timeoutMs: 180_000,
      verbosity: undefined,
      temperature: undefined,
      store: undefined,
    });
  });

  it("reports the transport selected by each concrete adapter", () => {
    const directOpenAi = GatewayInstanceSchema.parse({
      id: "openai",
      displayName: "OpenAI",
      kind: "direct",
      providerId: "openai",
    });
    const directAnthropic = GatewayInstanceSchema.parse({
      id: "anthropic",
      displayName: "Anthropic",
      kind: "direct",
      providerId: "anthropic",
    });
    const openrouter = GatewayInstanceSchema.parse({
      id: "openrouter",
      displayName: "OpenRouter",
      kind: "openrouter",
    });
    const messages = [{ role: "user" as const, content: "transport" }];

    expect(
      llmService.effectiveTransportForRoute(directOpenAi, { messages }),
    ).toBe("responses");
    expect(
      llmService.effectiveTransportForRoute(directAnthropic, { messages }),
    ).toBe("native");
    expect(
      llmService.effectiveTransportForRoute(openrouter, {
        messages,
        model: "openai/gpt-5.6-sol",
        reasoning: { mode: "pro", effort: "high" },
      }),
    ).toBe("chat");
    expect(
      llmService.effectiveTransportForRoute(openrouter, {
        messages,
        model: "openai/gpt-5.6-sol",
        reasoning: { mode: "pro", summary: "auto" },
      }),
    ).toBe("responses");
  });
});
