/**
 * W0 — raw per-turn LLM capture in the manifest step engine.
 *
 * Drives `runAction()` (the manifest `logic` path) directly with a programmable
 * mock runtime gateway (same bypass-Inngest approach as tc-10) and asserts the
 * step's `meta.turns` carries, per tool-use-loop turn:
 *   - response text + extracted reasoning (from provider-native `raw.thinking`)
 *   - the tools the model requested (name + input)
 *   - provider / model / tokens / finishReason / latency
 *   - a bounded prompt preview, only on the first turn.
 *
 * This is the capture half of W0; the register.ts persistence to `llm_turns` is
 * exercised end-to-end by a live manifest run.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { z } from "zod";
import { runAction, setRuntimeGateway } from "@agentic/runtime";

interface InlinePrompt {
  readonly kind: "prompt";
  readonly name: string;
  readonly system?: string;
  template: (ctx: unknown) => string;
  readonly output?: z.ZodType<unknown>;
}
function definePrompt(p: Omit<InlinePrompt, "kind">): InlinePrompt {
  return { kind: "prompt", ...p };
}

interface TurnTrace {
  ord: number;
  promptPreview?: string | null;
  responseText: string | null;
  reasoning: string | null;
  toolCalls: Array<{ name: string; input: unknown }>;
  provider: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  finishReason: string;
  latencyMs: number;
}

const queue: unknown[] = [];
const gw = {
  chat: async () => {
    const next = queue.shift();
    if (!next) throw new Error("[w0-mock-gateway] queue empty");
    return next;
  },
} as unknown as Parameters<typeof setRuntimeGateway>[0];

beforeAll(() => {
  setRuntimeGateway(gw);
});

describe("W0: raw per-turn LLM capture (meta.turns)", () => {
  it("captures response text, reasoning, and tool calls across a 2-turn loop", async () => {
    queue.length = 0;
    // Turn 0: model thinks (raw), then requests a tool.
    queue.push({
      text: "let me check the weather",
      provider: "mock",
      model: "mock-model-v7",
      tokensIn: 10,
      tokensOut: 5,
      finishReason: "tool_calls",
      latencyMs: 3,
      toolCalls: [{ id: "c1", name: "echoTool", input: { q: "hi" } }],
      raw: {
        content: [
          { type: "thinking", thinking: "I should call echoTool to answer" },
          { type: "text", text: "let me check the weather" },
        ],
      },
    });
    // Turn 1: final prose, no tools, no reasoning.
    queue.push({
      text: "final answer",
      provider: "mock",
      model: "mock-model-v7",
      tokensIn: 20,
      tokensOut: 8,
      finishReason: "stop",
      latencyMs: 2,
    });

    const echoTool = {
      name: "echoTool",
      description: "echo",
      handler: async () => ({ data: { echoed: true } }),
    };
    const prompt = definePrompt({ name: "act", template: () => "user body here" });

    const out = await runAction({
      ctx: {
        agentName: "a",
        actionName: "act",
        correlationId: "cor-w0",
        tenantSlug: "raas",
        event: { name: "X", data: {} },
        lastResult: null,
      },
      action: { order: "1", name: "act", description: "", type: "logic" },
      agent: {
        name: "a",
        tool_use: [
          { name: "echoTool", input_schema: { type: "object" } },
        ],
      },
      tenantRegistry: {
        prompts: { act: prompt },
        tools: { echoTool } as never,
      },
    });

    expect(out.ok).toBe(true);
    const turns = (out.meta as { turns?: TurnTrace[] }).turns;
    expect(Array.isArray(turns)).toBe(true);
    expect(turns).toHaveLength(2);

    const t0 = turns![0]!;
    expect(t0.ord).toBe(0);
    expect(t0.responseText).toBe("let me check the weather");
    expect(t0.reasoning).toContain("echoTool"); // extracted from raw.thinking
    expect(t0.toolCalls).toEqual([{ name: "echoTool", input: { q: "hi" } }]);
    expect(typeof t0.promptPreview).toBe("string"); // first turn carries the prompt
    expect(t0.promptPreview).toContain("user body here");
    expect(t0.provider).toBe("mock");
    expect(t0.model).toBe("mock-model-v7");
    expect(t0.finishReason).toBe("tool_calls");
    expect(t0.latencyMs).toBe(3);

    const t1 = turns![1]!;
    expect(t1.ord).toBe(1);
    expect(t1.responseText).toBe("final answer");
    expect(t1.reasoning).toBeNull();
    expect(t1.toolCalls).toEqual([]);
    expect(t1.promptPreview == null).toBe(true); // later turns omit the prompt
  });

  it("bounds oversized response text with a truncation marker", async () => {
    queue.length = 0;
    const huge = "x".repeat(20000);
    queue.push({
      text: huge,
      provider: "mock",
      model: "mock-model-v7",
      tokensIn: 1,
      tokensOut: 1,
      finishReason: "stop",
      latencyMs: 1,
    });
    const prompt = definePrompt({ name: "act", template: () => "body" });
    const out = await runAction({
      ctx: {
        agentName: "a",
        actionName: "act",
        correlationId: "cor-w0b",
        tenantSlug: "raas",
        event: { name: "X", data: {} },
        lastResult: null,
      },
      action: { order: "1", name: "act", description: "", type: "logic" },
      agent: { name: "a" },
      tenantRegistry: { prompts: { act: prompt } },
    });
    const turns = (out.meta as { turns?: TurnTrace[] }).turns!;
    expect(turns[0]!.responseText!.length).toBeLessThan(huge.length);
    expect(turns[0]!.responseText).toContain("[+");
  });
});
