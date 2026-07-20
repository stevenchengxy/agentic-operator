import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import {
  estimateInputTokenUpperBound,
  estimateTokenCostCents,
  getActiveBudgetReservations,
  isLLMError,
  LLMError,
  LLMGateway,
  reserveBudget,
  settleBudgetReservation,
  type ChatRequest,
  type ProviderAdapter,
} from "@agentic/llm-gateway";
import { getDb, getRawSqlite, tenantBudgets, tenants } from "@agentic/db";
import { makeId } from "@agentic/shared";
import { buildTestEnv } from "./harness";

class BarrierProvider implements ProviderAdapter {
  readonly id = "custom" as const;
  readonly name = "budget-barrier";
  readonly hasKey = true;
  readonly defaultModel = "budget-concurrency-v1";
  calls = 0;
  private releaseFirst!: () => void;
  private firstEntered!: () => void;
  readonly firstEnteredPromise = new Promise<void>((resolve) => {
    this.firstEntered = resolve;
  });
  private readonly firstReleasePromise = new Promise<void>((resolve) => {
    this.releaseFirst = resolve;
  });

  release(): void {
    this.releaseFirst();
  }

  async chat(_request: ChatRequest) {
    this.calls += 1;
    if (this.calls === 1) {
      this.firstEntered();
      await this.firstReleasePromise;
    }
    return {
      text: "provider response",
      provider: this.id,
      model: this.defaultModel,
      tokensIn: 2,
      tokensOut: 2,
      finishReason: "stop" as const,
      latencyMs: 1,
    };
  }
}

class FailOnceProvider implements ProviderAdapter {
  readonly id = "custom" as const;
  readonly name = "budget-fail-once";
  readonly hasKey = true;
  readonly defaultModel = "budget-concurrency-v1";
  calls = 0;

  async chat(_request: ChatRequest) {
    this.calls += 1;
    if (this.calls === 1) {
      throw new LLMError("invalid provider credential", "auth", this.id);
    }
    return {
      text: "provider response",
      provider: this.id,
      model: this.defaultModel,
      tokensIn: 2,
      tokensOut: 2,
      finishReason: "stop" as const,
      latencyMs: 1,
    };
  }
}

class TimeoutThenSuccessProvider implements ProviderAdapter {
  readonly id = "custom" as const;
  readonly name = "budget-timeout-then-success";
  readonly hasKey = true;
  readonly defaultModel = "budget-concurrency-v1";
  calls = 0;

  async chat(_request: ChatRequest) {
    this.calls += 1;
    if (this.calls === 1) {
      throw new LLMError("upstream response timed out", "timeout", this.id);
    }
    return {
      text: "retry response",
      provider: this.id,
      model: this.defaultModel,
      tokensIn: 2,
      tokensOut: 2,
      finishReason: "stop" as const,
      latencyMs: 1,
    };
  }
}

class AlwaysTimeoutProvider implements ProviderAdapter {
  readonly id = "custom" as const;
  readonly name = "budget-always-timeout";
  readonly hasKey = true;
  readonly defaultModel = "budget-concurrency-v1";
  calls = 0;

  async chat(_request: ChatRequest): Promise<never> {
    this.calls += 1;
    throw new LLMError("upstream response timed out", "timeout", this.id);
  }
}

