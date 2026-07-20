import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMsg, TurnEvent } from "./stream-gateway";

// Deterministic streamTurn: each call records the messages it saw and yields the next scripted turn.
const seenTurns: ChatMsg[][] = [];
const scriptedTurns: TurnEvent[][] = [];

vi.mock("./stream-gateway", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./stream-gateway")>();
  return {
    ...actual,
    isGatewayConfigured: () => false,
    setLlmCallContext: () => undefined,
    streamTurn: async function* (messages: ChatMsg[]) {
      seenTurns.push(structuredClone(messages));
      const events = scriptedTurns.shift() ?? [{ t: "done" as const, content: "done" }];
      for (const event of events) yield event;
    },
  };
});

import { runBrain } from "./conductor";
import type { BrainTool } from "./brain-types";
import type { FactoryPorts } from "./ports";

const baseOntologyPort = {
  listDomains: async () => [],
  fetchOntology: async () => ({ domainId: "dom", actions: [], events: [], objects: [], rules: [], workflow: [], source: "snapshot" as const }),
  fetchActionRules: async () => [],
};
const baseSandboxPort = { deployAndObserve: async () => { throw new Error("not used"); }, teardown: async () => undefined };
const baseReflectionPort = { list: async () => [], record: async () => undefined };

describe("#ASK-PARK v2 — a plain-text trailing question parks the run instead of ending it", () => {
  beforeEach(() => {
    vi.stubEnv("FACTORY_AI_MODEL", "test/park-model");
    seenTurns.splice(0);
    scriptedTurns.splice(0);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("auto-parks on a trailing question (no tool call), waits for the user, then resumes on the answer", async () => {
    // Turn 1: the brain ends with a plain-text open question and NO tool call → must PARK, not end.
    // Turn 2: after the user answers at the clarify gate, the run resumes and finishes normally.
    scriptedTurns.push(
      [{ t: "done", content: "两个集成里你希望用哪个？A 还是 B？" }],
      [{ t: "done", content: "好的，按 A 继续。" }],
    );
    let answered = false;
    const ports: FactoryPorts = {
      ontology: baseOntologyPort,
      sandbox: baseSandboxPort,
      reflection: baseReflectionPort,
      conversation: {
        has: async () => false,
        load: async () => null,
        save: async () => undefined,
        // Answer only becomes available AFTER the first model turn produced the question, so the
        // pre-question mailbox reads see nothing and the answer is consumed by the clarify gate.
        drainHumanMessages: async () => {
          if (seenTurns.length >= 1 && !answered) { answered = true; return [{ text: "用 A", actor: "usr-human" }]; }
          return [];
        },
      },
    };

    const events = [];
    for await (const event of runBrain({ domain: "dom", goal: "帮我选集成", ports, conversationId: "park-conv" })) {
      events.push(event);
    }

    // The run PARKED: a clarify(awaitingAnswer:true) frame was synthesized from the trailing question…
    const parkFrame = events.find((e): e is Extract<typeof e, { t: "clarify" }> => e.t === "clarify" && e.awaitingAnswer === true);
    expect(parkFrame).toBeTruthy();
    expect(String(parkFrame?.question)).toContain("A 还是 B？");
    expect(events).toContainEqual(expect.objectContaining({ t: "message", text: expect.stringContaining("运行已挂起") }));
    // …and it RESUMED: a clearing clarify(awaitingAnswer:false) frame + the answer threaded into turn 2's prompt.
    expect(events).toContainEqual(expect.objectContaining({ t: "clarify", awaitingAnswer: false }));
    expect(seenTurns).toHaveLength(2);
    expect(seenTurns[1]!.map((m) => String(m.content ?? "")).join("\n")).toContain("[用户澄清回答]");
    expect(events.at(-1)).toMatchObject({ t: "done" });
  });

  // #ASK-PROPOSAL 回归 — 真实事故：大脑把选项写在【正文散文】里（"路线A：只生成 createJD／
  // 路线B：补齐全部6个"），末句只留"你想选哪条？"。自动挂起只截尾句当 question、options 恒为
  // undefined，于是用户答「A」时回注给模型的只有「问题原文 + 字母A」——A 指什么在上下文里
  // 无从解析，大脑只好自己编（实际编成了"继续只做分析"）。修复：挂起时快照提案原文，回答
  // 回来时与答案一起还给模型。断言的是【解析 A 所需的原文在场】，不是断言模型怎么解释它。
  it("carries the proposal prose (where the options actually live) into the answer frame", async () => {
    const proposal = [
      "根据本体，当前只有 createJD 能生成。",
      "路线 A：直接生成 createJD 的完整代码（已有设计稿）。",
      "路线 B：补齐其他 5 个 agent 的工具契约，然后并行生成全部 6 个。",
      "你想选哪条？",
    ].join("\n");
    scriptedTurns.push([{ t: "done", content: proposal }], [{ t: "done", content: "开始生成 createJD。" }]);
    let answered = false;
    const ports: FactoryPorts = {
      ontology: baseOntologyPort,
      sandbox: baseSandboxPort,
      reflection: baseReflectionPort,
      conversation: {
        has: async () => false,
        load: async () => null,
        save: async () => undefined,
        drainHumanMessages: async () => {
          if (seenTurns.length >= 1 && !answered) { answered = true; return [{ text: "[澄清回答] A", actor: "usr-human" }]; }
          return [];
        },
      },
    };

    for await (const _event of runBrain({ domain: "dom", goal: "你能生成哪个agent?", ports, conversationId: "proposal-conv" })) { /* drain */ }

    expect(seenTurns).toHaveLength(2);
    const turn2 = seenTurns[1]!.map((m) => String(m.content ?? "")).join("\n");
    expect(turn2).toContain("[用户澄清回答]");
    expect(turn2).toContain("用户回答：A");
    // 关键：解析「A」所需的原文必须在场——否则 A 只是个无意义的字母。
    expect(turn2).toContain("你提问时给用户的原话");
    expect(turn2).toContain("路线 A：直接生成 createJD 的完整代码");
    expect(turn2).toContain("路线 B：补齐其他 5 个 agent");
    // 并且明确告诉模型：按你自己提过的选项理解它，别另编一个。
    expect(turn2).toContain("别给它另编一个解释");
  });

  it("extracts a punctuation-free trailing request instead of using the long report as the question", async () => {
    const report = `检查报告开头：${"这是一条已经完成的只读检查记录。".repeat(90)}`;
    scriptedTurns.push(
      [{ t: "done", content: `${report}\n\n请确认选择 A 还是 B。` }],
      [{ t: "done", content: "收到，继续执行。" }],
    );
    let answered = false;
    const ports: FactoryPorts = {
      ontology: baseOntologyPort,
      sandbox: baseSandboxPort,
      reflection: baseReflectionPort,
      conversation: {
        has: async () => false,
        load: async () => null,
        save: async () => undefined,
        drainHumanMessages: async () => {
          if (seenTurns.length >= 1 && !answered) {
            answered = true;
            return [{ text: "选择 A", actor: "usr-human" }];
          }
          return [];
        },
      },
    };

    const events = [];
    for await (const event of runBrain({ domain: "dom", goal: "检查配置", ports, conversationId: "tail-request-conv" })) {
      events.push(event);
    }

    const parkFrame = events.find((event): event is Extract<typeof event, { t: "clarify" }> =>
      event.t === "clarify" && event.awaitingAnswer === true);
    expect(parkFrame?.question).toBe("请确认选择 A 还是 B。");
    expect(parkFrame?.question).not.toContain("检查报告开头");
    expect(events).toContainEqual(expect.objectContaining({ t: "clarify", awaitingAnswer: false }));
    expect(seenTurns).toHaveLength(2);
  });

  it("does not park when request-like words only appear inside report prose", async () => {
    scriptedTurns.push([{
      t: "done",
      content: "检查完成。字段文案中包含“请选择一个平台”，这是对现状的引用。所有只读检查均已结束。",
    }]);
    const ports: FactoryPorts = {
      ontology: baseOntologyPort,
      sandbox: baseSandboxPort,
      reflection: baseReflectionPort,
      conversation: {
        has: async () => false,
        load: async () => null,
        save: async () => undefined,
        drainHumanMessages: async () => [],
      },
    };

    const events = [];
    for await (const event of runBrain({ domain: "dom", goal: "只读检查", ports, conversationId: "report-only-conv" })) {
      events.push(event);
    }

    expect(events.some((event) => event.t === "clarify" && event.awaitingAnswer === true)).toBe(false);
    expect(seenTurns).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ t: "done" });
  });
});

