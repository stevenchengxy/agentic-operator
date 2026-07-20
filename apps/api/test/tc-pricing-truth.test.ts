import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import {
  estimateTokenCostCents,
  LLMError,
  LLMGateway,
  resolveModelTokenPricing,
  type ChatRequest,
  type ProviderAdapter,
} from "@agentic/llm-gateway";
import { getDb, llmCalls, tenantBudgets, tenants } from "@agentic/db";
import { makeId } from "@agentic/shared";
import {
  calculateTenantUsage,
  reconcileBudgetUsage,
} from "../src/services/usage-accounting";
import { buildTestEnv } from "./harness";

class CustomProvider implements ProviderAdapter {
  readonly id = "custom" as const;
  readonly name = "custom-pricing-test";
  readonly hasKey = true;
  calls = 0;

  constructor(
    readonly defaultModel: string,
    private readonly actualModel = defaultModel,
  ) {}

  async chat(_request: ChatRequest) {
    this.calls += 1;
    return {
      text: "real provider response",
      provider: this.id,
      model: this.actualModel,
      tokensIn: 100_000,
      tokensOut: 50_000,
      finishReason: "stop" as const,
      latencyMs: 1,
    };
  }
}

describe("provider + served-model pricing truth", () => {
  const tenantIds: string[] = [];
  const originalOverride = process.env.AGENTIC_LLM_MODEL_PRICING_JSON;

  beforeAll(async () => {
    await buildTestEnv();
  });

  afterEach(() => {
    if (originalOverride === undefined) {
      delete process.env.AGENTIC_LLM_MODEL_PRICING_JSON;
    } else {
      process.env.AGENTIC_LLM_MODEL_PRICING_JSON = originalOverride;
    }
  });

  afterAll(() => {
    if (tenantIds.length > 0) {
      getDb().delete(tenants).where(inArray(tenants.id, tenantIds)).run();
    }
  });

  function createTenant(args: {
    usdCap: number | null;
    usedUsd?: number;
    tokenCap?: number | null;
  }): string {
    const db = getDb();
    const tenantId = makeId("ten");
    tenantIds.push(tenantId);
    db.insert(tenants)
      .values({ id: tenantId, slug: `budget-pricing-${tenantId}`, name: tenantId })
      .run();
    db.insert(tenantBudgets)
      .values({
        tenantId,
        monthlyTokenCap: args.tokenCap ?? null,
        monthlyUsdCap: args.usdCap,
        usedTokensMonth: 0,
        usedUsdMonth: args.usedUsd ?? 0,
        periodStart: new Date(Date.now() - 60_000),
      })
      .run();
    return tenantId;
  }

  function gateway(provider: CustomProvider): LLMGateway {
    const instance = new LLMGateway({
      defaultProvider: "custom",
      defaultModel: provider.defaultModel,
      timeoutMs: 5_000,
    });
    instance.registerProvider(provider);
    return instance;
  }

  it("uses the shared catalog for an exact provider + model and never a provider average", () => {
    const pricing = resolveModelTokenPricing({
      provider: "openai",
      model: "gpt-4.1",
    });
    expect(pricing).toMatchObject({
      provider: "openai",
      model: "gpt-4.1",
      inCentsPerMTok: 500,
      outCentsPerMTok: 2_000,
      source: "catalog",
    });
    expect(
      estimateTokenCostCents({
        provider: "openai",
        model: "gpt-4.1",
        tokensIn: 100_000,
        tokensOut: 50_000,
      })?.usdCents,
    ).toBe(150);
    expect(
      resolveModelTokenPricing({ provider: "custom", model: "unknown-model" }),
    ).toBeNull();
  });

  it("supports operator exact/wildcard prices, with exact taking precedence", () => {
    process.env.AGENTIC_LLM_MODEL_PRICING_JSON = JSON.stringify({
      "custom/*": { inCents: 900, outCents: 1_800 },
      "custom/known-model": { inCents: 120, outCents: 480 },
    });
    expect(
      resolveModelTokenPricing({ provider: "custom", model: "known-model" }),
    ).toMatchObject({
      inCentsPerMTok: 120,
      outCentsPerMTok: 480,
      source: "operator_override",
    });
    expect(
      resolveModelTokenPricing({ provider: "custom", model: "other-model" }),
    ).toMatchObject({
      inCentsPerMTok: 900,
      outCentsPerMTok: 1_800,
      source: "operator_override",
    });
    // Without provider identity a wildcard must not guess the upstream.
    expect(resolveModelTokenPricing({ model: "other-model" })).toBeNull();
  });

  it("fails before a paid call when a USD-capped model has no exact price", async () => {
    delete process.env.AGENTIC_LLM_MODEL_PRICING_JSON;
    const tenantId = createTenant({ usdCap: 500 });
    const provider = new CustomProvider("unpriced-v1");
    await expect(
      gateway(provider).chat({
        tenantId,
        messages: [{ role: "user", content: "run" }],
        maxTokens: 50_000,
      }),
    ).rejects.toMatchObject<Partial<LLMError>>({
      code: "cost_limit_exceeded",
    });
    expect(provider.calls).toBe(0);
  });

  it("allows an explicitly priced custom model and deducts its real configured price", async () => {
    process.env.AGENTIC_LLM_MODEL_PRICING_JSON = JSON.stringify({
      "custom/priced-v1": { inCents: 100, outCents: 400 },
    });
    const tenantId = createTenant({ usdCap: 500 });
    const provider = new CustomProvider("priced-v1");
    await gateway(provider).chat({
      tenantId,
      messages: [{ role: "user", content: "run" }],
      maxTokens: 50_000,
    });
    expect(provider.calls).toBe(1);
    const budget = getDb()
      .select()
      .from(tenantBudgets)
      .where(eq(tenantBudgets.tenantId, tenantId))
      .all()[0]!;
    expect(budget.usedTokensMonth).toBe(150_000);
    expect(budget.usedUsdMonth).toBe(30);
  });

  it("rejects a provider that changes to an unpriced served model but still records tokens", async () => {
    process.env.AGENTIC_LLM_MODEL_PRICING_JSON = JSON.stringify({
      "custom/request-alias": { inCents: 100, outCents: 400 },
    });
    const tenantId = createTenant({ usdCap: 500 });
    const provider = new CustomProvider("request-alias", "served-unpriced-v2");
    await expect(
      gateway(provider).chat({
        tenantId,
        messages: [{ role: "user", content: "run" }],
        maxTokens: 50_000,
      }),
    ).rejects.toMatchObject<Partial<LLMError>>({
      code: "cost_limit_exceeded",
    });
    expect(provider.calls).toBe(1);
    const budget = getDb()
      .select()
      .from(tenantBudgets)
      .where(eq(tenantBudgets.tenantId, tenantId))
      .all()[0]!;
    expect(budget.usedTokensMonth).toBe(150_000);
    expect(budget.usedUsdMonth).toBe(0);
  });

  it("surfaces unpriced historical tokens and never lowers a prior USD counter", () => {
    delete process.env.AGENTIC_LLM_MODEL_PRICING_JSON;
    const tenantId = createTenant({ usdCap: null, usedUsd: 17 });
    const now = new Date();
    getDb().insert(llmCalls)
      .values({
        id: makeId("llm"),
        tenantId,
        conversationId: "factory-pricing-test",
        provider: "custom",
        requestedModel: "unpriced-history",
        servedModel: "unpriced-history",
        approxTokensIn: 20_000,
        approxTokensOut: 10_000,
        ok: true,
        createdAt: now,
      })
      .run();
    const usage = calculateTenantUsage(
      tenantId,
      new Date(now.getTime() - 1_000),
      new Date(now.getTime() + 1_000),
    );
    expect(usage).toMatchObject({
      tokens: 30_000,
      usdCents: 0,
      unpricedTokens: 30_000,
      costComplete: false,
    });
    const row = getDb()
      .select()
      .from(tenantBudgets)
      .where(eq(tenantBudgets.tenantId, tenantId))
      .all()[0]!;
    const reconciled = reconcileBudgetUsage(
      row,
      new Date(now.getTime() + 1_000),
    );
    expect(reconciled.usdCents).toBe(17);
    expect(reconciled.costComplete).toBe(false);
  });
});
