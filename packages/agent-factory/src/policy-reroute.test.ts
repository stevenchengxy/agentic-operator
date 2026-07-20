import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMsg, TurnEvent } from "./stream-gateway";

// #POLICY-REROUTE 回归 —— 真实事故的完整复现。
//
// 用户开场问「你能生成哪个agent?」→ 意图门判 [提问] → 路由选 analyze 路线 → 往对话里注入
// 「本次是只读分析/答疑…【不要】进入生成流水线（不 create_plan / design_agent / sandbox_run /
// finish）…要图就调 build_blueprint」。大脑于是给出两条路线让用户选（路线A=只生成 createJD /
// 路线B=补齐全部6个）并挂起。用户答「A」。
//
// 旧版的问题：意图门 + 路由【只在开场按第一句话跑一次】，此后 ctx.policy / ctx.userIntent /
// 模型档位全部冻结。那条「【不要】进入生成流水线」于是终身有效，且比用户的新回答更长寿
// （折叠快照还会逐字重述「推理路线: analyze」）。大脑把「A」缝进这条过期路线，得出
// 「用户选择了方向A：继续只做分析」，接着照 analyze 路线去 understand_ontology + build_blueprint，
// 一个 agent 都没生成。
//
// 修复：澄清回答是一次【真实的用户表态】，重走意图门 + 路由；路线真的变了就显式宣告旧指令作废。
// 判成什么路线仍由 AI 的意图解析决定——这里只断言【分诊会重跑、旧禁令会被作废】，不断言结论。

const scriptedTurns: TurnEvent[][] = [];
const seenTurns: ChatMsg[][] = [];
const intentAnswers: string[] = [];

vi.mock("./stream-gateway", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./stream-gateway")>();
  return {
    ...actual,
    isGatewayConfigured: () => true,
    setLlmCallContext: () => undefined,
    streamTurn: async function* (messages: ChatMsg[]) {
      seenTurns.push(structuredClone(messages));
      const events = scriptedTurns.shift() ?? [{ t: "done" as const, content: "done" }];
      for (const event of events) yield event;
    },
    chatOnce: async (_system: string, _user: string, opts?: { purpose?: string }) => {
      // 意图门：第 1 次 = 开场提问；第 2 次 = 澄清回答后的重解析（用户选了"生成 createJD"）。
      if (opts?.purpose === "specialist:intent") return intentAnswers.shift() ?? "[提问] x ｜ 约束: 无 ｜ 期望产物: 无";
      return "";
    },
  };
});

import { runBrain } from "./conductor";
import type { FactoryPorts } from "./ports";

const portsWithAnswer = (answer: string): FactoryPorts => {
  let answered = false;
  return {
    ontology: {
      listDomains: async () => [],
      fetchOntology: async () => ({ domainId: "dom", actions: [], events: [], objects: [], rules: [], workflow: [], source: "snapshot" as const }),
      fetchActionRules: async () => [],
    },
    sandbox: { deployAndObserve: async () => { throw new Error("not used"); }, teardown: async () => undefined },
    reflection: { list: async () => [], record: async () => undefined },
    conversation: {
      has: async () => false,
      load: async () => null,
      save: async () => undefined,
      drainHumanMessages: async () => {
        if (seenTurns.length >= 1 && !answered) { answered = true; return [{ text: `[澄清回答] ${answer}`, actor: "usr-human" }]; }
        return [];
      },
    },
  } as unknown as FactoryPorts;
};

const PROPOSAL = [
  "当前只有 createJD 能生成。",
  "路线 A：直接生成 createJD 的完整代码。",
  "路线 B：补齐其他 5 个 agent 的工具契约，然后并行生成全部 6 个。",
  "你想选哪条？",
].join("\n");

