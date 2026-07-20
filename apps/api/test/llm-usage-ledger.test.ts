import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import {
  ensureCurrentBudgetPeriod,
  LLMError,
  LLMGateway,
  type ChatRequest,
  type ProviderAdapter,
} from "@agentic/llm-gateway";
import {
  getDb,
  llmCalls,
  tenantBudgets,
  tenants,
  usageEvents,
} from "@agentic/db";
import { makeId } from "@agentic/shared";
import { buildTestEnv, type TestEnv } from "./harness";

class RetryOnceAdapter implements ProviderAdapter {
  readonly id = "mock" as const;
  readonly name = "retry-once";
  readonly hasKey = true;
  readonly defaultModel = "mock-model-v1";
  calls = 0;

  async chat(_request: ChatRequest) {
    this.calls += 1;
    if (this.calls === 1) {
      throw new LLMError(
        "temporary timeout containing raw-error-secret-7fc94d",
        "timeout",
        "mock",
      );
    }
    return {
      text: "private-output-19731c",
      provider: this.id,
      model: this.defaultModel,
      tokensIn: 7,
      tokensOut: 3,
      usage: {
        inputTokens: 7,
        outputTokens: 3,
        totalTokens: 10,
        cachedInputTokens: 2,
        cacheWriteInputTokens: 0,
        cacheWrite5mInputTokens: 0,
        cacheWrite1hInputTokens: 0,
        reasoningTokens: 1,
        inputAudioTokens: 0,
        outputAudioTokens: 0,
        raw: { privateVendorField: "raw-usage-secret-8e5e03" },
      },
      providerReportedCostUsd: 0.012345,
      finishReason: "stop" as const,
      latencyMs: 2,
      providerRequestId: "provider-request-2",
    };
  }
}

class SubCentAdapter implements ProviderAdapter {
  readonly id = "mock" as const;
  readonly name = "sub-cent";
  readonly hasKey = true;
  readonly defaultModel = "mock-model-v1";

  async chat(_request: ChatRequest) {
    return {
      text: "ok",
      provider: this.id,
      model: this.defaultModel,
      tokensIn: 1,
      tokensOut: 0,
      usage: {
        inputTokens: 1,
        outputTokens: 0,
        totalTokens: 1,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        cacheWrite5mInputTokens: 0,
        cacheWrite1hInputTokens: 0,
        reasoningTokens: 0,
        inputAudioTokens: 0,
        outputAudioTokens: 0,
      },
      providerReportedCostUsd: 0.001,
      finishReason: "stop" as const,
      latencyMs: 1,
    };
  }
}