describe("#ASK-PARK-MUTEX — ask_user cannot ship in the same assistant turn", () => {
  beforeEach(() => {
    vi.stubEnv("FACTORY_AI_MODEL", "test/park-model");
    seenTurns.splice(0);
    scriptedTurns.splice(0);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("refuses a finish batched with ask_user (in EITHER ordering) and parks on the question", async () => {
    const finishRan = vi.fn();
    const askTool: BrainTool = {
      name: "ask_user",
      description: "test ask_user",
      parameters: { type: "object", properties: {} },
      async execute(_args, ctx) {
        ctx.clarifyPrompt = { question: "要继续吗？" };
        ctx.awaitingClarify = true;
        ctx.emit({ t: "clarify", question: "要继续吗？", awaitingAnswer: true });
        return { ok: true, summary: "parked" };
      },
    };
    const finishTool: BrainTool = {
      name: "finish",
      description: "test finish",
      parameters: { type: "object", properties: {} },
      async execute() { finishRan(); return { ok: true, summary: "shipped" }; },
    };
    // Hardest ordering: finish FIRST in the batch — the mutex must still refuse it before it executes.
    scriptedTurns.push(
      [{ t: "tool_calls", content: "", calls: [{ id: "f", name: "finish", args: "{}" }, { id: "a", name: "ask_user", args: "{}" }] }],
      [{ t: "done", content: "已按回答继续。" }],
    );
    let answered = false;
    const ports: FactoryPorts = {
      ontology: baseOntologyPort,
      sandbox: baseSandboxPort,
      reflection: baseReflectionPort,
      conversation: {
        has: async () => false,
        load: async () => null,
        save: async () => undefined,
        drainHumanMessages: async () => {
          if (seenTurns.length >= 1 && !answered) { answered = true; return [{ text: "继续", actor: "usr-human" }]; }
          return [];
        },
      },
    };

    const events = [];
    for await (const event of runBrain({ domain: "dom", goal: "开始", ports, tools: [askTool, finishTool], conversationId: "mutex-conv" })) {
      events.push(event);
    }

    // finish was REFUSED by the mutex (never executed) and surfaced a structured steer…
    expect(finishRan).not.toHaveBeenCalled();
    expect(events).toContainEqual(expect.objectContaining({ t: "tool.result", name: "finish", ok: false, summary: expect.stringContaining("暂不执行 finish") }));
    // …while ask_user parked the run, which then resumed on the answer (2nd model turn ran).
    expect(events).toContainEqual(expect.objectContaining({ t: "clarify", awaitingAnswer: true }));
    expect(seenTurns).toHaveLength(2);
    expect(seenTurns[1]!.map((m) => String(m.content ?? "")).join("\n")).toContain("[用户澄清回答]");
  });

  it("turns a typed next=ask_user tool result into a real park and stops later batch tools", async () => {
    const laterRan = vi.fn();
    const blocker: BrainTool = {
      name: "inspect_config",
      description: "discovers a configuration blocker",
      parameters: { type: "object", properties: {} },
      async execute() {
        return {
          ok: false,
          summary: "测试环境还没配好。",
          output: {
            next: "ask_user",
            reason: "sandbox_config_missing",
            question: "请先配置独立的 Inngest 测试环境，完成后告诉我可以继续。",
            context: "沙箱只允许使用与生产隔离的 broker 和凭据。",
            options: [
              { label: "已配置，可以继续", value: "SANDBOX_CONFIGURED" },
              { label: "暂不继续", value: "STOP" },
            ],
            missing: ["sandbox broker", "sandbox credentials"],
          },
        };
      },
    };
    const later: BrainTool = {
      name: "design_after_blocker",
      description: "must not run while clarification is pending",
      parameters: { type: "object", properties: {} },
      async execute() { laterRan(); return { ok: true, summary: "ran" }; },
    };
    scriptedTurns.push(
      [{
        t: "tool_calls",
        content: "",
        calls: [
          { id: "b", name: "inspect_config", args: "{}" },
          { id: "l", name: "design_after_blocker", args: "{}" },
        ],
      }],
      [{ t: "done", content: "已收到配置确认。" }],
    );
    let answered = false;
    const ports: FactoryPorts = {
      ontology: baseOntologyPort,
      sandbox: baseSandboxPort,
      reflection: baseReflectionPort,
      conversation: {
        has: async () => false,
        load: async () => null,
        save: async () => undefined,
        drainHumanMessages: async () => {
          if (seenTurns.length >= 1 && !answered) {
            answered = true;
            return [{ text: "独立测试环境已配置", actor: "usr-human" }];
          }
          return [];
        },
      },
    };

    const events = [];
    for await (const event of runBrain({
      domain: "dom",
      goal: "检查并继续",
      ports,
      tools: [blocker, later],
      conversationId: "structured-ask-conv",
    })) events.push(event);

    expect(laterRan).not.toHaveBeenCalled();
    expect(events).toContainEqual(expect.objectContaining({
      t: "clarify",
      question: expect.stringContaining("独立的 Inngest 测试环境"),
      options: expect.arrayContaining([
        expect.objectContaining({ label: "已配置，可以继续", value: "SANDBOX_CONFIGURED" }),
      ]),
      context: expect.stringContaining("与生产隔离"),
      awaitingAnswer: true,
    }));
    expect(events).toContainEqual(expect.objectContaining({
      t: "tool.result",
      name: "design_after_blocker",
      ok: false,
      summary: expect.stringContaining("运行已挂起"),
    }));
    expect(seenTurns).toHaveLength(2);
    expect(seenTurns[1]!.map((message) => String(message.content ?? "")).join("\n"))
      .toContain("独立测试环境已配置");
  });

  it("replays an answered structured blocker instead of resetting it to pending", async () => {
    const blocker: BrainTool = {
      name: "inspect_repeat_blocker",
      description: "returns the same typed blocker twice",
      parameters: { type: "object", properties: {} },
      async execute() {
        return {
          ok: false,
          summary: "还需要选择连接方式。",
          output: {
            next: "ask_user",
            question: "请选择连接方式 A 或 B。",
            options: [
              { label: "方式 A", value: "A" },
              { label: "方式 B", value: "B" },
            ],
          },
        };
      },
    };
    scriptedTurns.push(
      [{ t: "tool_calls", content: "", calls: [{ id: "b1", name: blocker.name, args: "{}" }] }],
      [{ t: "tool_calls", content: "", calls: [{ id: "b2", name: blocker.name, args: "{}" }] }],
      [{ t: "done", content: "已按 A 继续。" }],
    );
    let answered = false;
    const ports: FactoryPorts = {
      ontology: baseOntologyPort,
      sandbox: baseSandboxPort,
      reflection: baseReflectionPort,
      conversation: {
        has: async () => false,
        load: async () => null,
        save: async () => undefined,
        drainHumanMessages: async () => {
          if (seenTurns.length >= 1 && !answered) {
            answered = true;
            return [{ text: "A", actor: "usr-human" }];
          }
          return [];
        },
      },
    };
    const events = [];
    for await (const event of runBrain({
      domain: "dom",
      goal: "检查连接",
      ports,
      tools: [blocker],
      conversationId: "structured-repeat-conv",
    })) events.push(event);

    expect(events.filter((event) => event.t === "clarify" && event.awaitingAnswer)).toHaveLength(1);
    const second = events.find((event) => event.t === "tool.result" && event.id === "b2");
    expect(second).toMatchObject({ summary: expect.stringContaining("此前已经由用户回答：A") });
    expect(seenTurns).toHaveLength(3);
  });

  it("requires sandbox_run to be the only tool in its assistant turn", async () => {
    const sandboxRan = vi.fn();
    const sandboxTool: BrainTool = {
      name: "sandbox_run",
      description: "side effect",
      parameters: { type: "object", properties: {} },
      async execute() { sandboxRan(); return { ok: true, summary: "deployed" }; },
    };
    const inspectTool: BrainTool = {
      name: "inspect",
      description: "read only",
      parameters: { type: "object", properties: {} },
      async execute() { return { ok: true, summary: "inspected" }; },
    };
    scriptedTurns.push([{
      t: "tool_calls",
      content: "",
      calls: [
        { id: "s", name: "sandbox_run", args: "{}" },
        { id: "i", name: "inspect", args: "{}" },
      ],
    }]);
    const ports: FactoryPorts = {
      ontology: baseOntologyPort,
      sandbox: baseSandboxPort,
      reflection: baseReflectionPort,
      conversation: {
        has: async () => false,
        load: async () => null,
        save: async () => undefined,
        drainHumanMessages: async () => [],
      },
    };

    const events = [];
    for await (const event of runBrain({ domain: "dom", goal: "测试", ports, tools: [sandboxTool, inspectTool] })) {
      events.push(event);
    }

    expect(sandboxRan).not.toHaveBeenCalled();
    expect(events).toContainEqual(expect.objectContaining({
      t: "tool.result",
      name: "sandbox_run",
      ok: false,
      summary: expect.stringContaining("必须在没有其它并行工具调用的一轮里单独执行"),
    }));
  });
});

describe("test fixture clarification safety", () => {
  beforeEach(() => {
    vi.stubEnv("FACTORY_AI_MODEL", "test/fixture-safety-model");
    seenTurns.splice(0);
    scriptedTurns.splice(0);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("never turns key:value clarification text into a fixture and redacts an accidentally pasted secret", async () => {
    const secret = "sk-accidentally-pasted-secret";
    const snapshots: Array<{ ctx: Record<string, unknown>; messages: unknown[] }> = [];
    const askForFixture: BrainTool = {
      name: "request_fixture_data",
      description: "test-only fixture clarification",
      parameters: { type: "object", properties: {} },
      async execute(_args, ctx) {
        ctx.testCases = [{ id: "tc1", name: "case", scenario: "safe", kind: "pass", entryEvent: "START", payload: { candidate_email: "sandbox@example.invalid" }, expectedOutcome: "done" }];
        ctx.clarifyPrompt = {
          question: "请提供 sandbox 测试字段；不要粘贴凭证。",
          context: "补全 sandbox 安全测试数据；回答后必须显式调用 supply_test_data 并重新审批，禁止直接写入",
        };
        ctx.awaitingClarify = true;
        ctx.emit({ t: "clarify", question: ctx.clarifyPrompt.question, context: ctx.clarifyPrompt.context, awaitingAnswer: true });
        return { ok: true, summary: "waiting" };
      },
    };
    scriptedTurns.push(
      [{ t: "tool_calls", content: "", calls: [{ id: "fixture", name: askForFixture.name, args: "{}" }] }],
      [{ t: "done", content: "已停止收集凭证。" }],
    );
    let answered = false;
    const ports: FactoryPorts = {
      ontology: baseOntologyPort,
      sandbox: baseSandboxPort,
      reflection: baseReflectionPort,
      conversation: {
        has: async () => false,
        load: async () => null,
        save: async (_id, snapshot) => { snapshots.push(structuredClone(snapshot)); },
        drainHumanMessages: async () => {
          if (seenTurns.length >= 1 && !answered) {
            answered = true;
            return [{ text: `api_key: ${secret}`, actor: "usr-human" }];
          }
          return [];
        },
      },
    };

    const events = [];
    for await (const event of runBrain({
      domain: "dom",
      goal: "准备安全测试数据",
      ports,
      tools: [askForFixture],
      conversationId: "fixture-secret-conv",
    })) events.push(event);

    const serialized = JSON.stringify({ seenTurns, snapshots, events });
    expect(serialized).not.toContain(secret);
    expect(serialized).toContain("[REDACTED]");
    expect(events).toContainEqual(expect.objectContaining({ t: "message", text: expect.stringContaining("integration profile") }));
    expect(snapshots.at(-1)?.ctx.testDataOverrides).toBeUndefined();
    expect((snapshots.at(-1)?.ctx.testCases as Array<{ payload: Record<string, unknown> }>)[0]!.payload).toEqual({ candidate_email: "sandbox@example.invalid" });
    expect(seenTurns[1]!.map((message) => String(message.content ?? "")).join("\n")).toContain("未写入 fixture");
  });
});

describe("test approval third state — supply_data", () => {
  beforeEach(() => {
    vi.stubEnv("FACTORY_AI_MODEL", "test/supply-data-model");
    seenTurns.splice(0);
    scriptedTurns.splice(0);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("keeps approval closed, rejects sandbox, applies data atomically, then asks for approval again", async () => {
    const sandboxRan = vi.fn();
    const snapshots: Array<{ ctx: Record<string, unknown> }> = [];
    const propose: BrainTool = {
      name: "propose_cases",
      description: "test-only case proposal",
      parameters: { type: "object", properties: {} },
      async execute(_args, ctx) {
        ctx.testCases = [{
          id: "case-1",
          name: "resume fixture",
          scenario: "parse a supplied resume",
          kind: "pass",
          entryEvent: "RESUME_RECEIVED",
          payload: { resume: { text: "placeholder" } },
          expectedOutcome: "RESUME_PARSED",
        }];
        ctx.awaitingApproval = true;
        ctx.testDataSupplementPending = false;
        ctx.emit({ t: "test.cases", cases: ctx.testCases, awaitingApproval: true });
        return { ok: true, summary: "cases proposed" };
      },
    };
    const sandbox: BrainTool = {
      name: "sandbox_run",
      description: "must remain blocked while data is being supplied",
      parameters: { type: "object", properties: {} },
      async execute() {
        sandboxRan();
        return { ok: true, summary: "sandbox ran" };
      },
    };
    const supplyData: BrainTool = {
      name: "supply_test_data",
      description: "test-only atomic fixture update",
      parameters: { type: "object", properties: {} },
      async execute(_args, ctx) {
        expect(ctx.testDataSupplementPending).toBe(true);
        const current = structuredClone(ctx.testCases ?? []);
        current[0]!.payload = { resume: { text: "sanitized sandbox resume" } };
        ctx.testCases = current;
        ctx.testDataSupplementPending = false;
        ctx.awaitingApproval = true;
        ctx.lastSandbox = null;
        ctx.sandboxDesignReview = undefined;
        ctx.emit({ t: "test.cases", cases: current, awaitingApproval: true });
        return { ok: true, summary: "fixture updated; approval required" };
      },
    };

    scriptedTurns.push(
      [{ t: "tool_calls", content: "", calls: [{ id: "p", name: "propose_cases", args: "{}" }] }],
      [{ t: "tool_calls", content: "", calls: [{ id: "blocked", name: "sandbox_run", args: "{}" }] }],
      [{ t: "tool_calls", content: "", calls: [{ id: "supply", name: "supply_test_data", args: "{}" }] }],
      [{ t: "done", content: "测试数据已重新确认。" }],
    );

    let suppliedDecision = false;
    let approvedDecision = false;
    const ports: FactoryPorts = {
      ontology: baseOntologyPort,
      sandbox: baseSandboxPort,
      reflection: baseReflectionPort,
      conversation: {
        has: async () => false,
        load: async () => null,
        save: async (_id, snapshot) => {
          snapshots.push(structuredClone(snapshot) as { ctx: Record<string, unknown> });
        },
        drainHumanMessages: async () => {
          if (seenTurns.length >= 1 && !suppliedDecision) {
            suppliedDecision = true;
            return [{ text: "[测试用例决策: 补数据]", actor: "usr-human" }];
          }
          if (seenTurns.length >= 3 && !approvedDecision) {
            approvedDecision = true;
            return [{ text: "[测试用例决策: 执行]", actor: "usr-human" }];
          }
          return [];
        },
      },
    };

    const events = [];
    for await (const event of runBrain({
      domain: "dom",
      goal: "补齐测试数据后执行",
      ports,
      tools: [propose, sandbox, supplyData],
      conversationId: "supply-data-third-state",
    })) events.push(event);

    expect(sandboxRan).not.toHaveBeenCalled();
    expect(events).toContainEqual(expect.objectContaining({
      t: "test.decision",
      decision: "supply_data",
    }));
    expect(events).toContainEqual(expect.objectContaining({
      t: "tool.result",
      name: "sandbox_run",
      ok: false,
      summary: expect.stringContaining("当前正在补测试数据"),
    }));
    expect(events).toContainEqual(expect.objectContaining({
      t: "test.cases",
      awaitingApproval: true,
      cases: [expect.objectContaining({ payload: { resume: { text: "sanitized sandbox resume" } } })],
    }));
    expect(events).toContainEqual(expect.objectContaining({
      t: "test.decision",
      decision: "approve",
    }));
    expect(seenTurns).toHaveLength(4);
    const lastCtx = snapshots.at(-1)?.ctx;
    expect(lastCtx?.testDataSupplementPending).toBe(false);
    expect(lastCtx?.awaitingApproval).toBe(false);
  });
});
