import { describe, it, expect } from "vitest";
import { extractJson, runSpecialists, buildOntologySpecialistTasks, synthesizeUnderstanding, parseUserIntent, isContinueGoal, intentTagOf, expectsBuildDeliverable, type SpecialistLlm } from "./specialists";
import type { BrainEvent } from "./brain-types";
import type { DomainOntology } from "./ontology-types";

// Specialists — the LIGHT nesting channel of the shared reasoning core (架构书 §4.5).
// Everything here drives the orchestration with an injected fake llm: no provider calls.

function ont(overrides: Partial<DomainOntology> = {}): DomainOntology {
  return {
    domainId: "rec",
    objects: [{ id: "Candidate", name: "候选人" } as DomainOntology["objects"][number]],
    rules: [{ id: "1-1", businessLogicRuleName: "身份去重规则", standardizedLogicRule: "手机号优先判重" }],
    actions: [
      { id: "a", name: "processResume", actor: ["Agent"], trigger: ["RESUME_DOWNLOADED"], triggered_event: ["RESUME_PROCESSED"], target_objects: ["Candidate"], tool_use: [], system_prompt: "", user_prompt: "" },
    ],
    events: [{ name: "RESUME_PROCESSED", payload: { source_action: "processResume", event_data: [], state_mutations: [] } }],
    workflow: [],
    source: "snapshot",
    ...overrides,
  } as DomainOntology;
}

function emitCollector() {
  const events: BrainEvent[] = [];
  return { events, ctx: { emit: (e: BrainEvent) => events.push(e) } };
}

describe("extractJson — tolerant structured-output parsing", () => {
  it("parses fenced, prosed, and bare JSON; survives trailing prose", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('好的，结论如下：{"a":[1,2],"b":{"c":3}} 以上。')).toEqual({ a: [1, 2], b: { c: 3 } });
    expect(extractJson("[1,2,3] 附注")).toEqual([1, 2, 3]);
    expect(extractJson("没有任何结构")).toBeNull();
    expect(extractJson('{"broken": ')).toBeNull();
  });
});

describe("runSpecialists — parallel role calls with subagent events", () => {
  it("runs all tasks, parses JSON outputs, emits start/done per specialist", async () => {
    const { events, ctx } = emitCollector();
    const llm: SpecialistLlm = async (_s, u) => `{"keyFindings":["发现:${u.length}"],"risks":[],"ambiguities":["歧义A"]}`;
    const rs = await runSpecialists(ctx, [
      { id: "x", role: "x 专家", system: "s", user: "u1" },
      { id: "y", role: "y 专家", system: "s", user: "u2" },
    ], { llm });
    expect(rs).toHaveLength(2);
    expect(rs.every((r) => r.ok)).toBe(true);
    expect((rs[0]!.output as { ambiguities: string[] }).ambiguities).toEqual(["歧义A"]);
    const kinds = events.map((e) => e.t);
    expect(kinds.filter((k) => k === "subagent.start")).toHaveLength(2);
    expect(kinds.filter((k) => k === "subagent.done")).toHaveLength(2);
    expect(String((events[0] as { task: string }).task)).toContain("认知专家");
  });

  it("#EXPERT-REASONING deepen: each specialist runs a SECOND self-critique round, surfaced as a reasoning.step", async () => {
    const { events, ctx } = emitCollector();
    const seen: Array<{ system: string; purpose?: string }> = [];
    const llm: SpecialistLlm = async (s, _u, o) => { seen.push({ system: s, purpose: o?.purpose }); return o?.purpose?.endsWith(".deepen") ? '{"keyFindings":["深化后更完整","补漏一项"]}' : '{"keyFindings":["初稿一项"]}'; };
    const rs = await runSpecialists(ctx, [
      { id: "rules", role: "rules 专家", system: "s", user: "u", census: "规则清单（2）：A、B" },
    ], { llm, deepen: true });
    // two passes: draft + deepen
    expect(seen.map((c) => c.purpose)).toEqual(["specialist:rules", "specialist:rules.deepen"]);
    // the deepen pass re-read the census, NOT via the original system prompt
    expect(seen[1]!.system).toContain("复核者");
    // the refined output wins
    expect((rs[0]!.output as { keyFindings: string[] }).keyFindings).toContain("深化后更完整");
    // the second round is visible + foldable
    expect(events.some((e) => e.t === "reasoning.step" && String((e as { strategy?: string }).strategy) === "reflection")).toBe(true);
  });

  it("deepen is best-effort: a failing 2nd pass keeps the draft, still ok", async () => {
    const { ctx } = emitCollector();
    const llm: SpecialistLlm = async (_s, _u, o) => { if (o?.purpose?.endsWith(".deepen")) throw new Error("deepen down"); return '{"keyFindings":["初稿"]}'; };
    const rs = await runSpecialists(ctx, [{ id: "x", role: "x 专家", system: "s", user: "u", census: "c" }], { llm, deepen: true });
    expect(rs[0]!.ok).toBe(true);
    expect((rs[0]!.output as { keyFindings: string[] }).keyFindings).toEqual(["初稿"]);
  });

  it("one failing specialist degrades to ok:false without breaking the rest", async () => {
    const { ctx } = emitCollector();
    const llm: SpecialistLlm = async (_s, u) => {
      if (u === "bad") throw new Error("provider down");
      return '{"keyFindings":["ok"]}';
    };
    const rs = await runSpecialists(ctx, [
      { id: "good", role: "好专家", system: "s", user: "fine" },
      { id: "bad", role: "坏专家", system: "s", user: "bad" },
    ], { llm });
    expect(rs.find((r) => r.id === "good")!.ok).toBe(true);
    expect(rs.find((r) => r.id === "bad")!.ok).toBe(false);
    expect(rs.find((r) => r.id === "bad")!.summary).toContain("provider down");
  });
});

