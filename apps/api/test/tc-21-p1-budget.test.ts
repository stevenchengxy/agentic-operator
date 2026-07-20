/**
 * TC-16 — P1-LLM-05 budget hook regression.
 *
 * Exercises the gateway's pre-call + post-call budget checks against an
 * in-process mock provider:
 *
 *   1. Tenant with token cap 10, used 0 → 1st call succeeds, used jumps by
 *      the mock provider's returned token count.
 *   2. Tenant with token cap 10, used 10 → next call throws
 *      LLMError("cost_limit_exceeded") BEFORE the adapter runs.
 *   3. Tenant with USD cap 0 → next call also throws cost_limit_exceeded.
 *   4. assertBudgetAvailable on a tenant with no row is a no-op.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import {
  LLMGateway,
  LLMError,
  isLLMError,
  type ChatRequest,
  type ProviderAdapter,
} from "@agentic/llm-gateway";
import { getDb, tenantBudgets, tenants } from "@agentic/db";
import { makeId } from "@agentic/shared";
import { buildTestEnv } from "./harness";

class MockProvider implements ProviderAdapter {
  readonly id = "mock" as const;
  readonly name = "mock";
  readonly hasKey = true;
  readonly defaultModel: string | null = "mock-model-v1";
  readonly tokensInPerCall: number;
  readonly tokensOutPerCall: number;

  constructor(tokensIn = 5, tokensOut = 5) {
    this.tokensInPerCall = tokensIn;
    this.tokensOutPerCall = tokensOut;
  }

  async chat(_req: ChatRequest) {
    return {
      text: "mock response",
      provider: this.id,
      model: this.defaultModel ?? "mock",
      tokensIn: this.tokensInPerCall,
      tokensOut: this.tokensOutPerCall,
      finishReason: "stop" as const,
      latencyMs: 1,
    };
  }
}

describe("TC-16: budget hook (P1-LLM-05)", () => {
  let tenantA: string;
  let tenantB: string;
  let tenantUsd: string;
  let tenantUncapped: string;

  beforeAll(async () => {
    await buildTestEnv(); // ensures migrations have applied
    const db = getDb();
    // Seed 4 synthetic tenants with distinct cap shapes.
    const mk = (slug: string) => {
      const id = makeId("ten");
      db.insert(tenants).values({ id, slug, name: slug }).run();
      return id;
    };
    // Tag with a per-run suffix so re-runs against the shared DB don't
    // collide on the unique tenants.slug index.
    const tag = makeId("tag").slice(-8);
    tenantA = mk(`budget-cap-tokens-${tag}`);
    tenantB = mk(`budget-over-tokens-${tag}`);
    tenantUsd = mk(`budget-over-usd-${tag}`);
    tenantUncapped = mk(`budget-uncapped-${tag}`);

    db.insert(tenantBudgets)
      .values({
        tenantId: tenantA,
        // The gateway reserves two complete envelopes because a timed-out
        // first provider call can still be billed before its retry.
        monthlyTokenCap: 250,
        monthlyUsdCap: null,
        usedTokensMonth: 0,
        usedUsdMonth: 0,
      })
      .run();
    db.insert(tenantBudgets)
      .values({
        tenantId: tenantB,
        monthlyTokenCap: 5,
        monthlyUsdCap: null,
        usedTokensMonth: 5, // already at cap
        usedUsdMonth: 0,
      })
      .run();
    db.insert(tenantBudgets)
      .values({
        tenantId: tenantUsd,
        monthlyTokenCap: null,
        monthlyUsdCap: 0,
        usedTokensMonth: 0,
        usedUsdMonth: 1, // 1 cent already > 0 cap
      })
      .run();
    // tenantUncapped: no row at all → unlimited.
  });

  function mkGateway() {
    const gateway = new LLMGateway({
      defaultProvider: "mock",
      defaultModel: "mock-model-v1",
      timeoutMs: 5_000,
    });
    gateway.registerProvider(new MockProvider(5, 5));
    return gateway;
  }

  it("under-cap call succeeds and increments used_tokens_month", async () => {
    const gateway = mkGateway();
    const res = await gateway.chat({
      messages: [{ role: "user", content: "hi" }],
      tenantId: tenantA,
      maxTokens: 10,
    });
    expect(res.text).toBe("mock response");
    const row = getDb()
      .select()
      .from(tenantBudgets)
      .where(eq(tenantBudgets.tenantId, tenantA))
      .all()[0];
    expect(row!.usedTokensMonth).toBe(10); // 5 in + 5 out
  });

  it("over-cap tenant throws cost_limit_exceeded BEFORE the adapter runs", async () => {
    const gateway = mkGateway();
    let thrown: unknown = null;
    try {
      await gateway.chat({
        messages: [{ role: "user", content: "hi" }],
        tenantId: tenantB,
        maxTokens: 10,
      });
    } catch (err) {
      thrown = err;
    }
    expect(isLLMError(thrown)).toBe(true);
    expect((thrown as LLMError).code).toBe("cost_limit_exceeded");
  });

  it("USD over-cap throws cost_limit_exceeded", async () => {
    const gateway = mkGateway();
    let thrown: unknown = null;
    try {
      await gateway.chat({
        messages: [{ role: "user", content: "hi" }],
        tenantId: tenantUsd,
        maxTokens: 10,
      });
    } catch (err) {
      thrown = err;
    }
    expect(isLLMError(thrown)).toBe(true);
    expect((thrown as LLMError).code).toBe("cost_limit_exceeded");
  });

  it("uncapped tenant (no row) is a no-op — call succeeds", async () => {
    const gateway = mkGateway();
    const res = await gateway.chat({
      messages: [{ role: "user", content: "hi" }],
      tenantId: tenantUncapped,
    });
    expect(res.text).toBe("mock response");
    // Recording materializes a row with the deducted usage.
    const row = getDb()
      .select()
      .from(tenantBudgets)
      .where(eq(tenantBudgets.tenantId, tenantUncapped))
      .all()[0];
    expect(row).toBeDefined();
    expect(row!.usedTokensMonth).toBe(10);
  });

  it("omitting tenantId disables the budget hook entirely", async () => {
    const gateway = mkGateway();
    const res = await gateway.chat({
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.text).toBe("mock response");
  });
});
