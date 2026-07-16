import { describe, expect, it } from "vitest";
import {
  extractOpenAICompatibleReasoningContent,
  mapOpenAICompatibleMessages,
} from "../../../packages/llm-gateway/src/adapters/openai-compatible";

describe("OpenRouter Chat reasoning replay", () => {
  it("captures and replays the complete reasoning_details sequence unchanged", () => {
    const reasoningDetails = [
      {
        type: "reasoning.summary",
        summary: "Checked the requested city",
        id: "reasoning-summary-1",
        format: "anthropic-claude-v1",
        index: 0,
      },
      {
        type: "reasoning.encrypted",
        data: "opaque-encrypted-state",
        id: "reasoning-encrypted-1",
        format: "anthropic-claude-v1",
        index: 1,
      },
      {
        type: "reasoning.text",
        text: "provider-visible reasoning",
        signature: "opaque-signature",
        id: "reasoning-text-1",
        format: "anthropic-claude-v1",
        index: 2,
      },
    ];

    const reasoningContent = extractOpenAICompatibleReasoningContent(
      {
        reasoning: "plaintext fallback must not replace structured state",
        reasoning_details: reasoningDetails,
      },
      "openrouter",
    );

    expect(JSON.parse(reasoningContent!)).toEqual({
      provider: "openrouter",
      api: "chat",
      items: reasoningDetails,
    });

    const wire = mapOpenAICompatibleMessages(
      [
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
          reasoningContent,
        },
      ],
      "openrouter",
    );

    expect(wire).toEqual([
      {
        role: "assistant",
        content: "",
        reasoning_details: reasoningDetails,
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

  it("uses reasoning_content for OpenRouter plaintext-only reasoning", () => {
    const reasoningContent = extractOpenAICompatibleReasoningContent(
      { reasoning: "opaque plaintext state" },
      "openrouter",
    );

    expect(
      mapOpenAICompatibleMessages(
        [
          {
            role: "assistant",
            content: "Calling a tool",
            reasoningContent,
          },
        ],
        "openrouter",
      ),
    ).toEqual([
      {
        role: "assistant",
        content: "Calling a tool",
        reasoning_content: "opaque plaintext state",
      },
    ]);
  });

  it("does not leak a Responses replay envelope into Chat reasoning_content", () => {
    const wire = mapOpenAICompatibleMessages(
      [
        {
          role: "assistant",
          content: "",
          reasoningContent: JSON.stringify({
            provider: "openrouter",
            api: "responses",
            items: [{ type: "reasoning", encrypted_content: "opaque" }],
          }),
        },
      ],
      "openrouter",
    );

    expect(wire).toEqual([{ role: "assistant", content: "" }]);
  });
});