describe("buildOntologySpecialistTasks — four focused context windows", () => {
  it("builds objects/rules/actions/events tasks, each carrying ITS dimension in full", () => {
    const tasks = buildOntologySpecialistTasks(ont());
    expect(tasks.map((t) => t.id)).toEqual(["objects", "rules", "actions", "events"]);
    expect(tasks.find((t) => t.id === "rules")!.user).toContain("身份去重规则"); // full rule payload, not a name list
    expect(tasks.find((t) => t.id === "objects")!.user).toContain("候选人");
    expect(tasks.find((t) => t.id === "events")!.user).toContain("RESUME_PROCESSED");
    for (const t of tasks) expect(t.user).toContain("全域概况"); // cross-dimension census present
    for (const t of tasks) expect(t.system).toContain("绝不编造"); // fidelity contract in every role prompt
    // #EXPERT-REASONING — every task carries a compact roster for the deepen pass to check against
    for (const t of tasks) expect(t.census && t.census.length > 0).toBe(true);
    expect(tasks.find((t) => t.id === "rules")!.census).toContain("逐条核对不要漏");
  });
});

describe("synthesizeUnderstanding — reduce with deterministic fallback", () => {
  const results = [
    { id: "rules", role: "rules 专家", ok: true, output: { keyFindings: ["规则闸集中在身份去重"] }, summary: "rules 专家：1 项发现 · 0 项风险 · 0 处歧义" },
    { id: "events", role: "events 专家", ok: false, output: null, summary: "events 专家 分析失败：x" },
  ];
  it("uses the synthesis llm when it works", async () => {
    const llm: SpecialistLlm = async () => "整体理解：要造 1 个 agent；规则闸=身份去重。";
    const out = await synthesizeUnderstanding(results, ont(), { llm });
    expect(out).toContain("整体理解");
  });
  it("degrades to a deterministic stitch of specialist summaries when synthesis fails", async () => {
    const llm: SpecialistLlm = async () => { throw new Error("boom"); };
    const out = await synthesizeUnderstanding(results, ont(), { llm });
    expect(out).toContain("确定性拼接");
    expect(out).toContain("rules 专家");
  });
  it("returns empty when no specialist succeeded (caller falls back to v1)", async () => {
    const out = await synthesizeUnderstanding(results.map((r) => ({ ...r, ok: false })), ont(), { llm: async () => "x" });
    expect(out).toBe("");
  });
  // #PERSPECTIVES — 合成器现在同时收结构维度与业务视角专家的结论，prompt 必须点名覆盖视角要点，
  // 且不再把专家数写死为「四位」（镜头加入后数量可变）。
  it("synthesis prompt covers business-perspective conclusions (lens results merge into the same reduce)", async () => {
    let seenSystem = "";
    const llm: SpecialistLlm = async (system) => { seenSystem = system; return "整体理解"; };
    const withLens = [...results, { id: "lens.operation", role: "运营视角", ok: true, output: { keyFindings: ["解析批量环节无监控事件"] }, summary: "运营视角：1 项发现" }];
    await synthesizeUnderstanding(withLens, ont(), { llm });
    expect(seenSystem).toContain("业务视角");
    expect(seenSystem).not.toContain("四位维度专家");
  });
});

