import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { runGeneratedCode, setRuntimeGateway, getRuntimeGateway } from "@agentic/runtime";

// #NEST — a RUNNING CodeAct agent has its own harness: it can ctx.spawn(task) to generate a
// sub-agent's handler code and run it recursively. Depth-capped so self-spawn can't loop forever.
// Sandbox-gated (tenantSlug ends in -sb), inherits the never-throw fallback invariant.

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

describe("#NEST — recursive sub-agent spawning (nested harness)", () => {
  let prev: ReturnType<typeof getRuntimeGateway>;
  beforeAll(() => {
    prev = getRuntimeGateway();
    setRuntimeGateway(fakeGateway);
  });
  afterAll(() => {
    setRuntimeGateway(prev);
  });

  it("a running agent generates + runs a sub-agent and gets its result", async () => {
    const r = await runGeneratedCode(PARENT_CODE, { x: 7 }, { tenantSlug: "demo-sb" });
    expect(r).not.toBeNull();
    expect(r!.data.spawnedOk).toBe(true);
    expect(r!.data.got).toBe(42); // the sub-agent's return threaded back to the parent
  });

  it("sub-agent emits bubble up to the parent chain", async () => {
    const r = await runGeneratedCode(PARENT_CODE, { x: 1 }, { tenantSlug: "demo-sb" });
    expect(r!.emitted.map((e) => e.event)).toContain("SUB_DONE");
  });

  it("spawned sub-agent code is CAPTURED for promotion (design_subagent{code})", async () => {
    const r = await runGeneratedCode(PARENT_CODE, { x: 5 }, { tenantSlug: "demo-sb" });
    expect(r!.spawnedSubAgents && r!.spawnedSubAgents.length).toBeTruthy();
    expect(r!.spawnedSubAgents![0]!.code).toContain("defineAgent"); // the generated sub-agent's code, promotable
  });

  it("depth cap terminates self-spawn (no infinite recursion)", async () => {
    // parent(0) → sub(1) → sub(2), where sub(2).spawn hits the cap and returns ok:false.
    const r = await runGeneratedCode(PARENT_CODE, { x: 3 }, { tenantSlug: "demo-sb" });
    expect(r).not.toBeNull(); // it completed at all == the cap prevented an infinite loop
    expect(r!.data.got).toBe(42);
  });

  it("does NOT run generated code on a non-sandbox tenant (isolation invariant)", async () => {
    const r = await runGeneratedCode(PARENT_CODE, { x: 7 }, { tenantSlug: "real-prod" });
    expect(r).toBeNull();
  });
});
