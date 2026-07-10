import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { BrainCtx, BrainEvent } from "./brain-types";
import type { DomainOntology } from "./ontology-types";

// G3 critique_plan 三视角分治：计划够大（≥4 agent 或规则>60）时派三位视角专家
// （链路完整/规则合规/IO 契约）并行评审，按 problem 去重合并；<2 位成功则诚实降级单跳。

vi.mock("./specialists", async (importOriginal) => {
  const real = await importOriginal<typeof import("./specialists")>();
  return { ...real, runSpecialists: vi.fn() };
});

import { FACTORY_TOOLS } from "./tools";
import { runSpecialists } from "./specialists";

const critique = FACTORY_TOOLS.find((t) => t.name === "critique_plan")!;

function bigPlanCtx(): { ctx: BrainCtx; events: BrainEvent[] } {
  const events: BrainEvent[] = [];
  const actions = ["a1", "a2", "a3", "a4"].map((n) => ({ id: n, name: n, actor: ["Agent"], trigger: [`${n}_IN`], triggered_event: [`${n}_OUT`], target_objects: [], tool_use: [], system_prompt: "", user_prompt: "" }));
  const ctx = {
    domain: "rec",
    ontology: { domainId: "rec", objects: [], rules: [], actions, events: [], workflow: [], source: "snapshot" } as unknown as DomainOntology,
    currentPlan: { version: 1, summary: "s", agents: actions.map((a) => ({ actionName: a.name, role: "", triggerEvents: a.trigger, emitEvents: a.triggered_event, toolCandidates: [] })) },
    specs: [],
    humanDirectives: [],
    emit: (e: BrainEvent) => events.push(e),
    ports: {},
  } as unknown as BrainCtx;
  return { ctx, events };
}

beforeEach(() => {
  process.env.CUSTOM_LLM_API_KEY = "test-key"; // gateway configured → deep review reachable
  vi.mocked(runSpecialists).mockReset();
});
afterEach(() => {
  delete process.env.CUSTOM_LLM_API_KEY;
});

describe("critique_plan — 三视角分治评审", () => {
  it("三视角 issues 去重合并，含高危 → verdict=revise", async () => {
    vi.mocked(runSpecialists).mockResolvedValue([
      { id: "chain", role: "链路完整视角", ok: true, output: { issues: [{ severity: "high", problem: "a2 的产出无人消费", fix: "补衔接" }] }, summary: "" },
      { id: "rules", role: "规则合规视角", ok: true, output: { issues: [{ severity: "med", problem: "a3 未识别为规则闸", fix: "标记闸口" }, { severity: "high", problem: "a2 的产出无人消费", fix: "重复项应去重" }] }, summary: "" },
      { id: "contract", role: "IO 契约视角", ok: true, output: { issues: [] }, summary: "" },
    ] as never);
    const { ctx } = bigPlanCtx();
    const r = await critique.execute({ deep: true }, ctx);
    expect(r.ok).toBe(false); // revise
    const out = r.output as { verdict: string; issues: Array<{ problem: string; perspective: string }> };
    expect(out.verdict).toBe("revise");
    expect(out.issues).toHaveLength(2); // 跨视角同 problem 去重
    expect(out.issues.some((i) => i.perspective === "链路完整视角")).toBe(true);
    expect(vi.mocked(runSpecialists)).toHaveBeenCalledTimes(1);
    const tasks = vi.mocked(runSpecialists).mock.calls[0]![1] as Array<{ id: string }>;
    expect(tasks.map((t) => t.id)).toEqual(["chain", "rules", "contract"]);
  });

  it("零问题 → 三视角通过、verdict=ok", async () => {
    vi.mocked(runSpecialists).mockResolvedValue([
      { id: "chain", role: "链路完整视角", ok: true, output: { issues: [] }, summary: "" },
      { id: "rules", role: "规则合规视角", ok: true, output: { issues: [] }, summary: "" },
      { id: "contract", role: "IO 契约视角", ok: true, output: { issues: [] }, summary: "" },
    ] as never);
    const { ctx } = bigPlanCtx();
    const r = await critique.execute({ deep: true }, ctx);
    expect(r.ok).toBe(true);
    expect(r.summary).toContain("三视角评审通过");
  });

  it("专家 <2 成功 → 诚实降级（发降级 reflect，走单跳路径）", async () => {
    vi.mocked(runSpecialists).mockResolvedValue([
      { id: "chain", role: "链路完整视角", ok: false, output: null, summary: "挂了" },
      { id: "rules", role: "规则合规视角", ok: false, output: null, summary: "挂了" },
      { id: "contract", role: "IO 契约视角", ok: true, output: { issues: [] }, summary: "" },
    ] as never);
    const { ctx, events } = bigPlanCtx();
    const r = await critique.execute({ deep: true }, ctx);
    expect(events.some((e) => e.t === "reflect" && String((e as { lesson: string }).lesson).includes("降级"))).toBe(true);
    // 假 key 下单跳 chatJson 失败 → 工具自身的"网关错误已跳过"兜底
    expect(r.ok).toBe(true);
    expect(r.summary).toContain("跳过");
  });
});
