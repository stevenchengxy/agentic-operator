import { describe, it, expect } from "vitest";
import { deriveSessionTasks } from "./workers";
import type { BrainEvent } from "@/lib/hooks/useBrainStream";

// #UI-DRILL — lock the drill projection: forAgent-grouped tools, parentAgent sub-agents,
// validation problems, sandbox real I/O + fidelity badge. Pure over BrainEvent[] (replay-safe).

const ev = (o: Record<string, unknown>): BrainEvent => o as unknown as BrainEvent;

const created = (slug: string, actionName: string, extra: Record<string, unknown> = {}) =>
  ev({
    t: "agent.created",
    spec: { slug, actionName, short: actionName, nameZh: actionName, trigger: ["E_IN"], emit: ["E_OUT"], tools: ["x"], ...(extra.spec as object ?? {}) },
    design: { reasoning: `${actionName} 的设计推理`, decisionLogic: "score>40 → 面试", ...(extra.design as object ?? {}) },
    ...extra,
  });

describe("deriveSessionTasks drill (#UI-DRILL)", () => {
  it("groups tool calls to the agent via forAgent (reliable path, no substring guess needed)", () => {
    const tasks = deriveSessionTasks(
      [
        created("d-processResume", "processResume"),
        ev({ t: "tool.call", id: "c1", name: "refine_agent", reasoning: "对齐类型", input: {}, forAgent: "processResume" }),
        ev({ t: "tool.result", id: "c1", name: "refine_agent", ok: true, summary: "done" }),
      ],
      false,
    );
    const t = tasks.find((x) => x.agentSlug === "d-processResume")!;
    expect(t.transcript.some((it) => it.kind === "tool" && it.label === "refine_agent" && it.ok === true)).toBe(true);
    expect(t.drill?.reasoning).toContain("设计推理");
    expect(t.drill?.decisionLogic).toContain("score>40");
  });

  it("#P4+ projects a forAgent strategy choice onto that agent's drill (each agent's own reasoning method)", () => {
    const tasks = deriveSessionTasks(
      [
        created("d-processResume", "processResume"),
        ev({ t: "strategy", mode: "combo", steps: ["tot", "debate", "reflection"], chosenBy: "ai", rationale: "复杂设计+高风险落地", forAgent: "processResume" }),
      ],
      false,
    );
    const t = tasks.find((x) => x.agentSlug === "d-processResume")!;
    expect(t.drill?.strategy).toBe("tot → debate → reflection");
    expect(t.transcript.some((it) => it.label?.includes("推理方法"))).toBe(true);
  });

  it("attaches sub-agents via parentAgent and marks isSubAgent from the spec flag", () => {
    const tasks = deriveSessionTasks(
      [
        created("d-processResume", "processResume"),
        created("d-processresume-helper", "lockOwnership", { parentAgent: "processResume", spec: { slug: "d-processresume-helper", actionName: "lockOwnership", short: "lockOwnership", nameZh: "锁定归属", trigger: [], emit: [], tools: [], isSubAgent: true } }),
      ],
      false,
    );
    const parent = tasks.find((x) => x.agentSlug === "d-processResume")!;
    expect(parent.drill?.subAgents).toEqual([{ slug: "d-processresume-helper", name: "锁定归属" }]);
    const sub = tasks.find((x) => x.agentSlug === "d-processresume-helper")!;
    expect(sub.kind).toBe("subagent"); // from spec.isSubAgent, not slug convention
    expect(sub.drill?.parentAgent).toBe("processResume");
  });

  // #ROLE — 过程角色显示：AI 设定的子大脑角色进 typeLabel；工具行带过程角色前缀。
  it("AI-assigned sub-brain role shows in the spawn card; tool rows carry the process role", () => {
    const tasks = deriveSessionTasks(
      [
        ev({ t: "subagent.start", task: "调查历史失败的根因", role: "证据调查员" }),
        ev({ t: "subagent.done", task: "调查历史失败的根因", summary: "找到两条线索" }),
        ev({ t: "tool.call", id: "c9", name: "sandbox_run", reasoning: "真跑验证", input: {}, role: "沙箱工程师" }),
      ],
      false,
    );
    const spawn = tasks.find((t) => t.kind === "subagent")!;
    expect(spawn.typeLabel).toBe("Sub-agent · 证据调查员");
    const harness = tasks.find((t) => t.kind === "harness")!;
    expect(harness.transcript.some((it) => it.label === "沙箱工程师 · sandbox_run")).toBe(true);
  });

  // #per-agent-think — the attribution cursor routes think/message bursts onto the agent currently
  // being worked on, so its card shows its own reasoning stream (not just event summaries).
  it("attaches per-agent think slices to the current agent while keeping them in the harness too", () => {
    const tasks = deriveSessionTasks(
      [
        created("d-processResume", "processResume"),
        ev({ t: "think", delta: "先确认 processResume 的输出契约字段，再决定要不要精修" }),
        ev({ t: "tool.call", id: "c1", name: "refine_agent", reasoning: "对齐类型", input: {}, forAgent: "processResume" }),
        ev({ t: "tool.result", id: "c1", ok: true, summary: "done" }),
      ],
      false,
    );
    const t = tasks.find((x) => x.agentSlug === "d-processResume")!;
    expect(t.transcript.some((it) => it.kind === "think" && it.detail?.includes("输出契约"))).toBe(true);
    // no regression: the harness card still carries the same reasoning burst.
    const harness = tasks.find((x) => x.kind === "harness")!;
    expect(harness.transcript.some((it) => it.kind === "think" && it.detail?.includes("输出契约"))).toBe(true);
  });

  it("routes a free-form message to the current agent and does NOT leak harness reasoning onto it", () => {
    const tasks = deriveSessionTasks(
      [
        created("d-processResume", "processResume"),
        ev({ t: "message", text: "processResume 设计完成，输出契约已对齐下游。" }),
        // sandbox is harness-scope → cursor resets; the following reasoning must stay in the harness.
        ev({ t: "tool.call", id: "c2", name: "sandbox_run", reasoning: "整链真跑", input: {} }),
        ev({ t: "think", delta: "整条事件链已闭合，可以结束了" }),
        ev({ t: "done", status: "finished" }),
      ],
      false,
    );
    const t = tasks.find((x) => x.agentSlug === "d-processResume")!;
    expect(t.transcript.some((it) => it.kind === "message" && it.detail?.includes("输出契约"))).toBe(true);
    expect(t.transcript.some((it) => it.detail?.includes("事件链已闭合"))).toBe(false);
    const harness = tasks.find((x) => x.kind === "harness")!;
    expect(harness.transcript.some((it) => it.kind === "think" && it.detail?.includes("事件链已闭合"))).toBe(true);
  });

  it("captures validation problems per agent and sandbox real I/O + fidelity failure", () => {
    const tasks = deriveSessionTasks(
      [
        created("d-processResume", "processResume"),
        ev({ t: "validation", ok: false, issues: ["x"], agentIssueMap: { processResume: [{ kind: "type_mismatch", event: "E_OUT", field: "score" }] } }),
        ev({
          t: "sandbox",
          ran: 1,
          reachedTerminal: true,
          agents: [],
          events: [],
          fidelityFailures: ["processResume"],
          agentRuns: [{ agentSlug: "d-processResume", agentShort: "processResume", status: "ok", degraded: false, triggerEvent: "E_IN", inputPayload: { a: 1 }, tools: [], outputEvent: "E_OUT", reasoning: "", outputPayload: { score: "high" }, runId: "run-1" }],
        }),
      ],
      false,
    );
    const t = tasks.find((x) => x.agentSlug === "d-processResume")!;
    expect(t.drill?.problems.some((p) => p.includes("type_mismatch") && p.includes("score"))).toBe(true);
    expect(t.drill?.problems.some((p) => p.includes("执行保真失败"))).toBe(true);
    expect(t.drill?.io).toMatchObject({ triggerEvent: "E_IN", outputEvent: "E_OUT" });
    expect(t.drill?.fidelityFail).toBe(true);
    expect(t.status).toBe("error"); // fidelity violation reads red
    expect(t.meta).toContain("契约违约");
  });
});