describe("#POLICY-REROUTE — 澄清回答会重走意图门+路由，过期路线不再终身有效", () => {
  beforeEach(() => {
    vi.stubEnv("FACTORY_AI_MODEL", "test/m");
    scriptedTurns.splice(0);
    seenTurns.splice(0);
    intentAnswers.splice(0);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("答案改变了请求性质 → 路线重算 + 旧的「不要进入生成流水线」被显式作废", async () => {
    intentAnswers.push(
      "[提问] 了解可生成的智能体类型 ｜ 约束: 无 ｜ 期望产物: 智能体类型说明或列表",
      "[生成] 只生成 createJD 的 function 代码 ｜ 约束: 只做 createJD ｜ 期望产物: 可运行代码",
    );
    scriptedTurns.push([{ t: "done", content: PROPOSAL }], [{ t: "done", content: "开始生成 createJD。" }]);

    const events = [];
    for await (const event of runBrain({ domain: "dom", goal: "你能生成哪个agent?", ports: portsWithAnswer("A"), conversationId: "reroute-conv" })) {
      events.push(event);
    }

    // 开场：[提问] → analyze 路线。#POLICY-ADVISORY 后它是【事实+建议】而非命令，但仍带着
    // 「没被要求就别自作主张跑生成流水线」这条原则（过去是"【不要】进入生成流水线"的硬禁令）。
    const turn1 = seenTurns[0]!.map((m) => String(m.content ?? "")).join("\n");
    expect(turn1).toContain("[前置分诊·事实与建议]");
    expect(turn1).toContain("读成【只读分析/答疑】");
    expect(turn1).toContain("别自作主张跑生成流水线");

    // 答「A」之后：意图门重跑（第 2 次解析被消费）、路线重算并宣告旧指令作废。
    expect(intentAnswers).toHaveLength(0);
    const turn2 = seenTurns[1]!.map((m) => String(m.content ?? "")).join("\n");
    expect(turn2).toContain("[推理路线·已更新]");
    expect(turn2).toContain("路线从「analyze」切换为「full」");
    // 关键：旧的 analyze 分诊消息必须【物理消失】，不能只是被声明作废——两条矛盾指令同时在场时，
    // 模型倾向服从更早那条（#POLICY-PRUNE 的原注释就是这么写的，本案即此）。
    expect(turn2).not.toContain("[前置分诊·事实与建议] 意图门把用户这次的表态读成【只读分析/答疑】");
    expect(turn2).not.toContain("别自作主张跑生成流水线");
    // 新路线在场（full 生成路线），用户也看得到这次切换。
    expect(turn2).toContain("[推理路线] 完整生成路线");
    expect(events).toContainEqual(expect.objectContaining({ t: "policy", pipeline: "full" }));
    expect(events).toContainEqual(expect.objectContaining({ t: "message", text: expect.stringContaining("推理路线已从「analyze」切到「full」") }));
  });

  it("答案没有改变请求性质 → 不误报路线切换（仍是 analyze，无作废噪音）", async () => {
    intentAnswers.push(
      "[提问] 了解可生成的智能体类型 ｜ 约束: 无 ｜ 期望产物: 智能体类型说明或列表",
      "[提问] 再解释一下这两条路线的区别 ｜ 约束: 无 ｜ 期望产物: 说明",
    );
    scriptedTurns.push([{ t: "done", content: PROPOSAL }], [{ t: "done", content: "两条路线的区别是…" }]);

    const events = [];
    for await (const event of runBrain({ domain: "dom", goal: "你能生成哪个agent?", ports: portsWithAnswer("再解释一下"), conversationId: "noreroute-conv" })) {
      events.push(event);
    }

    const turn2 = seenTurns[1]!.map((m) => String(m.content ?? "")).join("\n");
    expect(turn2).not.toContain("[推理路线·已更新]");
    expect(turn2).not.toContain("就此作废");
    expect(events).not.toContainEqual(expect.objectContaining({ t: "message", text: expect.stringContaining("推理路线已从") }));
  });
});
