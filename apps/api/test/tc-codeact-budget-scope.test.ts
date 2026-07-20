import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  getRuntimeGateway,
  runGeneratedCodeIsolated as executeGeneratedCode,
  setRuntimeGateway,
} from "@agentic/runtime";
import type { ChatRequest, LLMGateway } from "@agentic/llm-gateway";
import { codeActContainerTestOptions } from "./codeact-container-test-transport";

function runGeneratedCodeIsolated(
  code: string,
  input: Record<string, unknown>,
  options: Parameters<typeof executeGeneratedCode>[2] = {},
) {
  return executeGeneratedCode(code, input, {
    ...options,
    ...codeActContainerTestOptions(),
  });
}

const REASON_CODE = `
export const reasoner = defineAgent({
  name: "reasoner",
  async handler(input, ctx) {
    const decision = await ctx.reason("decide", input);
    return { decision };
  },
});
`;

const SPAWN_CODE = `
export const parent = defineAgent({
  name: "parent",
  async handler(input, ctx) {
    const child = await ctx.spawn("make a child", input);
    return { spawned: child.ok, error: child.error ?? null };
  },
});
`;

const CHILD_CODE = `
export const child = defineAgent({
  name: "child",
  async handler(input) { return { child: true, input }; },
});
`;

describe.sequential("CodeAct LLM budget scope", () => {
  let previous: ReturnType<typeof getRuntimeGateway>;
  const previousGenerated = process.env.FACTORY_EXEC_GENERATED;
  const calls: ChatRequest[] = [];
  const gateway = {
    async chat(request: ChatRequest) {
      calls.push(request);
      const spawning = request.messages.some(
        (message) =>
          typeof message.content === "string" &&
          message.content.includes("子任务"),
      );
      return {
        text: spawning ? CHILD_CODE : JSON.stringify({ accepted: true }),
        provider: "custom" as const,
        model: "codeact-budget-test",
        tokensIn: 2,
        tokensOut: 2,
        finishReason: "stop" as const,
        latencyMs: 1,
      };
    },
  } as unknown as LLMGateway;

  beforeAll(() => {
    previous = getRuntimeGateway();
    setRuntimeGateway(gateway);
    process.env.FACTORY_EXEC_GENERATED = "1";
  });

  afterAll(() => {
    setRuntimeGateway(previous as LLMGateway);
    if (previousGenerated === undefined) delete process.env.FACTORY_EXEC_GENERATED;
    else process.env.FACTORY_EXEC_GENERATED = previousGenerated;
  });

  it("threads both tenant id and slug through default reason RPC", async () => {
    calls.length = 0;
    const result = await runGeneratedCodeIsolated(
      REASON_CODE,
      { value: 7 },
      {
        tenantSlug: "budget-sb",
        tenantId: "ten-budget-real",
        agentName: "budget-agent",
      },
    );

    expect(result).toMatchObject({
      ok: true,
      data: { decision: { accepted: true } },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      tenantSlug: "budget-sb",
      tenantId: "ten-budget-real",
      purpose: "agent:budget-agent/codeact:reason",
    });
  });

  it("refuses unscoped default reason before touching the gateway", async () => {
    calls.length = 0;
    const result = await runGeneratedCodeIsolated(
      REASON_CODE,
      { value: 7 },
      { tenantSlug: "budget-sb" },
    );

    expect(result).toMatchObject({ ok: false, failure: "rpc_failed" });
    if (!result.ok) expect(result.error).toContain("requires tenantId");
    expect(calls).toHaveLength(0);
  });

  it("keeps the same id/slug scope for reviewed spawned sub-agents", async () => {
    calls.length = 0;
    const result = await runGeneratedCodeIsolated(
      SPAWN_CODE,
      { value: 9 },
      { tenantSlug: "budget-sb", tenantId: "ten-budget-real" },
    );

    expect(result).toMatchObject({ ok: true, data: { spawned: true } });
    expect(calls.length).toBeGreaterThanOrEqual(1);
    for (const request of calls) {
      expect(request).toMatchObject({
        tenantSlug: "budget-sb",
        tenantId: "ten-budget-real",
      });
    }
  });
});