describe("parseUserIntent — the intent gate accumulates and never blocks", () => {
  it("parses a goal into one structured line", async () => {
    const llm: SpecialistLlm = async () => "[生成] 为招聘域生成全部智能体 ｜ 约束: 规则写进指令 ｜ 期望产物: 可上线 functions";
    const out = await parseUserIntent("生成全部智能体，把规则写进指令", undefined, { llm });
    expect(out).toContain("[生成]");
    expect(out.split("\n")).toHaveLength(1);
  });
  it("appends follow-up intents to the prior history", async () => {
    const llm: SpecialistLlm = async () => "[修改] 只重做 matchResume ｜ 约束: 无 ｜ 期望产物: 新版本";
    const out = await parseUserIntent("只重做 matchResume", "[生成] 初始目标 ｜ 约束: 无 ｜ 期望产物: functions", { llm });
    expect(out.split("\n")).toHaveLength(2);
    expect(out).toContain("+ [修改]");
  });
  it("llm failure degrades to recording the raw goal (fail-safe, appended)", async () => {
    const llm: SpecialistLlm = async () => { throw new Error("down"); };
    const out = await parseUserIntent("补充：金融客户优先", "[生成] 初始", { llm });
    expect(out).toContain("[生成] 初始");
    expect(out).toContain("追加：补充：金融客户优先");
  });
});

