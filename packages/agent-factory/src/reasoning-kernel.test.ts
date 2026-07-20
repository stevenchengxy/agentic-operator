import { describe, expect, it } from "vitest";
import { asModelTier, extractCotConclusion, kernelTokenCharge, runReasoning, type KernelLlm } from "./reasoning-kernel";
import { parseStrategyPlan } from "./reasoning-policy";
import type { BrainEvent } from "./brain-types";

/** Fake llm: records every call and returns a deterministic marker keyed by purpose. */
function fakeLlm() {
  const calls: Array<{ system: string; user: string; purpose?: string }> = [];
  const llm: KernelLlm = async (system, user, opts) => {
    calls.push({ system, user, purpose: opts?.purpose });
    // tot branches must carry a parseable self-score so pruning is deterministic.
    if (opts?.purpose?.startsWith("kernel:tot.b")) return `思路内容 score: ${50 + (calls.length % 5)}`;
    return `[${opts?.purpose}]`;
  };
  return { llm, calls };
}

const collect = () => {
  const events: BrainEvent[] = [];
  return { emit: (e: BrainEvent) => events.push(e), events };
};

describe("reasoning-kernel — real per-method execution", () => {
  it("cot: one continuous pass, one reasoning.step", async () => {
    const { llm, calls } = fakeLlm();
    const { emit, events } = collect();
    const res = await runReasoning({ subproblem: "分析这个域" }, parseStrategyPlan("cot"), { llm, emit });
    expect(calls.map((c) => c.purpose)).toEqual(["kernel:cot"]);
    expect(res.final).toBe("[kernel:cot]");
    expect(events.filter((e) => e.t === "reasoning.step")).toHaveLength(1);
    expect(res.ambientReactOnly).toBe(false);
  });

  it("reflection without a draft: draft → critique → rewrite (3 calls), rewrite is final", async () => {
    const { llm, calls } = fakeLlm();
    const res = await runReasoning({ subproblem: "设计一个校验 agent" }, parseStrategyPlan("reflection"), { llm });
    expect(calls.map((c) => c.purpose)).toEqual(["kernel:reflection.draft", "kernel:reflection.critique", "kernel:reflection.rewrite"]);
    expect(res.final).toBe("[kernel:reflection.rewrite]");
    expect(res.steps[0]!.meta?.critique).toBe("[kernel:reflection.critique]");
  });

  it("reflection WITH a threaded draft: skips the draft call (2 calls)", async () => {
    const { llm, calls } = fakeLlm();
    const res = await runReasoning({ subproblem: "打磨方案", draft: "已有草稿X" }, parseStrategyPlan("reflection"), { llm });
    expect(calls.map((c) => c.purpose)).toEqual(["kernel:reflection.critique", "kernel:reflection.rewrite"]);
    // the critique saw the threaded draft
    expect(calls[0]!.user).toContain("已有草稿X");
    expect(res.final).toBe("[kernel:reflection.rewrite]");
  });

  it("debate: N proposers in parallel + 1 judge; final is the verdict", async () => {
    const { llm, calls } = fakeLlm();
    const res = await runReasoning({ subproblem: "该不该 finish" }, parseStrategyPlan("debate"), { llm, branches: 3 });
    const purposes = calls.map((c) => c.purpose);
    expect(purposes.filter((p) => p?.startsWith("kernel:debate.p"))).toHaveLength(3);
    expect(purposes).toContain("kernel:debate.judge");
    expect(res.final).toBe("[kernel:debate.judge]");
    expect((res.steps[0]!.meta?.proposals as string[]).length).toBe(3);
  });

  it("tot: K divergent branches + merge, exposes scores", async () => {
    const { llm, calls } = fakeLlm();
    const res = await runReasoning({ subproblem: "复杂设计" }, parseStrategyPlan("tot"), { llm, branches: 4 });
    expect(calls.filter((c) => c.purpose?.startsWith("kernel:tot.b"))).toHaveLength(4);
    expect(calls.some((c) => c.purpose === "kernel:tot.merge")).toBe(true);
    expect(res.final).toBe("[kernel:tot.merge]");
    expect((res.steps[0]!.meta?.scores as number[]).length).toBe(4);
  });

  it("combo tot→debate→reflection: runs in order and THREADS each output into the next", async () => {
    const { llm, calls } = fakeLlm();
    const { emit, events } = collect();
    const res = await runReasoning({ subproblem: "为高风险动作定方案" }, parseStrategyPlan("tot→debate→reflection"), { llm, emit, branches: 2 });
    const stepEvents = events.filter((e): e is Extract<BrainEvent, { t: "reasoning.step" }> => e.t === "reasoning.step");
    expect(stepEvents.map((e) => e.strategy)).toEqual(["tot", "debate", "reflection"]);
    // debate's proposers saw tot's merged output as their threaded draft…
    expect(calls.find((c) => c.purpose === "kernel:debate.p0")!.user).toContain("[kernel:tot.merge]");
    // …and reflection's critique saw debate's verdict as its draft (so it skipped its own draft call).
    expect(calls.some((c) => c.purpose === "kernel:reflection.draft")).toBe(false);
    expect(calls.find((c) => c.purpose === "kernel:reflection.critique")!.user).toContain("[kernel:debate.judge]");
    expect(res.final).toBe("[kernel:reflection.rewrite]");
  });

  it("a lone react is the AMBIENT loop — no kernel LLM calls, no steps", async () => {
    const { llm, calls } = fakeLlm();
    const res = await runReasoning({ subproblem: "边做边探" }, parseStrategyPlan("react"), { llm });
    expect(res.ambientReactOnly).toBe(true);
    expect(calls).toHaveLength(0);
    expect(res.steps).toHaveLength(0);
  });

  it("react INSIDE a combo becomes a concrete action-plan step", async () => {
    const { llm, calls } = fakeLlm();
    const res = await runReasoning({ subproblem: "先想清楚再动手" }, parseStrategyPlan("tot→react"), { llm, branches: 2 });
    expect(calls.some((c) => c.purpose === "kernel:react.plan")).toBe(true);
    expect(res.final).toBe("[kernel:react.plan]");
  });

  it("enforces the LLM-call cap (budget guard) — a step that would exceed it degrades, keeping the carry", async () => {
    const { llm, calls } = fakeLlm();
    let charged = 0;
    // tot with 3 branches = 3 + 1 = 4 calls; cap at 2 → the merge (and some branches) blocked → step degrades.
    const res = await runReasoning({ subproblem: "x", draft: "SEED" }, parseStrategyPlan("tot"), { llm, branches: 3, maxLlmCalls: 2, onLlmCall: () => { charged++; } });
    expect(calls.length).toBeLessThanOrEqual(2);
    expect(charged).toBeLessThanOrEqual(2);
    // degraded step keeps the incoming carry rather than aborting the run
    expect(res.final).toBe("SEED");
    expect(res.steps[0]!.meta?.error).toBeTruthy();
  });
});

