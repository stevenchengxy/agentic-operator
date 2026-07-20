import { describe, it, expect } from "vitest";
import { FACTORY_TOOLS } from "./tools";
import type { BrainCtx, BrainEvent } from "./brain-types";

// #NATIVE（设计期契约降级）— 锁定语义：契约缺口/类型问题是【高置信提醒】，不翻 validate 的
// ok、不阻断推进；真正的行为裁判是沙箱保真（execution_fidelity 验收判据）。结构性问题
// （覆盖缺口/事件图不闭合/显式降级壳/未解析工具）仍然翻 ok。零工具纯逻辑不是缺陷。

const validate = FACTORY_TOOLS.find((t) => t.name === "validate_graph")!;

function spec(p: Record<string, unknown>): Record<string, unknown> {
  return { slug: `d-${p.actionName}`, nameZh: String(p.actionName), short: String(p.actionName), tools: ["x"], unresolvedTools: [], systemPrompt: "", trigger: [], emit: [], ...p };
}

function ctxWith(specs: Array<Record<string, unknown>>): { ctx: BrainCtx; emitted: BrainEvent[] } {
  const emitted: BrainEvent[] = [];
  const ontology = {
    domainId: "d",
    // 本体动作与 specs 一一对应（无覆盖缺口）；E_IN 入口、E_OUT 终态（closure 成立）。
    actions: specs.map((s) => ({ id: s.actionName, name: s.actionName, actor: ["Agent"], trigger: s.trigger, triggered_event: s.emit, target_objects: [], tool_use: [], system_prompt: "", user_prompt: "" })),
    events: [
      { name: "E_IN", payload: { event_data: [{ name: "candidate_id", type: "string" }] } },
      { name: "E_MID", payload: { event_data: [{ name: "candidate_id", type: "string" }] } },
      { name: "E_OUT", payload: { event_data: [] } },
    ],
    objects: [],
    rules: [],
    workflow: [],
    source: "snapshot",
  };
  const ctx = { specs, ontology, currentPlan: { version: 1 }, lastValidation: null, lastSandbox: null, emit: (e: BrainEvent) => emitted.push(e), domain: "d", boundaryEvents: [{ event: "E_OUT", kind: "terminal" }] } as unknown as BrainCtx;
  return { ctx, emitted };
}

describe("validate_graph — 契约提醒不阻断（#NATIVE）", () => {
  it("payload_gap（下游读没人写的字段）→ ok 仍为 true，但提醒醒目在场", async () => {
    // B 期待 score(number)，A 只产出 candidate_id → 契约缺口；但图闭合、覆盖齐、有工具。
    const { ctx, emitted } = ctxWith([
      spec({ actionName: "A", trigger: ["E_IN"], emit: ["E_MID"], outputSchema: [{ field: "candidate_id", type: "string" }] }),
      spec({ actionName: "B", trigger: ["E_MID"], emit: ["E_OUT"], inputSchema: [{ field: "score", type: "number" }] }),
    ]);
    const r = await validate.execute({}, ctx);
    expect(r.ok).toBe(true); // 契约问题不再翻 ok
    const v = emitted.find((e) => e.t === "validation") as { ok: boolean; issues: string[] };
    expect(v.ok).toBe(true);
    expect(v.issues.some((l) => l.includes("契约提醒") && l.includes("高置信"))).toBe(true);
    expect(String(r.summary)).toContain("契约提醒");
    expect(String(r.summary)).toContain("沙箱保真"); // 指明真正的裁判
  });

  it("结构性问题（覆盖缺口）仍然翻 ok=false", async () => {
    const { ctx } = ctxWith([spec({ actionName: "A", trigger: ["E_IN"], emit: ["E_OUT"] })]);
    // 本体里再声明一个没有 spec 的 Agent 动作 → coverage gap（结构性，硬）
    (ctx.ontology as unknown as { actions: unknown[] }).actions.push({ id: "C", name: "C", actor: ["Agent"], trigger: ["E_MID"], triggered_event: ["E_OUT"], target_objects: [], tool_use: [], system_prompt: "", user_prompt: "" });
    const r = await validate.execute({}, ctx);
    expect(r.ok).toBe(false);
    expect(String(r.summary)).toContain("缺少 agent 的动作");
  });

  it("闭合的零工具纯逻辑 agent 仍可通过，显式降级壳不可通过", async () => {
    const pure = spec({ actionName: "A", trigger: ["E_IN"], emit: ["E_OUT"], tools: [] });
    const { ctx } = ctxWith([pure]);
    expect((await validate.execute({}, ctx)).ok).toBe(true);

    (ctx.specs[0] as unknown as { degraded?: boolean }).degraded = true;
    const degraded = await validate.execute({}, ctx);
    expect(degraded.ok).toBe(false);
    expect(String(degraded.summary)).toContain("降级壳");
  });
});
