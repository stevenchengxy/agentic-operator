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
        ev({ t: "done", status: "finished", completionKind: "delivery" }),
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

describe("completionKind projection", () => {
  it("projects waiting-human as an idle gate instead of a failed harness", () => {
    const harness = deriveSessionTasks([
      ev({ t: "clarify", question: "请选择", awaitingAnswer: true }),
      ev({ t: "done", status: "waiting_human", completionKind: "incomplete" }),
    ], false).find((task) => task.kind === "harness")!;
    expect(harness.status).toBe("idle");
    expect(harness.transcript.at(-1)).toMatchObject({ label: "等待人工回复" });
  });

  it("marks informational answers successful without a delivery claim", () => {
    const harness = deriveSessionTasks([
      ev({ t: "message", text: "回答" }),
      ev({ t: "done", status: "incomplete", completionKind: "answer" }),
    ], false).find((task) => task.kind === "harness")!;
    expect(harness.status).toBe("ok");
    expect(harness.transcript.at(-1)).toMatchObject({
      label: "回答完成 · 无交付/沙箱声明",
      ok: true,
    });
  });

  it("does not guess completion type for legacy done frames", () => {
    const harness = deriveSessionTasks([
      ev({ t: "done", status: "finished" }),
    ], false).find((task) => task.kind === "harness")!;
    expect(harness.status).toBe("idle");
    expect(harness.transcript.at(-1)).toMatchObject({ label: "结束 · 完成类型未知" });
    expect(harness.transcript.at(-1)?.ok).toBeUndefined();
  });
});

// #CHECKLIST — harness 持有的验收清单投影：acceptance 事件 → 舰队快照 + per-agent drill.checklist。
describe("acceptance checklist projection (#CHECKLIST)", () => {
  const acceptanceEv = (allPass: boolean) =>
    ev({
      t: "acceptance",
      allPass,
      criteria: [
        { key: "coverage", label: "覆盖全部 Agent 动作", pass: true, detail: "6 个全覆盖" },
        { key: "chain_ran", label: "链路端到端跑通", pass: allPass, detail: allPass ? "整链通" : "降级 processResume" },
      ],
      perAgent: [
        { slug: "d-processResume", short: "processResume", pass: allPass, items: [{ key: "code_really_ran", label: "生成代码真的执行", pass: allPass, detail: allPass ? "回执 ✓" : "回退声明式" }] },
      ],
    });

  it("deriveAcceptance returns the LAST snapshot; none → null", async () => {
    const { deriveAcceptance } = await import("./workers");
    expect(deriveAcceptance([created("a", "a")])).toBeNull();
    const snap = deriveAcceptance([
      ev({
        t: "sandbox",
        simulated: false,
        fullChainRan: true,
        reachedSuccessTerminal: true,
      }),
      acceptanceEv(false),
      acceptanceEv(true),
    ]);
    expect(snap!.allPass).toBe(true);
    expect(snap!.evidenceValid).toBe(true);
    expect(snap!.criteria).toHaveLength(2);
    expect(snap!.perAgent[0]!.short).toBe("processResume");
  });

  it("never turns a simulated sandbox or its checklist green", async () => {
    const { deriveAcceptance } = await import("./workers");
    const events = [
      created("d-processResume", "processResume"),
      ev({
        t: "sandbox",
        simulated: true,
        fullChainRan: true,
        reachedSuccessTerminal: true,
        agentRuns: [
          {
            agentSlug: "d-processResume",
            agentShort: "processResume",
            status: "ok",
            inputPayload: { value: "synthetic" },
          },
        ],
      }),
      acceptanceEv(true),
    ];

    const snap = deriveAcceptance(events);
    expect(snap).toMatchObject({ allPass: false, evidenceValid: false });
    expect(snap!.criteria.every((criterion) => !criterion.pass)).toBe(true);
    expect(snap!.perAgent.every((agent) => !agent.pass)).toBe(true);

    const tasks = deriveSessionTasks(events, false);
    const sandbox = tasks.find((task) => task.kind === "sandbox")!;
    expect(sandbox.status).toBe("error");
    expect(sandbox.typeLabel).toContain("invalid evidence");
    const agent = tasks.find(
      (task) => task.agentSlug === "d-processResume",
    )!;
    expect(agent.drill?.io).toBeUndefined();
    expect(agent.drill?.checklist?.every((item) => !item.pass)).toBe(true);
  });

  it("folds perAgent items into the agent's drill.checklist + a harness gate item", () => {
    const tasks = deriveSessionTasks([created("d-processResume", "processResume"), acceptanceEv(false)], false);
    const agent = tasks.find((x) => x.agentSlug === "d-processResume")!;
    expect(agent.drill?.checklist).toHaveLength(1);
    expect(agent.drill?.checklist?.[0]?.pass).toBe(false);
    const harness = tasks.find((x) => x.kind === "harness")!;
    expect(harness.transcript.some((it) => it.kind === "gate" && it.label.includes("验收清单"))).toBe(true);
  });
});
