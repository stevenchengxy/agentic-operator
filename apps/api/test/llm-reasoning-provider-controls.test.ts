import { describe, expect, it } from "vitest";
import {
  assertModelControls,
  buildOpenAIResponsesRequest,
  mapOpenAICompatibleMessages,
  mapOpenAICompatibleReasoning,
} from "@agentic/llm-gateway";

describe("provider-neutral reasoning controls", () => {
  it("maps DeepSeek's normalized effort scale to its native high/max values", () => {
    expect(
      mapOpenAICompatibleReasoning(
        "deepseek",
        { reasoning: { effort: "none" } },
        "deepseek",
        "deepseek-v4-pro",
      ),
    ).toEqual({ thinking: { type: "disabled" } });
    expect(
      mapOpenAICompatibleReasoning(
        "deepseek",
        { reasoning: { effort: "low" } },
        "deepseek",
        "deepseek-v4-pro",
      ),
    ).toEqual({
      thinking: { type: "enabled" },
      reasoning_effort: "high",
    });
    expect(
      mapOpenAICompatibleReasoning(
        "deepseek",
        { reasoning: { effort: "xhigh" } },
        "deepseek",
        "deepseek-v4-pro",
      ),
    ).toEqual({
      thinking: { type: "enabled" },
      reasoning_effort: "max",
    });
  });

  it("only maps explicit disable for providers that expose thinking on/off", () => {
    expect(
      mapOpenAICompatibleReasoning(
        "moonshot",
        { reasoning: { effort: "none" } },
        "moonshot",
        "kimi-k2.6",
      ),
    ).toEqual({ thinking: { type: "disabled" } });
    expect(
      mapOpenAICompatibleReasoning(
        "moonshot",
        {
          tools: [{ name: "lookup", input_schema: { type: "object" } }],
        },
        "moonshot",
        "kimi-k2.6",
      ),
    ).toEqual({ thinking: { type: "enabled", keep: "all" } });
    expect(
      mapOpenAICompatibleReasoning(
        "zai",
        {
          tools: [{ name: "lookup", input_schema: { type: "object" } }],
        },
        "zai",
        "glm-5.2",
      ),
    ).toEqual({
      thinking: { type: "enabled", clear_thinking: false },
    });
    expect(
      mapOpenAICompatibleReasoning(
        "zai",
        { reasoning: { effort: "none" } },
        "zai",
        "glm-5.2",
      ),
    ).toEqual({ thinking: { type: "disabled" } });

    expect(() =>
      mapOpenAICompatibleReasoning(
        "moonshot",
        { reasoning: { effort: "high" } },
        "moonshot",
        "kimi-k2.6",
      ),
    ).toThrow(/on\/off thinking control/);
    expect(() =>
      mapOpenAICompatibleReasoning(
        "moonshot",
        { reasoning: { effort: "none" } },
        "moonshot",
        "kimi-k2.7-code",
      ),
    ).toThrow(/mandatory thinking/);
    expect(() =>
      mapOpenAICompatibleReasoning(
        "zai",
        { reasoning: { effort: "high" } },
        "zai",
        "glm-5.2",
      ),
    ).toThrow(/no native effort level/);
  });

  it("replays opaque reasoning_content exactly on assistant tool turns", () => {
    expect(
      mapOpenAICompatibleMessages([
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "call_1",
              name: "weather.lookup",
              input: { city: "Singapore" },
            },
          ],
          reasoningContent: "opaque-provider-state",
        },
      ]),
    ).toEqual([
      {
        role: "assistant",
        content: "",
        reasoning_content: "opaque-provider-state",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: {
              name: "weather__lookup",
              arguments: '{"city":"Singapore"}',
            },
          },
        ],
      },
    ]);
  });

  it("replays only same-provider Responses reasoning items for tool turns", () => {
    const reasoningItem = {
      type: "reasoning" as const,
      id: "rs_1",
      summary: [],
      encrypted_content: "encrypted-state",
    };
    const wire = buildOpenAIResponsesRequest(
      {
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "call_1",
                name: "weather.lookup",
                input: { city: "Singapore" },
              },
            ],
            reasoningContent: JSON.stringify({
              provider: "openai",
              api: "responses",
              items: [reasoningItem],
            }),
          },
          {
            role: "tool",
            content: [
              {
                type: "tool_result",
                tool_use_id: "call_1",
                content: '{"temperature":30}',
              },
            ],
          },
        ],
        tools: [
          {
            name: "weather.lookup",
            input_schema: { type: "object" },
          },
        ],
      },
      "gpt-5.6-sol",
      "openai",
    );

    expect(wire.input).toEqual(
      expect.arrayContaining([reasoningItem]),
    );
    expect(wire.include).toEqual(["reasoning.encrypted_content"]);
  });

  it("rejects unsupported catalog-known controls before dispatch", () => {
    expect(() =>
      assertModelControls("anthropic", "claude-fable-5", {
        reasoning: { effort: "none" },
      }),
    ).toThrow(/does not support reasoning\.effort=none/);
    expect(() =>
      assertModelControls("zai", "glm-5.2", {
        reasoning: { effort: "high" },
      }),
    ).toThrow(/does not support reasoning\.effort=high/);

    expect(() =>
      assertModelControls("anthropic", "claude-sonnet-5", {
        reasoning: { effort: "none" },
      }),
    ).not.toThrow();
    expect(() =>
      assertModelControls("deepseek", "deepseek-v4-pro", {
        reasoning: { effort: "max" },
      }),
    ).not.toThrow();
  });
});
