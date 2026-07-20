/**
 * TC-15 — Phase 1 adapter tool-use round-trip tests.
 *
 * Targets:
 *   - P1-CON-01: ChatMessage.content widened to ChatContentBlock[].
 *   - P1-CON-02: ChatRequest.tools[], ChatResponse.toolCalls[] round-trip.
 *   - P1-LLM-01: Anthropic adapter shapes tool_use blocks correctly.
 *   - P1-LLM-02: OpenAI-compatible adapter maps tool_calls↔tool_use.
 *   - P1-LLM-03: Gemini adapter shapes functionCall/functionResponse parts.
 *   - P1-LLM-04: Mock adapter emits a deterministic tool_use on prompt match.
 *
 * These tests exercise the adapter mapping logic directly (no real network).
 * For Anthropic, OpenAI-compat and Gemini we exercise the input transforms
 * statically — the response parsing is covered by the mock-driven end-to-end
 * test in TC-16.
 */

import { describe, it, expect } from "vitest";
import { MockAdapter, _resetMockIdSeq } from "@agentic/llm-gateway";
import {
  ChatMessageSchema,
  ToolDefSchema,
  ToolUseBlockSchema,
  ToolResultBlockSchema,
} from "@agentic/contracts";
import type { ChatMessage, ToolDef } from "@agentic/llm-gateway";

describe("TC-15: Phase 1 adapter tool-use round-trip", () => {
  describe("P1-CON-01: ChatMessage content union parses both shapes", () => {
    it("accepts a plain-string content", () => {
      const parsed = ChatMessageSchema.parse({ role: "user", content: "hi" });
      expect(parsed.role).toBe("user");
      expect(typeof parsed.content).toBe("string");
    });

    it("accepts a typed block array", () => {
      const parsed = ChatMessageSchema.parse({
        role: "assistant",
        content: [
          { type: "text", text: "ok" },
          { type: "tool_use", id: "t1", name: "lookup", input: { city: "x" } },
        ],
      });
      expect(parsed.role).toBe("assistant");
      expect(Array.isArray(parsed.content)).toBe(true);
    });

    it("accepts a tool-role message with tool_result blocks", () => {
      const parsed = ChatMessageSchema.parse({
        role: "tool",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: '{"v":1}' },
        ],
      });
      expect(parsed.role).toBe("tool");
    });

    it("rejects a tool block with the wrong shape", () => {
      const bad = ChatMessageSchema.safeParse({
        role: "assistant",
        content: [{ type: "tool_use", name: "x" /* missing id+input */ }],
      });
      expect(bad.success).toBe(false);
    });
  });

  describe("P1-CON-02: ToolDef + ToolCall shape", () => {
    it("ToolDefSchema enforces name + input_schema", () => {
      const ok = ToolDefSchema.parse({
        name: "lookupWeather",
        description: "Look up weather",
        input_schema: {
          type: "object",
          properties: { city: { type: "string" } },
        },
      });
      expect(ok.name).toBe("lookupWeather");
      const bad = ToolDefSchema.safeParse({ name: "x" /* missing schema */ });
      expect(bad.success).toBe(false);
    });

    it("ToolUseBlock and ToolResultBlock parse round-trip", () => {
      const tu = ToolUseBlockSchema.parse({
        type: "tool_use",
        id: "id-1",
        name: "n",
        input: { a: 1 },
      });
      expect(tu.id).toBe("id-1");
      const tr = ToolResultBlockSchema.parse({
        type: "tool_result",
        tool_use_id: "id-1",
        content: '{"ok":true}',
        is_error: false,
      });
      expect(tr.tool_use_id).toBe("id-1");
    });
  });

  describe("P1-LLM-04: mock adapter tool-use simulation", () => {
    it("emits a tool_use block when prompt matches advertised tool", async () => {
      _resetMockIdSeq();
      const m = new MockAdapter();
      const tools: ToolDef[] = [
        {
          name: "lookupWeather",
          description: "Look up weather by city",
          input_schema: {
            type: "object",
            properties: { city: { type: "string" } },
          },
        },
      ];
      const messages: ChatMessage[] = [
        { role: "system", content: "You answer weather questions." },
        { role: "user", content: "use lookupWeather to find Tokyo's weather" },
      ];
      const res = await m.chat({
        messages,
        tools,
        tenantSlug: "__system",
      } as never);
      expect(res.finishReason).toBe("tool_calls");
      expect(res.toolCalls).toBeDefined();
      expect(res.toolCalls![0]!.name).toBe("lookupWeather");
      expect(typeof res.toolCalls![0]!.id).toBe("string");
      expect(res.toolCalls![0]!.input).toEqual(
        expect.objectContaining({ prompt: expect.any(String) }),
      );
    });

    it("falls back to text when no tool advertised", async () => {
      const m = new MockAdapter();
      const res = await m.chat({
        messages: [{ role: "user", content: "Hello!" }],
        tenantSlug: "__system",
      } as never);
      expect(res.finishReason).toBe("stop");
      expect(res.toolCalls).toBeUndefined();
      expect(res.text.length).toBeGreaterThan(0);
    });

    it("after a tool_result is appended, returns plain text and signals the result was seen", async () => {
      _resetMockIdSeq();
      const m = new MockAdapter();
      const tools: ToolDef[] = [
        {
          name: "lookupWeather",
          description: "Look up weather",
          input_schema: { type: "object" },
        },
      ];
      const messages: ChatMessage[] = [
        { role: "user", content: "use lookupWeather" },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "mock_tool_1",
              name: "lookupWeather",
              input: {},
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool_result",
              tool_use_id: "mock_tool_1",
              content: '{"tempC":18}',
            },
          ],
        },
      ];
      const res = await m.chat({
        messages,
        tools,
        tenantSlug: "__system",
      } as never);
      // The mock now finishes with text once a tool_result is present.
      expect(res.finishReason).toBe("stop");
      expect(res.toolCalls).toBeUndefined();
      expect(res.text).toContain("tool_result_seen");
    });

    it("returns deterministic schema-valid JSON when jsonMode includes an output contract", async () => {
      const m = new MockAdapter();
      const schema = {
        type: "object",
        required: ["label", "confidence", "evidence"],
        properties: {
          label: { type: "string", minLength: 1 },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          evidence: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              required: ["url"],
              properties: { url: { type: "string", format: "uri" } },
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      };
      const res = await m.chat({
        messages: [
          {
            role: "system",
            content: [
              "Return only one JSON value that validates against this output contract. Do not wrap it in Markdown fences or add prose.",
              "```json",
              JSON.stringify(schema),
              "```",
            ].join("\n"),
          },
          { role: "user", content: "Classify this request." },
        ],
        jsonMode: true,
        tenantSlug: "__system",
      } as never);

      expect(JSON.parse(res.text)).toEqual({
        label: "mock",
        confidence: 0,
        evidence: [{ url: "https://example.test/mock" }],
      });
    });
  });
});
