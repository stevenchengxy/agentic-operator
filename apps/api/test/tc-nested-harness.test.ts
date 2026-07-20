import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { runGeneratedCode, setRuntimeGateway, getRuntimeGateway } from "@agentic/runtime";
import { codeActContainerTestOptions } from "./codeact-container-test-transport";

// #NEST — a RUNNING CodeAct agent has its own harness: it can ctx.spawn(task) to generate a
// sub-agent's handler code and run it recursively. Depth-capped so self-spawn can't loop forever.
// Sandbox-gated with a nonce-bearing Factory tenant identity, and inherits the
// never-throw fallback invariant. Durable attempt authorization is covered at
// the registration/dispatch boundary; this is an executor-kernel test.

// A sub-agent that emits + returns a fixed result, and tries to spawn ONE level deeper (to exercise
// the depth cap without an infinite loop).
const SUBAGENT_CODE = `
export const subAgent = defineAgent({
  name: "sub",
  async handler(input, ctx) {
    const deeper = await ctx.spawn("go deeper", input);
    ctx.emit("SUB_DONE", { from: "sub" });
    return { subResult: 42, echo: input && input.x, deeperOk: deeper.ok, deeperErr: deeper.error || null };
  }
});
`;

// The parent agent spawns a sub-agent and surfaces its result.
const PARENT_CODE = `
export const parentAgent = defineAgent({
  name: "parent",
  async handler(input, ctx) {
    const r = await ctx.spawn("summarize the input into a sub result", { x: input.x });
    return { got: r.ok ? r.data.subResult : null, spawnedOk: r.ok, subEmits: (r.emitted || []).map((e) => e.event) };
  }
});
`;

// Fake gateway: any chat() (used by generateSubAgentCode) returns the sub-agent code.
const fakeGateway = {
  async chat() {
    return { text: SUBAGENT_CODE };
  },
} as unknown as Parameters<typeof setRuntimeGateway>[0];

describe.sequential("#NEST — recursive sub-agent spawning (nested harness)", () => {
  const sandboxScope = {
    tenantSlug: "af-sbx-ae57ed00-7e57c0de-123456789abc-sb",
    tenantId: "ten-nested-harness-sandbox",
    factoryExecutionScope: {
      kind: "sandbox" as const,
      target_domain_id: "Agents-generation",
      candidate_fingerprint: "candidate:nested-harness",
      attempt_id: "ae57ed00-7e57-4c0d-a123-123456789abc",
    },
  };
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

  function executeInFactorySandbox(code: string, input: Record<string, unknown>) {
    return runGeneratedCode(code, input, {
      ...sandboxScope,
      ...codeActContainerTestOptions(),
    });
  }

  it("a running agent generates + runs a sub-agent and gets its result", async () => {
    const r = await executeInFactorySandbox(PARENT_CODE, { x: 7 });
    expect(r).not.toBeNull();
    expect(r!.data.spawnedOk).toBe(true);
    expect(r!.data.got).toBe(42); // the sub-agent's return threaded back to the parent
  });

  it("sub-agent emits bubble up to the parent chain", async () => {
    const r = await executeInFactorySandbox(PARENT_CODE, { x: 1 });
    expect(r!.emitted.map((e) => e.event)).toContain("SUB_DONE");
  });

  it("spawned sub-agent code is CAPTURED for promotion (design_subagent{code})", async () => {
    const r = await executeInFactorySandbox(PARENT_CODE, { x: 5 });
    expect(r!.spawnedSubAgents && r!.spawnedSubAgents.length).toBeTruthy();
    expect(r!.spawnedSubAgents![0]!.code).toContain("defineAgent"); // the generated sub-agent's code, promotable
  });

  it("depth cap terminates self-spawn (no infinite recursion)", async () => {
    // parent(0) → sub(1) → sub(2), where sub(2).spawn hits the cap and returns ok:false.
    const r = await executeInFactorySandbox(PARENT_CODE, { x: 3 });
    expect(r).not.toBeNull(); // it completed at all == the cap prevented an infinite loop
    expect(r!.data.got).toBe(42);
  });

  it("does NOT run generated code on a non-sandbox tenant (isolation invariant)", async () => {
    const r = await runGeneratedCode(PARENT_CODE, { x: 7 }, {
      tenantSlug: "real-prod",
      tenantId: "ten-real-prod",
      ...codeActContainerTestOptions(),
    });
    expect(r).toBeNull();
  });
});
