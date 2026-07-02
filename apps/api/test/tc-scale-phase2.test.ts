import { describe, it, expect } from "vitest";
import { setFanoutBridge, publish, subscribe, runWithTraceContext, getTraceContext, type FanoutBridge } from "@agentic/runtime";
import { DrizzleToolStatsStore } from "../src/services/agent-factory/stores";
import { rankRealTools } from "@agentic/agent-factory";

// #SCALE — Phase-2 substrates behind config flips: fanout bridge, ALS tracing, tool-stats demotion.

describe("#SCALE-FANOUT bridge", () => {
  it("mirrors publishes to the bridge and delivers remote events to local subscribers (no loop)", () => {
    const bridged: unknown[] = [];
    let remote: ((e: unknown) => void) | null = null;
    const bridge: FanoutBridge = { publish: (e) => bridged.push(e), onRemote: (cb) => { remote = cb; } };
    setFanoutBridge(bridge);
    const got: unknown[] = [];
    const un = subscribe("ten-x", (e) => got.push(e));
    publish({ type: "run.started", tenantId: "ten-x", at: 1, runId: "r1" } as never);
    expect(bridged.length).toBe(1); // mirrored out
    expect(got.length).toBe(1); // delivered locally
    remote!({ type: "run.started", tenantId: "ten-x", at: 2, runId: "r2" }); // a remote instance's event
    expect(got.length).toBe(2); // delivered locally
    expect(bridged.length).toBe(1); // NOT re-mirrored (no loop)
    un();
    setFanoutBridge(null);
  });
});

describe("#SCALE-TRACE ambient context", () => {
  it("propagates through the async path and is null outside", async () => {
    expect(getTraceContext()).toBeNull();
    const seen = await runWithTraceContext({ correlationId: "c9", agentName: "A", tenantSlug: "t", runId: "r" }, async () => {
      await new Promise((r) => setTimeout(r, 1));
      return getTraceContext();
    });
    expect(seen?.correlationId).toBe("c9");
    expect(getTraceContext()).toBeNull();
  });
});

describe("#SCALE-TOOLS empirical demotion", () => {
  it("records stats and rankRealTools demotes a <70% tool with >=3 invocations", async () => {
    const store = new DrizzleToolStatsStore();
    const name = `probe.flaky-${Math.floor(Date.now() % 1e9)}`;
    await store.record(name, false); await store.record(name, false); await store.record(name, true);
    const rates = await store.successRates();
    expect(rates[name]).toEqual({ invoked: 3, succeeded: 1 });
    const action = { id: "a", name: "flaky probe call", actor: ["Agent"], trigger: [], triggered_event: [], target_objects: [], tool_use: [], system_prompt: "", user_prompt: "", inputs: [], outputs: [] } as never;
    const tools = [{ name, summary: "flaky probe call helper", successRate: 1 / 3, invoked: 3 }, { name: "probe.stable", summary: "flaky probe call helper", successRate: 1, invoked: 5 }];
    const ranked = rankRealTools(action, tools as never);
    expect(ranked).not.toContain(name); // demoted
    expect(ranked).toContain("probe.stable");
  });
});
