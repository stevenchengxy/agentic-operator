import { describe, it, expect } from "vitest";
import { heterogeneousReviewChain, modelFamily, modelChain } from "./model-router";
import { budgetForDifficulty } from "./reasoning-policy";

// #HETERO-REVIEW (P1-3) + #BUDGET-ROUTE (P1-5) — pure routing tests.

describe("modelFamily", () => {
  it("extracts the family from provider-prefixed ids", () => {
    expect(modelFamily("anthropic/claude-sonnet-4.6")).toBe("claude");
    expect(modelFamily("openai/gpt-5.4")).toBe("gpt");
    expect(modelFamily("google/gemini-3.1-pro-preview")).toBe("gemini");
    expect(modelFamily("kimi-k2")).toBe("kimi");
  });
});

describe("heterogeneousReviewChain", () => {
  const env = (over: Record<string, string>) => ({
    CUSTOM_LLM_API_KEY: "x",
    CUSTOM_LLM_BASE_URL: "http://127.0.0.1:1/v1",
    FACTORY_AI_MODEL: "anthropic/claude-haiku-4.5",
    ...over,
  });

  it("rotates a different-family model to the front when heads collide", () => {
    const e = env({
      FACTORY_MODEL_HARD: "anthropic/claude-sonnet-4.6,openai/gpt-5.4",
      FACTORY_MODEL_REVIEW: "anthropic/claude-opus-4.8,openai/gpt-5.5,anthropic/claude-sonnet-4.6",
    });
    const chain = heterogeneousReviewChain("hard", e);
    // generator head = claude family → review must NOT lead with claude
    expect(modelFamily(chain[0]!)).toBe("gpt");
    // nothing lost, order otherwise preserved
    expect(chain).toEqual(expect.arrayContaining(["anthropic/claude-opus-4.8", "openai/gpt-5.5"]));
  });

  it("keeps the review chain untouched when its head already differs", () => {
    const e = env({
      FACTORY_MODEL_HARD: "anthropic/claude-sonnet-4.6",
      FACTORY_MODEL_REVIEW: "openai/gpt-5.5,anthropic/claude-opus-4.8",
    });
    expect(heterogeneousReviewChain("hard", e)[0]).toBe("openai/gpt-5.5");
  });

  it("degrades gracefully when every review model shares the generator family", () => {
    const e = env({
      FACTORY_MODEL_HARD: "anthropic/claude-sonnet-4.6",
      FACTORY_MODEL_REVIEW: "anthropic/claude-opus-4.8,anthropic/claude-haiku-4.5",
    });
    const chain = heterogeneousReviewChain("hard", e);
    expect(chain[0]).toBe("anthropic/claude-opus-4.8"); // unchanged — homogeneous but functional
    expect(chain).toEqual(modelChain("review", e));
  });
});

describe("budgetForDifficulty", () => {
  it("simple → single-draft sequential revision, iterate", () => {
    const b = budgetForDifficulty("simple");
    expect(b.candidates).toBe(1);
    expect(b.reviseTurns).toBe(2);
    expect(b.escalation).toBe("iterate");
  });
  it("standard → 2 candidates only when a real verifier exists; tier_up on stall", () => {
    expect(budgetForDifficulty("standard").candidates).toBe(2);
    expect(budgetForDifficulty("standard", { realVerifier: false }).candidates).toBe(1);
    expect(budgetForDifficulty("standard").escalation).toBe("tier_up");
  });
  it("complex → never grind: escalate to the human", () => {
    expect(budgetForDifficulty("complex").escalation).toBe("ask_user");
    expect(budgetForDifficulty("complex").reviseTurns).toBeLessThanOrEqual(3);
  });
});
