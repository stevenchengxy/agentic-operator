import { describe, it, expect } from "vitest";
import { extractJson, runSpecialists, buildOntologySpecialistTasks, synthesizeUnderstanding, parseUserIntent, type SpecialistLlm } from "./specialists";
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