describe("intent gate — 继续类短语旁路 + 期望产物确定性纠偏（分析→提问→继续→再分析 死循环修复）", () => {
  it("isContinueGoal matches short affirmatives, not real goals", () => {
    for (const g of ["继续", "请继续", "开始吧", "开始生成", "好的", "是", "确认", "OK", "go", "继续。"]) expect(isContinueGoal(g), g).toBe(true);
    for (const g of ["继续分析这个本体的规则部分", "重新生成 matchResume", "开始之前先回答我一个问题", ""]) expect(isContinueGoal(g), g).toBe(false);
  });
  it("isContinueGoal covers ENGLISH continue phrases (the analyze→ask→continue loop guard)", () => {
    for (const g of ["continue", "Proceed", "go ahead", "sure", "yep", "yeah", "confirm", "confirmed", "do it", "start", "go on", "agree", "agreed", "yes please"]) expect(isContinueGoal(g), g).toBe(true);
    for (const g of ["continue analyzing the rules", "start over with matchResume", "proceed with caution because…"]) expect(isContinueGoal(g), g).toBe(false);
  });
  it("expectsBuildDeliverable reads the 期望产物 segment only", () => {
    expect(expectsBuildDeliverable("[分析] 构建本体并生成智能体 ｜ 约束: 无 ｜ 期望产物: 可运行的智能体代码、试运行日志与验证报告")).toBe(true);
    expect(expectsBuildDeliverable("[分析] 解读本体 ｜ 约束: 无 ｜ 期望产物: 一份 HTML 分析报告")).toBe(false);
    expect(expectsBuildDeliverable("没有产物段的行")).toBe(false);
  });
  it("#BLUEPRINT: a diagram/flow/blueprint deliverable is ANALYSIS even when it names 'agent'", () => {
    // The exact misroute: "即将设计的 agents 的整体流程图" contains "agent" but is a diagram, not a build.
    expect(expectsBuildDeliverable("[分析] 梳理事件流 ｜ 约束: 无 ｜ 期望产物: 即将设计的 agents 的整体流程图")).toBe(false);
    expect(expectsBuildDeliverable("[分析] 梳理业务 ｜ 约束: 无 ｜ 期望产物: 一张业务流程图与 agent 蓝图")).toBe(false);
    expect(expectsBuildDeliverable("[分析] 画时序 ｜ 约束: 无 ｜ 期望产物: agent 之间的时序图")).toBe(false);
    // …but if it ALSO demands runnable/deploy artifacts, the build signal wins.
    expect(expectsBuildDeliverable("[分析] 先画图再落地 ｜ 约束: 无 ｜ 期望产物: agent 流程图 + 可运行的智能体代码")).toBe(true);
    expect(expectsBuildDeliverable("[分析] 造并部署 ｜ 约束: 无 ｜ 期望产物: 能跑通并部署的 agent 流程")).toBe(true);
  });
  it("#BLUEPRINT: llm says [分析] with a flow-diagram deliverable → stays [分析] (not flipped to 生成)", async () => {
    const llm: SpecialistLlm = async () => "[分析] 读取本体梳理即将设计的 agents 整体流程图 ｜ 约束: 无 ｜ 期望产物: agents 的整体流程图";
    const out = await parseUserIntent("帮我读取 Ontology，梳理出即将设计的 agents 的整体流程图", undefined, { llm });
    expect(out).toContain("[分析]");
    expect(out).not.toContain("[生成]");
  });
  it("『继续』does NOT re-classify via llm — it inherits the goal and upgrades to [生成] when the prior deliverable is build-shaped", async () => {
    let llmCalled = false;
    const llm: SpecialistLlm = async () => { llmCalled = true; return "[分析] 不该走到这"; };
    const prior = "[分析] 基于上传的action数据构建业务领域Ontology，生成可执行的智能体并验证完整事件链 ｜ 约束: 智能体必须可实际运行 ｜ 期望产物: 可运行的智能体代码、试运行日志与验证报告";
    const out = await parseUserIntent("继续", prior, { llm });
    expect(llmCalled).toBe(false);
    const last = out.split("\n").pop()!;
    expect(last).toContain("[生成]");
    expect(last).toContain("继续推进既定目标");
    expect(intentTagOf(last)).toBe("生成");
  });
  it("『继续』after a genuinely read-only intent stays [分析]", async () => {
    const llm: SpecialistLlm = async () => { throw new Error("unused"); };
    const out = await parseUserIntent("继续", "[分析] 解读本体结构 ｜ 约束: 无 ｜ 期望产物: 无", { llm });
    expect(out.split("\n").pop()!).toContain("[分析]");
  });
  // #INTENT-CONTINUE 回归 —— 危险的默认：旧版把纯应答词「好的/ok」也当 continue、绕过 LLM、
  // 且无标签时兜底成 [生成]。真实事故：AI 分析完，用户回「好的」(=我知道了) → 被判授权生成 →
  // 一路跑到真实沙箱部署。修复后：纯应答词【交回 LLM】结合上下文判，不再用正则替 AI 拍板。
  it("纯应答词「好的」不再走确定性快路径——交给 LLM 判（哪怕上一条是 build 形状也不擅自升级 [生成]）", async () => {
    let seenUser = "";
    const llm: SpecialistLlm = async (_s, u) => { seenUser = u; return "[其它] 用户在附和上一段分析 ｜ 约束: 无 ｜ 期望产物: 无"; };
    const priorBuild = "[生成] 造并部署智能体 ｜ 约束: 可运行 ｜ 期望产物: 可运行的智能体代码";
    const out = await parseUserIntent("好的", priorBuild, { llm });
    // 关键：走了 LLM（拿到了 priorIntent 上下文），而不是被正则直接判成 [生成]。
    expect(seenUser).toContain("此前意图");
    expect(out.split("\n").pop()!).toContain("[其它]");
  });
  it("无类型标签的 priorIntent + 明确推进词『继续』→ 不猜 [生成]，落到 LLM 判", async () => {
    let llmCalled = false;
    const llm: SpecialistLlm = async () => { llmCalled = true; return "[分析] LLM 重新判定 ｜ 约束: 无 ｜ 期望产物: 无"; };
    // priorIntent 来自 LLM 失败时的降级原文（无 [类型] 标签）。
    const out = await parseUserIntent("继续", "目标原文：看看这个域有哪些动作", { llm });
    expect(llmCalled).toBe(true); // 不再兜底成 [生成]
    expect(out).not.toContain("[生成]");
  });
  it("deterministic veto: llm says [分析] but its own parsed deliverable is build-shaped → rewritten to [生成]", async () => {
    const llm: SpecialistLlm = async () => "[分析] 基于action数据构建Ontology并生成智能体 ｜ 约束: 无 ｜ 期望产物: 可运行的智能体代码与试运行日志";
    const out = await parseUserIntent("我上传的action数据作为替代，请你分析，并生成能真正跑通的智能体", undefined, { llm });
    expect(out).toContain("[生成]");
    expect(out).not.toContain("[分析]");
  });
});