describe("atomic LLM budget reservations", () => {
  const tenantIds: string[] = [];
  const priorPricing = process.env.AGENTIC_LLM_MODEL_PRICING_JSON;

  const request = {
    messages: [{ role: "user" as const, content: "concurrency check" }],
    maxTokens: 10,
  };

  beforeAll(async () => {
    await buildTestEnv();
    process.env.AGENTIC_LLM_MODEL_PRICING_JSON = JSON.stringify({
      "custom/budget-concurrency-v1": {
        inCents: 100_000,
        outCents: 100_000,
      },
    });
  });

  afterAll(() => {
    if (priorPricing === undefined) {
      delete process.env.AGENTIC_LLM_MODEL_PRICING_JSON;
    } else {
      process.env.AGENTIC_LLM_MODEL_PRICING_JSON = priorPricing;
    }
    if (tenantIds.length > 0) {
      getDb().delete(tenants).where(inArray(tenants.id, tenantIds)).run();
    }
  });

  function createTenant(args: {
    tokenCap: number | null;
    usdCap: number | null;
  }): string {
    const tenantId = makeId("ten");
    tenantIds.push(tenantId);
    getDb().insert(tenants).values({
      id: tenantId,
      slug: `budget-reservation-${tenantId}`,
      name: tenantId,
    }).run();
    getDb().insert(tenantBudgets).values({
      tenantId,
      monthlyTokenCap: args.tokenCap,
      monthlyUsdCap: args.usdCap,
      usedTokensMonth: 0,
      usedUsdMonth: 0,
      periodStart: new Date(Date.now() - 1_000),
    }).run();
    return tenantId;
  }

  function gateway(provider: ProviderAdapter): LLMGateway {
    const instance = new LLMGateway({
      defaultProvider: "custom",
      defaultModel: provider.defaultModel,
      timeoutMs: 5_000,
    });
    instance.registerProvider(provider);
    return instance;
  }

  it("admits only one concurrent call when the token cap holds one envelope", async () => {
    const reservedTokens =
      (estimateInputTokenUpperBound(request) + request.maxTokens) * 2;
    const tenantId = createTenant({ tokenCap: reservedTokens, usdCap: null });
    const provider = new BarrierProvider();
    const instance = gateway(provider);

    const first = instance.chat({ ...request, tenantId });
    await provider.firstEnteredPromise;
    expect(getActiveBudgetReservations(tenantId)).toMatchObject({
      count: 1,
      reservedTokens,
    });

    const second = await instance
      .chat({ ...request, tenantId })
      .then(() => null, (error: unknown) => error);
    expect(isLLMError(second)).toBe(true);
    expect((second as LLMError).code).toBe("cost_limit_exceeded");
    expect(provider.calls).toBe(1);

    provider.release();
    await expect(first).resolves.toMatchObject({ text: "provider response" });
    expect(getActiveBudgetReservations(tenantId)).toEqual({
      count: 0,
      reservedTokens: 0,
      reservedUsdCents: 0,
    });
    const budget = getDb().select().from(tenantBudgets)
      .where(eq(tenantBudgets.tenantId, tenantId)).all()[0]!;
    expect(budget.usedTokensMonth).toBe(4);
  });

  it("admits only one concurrent call when the USD cap holds one priced envelope", async () => {
    const inputBound = estimateInputTokenUpperBound(request);
    const reservedUsd = estimateTokenCostCents({
      provider: "custom",
      model: "budget-concurrency-v1",
      tokensIn: inputBound,
      tokensOut: request.maxTokens,
    })!.usdCents * 2;
    const tenantId = createTenant({ tokenCap: null, usdCap: reservedUsd });
    const provider = new BarrierProvider();
    const instance = gateway(provider);

    const first = instance.chat({ ...request, tenantId });
    await provider.firstEnteredPromise;
    expect(getActiveBudgetReservations(tenantId)).toMatchObject({
      count: 1,
      reservedUsdCents: reservedUsd,
    });

    await expect(instance.chat({ ...request, tenantId })).rejects.toMatchObject({
      code: "cost_limit_exceeded",
    });
    expect(provider.calls).toBe(1);
    provider.release();
    await first;

    const budget = getDb().select().from(tenantBudgets)
      .where(eq(tenantBudgets.tenantId, tenantId)).all()[0]!;
    expect(budget.usedUsdMonth).toBe(
      estimateTokenCostCents({
        provider: "custom",
        model: "budget-concurrency-v1",
        tokensIn: 2,
        tokensOut: 2,
      })!.usdCents,
    );
  });

  it("releases a failed provider reservation so a later call can proceed", async () => {
    const reservedTokens =
      (estimateInputTokenUpperBound(request) + request.maxTokens) * 2;
    const tenantId = createTenant({ tokenCap: reservedTokens, usdCap: null });
    const provider = new FailOnceProvider();
    const instance = gateway(provider);

    await expect(instance.chat({ ...request, tenantId })).rejects.toMatchObject({
      code: "auth",
    });
    expect(getActiveBudgetReservations(tenantId).count).toBe(0);
    await expect(instance.chat({ ...request, tenantId })).resolves.toMatchObject({
      text: "provider response",
    });
    expect(provider.calls).toBe(2);
  });

  it("conservatively charges an ambiguous first attempt before returning a retry response", async () => {
    const perAttemptTokens =
      estimateInputTokenUpperBound(request) + request.maxTokens;
    const tenantId = createTenant({
      tokenCap: perAttemptTokens * 2,
      usdCap: null,
    });
    const provider = new TimeoutThenSuccessProvider();

    await expect(gateway(provider).chat({ ...request, tenantId })).resolves.toMatchObject({
      text: "retry response",
    });
    expect(provider.calls).toBe(2);

    const budget = getDb().select().from(tenantBudgets)
      .where(eq(tenantBudgets.tenantId, tenantId)).all()[0]!;
    expect(budget.usedTokensMonth).toBe(perAttemptTokens + 4);
    const reservation = getRawSqlite().prepare(
      `SELECT status, actual_tokens AS actualTokens, outcome
       FROM llm_budget_reservations WHERE tenant_id = ?`,
    ).get(tenantId) as {
      status: string;
      actualTokens: number;
      outcome: string;
    };
    expect(reservation).toMatchObject({
      status: "settled",
      actualTokens: perAttemptTokens + 4,
      outcome: "settled_conservative:1_uncertain_attempts",
    });
  });

  it("charges both ambiguous attempts when both provider responses are lost", async () => {
    const perAttemptTokens =
      estimateInputTokenUpperBound(request) + request.maxTokens;
    const tenantId = createTenant({
      tokenCap: perAttemptTokens * 2,
      usdCap: null,
    });
    const provider = new AlwaysTimeoutProvider();

    await expect(gateway(provider).chat({ ...request, tenantId })).rejects.toMatchObject({
      code: "timeout",
    });
    expect(provider.calls).toBe(2);
    const budget = getDb().select().from(tenantBudgets)
      .where(eq(tenantBudgets.tenantId, tenantId)).all()[0]!;
    expect(budget.usedTokensMonth).toBe(perAttemptTokens * 2);
    const reservation = getRawSqlite().prepare(
      `SELECT status, outcome FROM llm_budget_reservations WHERE tenant_id = ?`,
    ).get(tenantId) as { status: string; outcome: string };
    expect(reservation).toEqual({
      status: "settled",
      outcome: "settled_conservative:2_uncertain_attempts",
    });
  });

  it("accounts an expired crash lease once and rejects a late settlement", () => {
    const perAttemptTokens =
      estimateInputTokenUpperBound(request) + request.maxTokens;
    const tenantId = createTenant({
      tokenCap: perAttemptTokens * 2,
      usdCap: null,
    });
    const reservation = reserveBudget({
      tenantId,
      provider: "custom",
      model: "budget-concurrency-v1",
      request,
      timeoutMs: 1_000,
      maxAttempts: 2,
    })!;
    getRawSqlite().prepare(
      "UPDATE llm_budget_reservations SET expires_at = ? WHERE id = ?",
    ).run(Date.now() - 1, reservation.id);

    expect(getActiveBudgetReservations(tenantId)).toEqual({
      count: 0,
      reservedTokens: 0,
      reservedUsdCents: 0,
    });
    const afterExpiry = getDb().select().from(tenantBudgets)
      .where(eq(tenantBudgets.tenantId, tenantId)).all()[0]!;
    expect(afterExpiry.usedTokensMonth).toBe(reservation.reservedTokens);
    const expired = getRawSqlite().prepare(
      `SELECT status, actual_tokens AS actualTokens, outcome
       FROM llm_budget_reservations WHERE id = ?`,
    ).get(reservation.id);
    expect(expired).toEqual({
      status: "expired",
      actualTokens: reservation.reservedTokens,
      outcome: "lease_expired_conservative",
    });

    expect(() => settleBudgetReservation({
      reservation,
      servedModel: reservation.model,
      tokensIn: 2,
      tokensOut: 2,
    })).toThrowError(expect.objectContaining({ code: "cost_limit_exceeded" }));
    const afterLateResponse = getDb().select().from(tenantBudgets)
      .where(eq(tenantBudgets.tenantId, tenantId)).all()[0]!;
    expect(afterLateResponse.usedTokensMonth).toBe(reservation.reservedTokens);
  });
});
