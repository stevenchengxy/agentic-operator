import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import {
  LLMError,
  LLMGateway,
  type ChatRequest,
  type ProviderAdapter,
} from "@agentic/llm-gateway";
import { getDb, llmCalls, tenants } from "@agentic/db";
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
      throw new LLMError("temporary network failure", "network", "mock");
    }
    return {
      text: "ok",
      provider: this.id,
      model: this.defaultModel,
      tokensIn: 7,
      tokensOut: 3,
      finishReason: "stop" as const,
      latencyMs: 2,
      providerRequestId: "provider-request-2",
    };
  }
}

describe("durable LLM usage ledger", () => {
  let tenantId: string;
  let tenantSlug: string;
  let env: TestEnv;

  beforeAll(async () => {
    env = await buildTestEnv();
    tenantId = makeId("ten");
    tenantSlug = `llm-ledger-${tenantId}`;
    getDb().insert(tenants).values({
      id: tenantId,
      slug: tenantSlug,
      name: "LLM ledger test",
    }).run();
  });

  afterAll(() => {
    if (tenantId) {
      getDb().delete(tenants).where(eq(tenants.id, tenantId)).run();
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
      messages: [{ role: "user", content: "retry once" }],
      reasoning: { mode: "standard", effort: "high", summary: "auto" },
      verbosity: "low",
      store: false,
    });

    expect(response.usage).toMatchObject({
      inputTokens: 7,
      outputTokens: 3,
      totalTokens: 10,
    });
    expect(response.cost).toMatchObject({ source: "catalog", totalUsdNanos: 0 });

    const attempts = getDb()
      .select()
      .from(llmCalls)
      .where(eq(llmCalls.tenantId, tenantId))
      .orderBy(asc(llmCalls.attempt))
      .all();
    expect(attempts).toHaveLength(2);
    expect(attempts.map((attempt) => attempt.status)).toEqual(["failed", "ok"]);
    expect(attempts.map((attempt) => attempt.attempt)).toEqual([1, 2]);
    expect(new Set(attempts.map((attempt) => attempt.logicalCallId)).size).toBe(1);
    expect(attempts[0]?.errorCode).toBe("network");
    expect(attempts[1]).toMatchObject({
      inputTokens: 7,
      outputTokens: 3,
      totalTokens: 10,
      costUsdNanos: 0,
      providerRequestId: "provider-request-2",
      reasoningMode: "standard",
      reasoningEffort: "high",
      reasoningSummary: "auto",
      textVerbosity: "low",
      storeResponse: false,
    });

    const headers = { "x-agentic-tenant": tenantSlug };
    const callsResponse = await env.fetch("/v1/usage/calls", { headers });
    expect(callsResponse.status).toBe(200);
    const callsBody = (await callsResponse.json()) as {
      data: Array<{ status: string; costUsd: number | null }>;
    };
    expect(callsBody.data.map((call) => call.status).sort()).toEqual(["failed", "ok"]);
    expect(callsBody.data.find((call) => call.status === "ok")?.costUsd).toBe(0);

    const usageResponse = await env.fetch("/v1/usage", { headers });
    expect(usageResponse.status).toBe(200);
    const usageBody = (await usageResponse.json()) as {
      data: {
        totals: { calls: number; tokensIn: number; tokensOut: number; usdNanos: number };
        byReasoning: Array<{ key: string; calls: number }>;
      };
    };
    expect(usageBody.data.totals).toMatchObject({
      calls: 1,
      tokensIn: 7,
      tokensOut: 3,
      usdNanos: 0,
    });
    expect(usageBody.data.byReasoning).toEqual([
      expect.objectContaining({
        calls: 1,
        key: expect.stringContaining("store=false"),
      }),
    ]);
  });
});
