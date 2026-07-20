import { describe, expect, it } from "vitest";
import { PROVIDER_MODEL_CATALOG } from "@agentic/contracts";
import {
  buildOpenAICompatibleRequest,
  mapOpenAICompatibleReasoning,
} from "../../../packages/llm-gateway/src/adapters/openai-compatible";

describe("Moonshot Kimi K3 provider contract", () => {
  it("maps the only supported explicit effort to the top-level K3 field", () => {
    expect(
      mapOpenAICompatibleReasoning(
        "moonshot",
        { reasoning: { effort: "max" } },
        "moonshot",
        "kimi-k3",
      ),
    ).toEqual({ reasoning_effort: "max" });

    expect(
      mapOpenAICompatibleReasoning("moonshot", {}, "moonshot", "kimi-k3"),
    ).toEqual({});
  });

  it("rejects efforts that K3 cannot accept or disable", () => {
    for (const effort of ["none", "high"] as const) {
      expect(() =>
        mapOpenAICompatibleReasoning(
          "moonshot",
          { reasoning: { effort } },
          "moonshot",
          "kimi-k3",
        ),
      ).toThrow(/supports only reasoning\.effort=max/);
    }
  });

  it("uses max_completion_tokens and omits fixed sampling parameters", () => {
    const wire = buildOpenAICompatibleRequest(
      { id: "moonshot", reasoningDialect: "moonshot" },
      {
        messages: [{ role: "user", content: "Inspect this contract" }],
        temperature: 0.2,
        maxTokens: 1_048_576,
        reasoning: { effort: "max" },
      },
      "kimi-k3",
    );

    expect(wire).toMatchObject({
      model: "kimi-k3",
      stream: false,
      max_completion_tokens: 1_048_576,
      reasoning_effort: "max",
    });
    expect(wire).not.toHaveProperty("max_tokens");
    expect(wire).not.toHaveProperty("temperature");
    expect(wire).not.toHaveProperty("top_p");
  });
});

describe("Z.AI GLM-5.2 provider contract", () => {
  it("maps high effort to enabled thinking without changing its level", () => {
    expect(
      mapOpenAICompatibleReasoning(
        "zai",
        { reasoning: { effort: "high" } },
        "zai",
        "glm-5.2",
      ),
    ).toEqual({
      thinking: { type: "enabled" },
      reasoning_effort: "high",
    });
  });

  it("maps max effort and explicit reasoning disable distinctly", () => {
    expect(
      mapOpenAICompatibleReasoning(
        "zai",
        { reasoning: { effort: "max" } },
        "zai",
        "glm-5.2",
      ),
    ).toEqual({
      thinking: { type: "enabled" },
      reasoning_effort: "max",
    });
    expect(
      mapOpenAICompatibleReasoning(
        "zai",
        { reasoning: { effort: "none" } },
        "zai",
        "glm-5.2",
      ),
    ).toEqual({ thinking: { type: "disabled" } });
  });

  it("rejects effort values outside GLM-5.2's direct API contract", () => {
    for (const effort of ["low", "medium", "xhigh"] as const) {
      expect(() =>
        mapOpenAICompatibleReasoning(
          "zai",
          { reasoning: { effort } },
          "zai",
          "glm-5.2",
        ),
      ).toThrow(/supports only reasoning\.effort=high, max, or none/);
    }
  });

  it("omits reasoning controls by default but preserves tool-loop thinking", () => {
    expect(mapOpenAICompatibleReasoning("zai", {}, "zai", "glm-5.2")).toEqual(
      {},
    );
    expect(
      mapOpenAICompatibleReasoning(
        "zai",
        { tools: [{ name: "lookup", input_schema: { type: "object" } }] },
        "zai",
        "glm-5.2",
      ),
    ).toEqual({
      thinking: { type: "enabled", clear_thinking: false },
    });
  });
});

describe("Moonshot, Z.AI, and OpenRouter catalog regressions", () => {
  it("advertises exact current output, reasoning, sampling, and price metadata", () => {
    const directK3 = PROVIDER_MODEL_CATALOG.moonshot.find(
      (model) => model.name === "kimi-k3",
    );
    const directGlm = PROVIDER_MODEL_CATALOG.zai.find(
      (model) => model.name === "glm-5.2",
    );
    const openRouterOpus = PROVIDER_MODEL_CATALOG.openrouter.find(
      (model) => model.name === "anthropic/claude-opus-4.8",
    );
    const openRouterGlm = PROVIDER_MODEL_CATALOG.openrouter.find(
      (model) => model.name === "z-ai/glm-5.2",
    );

    expect(directK3).toMatchObject({
      ctx: 1_048_576,
      out: 1_048_576,
      reasoningEfforts: ["max"],
      defaultReasoningEffort: "max",
      temperatureRange: null,
      pricing: [{ input: 3, cachedInput: 0.3, output: 15 }],
    });
    expect(directGlm).toMatchObject({
      ctx: 1_000_000,
      out: 131_072,
      reasoningEfforts: ["none", "high", "max"],
      defaultReasoningEffort: "max",
      temperatureRange: { min: 0, max: 1 },
      pricing: [{ input: 1.4, cachedInput: 0.26, output: 4.4 }],
    });
    expect(openRouterOpus).toMatchObject({ temperatureRange: null });
    expect(openRouterGlm).toMatchObject({
      reasoningEfforts: ["high", "xhigh"],
      defaultReasoningEffort: "high",
      pricing: [{ input: 0.2912, cachedInput: 0.05408, output: 0.9152 }],
      priceAsOf: "2026-07-19",
    });
  });
});
