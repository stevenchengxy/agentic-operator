import { describe, expect, it } from "vitest";
import { findCatalogModel, PROVIDER_MODEL_CATALOG } from "@agentic/contracts";
import {
  LLMError,
  LLMGateway,
  type ChatRequest,
  type ProviderAdapter,
  type ProviderId,
} from "@agentic/llm-gateway";
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
      temperatureRange: null,
    });
  });

  it("resolves the GPT-5.6 alias and dated snapshots to catalog capabilities", () => {
    expect(findCatalogModel("openai", "gpt-5.6")?.name).toBe("gpt-5.6-sol");
    expect(
      findCatalogModel("openai", "gpt-5.6-luna-2026-06-01")?.temperatureRange,
    ).toBeNull();
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

  it("omits inherited temperature for catalog-known unsupported models", async () => {
    const requests: ChatRequest[] = [];
    const adapter = capturingAdapter("openai", "gpt-5.6-luna", requests);
    const gateway = new LLMGateway({
      defaultProvider: "openai",
      defaultModel: "gpt-5.6-luna",
      timeoutMs: 1_000,
    });
    gateway.registerProvider(adapter);

    await gateway.chat({
      messages: [{ role: "user", content: "test inherited defaults" }],
      temperature: 0.2,
      reasoning: { mode: "standard", effort: "medium" },
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.temperature).toBeUndefined();
  });

  it("preserves supported temperatures and validates model-specific ranges", async () => {
    const requests: ChatRequest[] = [];
    const adapter = capturingAdapter("zai", "glm-5.2", requests);
    const gateway = new LLMGateway({
      defaultProvider: "zai",
      defaultModel: "glm-5.2",
      timeoutMs: 1_000,
    });
    gateway.registerProvider(adapter);

    await gateway.chat({
      messages: [{ role: "user", content: "supported temperature" }],
      temperature: 0.8,
    });
    expect(requests[0]?.temperature).toBe(0.8);

    await expect(
      gateway.chat({
        messages: [{ role: "user", content: "out of range" }],
        temperature: 1.2,
      }),
    ).rejects.toThrow(/Supported values: 0\.\.1/);
    expect(requests).toHaveLength(1);
  });

  it("retries an unknown model once without temperature on an explicit provider 400", async () => {
    const requests: ChatRequest[] = [];
    const adapter: ProviderAdapter = {
      id: "custom",
      name: "temperature compatibility probe",
      hasKey: true,
      defaultModel: "future-model",
      async chat(request) {
        requests.push(request);
        if (requests.length === 1) {
          throw new LLMError(
            "400 Unsupported parameter: 'temperature' is not supported with this model.",
            "bad_request",
            "custom",
          );
        }
        return successfulResponse("custom", "future-model");
      },
    };
    const gateway = new LLMGateway({
      defaultProvider: "custom",
      defaultModel: "future-model",
      timeoutMs: 1_000,
    });
    gateway.registerProvider(adapter);

    await gateway.chat({
      messages: [{ role: "user", content: "future model" }],
      temperature: 0.2,
    });
    await gateway.chat({
      messages: [{ role: "user", content: "future model again" }],
      temperature: 0.2,
    });

    expect(requests.map((request) => request.temperature)).toEqual([
      0.2,
      undefined,
      undefined,
    ]);
  });

  it("does not retry unrelated bad requests without temperature", async () => {
    let calls = 0;
    const adapter: ProviderAdapter = {
      id: "custom",
      name: "unrelated bad request",
      hasKey: true,
      defaultModel: "future-model",
      async chat() {
        calls += 1;
        throw new LLMError(
          "400 Invalid structured output schema.",
          "bad_request",
          "custom",
        );
      },
    };
    const gateway = new LLMGateway({
      defaultProvider: "custom",
      defaultModel: "future-model",
      timeoutMs: 1_000,
    });
    gateway.registerProvider(adapter);

    await expect(
      gateway.chat({
        messages: [{ role: "user", content: "bad schema" }],
        temperature: 0.2,
      }),
    ).rejects.toThrow(/Invalid structured output schema/);
    expect(calls).toBe(1);
  });

  it("honors a routed no-retry policy for transient provider errors", async () => {
    let calls = 0;
    const gateway = transientGateway(async () => {
      calls += 1;
      throw new LLMError("temporary timeout", "timeout", "mock");
    });

    await expect(
      gateway.chat({
        messages: [{ role: "user", content: "one attempt only" }],
        retryPolicy: { maxAttempts: 1, baseBackoffMs: 0 },
      }),
    ).rejects.toThrow(/temporary timeout/);
    expect(calls).toBe(1);
  });

  it("honors a bounded multi-attempt policy and stops after success", async () => {
    let calls = 0;
    const gateway = transientGateway(async () => {
      calls += 1;
      if (calls < 3) {
        throw new LLMError("temporary timeout", "timeout", "mock");
      }
      return successfulResponse("mock", "mock-model-v1");
    });

    await expect(
      gateway.chat({
        messages: [{ role: "user", content: "up to three attempts" }],
        retryPolicy: { maxAttempts: 3, baseBackoffMs: 0 },
      }),
    ).resolves.toMatchObject({ text: "ok" });
    expect(calls).toBe(3);
  });
});

function successfulResponse(provider: ProviderId, model: string) {
  return {
    text: "ok",
    provider,
    model,
    tokensIn: 1,
    tokensOut: 1,
    finishReason: "stop" as const,
    latencyMs: 1,
  };
}

function capturingAdapter(
  id: ProviderId,
  model: string,
  requests: ChatRequest[],
): ProviderAdapter {
  return {
    id,
    name: `${id} capture`,
    hasKey: true,
    defaultModel: model,
    async chat(request) {
      requests.push(request);
      return successfulResponse(id, model);
    },
  };
}

function transientGateway(
  chat: ProviderAdapter["chat"],
): LLMGateway {
  const gateway = new LLMGateway({
    defaultProvider: "mock",
    defaultModel: "mock-model-v1",
    timeoutMs: 1_000,
  });
  gateway.registerProvider({
    id: "mock",
    name: "retry-policy-test",
    hasKey: true,
    defaultModel: "mock-model-v1",
    chat,
  });
  return gateway;
}