describe("#KERNEL-BUDGET — per-call token budgets scale from FACTORY_KERNEL_MAX_TOKENS", () => {
  /** Fake llm that records the maxTokens each role requested. */
  function budgetLlm() {
    const byPurpose = new Map<string, number | undefined>();
    const llm: KernelLlm = async (_s, _u, opts) => {
      byPurpose.set(opts?.purpose ?? "?", opts?.maxTokens);
      if (opts?.purpose?.startsWith("kernel:tot.b")) return "思路 score: 60";
      return `[${opts?.purpose}]`;
    };
    return { llm, byPurpose };
  }
  const withEnv = async (value: string | undefined, fn: () => Promise<void>) => {
    const prev = process.env.FACTORY_KERNEL_MAX_TOKENS;
    if (value === undefined) delete process.env.FACTORY_KERNEL_MAX_TOKENS;
    else process.env.FACTORY_KERNEL_MAX_TOKENS = value;
    try { await fn(); } finally {
      if (prev === undefined) delete process.env.FACTORY_KERNEL_MAX_TOKENS;
      else process.env.FACTORY_KERNEL_MAX_TOKENS = prev;
    }
  };

  it("default base is 1800: synthesis roles get the full base, critique its ratio, charge follows", async () => {
    await withEnv(undefined, async () => {
      const { llm, byPurpose } = budgetLlm();
      await runReasoning({ subproblem: "x" }, parseStrategyPlan("reflection"), { llm });
      expect(byPurpose.get("kernel:reflection.rewrite")).toBe(1800);
      expect(byPurpose.get("kernel:reflection.critique")).toBe(Math.round(1800 * 0.65));
      expect(kernelTokenCharge()).toBe(1800 + 400);
    });
  });

  it("FACTORY_KERNEL_MAX_TOKENS raises every role proportionally and the ledger charge follows", async () => {
    await withEnv("3000", async () => {
      const { llm, byPurpose } = budgetLlm();
      await runReasoning({ subproblem: "x" }, parseStrategyPlan("cot"), { llm });
      expect(byPurpose.get("kernel:cot")).toBe(Math.round(3000 * 0.9));
      expect(kernelTokenCharge()).toBe(3400);
    });
  });

  it("nonsense or too-small values fall back to the default; huge values clamp (never degenerate)", async () => {
    await withEnv("abc", async () => { expect(kernelTokenCharge()).toBe(2200); });
    await withEnv("50", async () => { expect(kernelTokenCharge()).toBe(2200); });
    await withEnv("999999", async () => { expect(kernelTokenCharge()).toBe(32_000 + 400); });
  });
});

