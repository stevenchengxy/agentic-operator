import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// select_strategy now EXECUTES the reasoning kernel (was a label-only no-op). The kernel's default llm
// is chatOnce — mock it to return a deterministic marker keyed by purpose so we can assert real execution.
vi.mock("./stream-gateway", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./stream-gateway")>();
  return {
    ...actual,
    chatOnce: async (_s: string, _u: string, o?: { purpose?: string }) => `[${o?.purpose}]`,
  };
});

import { FACTORY_TOOLS } from "./tools";
import type { BrainCtx, BrainEvent } from "./brain-types";

const selectStrategyTool = FACTORY_TOOLS.find((t) => t.name === "select_strategy")!;

function ctx(): BrainCtx {
  const events: BrainEvent[] = [];
  const c = {
    domain: "d", goal: "g", specs: [], ontology: null, userIntent: "[生成] 造 agent",
    ontologyUnderstanding: "这个域有 6 个动作",
    budgetLedger: { tokens: 0, spawns: 0, maxTokens: null, maxSpawns: 20 },
    emit: (e: BrainEvent) => events.push(e),
  } as unknown as BrainCtx;
  return Object.assign(c, { __events: events }) as BrainCtx;
}

describe("select_strategy — actually executes the reasoning kernel", () => {
  beforeEach(() => vi.stubEnv("FACTORY_AI_MODEL", "test/m"));
  afterEach(() => vi.unstubAllEnvs());

  it("no `proposed` → returns a prior suggestion + menu, does NOT run the kernel", async () => {
    const c = ctx();
    const res = await selectStrategyTool.execute({ subproblem: "怎么设计这个 agent" }, c);
    expect(res.ok).toBe(true);
    expect((res.output as { menu: unknown }).menu).toBeTruthy();
    const events = (c as unknown as { __events: BrainEvent[] }).__events;
    expect(events.some((e) => e.t === "reasoning.step")).toBe(false);
  });

  it("proposed combo `tot→debate→reflection` → runs each step, emits reasoning.step per step, returns the final conclusion", async () => {
    const c = ctx();
    const res = await selectStrategyTool.execute({ subproblem: "高风险动作定方案", proposed: "tot→debate→reflection", rationale: "复杂+高风险" }, c);
    expect(res.ok).toBe(true);
    const out = res.output as { reasoning: string; steps: Array<{ strategy: string }> };
    // combo threaded to completion → final is the reflection rewrite
    expect(out.reasoning).toBe("[kernel:reflection.rewrite]");
    expect(out.steps.map((s) => s.strategy)).toEqual(["tot", "debate", "reflection"]);
    const events = (c as unknown as { __events: BrainEvent[] }).__events;
    const steps = events.filter((e): e is Extract<BrainEvent, { t: "reasoning.step" }> => e.t === "reasoning.step");
    expect(steps.map((e) => e.strategy)).toEqual(["tot", "debate", "reflection"]);
    // the shared budget ledger was charged for the real kernel LLM calls
    expect(c.budgetLedger!.tokens).toBeGreaterThan(0);
  });

  it("proposed lone `react` → ambient loop, no kernel run", async () => {
    const c = ctx();
    const res = await selectStrategyTool.execute({ subproblem: "边做边探", proposed: "react" }, c);
    expect(res.ok).toBe(true);
    expect((res.output as { ambient?: boolean }).ambient).toBe(true);
    const events = (c as unknown as { __events: BrainEvent[] }).__events;
    expect(events.some((e) => e.t === "reasoning.step")).toBe(false);
    expect(c.budgetLedger!.tokens).toBe(0);
  });

  // #KERNEL-TIER-AI / #BRANCHES-AI — AI 现在能为这一次推理点【模型档位】和【探索宽度 K】，
  // 而不是让角色名正则和固定默认替它定。（分叉数的精确断言在 reasoning-kernel.test.ts，
  // 那里 fakeLlm 记录每次调用；这里是端到端冒烟：AI 传的参数确实被 select_strategy 接住。）
  it("AI 传 branches / tier → select_strategy 接住并正常执行（端到端冒烟）", async () => {
    const c = ctx();
    const res = await selectStrategyTool.execute({ subproblem: "解空间很大的拆分", proposed: "tot", rationale: "多路", branches: 5, tier: "hard" }, c);
    expect(res.ok).toBe(true);
    const events = (c as unknown as { __events: BrainEvent[] }).__events;
    expect(events.some((e) => e.t === "reasoning.step" && e.strategy === "tot")).toBe(true);
  });

  it("AI 不传 tier → 沿用角色默认（explore=fast/synth=default）；传 tier 不报错、正常执行", async () => {
    const c = ctx();
    // 不传 tier：仍能跑通（回落默认档），不因缺档位而失败。
    const base = await selectStrategyTool.execute({ subproblem: "普通决策", proposed: "cot" }, c);
    expect(base.ok).toBe(true);
    // 传合法 tier：AI 显式点 hard，正常执行（模型选择走 kernelModelsFor 的 AI-优先分支）。
    const c2 = ctx();
    const hard = await selectStrategyTool.execute({ subproblem: "难题", proposed: "cot", tier: "hard", rationale: "这题难" }, c2);
    expect(hard.ok).toBe(true);
    // 非法 tier 字符串被 asModelTier 收敛掉，不炸、回落默认。
    const c3 = ctx();
    const bad = await selectStrategyTool.execute({ subproblem: "x", proposed: "cot", tier: "超强档" }, c3);
    expect(bad.ok).toBe(true);
  });
});
