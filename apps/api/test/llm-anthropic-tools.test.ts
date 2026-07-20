import { describe, expect, it } from "vitest";
import {
  mapAnthropicMessages,
  mapAnthropicRequest,
  mapAnthropicResponse,
} from "../../../packages/llm-gateway/src/adapters/anthropic";

describe("Anthropic native tool mapping", () => {
  it("projects tool definitions, tool calls, and results into native Messages API blocks", () => {
    const request = mapAnthropicRequest(
      {
        messages: [
          { role: "system", content: "Be concise." },
          { role: "user", content: "What is the weather?" },
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "toolu_1",
                name: "weather.lookup",
                input: { city: "Singapore" },
              },
            ],
          },
          {
            role: "tool",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_1",
                content: '{"temperatureC":30}',
                is_error: false,
              },
            ],
          },
        ],
        tools: [
          {
            name: "weather.lookup",
            description: "Look up current weather",
            input_schema: {
              type: "object",
              properties: { city: { type: "string" } },
              required: ["city"],
            },
          },
        ],
        reasoning: { effort: "low" },
      },
      "claude-opus-4-8",
    );

    expect(request.system).toBe("Be concise.");
    expect(request.tools).toEqual([
      {
        name: "weather__lookup",
        description: "Look up current weather",
        input_schema: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      },
    ]);
    expect(request.messages).toEqual([
      { role: "user", content: "What is the weather?" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "weather__lookup",
            input: { city: "Singapore" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: '{"temperatureC":30}',
            is_error: false,
          },
        ],
      },
    ]);
    expect(request.thinking).toEqual({ type: "adaptive" });
    expect(request.output_config).toEqual({ effort: "low" });
  });

  it("returns native tool calls and preserves adaptive-thinking blocks as opaque replay state", () => {
    const nativeContent = [
      {
        type: "thinking",
        thinking: "private reasoning that must not become response text",
        signature: "opaque-signature",
      },
      {
        type: "text",
        text: "I will check.",
        citations: null,
      },
      {
        type: "tool_use",
        id: "toolu_1",
        name: "weather__lookup",
        input: { city: "Singapore" },
        caller: { type: "direct" },
      },
    ];
    const response = {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-opus-4-8",
      content: nativeContent,
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: {
        input_tokens: 10,
        cache_creation_input_tokens: 2,
        cache_read_input_tokens: 3,
        output_tokens: 7,
        cache_creation: {
          ephemeral_5m_input_tokens: 1,
          ephemeral_1h_input_tokens: 1,
        },
        output_tokens_details: { thinking_tokens: 4 },
      },
    } as unknown as Parameters<typeof mapAnthropicResponse>[0];

    const mapped = mapAnthropicResponse(
      response,
      { effort: "low" },
      23,
    );

    expect(mapped.text).toBe("I will check.");
    expect(mapped.text).not.toContain("private reasoning");
    expect(mapped.reasoningSummary).toBeUndefined();
    expect(mapped.toolCalls).toEqual([
      {
        id: "toolu_1",
        name: "weather.lookup",
        input: { city: "Singapore" },
      },
    ]);
    expect(mapped.finishReason).toBe("tool_calls");
    expect(mapped.usage?.reasoningTokens).toBe(4);

    const replayEnvelope = JSON.parse(mapped.reasoningContent!);
    expect(replayEnvelope).toEqual({
      provider: "anthropic",
      version: 1,
      items: nativeContent,
    });

    const replayed = mapAnthropicMessages([
      {
        role: "assistant",
        // Public content may be reconstructed by the runtime. The opaque state
        // remains authoritative so signed thinking and block order stay exact.
        content: [
          { type: "text", text: "reconstructed text" },
          {
            type: "tool_use",
            id: "toolu_1",
            name: "weather.lookup",
            input: { city: "Singapore" },
          },
        ],
        reasoningContent: mapped.reasoningContent,
      },
    ]);
    expect(replayed.messages).toEqual([
      { role: "assistant", content: nativeContent },
    ]);
  });

  it("ignores opaque replay state belonging to another provider", () => {
    const projected = mapAnthropicMessages([
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call_2",
            name: "database.query",
            input: { sql: "select 1" },
          },
        ],
        reasoningContent: JSON.stringify({
          provider: "openai",
          version: 1,
          items: [{ type: "reasoning", id: "rs_1" }],
        }),
      },
    ]);

    expect(projected.messages).toEqual([
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call_2",
            name: "database__query",
            input: { sql: "select 1" },
          },
        ],
      },
    ]);
  });

  it("rejects malformed replay state that claims to be Anthropic state", () => {
    expect(() =>
      mapAnthropicMessages([
        {
          role: "assistant",
          content: "ignored",
          reasoningContent: JSON.stringify({
            provider: "anthropic",
            version: 1,
            items: [{ type: "thinking", thinking: "missing signature" }],
          }),
        },
      ]),
    ).toThrow(/reasoning replay state is malformed/);
  });
});
