import { describe, it, expect } from "vitest";
import { modelChain, tierForContext } from "./model-router";
import { runDigest, scoreRounds } from "./run-analysis";
import type { BrainEvent } from "./brain-types";

// #7 — config-driven tiered model routing with fallback chains.
describe("modelChain (#7 — no hardcoded model ids)", () => {
  const base = { FACTORY_AI_MODEL: "base/model" };

  it("falls back to the base model when a tier is unset", () => {
    expect(modelChain("fast", base)).toEqual(["base/model"]);
    expect(modelChain("hard", base)).toEqual(["base/model"]);
  });

  it("parses a comma-separated chain and appends the base as the ultimate fallback", () => {
    const env = { ...base, FACTORY_MODEL_HARD: "a/x, b/y" };
    expect(modelChain("hard", env)).toEqual(["a/x", "b/y", "base/model"]);
  });

  it("dedupes when the chain already contains the base model", () => {
    const env = { ...base, FACTORY_MODEL_FAST: "base/model, fast/one" };
    expect(modelChain("fast", env)).toEqual(["base/model", "fast/one"]);
  });

  it("routes each tier from its own env var independently", () => {
    const env = { ...base, FACTORY_MODEL_FAST: "f/1", FACTORY_MODEL_DEFAULT: "d/1", FACTORY_MODEL_HARD: "h/1" };
    expect(modelChain("fast", env)[0]).toBe("f/1");
    expect(modelChain("default", env)[0]).toBe("d/1");
    expect(modelChain("hard", env)[0]).toBe("h/1");
  });
});

describe("tierForContext (#7 — difficulty heuristic)", () => {
  it("is fast while only reading/planning (no plan, no specs)", () => {
    expect(tierForContext({ specs: [], currentPlan: null })).toBe("fast");
  });
  it("is default once a plan exists but nothing is designed", () => {
    expect(tierForContext({ specs: [], currentPlan: { v: 1 } })).toBe("default");
  });
  it("is hard WHILE actively designing the planned agents (specs < planned)", () => {
    expect(tierForContext({ specs: [{}], currentPlan: { v: 1, agents: [{}, {}, {}] } })).toBe("hard");
  });
  it("drops back to default once the planned set is fully designed (no longer a one-way ratchet)", () => {
    // 3 planned, 3 designed → post-design work (validate / sandbox / finish) → default, not stuck on hard.
    expect(tierForContext({ specs: [{}, {}, {}], currentPlan: { v: 1, agents: [{}, {}, {}] } })).toBe("default");
  });
});

// #6 — whole-run analyzer digest (pure, the LLM critic's input).
describe("runDigest (#6 — run analyzer)", () => {
  const events: BrainEvent[] = [
    { t: "think", delta: "我先" }, { t: "think", delta: "读一下本体的结构" },
    { t: "tool.call", id: "1", name: "read_ontology", reasoning: "先读本体", input: { domain: "X" } },
    { t: "tool.result", id: "1", name: "read_ontology", ok: true, summary: "已读取", output: "6 个动作 16 个事件" },
    { t: "tool.call", id: "2", name: "design_agent", reasoning: "设计第一个", input: {} },
    { t: "tool.result", id: "2", name: "design_agent", ok: false, summary: "未知动作 fooBar" },
    { t: "code", actionName: "createJD", codeSource: "ai", code: "export const fn = () => 42;" } as unknown as BrainEvent,
    { t: "refine", actionName: "createJD", critique: "缺少前置校验" } as unknown as BrainEvent,
    { t: "score.delta", actionName: "createJD", priorTotal: 60, newTotal: 78, delta: 18, regression: false, dimensions: { toolResolution: 20 } } as unknown as BrainEvent,
    { t: "sandbox", functionsRegistered: 3, ran: 2, fullChainRan: true, simulated: false } as unknown as BrainEvent,
    { t: "done", status: "finished" } as unknown as BrainEvent,
  ];

  it("counts thinking BLOCKS (not raw deltas) / tool calls / failures / refines in the header", () => {
    const d = runDigest(events);
    // the two consecutive think deltas form ONE thought block → "1 段思考", not "2".
    expect(d).toContain("1 段思考");
    expect(d).toContain("2 次工具调用(1 失败)");
    expect(d).toContain("1 次精修");
  });

  it("carries the FULL narrative: thinking prose, tool input + output, code, critique", () => {
    const d = runDigest(events);
    expect(d).toContain("读一下本体的结构"); // accumulated thinking text (was only COUNTED before)
    expect(d).toContain("输入:"); // tool input
    expect(d).toContain("6 个动作 16 个事件"); // tool OUTPUT (success), not just failures
    expect(d).toContain("export const fn = () => 42;"); // the actual code written
    expect(d).toContain("缺少前置校验"); // refine critique
  });

  it("surfaces the per-round score line, sandbox outcome, and terminal status", () => {
    const d = runDigest(events);
    expect(d).toContain("逐轮评分: createJD#1 60→78(+18)");
    expect(d).toContain("沙箱: 部署 3·跑 2·通 (真实)");
    expect(d).toContain("结束: finished");
  });

  it("scoreRounds derives per-agent attempt numbers from score.delta", () => {
    const evs: BrainEvent[] = [
      { t: "score.delta", actionName: "A", priorTotal: 50, newTotal: 60, delta: 10, regression: false } as unknown as BrainEvent,
      { t: "score.delta", actionName: "A", priorTotal: 60, newTotal: 55, delta: -5, regression: true } as unknown as BrainEvent,
      { t: "score.delta", actionName: "B", priorTotal: 70, newTotal: 80, delta: 10, regression: false } as unknown as BrainEvent,
    ];
    const r = scoreRounds(evs);
    expect(r.map((x) => `${x.agent}#${x.attempt}`)).toEqual(["A#1", "A#2", "B#1"]);
    expect(r[1]!.regression).toBe(true);
  });

  it("is bounded by the digest cap so a huge run can't blow the critic's context", () => {
    const many: BrainEvent[] = Array.from({ length: 5000 }, (_, i) => ({ t: "tool.call", id: String(i), name: "x".repeat(50), reasoning: "y".repeat(50), input: {} }) as BrainEvent);
    expect(runDigest(many).length).toBeLessThanOrEqual(120100);
  });
});
