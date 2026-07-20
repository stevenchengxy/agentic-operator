import { describe, expect, it } from "vitest";
import {
  buildOpenAIResponsesRequest,
  createOpenAIResponsesAdapter,
} from "../../../packages/llm-gateway/src/adapters/openai-responses";
import { mapOpenAICompatibleReasoning } from "../../../packages/llm-gateway/src/adapters/openai-compatible";
import { assertModelControls } from "../../../packages/llm-gateway/src/capabilities";
import {
  resolveOpenRouterReasoningMode,
  shouldUseOpenRouterResponses,
} from "../../../packages/llm-gateway/src/providers/openrouter";

describe("OpenAI and OpenRouter reasoning controls", () => {
  it("maps every normalized OpenResponses control without conflating mode and effort", () => {
    const wire = buildOpenAIResponsesRequest(
      {
        messages: [{ role: "user", content: "Solve this" }],
        maxTokens: 1_024,
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
      "gpt-5.6-sol",
      "openai",
    );

    expect(wire).toMatchObject({
      model: "gpt-5.6-sol",
      max_output_tokens: 1_024,
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

  it("maps summary=none to the Responses null sentinel and defaults storage off", () => {
    const wire = buildOpenAIResponsesRequest(
      {
        messages: [{ role: "user", content: "Answer briefly" }],
        reasoning: { summary: "none" },
      },
      "gpt-5.6-luna",
    );

    expect(wire.reasoning).toEqual({ summary: null });
    expect(wire.store).toBe(false);
  });

  it("rejects stateful OpenRouter Responses requests", () => {
    expect(() =>
      buildOpenAIResponsesRequest(
        {
          messages: [{ role: "user", content: "Remember this" }],
          store: true,
        },
        "openai/gpt-5.6-sol",
        "openrouter",
      ),
    ).toThrow(/does not support store=true/);
  });

  it("keeps effort-only OpenRouter calls on Chat Completions", () => {
    expect(
      shouldUseOpenRouterResponses({ reasoning: { effort: "high" } }),
    ).toBe(false);
    expect(shouldUseOpenRouterResponses({ reasoning: { mode: "pro" } })).toBe(
      true,
    );
    expect(
      shouldUseOpenRouterResponses({ reasoning: { context: "all_turns" } }),
    ).toBe(true);
    expect(shouldUseOpenRouterResponses({ verbosity: "low" })).toBe(true);
    expect(shouldUseOpenRouterResponses({ store: false })).toBe(true);
  });

  it("resolves OpenRouter GPT-5.6 modes through the paired model ids", () => {
    const pro = resolveOpenRouterReasoningMode({
      messages: [{ role: "user", content: "Solve this" }],
      model: "openai/gpt-5.6-sol",
      reasoning: { mode: "pro", effort: "max" },
    });
    expect(pro).toMatchObject({
      model: "openai/gpt-5.6-sol-pro",
      reasoning: { effort: "max" },
    });
    expect(pro.reasoning).not.toHaveProperty("mode");
    expect(shouldUseOpenRouterResponses(pro)).toBe(false);

    const standard = resolveOpenRouterReasoningMode({
      messages: [{ role: "user", content: "Solve this" }],
      model: "openai/gpt-5.6-sol-pro",
      reasoning: { mode: "standard", summary: "detailed" },
    });
    expect(standard).toMatchObject({
      model: "openai/gpt-5.6-sol",
      reasoning: { summary: "detailed" },
    });
    expect(standard.reasoning).not.toHaveProperty("mode");
    expect(shouldUseOpenRouterResponses(standard)).toBe(true);
  });

  it("advertises richer OpenRouter controls to gateway preflight", () => {
    expect(() =>
      assertModelControls("openrouter", "openai/gpt-5.6-terra", {
        reasoning: {
          mode: "pro",
          effort: "max",
          summary: "detailed",
          context: "all_turns",
        },
        verbosity: "high",
        store: false,
      }),
    ).not.toThrow();
  });

  it("uses each Chat Completions provider's documented effort dialect", () => {
    expect(
      mapOpenAICompatibleReasoning(
        "openai-chat",
        { reasoning: { effort: "high" } },
        "openai",
        "gpt-5.4",
      ),
    ).toEqual({ reasoning_effort: "high" });

    expect(
      mapOpenAICompatibleReasoning(
        "openrouter",
        { reasoning: { effort: "high" } },
        "openrouter",
        "openai/gpt-5.6-sol",
      ),
    ).toEqual({ reasoning: { effort: "high" } });

    expect(() =>
      mapOpenAICompatibleReasoning(
        "openrouter",
        { reasoning: { mode: "pro" } },
        "openrouter",
        "openai/gpt-5.6-sol",
      ),
    ).toThrow(/does not accept reasoning mode on Chat Completions/);
  });

  it("normalizes OpenRouter Responses output, summaries, controls, and cost", async () => {
    let requestUrl = "";
    let requestBody: unknown;
    const adapter = createOpenAIResponsesAdapter({
      id: "openrouter",
      name: "OpenRouter",
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: "test-key",
      defaultModel: "openai/gpt-5.6-sol",
      fetch: async (input, init) => {
        const request =
          input instanceof Request ? input : new Request(input, init);
        requestUrl = request.url;
        requestBody = await request.clone().json();
        return new Response(
          JSON.stringify({
            id: "resp_test",
            object: "response",
            created_at: 1,
            model: "openai/gpt-5.6-sol",
            status: "completed",
            output: [
              {
                type: "reasoning",
                id: "rs_test",
                summary: ["First summary", "Second summary"],
              },
              {
                type: "message",
                id: "msg_test",
                status: "completed",
                role: "assistant",
                content: [
                  {
                    type: "output_text",
                    text: "Provider answer",
                    annotations: [],
                  },
                ],
              },
            ],
            reasoning: {
              mode: "pro",
              effort: "high",
              summary: "detailed",
              context: "all_turns",
            },
            text: { format: { type: "text" }, verbosity: "high" },
            usage: {
              input_tokens: 10,
              input_tokens_details: { cached_tokens: 2 },
              output_tokens: 6,
              output_tokens_details: { reasoning_tokens: 3 },
              total_tokens: 16,
              cost: "0.00012",
            },
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
              "x-request-id": "req_test",
            },
          },
        );
      },
    });

    const response = await adapter.chat({
      messages: [{ role: "user", content: "Solve this" }],
      model: "openai/gpt-5.6-sol-pro",
      reasoning: {
        effort: "max",
        summary: "concise",
        context: "current_turn",
      },
      verbosity: "low",
      store: false,
    });

    expect(requestUrl).toBe("https://openrouter.ai/api/v1/responses");
    expect(requestBody).toMatchObject({
      reasoning: {
        effort: "max",
        summary: "concise",
        context: "current_turn",
      },
      text: { verbosity: "low" },
      store: false,
    });
    expect(
      (requestBody as { reasoning: Record<string, unknown> }).reasoning,
    ).not.toHaveProperty("mode");
    expect(response).toMatchObject({
      text: "Provider answer",
      reasoning: {
        mode: "pro",
        effort: "high",
        summary: "detailed",
        context: "all_turns",
      },
      verbosity: "high",
      reasoningSummary: "First summary\n\nSecond summary",
      providerReportedCostUsd: 0.00012,
      finishReason: "stop",
      usage: {
        inputTokens: 10,
        outputTokens: 6,
        totalTokens: 16,
        cachedInputTokens: 2,
        reasoningTokens: 3,
      },
    });
  });

  it("retains provider-reported cost from a NewAPI-compatible Responses endpoint", async () => {
    const adapter = createOpenAIResponsesAdapter({
      id: "custom",
      name: "NewAPI CSI",
      baseURL: "https://newapi.example.test/v1",
      apiKey: "test-key",
      defaultModel: null,
      fetch: async () =>
        new Response(
          JSON.stringify({
            id: "resp_newapi",
            object: "response",
            created_at: 1,
            model: "moonshotai/kimi-k3",
            status: "completed",
            output: [
              {
                type: "message",
                id: "msg_newapi",
                status: "completed",
                role: "assistant",
                content: [
                  {
                    type: "output_text",
                    text: "Gateway answer",
                    annotations: [],
                  },
                ],
              },
            ],
            usage: {
              input_tokens: 4,
              output_tokens: 2,
              total_tokens: 6,
              cost: "0.00003125",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });

    const response = await adapter.chat({
      messages: [{ role: "user", content: "Test" }],
      model: "moonshotai/kimi-k3",
      reasoning: { effort: "high" },
    });

    expect(response.providerReportedCostUsd).toBe(0.00003125);
    expect(response.usage).toMatchObject({
      inputTokens: 4,
      outputTokens: 2,
      totalTokens: 6,
    });
  });
});
