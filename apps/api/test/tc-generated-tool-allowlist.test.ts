import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  getRuntimeGateway,
  runAction,
  setRuntimeGateway,
} from "@agentic/runtime";
import type { LLMGateway } from "@agentic/llm-gateway";

type Reply = {
  text: string;
  toolCalls?: Array<{
    id: string;
    name: string;
    input: Record<string, unknown>;
  }>;
};

const replies: Reply[] = [];
let previousGateway: LLMGateway | null = null;

const gateway = {
  async chat() {
    const reply = replies.shift();
    if (!reply) throw new Error("test gateway reply queue is empty");
    return {
      ...reply,
      provider: "custom" as const,
      model: "generated-tool-allowlist-test",
      tokensIn: 1,
      tokensOut: 1,
      finishReason: reply.toolCalls?.length ? "tool_calls" as const : "stop" as const,
      latencyMs: 1,
    };
  },
} as unknown as LLMGateway;

const prompt = {
  kind: "prompt" as const,
  name: "handwritten",
  template: () => "run the hand-written agent",
};

beforeAll(() => {
  previousGateway = getRuntimeGateway();
  setRuntimeGateway(gateway);
});

afterAll(() => {
  setRuntimeGateway(previousGateway as LLMGateway);
});

beforeEach(() => {
  replies.length = 0;
});

describe("generated Agent runtime tool allowlist", () => {
  it("rejects a declarative LLM tool call outside agent.tool_use without invoking it", async () => {
    replies.push({
      text: "",
      toolCalls: [{ id: "forbidden-1", name: "meta.ping", input: {} }],
    });

    const output = await runAction({
      ctx: {
        agentName: "generated-rules",
        actionName: "checkRules",
        correlationId: "allowlist-declarative-deny",
        tenantSlug: "allowlist-sb",
        event: { name: "START", data: {} },
      },
      action: {
        order: "1",
        name: "checkRules",
        description: "check rules",
        type: "logic",
      },
      agent: {
        name: "generated-rules",
        generated: true,
        tool_use: [{ name: "ontology.fetchActionRules" }],
      },
    });

    expect(output).toMatchObject({
      ok: false,
      meta: {
        error: "llm_incomplete",
        message: expect.stringContaining("generated_tool_not_declared"),
        toolCalls: [],
      },
    });
    expect(String(output.meta?.message)).toContain("meta.ping");
  });

  it("executes a declarative tool call when agent.tool_use declares it", async () => {
    replies.push(
      {
        text: "",
        toolCalls: [{ id: "allowed-1", name: "meta.ping", input: {} }],
      },
      { text: "done" },
    );

    const output = await runAction({
      ctx: {
        agentName: "generated-ping",
        actionName: "ping",
        correlationId: "allowlist-declarative-allow",
        tenantSlug: "allowlist-sb",
        event: { name: "START", data: {} },
      },
      action: {
        order: "1",
        name: "ping",
        description: "ping",
        type: "logic",
      },
      agent: {
        name: "generated-ping",
        generated: true,
        tool_use: [{ name: "meta.ping" }],
      },
    });

    expect(output.ok).toBe(true);
    expect(output.meta?.toolCalls).toEqual([
      expect.objectContaining({ name: "meta.ping", isError: false }),
    ]);
  });

  it("does not change the legacy resolution behaviour of hand-written agents", async () => {
    // A provider should not normally request an unadvertised tool. This pins
    // the compatibility boundary explicitly: the new strict check is scoped
    // to generated:true and does not silently change existing tenant code.
    replies.push(
      {
        text: "",
        toolCalls: [{ id: "legacy-1", name: "meta.ping", input: {} }],
      },
      { text: "done" },
    );

    const output = await runAction({
      ctx: {
        agentName: "handwritten-agent",
        actionName: "handwritten",
        correlationId: "allowlist-handwritten-compatible",
        tenantSlug: "legacy-tenant",
        event: { name: "START", data: {} },
      },
      action: {
        order: "1",
        name: "handwritten",
        description: "legacy hand-written prompt",
        type: "logic",
      },
      agent: { name: "handwritten-agent" },
      tenantRegistry: { prompts: { handwritten: prompt } },
    });

    expect(output.ok).toBe(true);
    expect(output.meta?.toolCalls).toEqual([
      expect.objectContaining({ name: "meta.ping", isError: false }),
    ]);
  });

  it("rejects a direct generated plan tool step outside agent.tool_use", async () => {
    const output = await runAction({
      ctx: {
        agentName: "generated-plan",
        actionName: "meta.ping",
        correlationId: "allowlist-plan-deny",
        tenantSlug: "allowlist-sb",
        event: { name: "START", data: {} },
      },
      action: {
        order: "1",
        name: "meta.ping",
        description: "undeclared plan tool",
        type: "tool",
      },
      agent: { name: "generated-plan", generated: true, tool_use: [] },
    });

    expect(output).toMatchObject({
      ok: false,
      meta: { error: "generated_tool_not_declared", tool: "meta.ping" },
    });
  });
});
