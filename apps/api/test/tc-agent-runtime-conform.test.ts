import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { runGeneratedCode, setRuntimeGateway, getRuntimeGateway } from "@agentic/runtime";
import { codeActContainerTestOptions } from "./codeact-container-test-transport";

const FACTORY_SANDBOX = {
  tenantSlug: "af-sbx-c0f0aace-7e57c0de-123456789abc-sb",
  tenantId: "ten-runtime-conformance-sandbox",
  factoryExecutionScope: {
    kind: "sandbox" as const,
    target_domain_id: "Agents-generation",
    candidate_fingerprint: "candidate:runtime-conformance",
    attempt_id: "c0f0aace-7e57-4c0d-a123-123456789abc",
  },
};

// Low-level executor-kernel fixture only. API/register tests own the durable
// sandbox-attempt authorization boundary.

// #REDESIGN P2 — the CodeAct (runtime) adapter provides the UNIFIED AgentRuntime socket: a generated
// handler receives identity + reason/tool/emit/memory/invoke/spawn/log, uniform with the delivered
// tier. This proves the runtime adapter plugs into the power-strip.

const CONFORM_CODE = [
  'export const conform = defineAgent({',
  '  name: "conform",',
  '  async handler(input, ctx) {',
  '    await ctx.memory.put("k", 42);',
  '    const memV = await ctx.memory.get("k");',
  '    const searchEmpty = (await ctx.memory.search("q", 3)).length === 0;',
  '    ctx.log("info", "conformance check");',
  '    const hasSocket = ['
    + 'typeof ctx.reason, typeof ctx.tool, typeof ctx.emit, typeof ctx.invoke,'
    + 'typeof ctx.spawn, typeof ctx.log].every((t) => t === "function")'
    + ' && !!ctx.memory && typeof ctx.agentName === "string" && typeof ctx.tenantSlug === "string";',
  '    return { hasSocket, memV, searchEmpty, agentName: ctx.agentName, tenant: ctx.tenantSlug, corr: ctx.correlationId };',
  '  }',
  '});',
].join("\n");

const fakeGateway = { async chat() { return { text: "{}" }; } } as unknown as Parameters<typeof setRuntimeGateway>[0];

describe.sequential("#REDESIGN P2 — CodeAct adapter provides a valid AgentRuntime socket", () => {
  let prev: ReturnType<typeof getRuntimeGateway>;
  const previousGenerated = process.env.FACTORY_EXEC_GENERATED;
  beforeAll(() => {
    prev = getRuntimeGateway();
    setRuntimeGateway(fakeGateway);
    process.env.FACTORY_EXEC_GENERATED = "1";
  });
  afterAll(() => {
    setRuntimeGateway(prev);
    if (previousGenerated === undefined) delete process.env.FACTORY_EXEC_GENERATED;
    else process.env.FACTORY_EXEC_GENERATED = previousGenerated;
  });

  it("a generated handler receives the full unified ctx (identity + memory + capabilities)", async () => {
    const r = await runGeneratedCode(CONFORM_CODE, { x: 1 }, {
      ...FACTORY_SANDBOX,
      ...codeActContainerTestOptions(),
    });
    expect(r).not.toBeNull();
    expect(r!.data.hasSocket).toBe(true);
    expect(r!.data.memV).toBe(42);            // real in-process sandbox memory
    expect(r!.data.searchEmpty).toBe(true);   // honest empty (ephemeral scope isn't vector-indexed)
    expect(r!.data.agentName).toBe("codeact");
    expect(r!.data.tenant).toBe(FACTORY_SANDBOX.tenantSlug);
    expect(r!.data.corr).toBe("sandbox");
  });
});