describe("durable LLM usage ledger", () => {
  let tenantId: string;
  let tenantSlug: string;
  let env: TestEnv;
  let exportRoot: string;
  let originalExportRoot: string | undefined;

  beforeAll(async () => {
    originalExportRoot = process.env.AGENTIC_USAGE_EXPORT_ROOT;
    exportRoot = mkdtempSync(path.join(tmpdir(), "agentic-usage-export-"));
    process.env.AGENTIC_USAGE_EXPORT_ROOT = exportRoot;
    env = await buildTestEnv();
    tenantId = makeId("ten");
    tenantSlug = `llm-ledger-${tenantId}`;
    getDb()
      .insert(tenants)
      .values({
        id: tenantId,
        slug: tenantSlug,
        name: "LLM ledger test",
      })
      .run();
  });

  afterAll(() => {
    if (tenantId) {
      getDb().delete(tenants).where(eq(tenants.id, tenantId)).run();
    }
    rmSync(exportRoot, { recursive: true, force: true });
    if (originalExportRoot === undefined) {
      delete process.env.AGENTIC_USAGE_EXPORT_ROOT;
    } else {
      process.env.AGENTIC_USAGE_EXPORT_ROOT = originalExportRoot;
    }
  });

  it("records each retry and charges only the successful attempt", async () => {
    const adapter = new RetryOnceAdapter();
    const gateway = new LLMGateway({
      defaultProvider: "mock",
      defaultModel: "mock-model-v1",
      timeoutMs: 5_000,
    });
    gateway.registerProvider(adapter);

    const response = await gateway.chat({
      tenantId,
      model: "future-mock-reasoner",
      runId: undefined,
      purpose: "test.retry",
      messages: [{ role: "user", content: "private-prompt-secret-c28821" }],
      reasoning: { mode: "standard", effort: "high", summary: "auto" },
      verbosity: "low",
      store: false,
      attribution: {
        billingAccountId: "billing-account-17",
        providerAccountId: "upstream-project-23",
        actorType: "api_token",
        actorId: "principal-29",
        credentialId: "credential-record-31",
        providerCredentialId: "provider-credential-record-33",
        product: "evaluation-suite",
        productSurface: "model-benchmarks",
        productAction: "run-evaluation",
        interactionId: "interaction-37",
        functionName: "evaluateCandidateModel",
        apiRoute: "/v1/evaluations/:id/run",
        httpMethod: "POST",
        requestId: "request-41",
        correlationId: "correlation-43",
        invocationSource: "api",
      },
    });

    expect(response.usage).toMatchObject({
      inputTokens: 7,
      outputTokens: 3,
      totalTokens: 10,
    });
    expect(response.cost).toMatchObject({
      source: "provider",
      totalUsdNanos: 12_345_000,
    });

    const attempts = getDb()
      .select()
      .from(llmCalls)
      .where(eq(llmCalls.tenantId, tenantId))
      .orderBy(asc(llmCalls.attempt))
      .all();
    expect(attempts).toHaveLength(2);
    expect(attempts.map((attempt) => attempt.status)).toEqual(["failed", "ok"]);
    expect(attempts.map((attempt) => attempt.attempt)).toEqual([1, 2]);
    expect(new Set(attempts.map((attempt) => attempt.logicalCallId)).size).toBe(
      1,
    );
    expect(attempts[0]?.errorCode).toBe("timeout");
    expect(attempts[1]).toMatchObject({
      inputTokens: 7,
      outputTokens: 3,
      totalTokens: 10,
      costUsdNanos: 12_345_000,
      providerRequestId: "provider-request-2",
      reasoningMode: "standard",
      reasoningEffort: "high",
      reasoningSummary: "auto",
      textVerbosity: "low",
      storeResponse: false,
    });
    for (const attempt of attempts) {
      expect(attempt).toMatchObject({
        billingAccountId: "billing-account-17",
        providerAccountId: "upstream-project-23",
        actorType: "api_token",
        actorId: "principal-29",
        credentialId: "credential-record-31",
        providerCredentialId: "provider-credential-record-33",
        product: "evaluation-suite",
        productSurface: "model-benchmarks",
        productAction: "run-evaluation",
        interactionId: "interaction-37",
        functionName: "evaluateCandidateModel",
        apiRoute: "/v1/evaluations/:id/run",
        httpMethod: "POST",
        requestId: "request-41",
        correlationId: "correlation-43",
        invocationSource: "api",
      });
    }

    const events = getDb()
      .select()
      .from(usageEvents)
      .where(eq(usageEvents.tenantId, tenantId))
      .orderBy(asc(usageEvents.sequence))
      .all();
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.llmCallId)).toEqual(
      attempts.map((attempt) => attempt.id),
    );
    expect(events[0]).toMatchObject({
      status: "failed",
      costLiability: "unknown",
      providerCostUsdNanos: null,
      billableChargeUsdNanos: null,
    });
    expect(events[1]).toMatchObject({
      status: "ok",
      costLiability: "known",
      providerCostUsdNanos: 12_345_000,
      billableChargeUsdNanos: 12_345_000,
      productSurface: "model-benchmarks",
      productAction: "run-evaluation",
      interactionId: "interaction-37",
      functionName: "evaluateCandidateModel",
      apiRoute: "/v1/evaluations/:id/run",
      httpMethod: "POST",
      providerCredentialId: "provider-credential-record-33",
    });
    expect(events[0]?.exportedAt).not.toBeNull();
    expect(events[1]?.exportedAt).not.toBeNull();

    const budget = getDb()
      .select()
      .from(tenantBudgets)
      .where(eq(tenantBudgets.tenantId, tenantId))
      .all()[0];
    expect(budget).toMatchObject({
      usedTokensMonth: 10,
      usedUsdNanos: 12_345_000,
      usedUsdMonth: 2,
    });

    const exportFiles = listFiles(exportRoot).filter((file) =>
      file.endsWith(".ndjson"),
    );
    expect(exportFiles).toHaveLength(2);
    for (const file of exportFiles) {
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
    const exportedText = exportFiles
      .map((file) => readFileSync(file, "utf8"))
      .join("");
    const exported = exportedText
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(exported).toHaveLength(2);
    expect(exported.map((record) => record.schema)).toEqual([
      "agentic.usage.v1",
      "agentic.usage.v1",
    ]);
    expect(exported).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "failed",
          provider_cost: expect.objectContaining({
            liability: "unknown",
            total_nanos: null,
          }),
        }),
        expect.objectContaining({
          status: "ok",
          principal: {
            type: "api_token",
            id: "principal-29",
            credential_id: "credential-record-31",
          },
          usage: expect.objectContaining({
            authoritative: true,
            input_tokens: 7,
            output_tokens: 3,
            total_tokens: 10,
            cached_input_tokens: 2,
            reasoning_tokens: 1,
          }),
          provider_cost: expect.objectContaining({
            liability: "known",
            total_nanos: 12_345_000,
          }),
          billable_charge: expect.objectContaining({
            total_nanos: 12_345_000,
          }),
          llm: expect.objectContaining({
            provider_credential_id: "provider-credential-record-33",
            provider_account_id: "upstream-project-23",
          }),
          attribution: expect.objectContaining({
            interaction_id: "interaction-37",
            surface: "model-benchmarks",
            action: "run-evaluation",
            function: "evaluateCandidateModel",
            api: {
              method: "POST",
              route: "/v1/evaluations/:id/run",
            },
          }),
        }),
      ]),
    );
    expect(exportedText).not.toContain("private-prompt-secret-c28821");
    expect(exportedText).not.toContain("private-output-19731c");
    expect(exportedText).not.toContain("raw-error-secret-7fc94d");
    expect(exportedText).not.toContain("raw-usage-secret-8e5e03");

    const headers = { "x-agentic-tenant": tenantSlug };
    const callsResponse = await env.fetch("/v1/usage/calls", { headers });
    expect(callsResponse.status).toBe(200);
    const callsBody = (await callsResponse.json()) as {
      data: Array<{ status: string; costUsd: number | null }>;
    };
    expect(callsBody.data.map((call) => call.status).sort()).toEqual([
      "failed",
      "ok",
    ]);
    expect(callsBody.data.find((call) => call.status === "ok")?.costUsd).toBe(
      0.012345,
    );

    const usageResponse = await env.fetch("/v1/usage", { headers });
    expect(usageResponse.status).toBe(200);
    const usageBody = (await usageResponse.json()) as {
      data: {
        totals: {
          calls: number;
          tokensIn: number;
          tokensOut: number;
          usdNanos: number;
        };
        byReasoning: Array<{ key: string; calls: number }>;
        attempts: {
          logicalCalls: number;
          attempts: number;
          succeeded: number;
          failed: number;
          retries: number;
          fallbacks: number;
        };
        byGateway: Array<{ key: string; attempts: number }>;
      };
    };
    expect(usageBody.data.totals).toMatchObject({
      calls: 1,
      tokensIn: 7,
      tokensOut: 3,
      usdNanos: 12_345_000,
    });
    expect(usageBody.data.byReasoning).toEqual([
      expect.objectContaining({
        calls: 1,
        key: expect.stringContaining("store=false"),
      }),
    ]);
    expect(usageBody.data.attempts).toMatchObject({
      logicalCalls: 1,
      attempts: 2,
      succeeded: 1,
      failed: 1,
      retries: 1,
      fallbacks: 0,
    });
    expect(usageBody.data.byGateway).toEqual([
      expect.objectContaining({ key: "mock", attempts: 2 }),
    ]);
  });

  it("rolls monthly counters at the UTC month boundary", () => {
    const previousPeriod = new Date("2026-06-01T00:00:00.000Z");
    const currentPeriod = new Date("2026-07-01T00:00:00.000Z");
    getDb()
      .insert(tenantBudgets)
      .values({
        tenantId,
        periodStart: previousPeriod,
        usedTokensMonth: 987,
        usedUsdMonth: 54,
        usedUsdNanos: 539_000_000,
      })
      .onConflictDoUpdate({
        target: tenantBudgets.tenantId,
        set: {
          periodStart: previousPeriod,
          usedTokensMonth: 987,
          usedUsdMonth: 54,
          usedUsdNanos: 539_000_000,
        },
      })
      .run();

    ensureCurrentBudgetPeriod(tenantId, new Date("2026-07-18T12:34:56.000Z"));

    const budget = getDb()
      .select()
      .from(tenantBudgets)
      .where(eq(tenantBudgets.tenantId, tenantId))
      .all()[0];
    expect(budget).toMatchObject({
      usedTokensMonth: 0,
      usedUsdMonth: 0,
      usedUsdNanos: 0,
    });
    expect(budget?.periodStart).toEqual(currentPeriod);
  });

  it("accumulates repeated sub-cent charges from exact nanodollars", async () => {
    const exactTenantId = makeId("ten");
    const exactTenantSlug = `exact-budget-${exactTenantId}`;
    getDb()
      .insert(tenants)
      .values({
        id: exactTenantId,
        slug: exactTenantSlug,
        name: "Exact budget test",
      })
      .run();
    getDb()
      .insert(tenantBudgets)
      .values({
        tenantId: exactTenantId,
        monthlyUsdCap: 1,
        periodStart: new Date(),
      })
      .run();

    try {
      const gateway = new LLMGateway({
        defaultProvider: "mock",
        defaultModel: "mock-model-v1",
        timeoutMs: 5_000,
      });
      gateway.registerProvider(new SubCentAdapter());
      const request = {
        tenantId: exactTenantId,
        messages: [{ role: "user" as const, content: "meter" }],
      };

      for (let index = 0; index < 10; index += 1) {
        await gateway.chat(request);
      }

      const budget = getDb()
        .select()
        .from(tenantBudgets)
        .where(eq(tenantBudgets.tenantId, exactTenantId))
        .all()[0];
      expect(budget).toMatchObject({
        usedTokensMonth: 10,
        usedUsdNanos: 10_000_000,
        usedUsdMonth: 1,
      });
      const usageResponse = await env.fetch("/v1/usage", {
        headers: { "x-agentic-tenant": exactTenantSlug },
      });
      expect(usageResponse.status).toBe(200);
      const usage = (await usageResponse.json()) as {
        data: {
          totals: { usdNanos: number; usdCents: number };
          byModel: Array<{ usdNanos: number; usdCents: number }>;
        };
      };
      expect(usage.data.totals).toMatchObject({
        usdNanos: 10_000_000,
        usdCents: 1,
      });
      expect(usage.data.byModel).toEqual([
        expect.objectContaining({ usdNanos: 10_000_000, usdCents: 1 }),
      ]);
      await expect(gateway.chat(request)).rejects.toMatchObject({
        code: "cost_limit_exceeded",
      });
    } finally {
      getDb().delete(tenants).where(eq(tenants.id, exactTenantId)).run();
    }
  });
});

function listFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(entryPath));
    else files.push(entryPath);
  }
  return files;
}
