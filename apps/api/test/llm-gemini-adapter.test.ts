import { describe, expect, it } from "vitest";
import {
  mapGeminiGenerateContentRequest,
  mapGeminiGenerateContentResponse,
} from "../../../packages/llm-gateway/src/adapters/gemini";

describe("@google/genai adapter mapping", () => {
  it("preserves JSON mode, declared tools, and a structured tool-result loop", () => {
    const signal = new AbortController().signal;
    const request = mapGeminiGenerateContentRequest(
      {
        model: "gemini-3.5-flash",
        messages: [
          { role: "system", content: "Use tools when useful." },
          { role: "user", content: "Look up Singapore." },
          {
            role: "assistant",
            content: [
              { type: "text", text: "I will check." },
              {
                type: "tool_use",
                id: "call-1",
                name: "places.lookup",
                input: { city: "Singapore" },
              },
            ],
          },
          {
            role: "tool",
            content: [
              {
                type: "tool_result",
                tool_use_id: "call-1",
                content: '{"country":"Singapore"}',
              },
            ],
          },
        ],
        tools: [
          {
            name: "places.lookup",
            description: "Look up a place",
            input_schema: {
              type: "object",
              properties: { city: { type: "string" } },
              required: ["city"],
            },
          },
        ],
        jsonMode: true,
        reasoning: { effort: "low", summary: "auto" },
        signal,
      },
      "gemini-3.5-flash",
    );

    expect(request).toMatchObject({
      model: "gemini-3.5-flash",
      contents: [
        { role: "user", parts: [{ text: "Look up Singapore." }] },
        {
          role: "model",
          parts: [
            { text: "I will check." },
            {
              functionCall: {
                id: "call-1",
                name: "places.lookup",
                args: { city: "Singapore" },
              },
            },
          ],
        },
        {
          role: "user",
          parts: [
            {
              functionResponse: {
                id: "call-1",
                name: "places.lookup",
                response: { country: "Singapore" },
              },
            },
          ],
        },
      ],
      config: {
        systemInstruction: "Use tools when useful.",
        responseMimeType: "application/json",
        thinkingConfig: { thinkingLevel: "LOW", includeThoughts: true },
        tools: [
          {
            functionDeclarations: [
              {
                name: "places.lookup",
                description: "Look up a place",
                parametersJsonSchema: {
                  type: "object",
                  properties: { city: { type: "string" } },
                  required: ["city"],
                },
              },
            ],
          },
        ],
      },
    });
    expect(request.config?.abortSignal).toBe(signal);
  });

  it("rejects a tool result that cannot be paired to a prior call", () => {
    expect(() =>
      mapGeminiGenerateContentRequest(
        {
          messages: [
            {
              role: "tool",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "missing-call",
                  content: "ok",
                },
              ],
            },
          ],
        },
        "gemini-3.5-flash",
      ),
    ).toThrow(/has no preceding tool call/);
  });

  it("normalizes function calls, thought usage, cached usage, and summaries", () => {
    const response = {
      text: "I found it.",
      modelVersion: "gemini-3.5-flash-001",
      responseId: "response-1",
      functionCalls: [
        {
          id: "call-2",
          name: "places.lookup",
          args: { city: "Tokyo" },
        },
      ],
      candidates: [
        {
          finishReason: "STOP",
          content: {
            parts: [
              { thought: true, text: "A concise reasoning summary." },
              { text: "I found it." },
            ],
          },
        },
      ],
      usageMetadata: {
        promptTokenCount: 20,
        cachedContentTokenCount: 5,
        candidatesTokenCount: 7,
        thoughtsTokenCount: 3,
        totalTokenCount: 30,
      },
    } as unknown as Parameters<typeof mapGeminiGenerateContentResponse>[0];

    const mapped = mapGeminiGenerateContentResponse(
      response,
      "gemini-3.5-flash",
      { effort: "low", summary: "auto" },
      42,
    );

    expect(mapped).toMatchObject({
      text: "I found it.",
      model: "gemini-3.5-flash-001",
      providerRequestId: "response-1",
      finishReason: "tool_calls",
      latencyMs: 42,
      tokensIn: 20,
      tokensOut: 10,
      usage: {
        inputTokens: 20,
        outputTokens: 10,
        totalTokens: 30,
        cachedInputTokens: 5,
        reasoningTokens: 3,
      },
      reasoningSummary: "A concise reasoning summary.",
      toolCalls: [
        {
          id: "call-2",
          name: "places.lookup",
          input: { city: "Tokyo" },
        },
      ],
    });
  });
});
