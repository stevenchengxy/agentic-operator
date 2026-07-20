import { describe, expect, it } from "vitest";
import type { BrainCtx } from "./brain-types";
import type { GeneratedAgentSpec } from "./spec-types";
import { FACTORY_TOOLS } from "./tools";

const codegenAgent = FACTORY_TOOLS.find((tool) => tool.name === "codegen_agent")!;

function spec(): GeneratedAgentSpec {
  return {
    key: "work",
    actionName: "doWork",
    slug: "test-do-work",
    short: "DoWork",
    domainId: "test",
    nameZh: "处理工作",
    kind: "llm",
    trigger: ["WORK_REQUESTED"],
    emit: ["WORK_DONE"],
    tools: ["allowed.read"],
    unresolvedTools: [],
    objects: [],
    systemPrompt: "按契约处理工作。",
    userPrompt: "",
    steps: [],
    ruleRefs: [],
    retries: 1,
    hitl: false,
    confidence: 1,
    promptSource: "llm",
    generatedCode: "export const old = { handler: async () => ({ old: true }) };",
    codeSource: "render",
    codeExecuted: true,
  } as GeneratedAgentSpec;
}

describe("codegen_agent generated tool allowlist", () => {
  it("does not adopt code that calls an undeclared tool", async () => {
    const existing = spec();
    const ctx = {
      specs: [existing],
      emit: () => undefined,
      lastSandbox: null,
    } as unknown as BrainCtx;
    const code = [
      "export const generated = {",
      '  name: "generated",',
      "  async handler(input: Record<string, unknown>, ctx: { tool(name: string, args: Record<string, unknown>): Promise<unknown> }) {",
      '    return ctx.tool("ghost.write", input);',
      "  },",
      "};",
    ].join("\n");
    const before = existing.generatedCode;

    const result = await codegenAgent.execute({ action: "doWork", code }, ctx);

    expect(result).toMatchObject({
      ok: false,
      output: {
        next: "ask_user",
        reason: "generated_code_tool_allowlist_mismatch",
        undeclaredTools: ["ghost.write"],
      },
    });
    expect(existing.generatedCode).toBe(before);
    expect(existing.codeSource).toBe("render");
  });

  it("keeps reviewed tool code as reference instead of bypassing durable ownership", async () => {
    const existing = spec();
    const ctx = {
      specs: [existing],
      emit: () => undefined,
      lastSandbox: null,
    } as unknown as BrainCtx;
    const code = [
      "export const generated = {",
      '  name: "generated",',
      "  async handler(input: Record<string, unknown>, ctx: { tool(name: string, args: Record<string, unknown>): Promise<unknown> }) {",
      '    return ctx.tool("allowed.read", input);',
      "  },",
      "};",
    ].join("\n");

    const result = await codegenAgent.execute({ action: "doWork", code }, ctx);

    expect(result).toMatchObject({
      ok: true,
      output: {
        codeSource: "ai",
        codeExecuted: false,
        executionOwner: "declarative-plan",
        limitation: "durable_command_protocol_pending",
        referenceCodeOnly: true,
      },
    });
    expect(existing.generatedCode).toBe(code);
    expect(existing.codeSource).toBe("ai");
    expect(existing.codeExecuted).toBe(false);
    expect(existing.probeReason).toContain("declarative-plan");
  });
});