describe("#CLEAN-ANSWER — extractCotConclusion splits reasoning from the user-facing conclusion", () => {
  it("takes only the text after 【明确结论】 (the real live-run shape)", () => {
    const blob = "先理清这个子问题的目标与约束：\n1. 用户要了解身份\n\n【明确结论】\n\n你好！我是这座工厂的主控大脑，也是你的 Agent 工程师。";
    const out = extractCotConclusion(blob);
    expect(out).not.toBeNull();
    expect(out!.conclusion).toBe("你好！我是这座工厂的主控大脑，也是你的 Agent 工程师。");
    expect(out!.reasoning).toContain("先理清这个子问题");
    expect(out!.reasoning).not.toContain("你好");
  });

  it("tolerates a markdown-heading / bold marker form", () => {
    expect(extractCotConclusion("推导过程……\n## 明确结论：这是答案的正文内容。")!.conclusion).toBe("这是答案的正文内容。");
    expect(extractCotConclusion("分析……\n**明确结论**： 最终给出的完整回答在这里。")!.conclusion).toBe("最终给出的完整回答在这里。");
  });

  it("splits on the LAST marker when several appear", () => {
    const out = extractCotConclusion("引用了【明确结论】这个词做讨论……然后真正给出：\n【明确结论】真正的最终答案文本。");
    expect(out!.conclusion).toBe("真正的最终答案文本。");
  });

  it("returns null (caller keeps full text) when no marker or the conclusion is trivially short", () => {
    expect(extractCotConclusion("一段没有结论标记的普通推理文本。")).toBeNull();
    expect(extractCotConclusion("很多推理……\n【明确结论】\n短")).toBeNull(); // <10 chars → mis-parse guard
    expect(extractCotConclusion("")).toBeNull();
  });
});

// #KERNEL-TIER-AI — AI 传的档位先经 asModelTier 收敛：合法档位放行，非法输入回落 undefined
// （→ 让调用点回落 env / 角色默认），所以 AI 传垃圾也不会炸、不会误选一个不存在的档。
describe("asModelTier — AI 请求的模型档位校验", () => {
  it("认得四个合法档位（含前后空白）", () => {
    for (const t of ["fast", "default", "hard", "review"]) {
      expect(asModelTier(t)).toBe(t);
      expect(asModelTier(`  ${t}  `)).toBe(t);
    }
  });
  it("非法/垃圾输入 → undefined（回落默认，绝不误选）", () => {
    for (const bad of ["超强档", "HARD", "turbo", "", "  ", "fast-ish", 3, null, undefined, {}]) {
      expect(asModelTier(bad as unknown)).toBeUndefined();
    }
  });
});
