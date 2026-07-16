import { describe, expect, it } from "vitest";
import { PROVIDER_MODEL_CATALOG } from "@agentic/contracts";
import { LLMGateway, type ProviderAdapter } from "@agentic/llm-gateway";
import { assertModelControls } from "../../../packages/llm-gateway/src/capabilities";
import { buildOpenAIResponsesRequest } from "../../../packages/llm-gateway/src/adapters/openai-responses";
import { mapGeminiThinking } from "../../../packages/llm-gateway/src/adapters/gemini";

describe("frontier reasoning controls", () => {
  it("advertises exact GPT-5.6 modes and effort values", () => {
    const luna = PROVIDER_MODEL_CATALOG.openai.find(
      (model) => model.name === "gpt-5.6-luna",
    );
    expect(luna).toMatchObject({
      reasoningModes: ["standard", "pro"],
      reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
      defaultReasoningMode: "standard",
      defaultReasoningEffort: "medium",
      textVerbosities: ["low", "medium", "high"],
    });
  });

  it("builds a Responses request without dropping advanced OpenAI controls", () => {
    const wire = buildOpenAIResponsesRequest(
      {
        messages: [{ role: "user", content: "Solve this" }],
        reasoning: {
          mode: "pro",
          effort: "max",
          summary: "detailed",
          context: "all_turns",
        },
        verbosity: "high",
        store: true,
        jsonMode: true,
      },
      "gpt-5.6-luna",
    );
    expect(wire).toMatchObject({
      model: "gpt-5.6-luna",
      reasoning: {
        mode: "pro",
        effort: "max",
        summary: "detailed",
        context: "all_turns",
      },
      text: { format: { type: "json_object" }, verbosity: "high" },
      store: true,
    });
  });

  it("maps normalized Gemini effort to the current SDK thinking level", () => {
    expect(mapGeminiThinking({ effort: "medium", summary: "auto" })).toEqual({
      thinkingLevel: "MEDIUM",
      includeThoughts: true,
    });
  });

  it("rejects unsupported catalog combinations before adapter dispatch", async () => {
    let calls = 0;
    const adapter: ProviderAdapter = {
      id: "openai",
      name: "never-called",
      hasKey: true,
      defaultModel: "gpt-5.4-mini",
      async chat() {
        calls += 1;
        throw new Error("must not dispatch");
      },
    };
    const gateway = new LLMGateway({
      defaultProvider: "openai",
      defaultModel: "gpt-5.4-mini",
      timeoutMs: 1_000,
    });
    gateway.registerProvider(adapter);
    await expect(
      gateway.chat({
        messages: [{ role: "user", content: "test" }],
        reasoning: { mode: "pro" },
      }),
    ).rejects.toThrow(/does not support reasoning.mode=pro/);
    expect(calls).toBe(0);
  });

  it("allows live-discovered model ids to defer validation to the provider", () => {
    expect(() =>
      assertModelControls("openai", "gpt-5.7-preview", {
        reasoning: { effort: "max", mode: "pro" },
        verbosity: "high",
        store: true,
      }),
    ).not.toThrow();
  });
});
