import { describe, it, expect } from "vitest";
import { FACTORY_TOOLS } from "./tools";
import type { BrainCtx } from "./brain-types";

// #A — in-loop deliberation: refine budget (per-agent + global) forces the brain to step UP a
// level instead of grinding; review_agent's deterministic pass still works without a gateway.
const refineAgent = FACTORY_TOOLS.find((t) => t.name === "refine_agent")!;
const reviewAgent = FACTORY_TOOLS.find((t) => t.name === "review_agent")!;

const mk = (specs: unknown[], attemptHistory: Record<string, unknown[]>): BrainCtx =>
  ({ specs, attemptHistory, ontology: { rules: [] } }) as unknown as BrainCtx;

describe("refine_agent budget (#A)", () => {
  it("refuses + steers when a single agent hits the per-agent refine budget", async () => {
    const ctx = mk([{ actionName: "A", nameZh: "A", tools: [], systemPrompt: "x" }], { A: [{}, {}, {}, {}] }); // 4 == default budget
    const r = await refineAgent.execute({ action: "A", critique: "again", system_prompt: "new" }, ctx);
    expect(r.ok).toBe(false);
    expect(r.summary).toContain("重试上限");
    expect((r.output as { advice?: string }).advice).toBe("revert_or_verify_or_replan");
  });

  it("refuses cross-agent churn when the GLOBAL cap is hit", async () => {
    // 2 specs → globalCap = 3*2 = 6; A has 3 (< per-agent 4) but total = 6 == cap.
    const ctx = mk(
      [{ actionName: "A", nameZh: "A", tools: [], systemPrompt: "x" }, { actionName: "B", nameZh: "B", tools: [], systemPrompt: "y" }],
      { A: [{}, {}, {}], B: [{}, {}, {}] },
    );
    const r = await refineAgent.execute({ action: "A", critique: "again", system_prompt: "new" }, ctx);
    expect(r.ok).toBe(false);
    expect(r.summary).toContain("全域已累计");
    expect((r.output as { advice?: string }).advice).toBe("stop_churn_verify_or_analyze");
  });
});

describe("review_agent (#A — deterministic tier works without a gateway)", () => {
  it("passes a clean non-gate agent and surfaces no LLM-judge findings offline", async () => {
    const ctx = mk([{ actionName: "ProcessThing", nameZh: "处理", systemPrompt: "做这件事，按职责处理事件。", tools: [], decisionLogic: "" }], {});
    const r = await reviewAgent.execute({}, ctx);
    expect(r.ok).toBe(true);
    expect((r.output as { judge?: string[] }).judge).toEqual([]);
  });
  it("flags an empty prompt deterministically", async () => {
    const ctx = mk([{ actionName: "Empty", nameZh: "空", systemPrompt: "   ", tools: [], decisionLogic: "" }], {});
    const r = await reviewAgent.execute({}, ctx);
    expect(r.ok).toBe(false);
    expect((r.output as { deterministic: string[] }).deterministic.some((f) => f.includes("prompt 为空"))).toBe(true);
  });
});
