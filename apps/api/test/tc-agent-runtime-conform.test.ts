import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { runGeneratedCode, setRuntimeGateway, getRuntimeGateway } from "@agentic/runtime";

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

describe("#REDESIGN P2 — CodeAct adapter provides a valid AgentRuntime socket", () => {
  let prev: ReturnType<typeof getRuntimeGateway>;
  beforeAll(() => { prev = getRuntimeGateway(); setRuntimeGateway(fakeGateway); });
  afterAll(() => { setRuntimeGateway(prev); });

  it("a generated handler receives the full unified ctx (identity + memory + capabilities)", async () => {
    const r = await runGeneratedCode(CONFORM_CODE, { x: 1 }, { tenantSlug: "conform-sb" });
    expect(r).not.toBeNull();
    expect(r!.data.hasSocket).toBe(true);
    expect(r!.data.memV).toBe(42);            // real in-process sandbox memory
    expect(r!.data.searchEmpty).toBe(true);   // honest empty (ephemeral scope isn't vector-indexed)
    expect(r!.data.agentName).toBe("codeact");
    expect(r!.data.tenant).toBe("conform-sb");
    expect(r!.data.corr).toBe("sandbox");
  });
});
