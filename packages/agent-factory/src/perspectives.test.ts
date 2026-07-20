import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_LENS_IDS,
  STAKEHOLDER_LENSES,
  buildLensTasks,
  perspectivesEnabled,
  sanitizeLensSelection,
  selectLenses,
} from "./perspectives";
import type { SpecialistResult } from "./specialists";
import type { DomainOntology } from "./ontology-types";

// #PERSPECTIVES — 利益相关者视角库（业务客户/运营/后台对账/合规风险/外部协作方）。
// 与四维结构专家正交：结构维度回答「数据是什么」，视角回答「数据服务谁」。
// 设计铁律（system-prompt ②c，EMNLP24）：视角=「查什么」的结构焦点，不是人设扮演。

const ont = (): DomainOntology =>
  ({
    domainId: "rec",
    source: "snapshot",
    workflow: [],
    objects: [{ id: "Candidate", name: "候选人" }],
    events: [{ name: "RESUME_PROCESSED", payload: { source_action: "processResume", event_data: [], state_mutations: [] } }],
    rules: [{ id: "r1", name: "身份查重规则", enforcementLevel: "mandatory" }],
    actions: [
      {
        id: "a",
        name: "processResume",
        actor: ["Agent"],
        trigger: ["RESUME_DOWNLOADED"],
        triggered_event: ["RESUME_PROCESSED"],
        target_objects: [],
        tool_use: [],
        system_prompt: "",
        user_prompt: "",
      },
    ],
  }) as unknown as DomainOntology;

const dimResults: SpecialistResult[] = [
  { id: "rules", role: "rules 专家", ok: true, output: { keyFindings: ["强制规则集中在身份核验"], risks: ["规则9无闸口"], ambiguities: [] }, summary: "rules 专家：1 项发现" },
  { id: "events", role: "events 专家", ok: false, output: null, summary: "events 专家 分析失败：x" },
];

const PERSONA_RED_FLAGS = /资深|扮演|多年经验|世界级|顶级/;

afterEach(() => {
  delete process.env.FACTORY_PERSPECTIVES;
  vi.restoreAllMocks();
});

describe("#PERSPECTIVES — 内置视角库", () => {
  it("库含 5 个视角、id 唯一、默认三视角全部在库", () => {
    expect(STAKEHOLDER_LENSES.length).toBe(5);
    const ids = STAKEHOLDER_LENSES.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of DEFAULT_LENS_IDS) expect(ids).toContain(id);
  });

  it("无人设 lint：每个 focus/appliesWhen 都是「查什么」，不含人设修辞", () => {
    for (const l of STAKEHOLDER_LENSES) {
      expect(l.focus).not.toMatch(PERSONA_RED_FLAGS);
      expect(l.focus).not.toContain("你是");
      expect(l.appliesWhen).not.toMatch(PERSONA_RED_FLAGS);
      expect(l.label.length).toBeLessThanOrEqual(12);
      expect(l.focus.length).toBeGreaterThanOrEqual(40); // 焦点必须有实质内容
    }
  });
});

describe("#PERSPECTIVES — sanitizeLensSelection（纯函数钳制）", () => {
  const lib = (id: string) => STAKEHOLDER_LENSES.find((l) => l.id === id)!;

  it("库外 id 丢弃；有效不足 2 个 → null（触发调用方回退）", () => {
    expect(sanitizeLensSelection({ selected: [{ id: "nonsense", focus: "x".repeat(50) }] })).toBeNull();
    expect(sanitizeLensSelection({ selected: [{ id: "operation", focus: "y".repeat(50) }] })).toBeNull();
    expect(sanitizeLensSelection("not json at all")).toBeNull();
    expect(sanitizeLensSelection(null)).toBeNull();
  });

  it("重复 id 去重、超过 4 个钳到 4", () => {
    const sel = sanitizeLensSelection({
      selected: [
        { id: "operation", focus: "改写后的运营检视要点——盯监控信号与人工接管点，长度足够有效。" },
        { id: "operation", focus: "重复条目应被去掉" },
        { id: "business_customer", focus: "改写后的客户触点检视要点——盯 SLA 与失败告知路径，长度足够有效。" },
        { id: "backoffice", focus: "改写后的对账检视要点——盯审计事件与对账键来源，长度足够有效。" },
        { id: "compliance_risk", focus: "改写后的合规检视要点——盯敏感字段流经与补偿事件，长度足够有效。" },
        { id: "partner_integration", focus: "改写后的协作方检视要点——盯外部契约与回调承接，长度足够有效。" },
      ],
    });
    expect(sel).not.toBeNull();
    expect(sel!.length).toBe(4);
    expect(new Set(sel!.map((s) => s.id)).size).toBe(4);
  });

  it("人设口吻的改写 → 弃用改写、回落库原文、adapted:false；合法改写 → adapted:true", () => {
    const sel = sanitizeLensSelection({
      selected: [
        { id: "operation", focus: "你是资深运营专家，凭多年经验审视全局链路的监控与接管。" },
        { id: "backoffice", focus: "对账与审计检视——哪些动作改核心对象无事件留痕、对账键由哪个字段供给。" },
      ],
    })!;
    const op = sel.find((s) => s.id === "operation")!;
    expect(op.focus).toBe(lib("operation").focus);
    expect(op.adapted).toBe(false);
    const bo = sel.find((s) => s.id === "backoffice")!;
    expect(bo.adapted).toBe(true);
    expect(bo.focus).toContain("对账键");
  });

  it("改写长度出界（<20 或 >400）→ 回落库原文", () => {
    const sel = sanitizeLensSelection({
      selected: [
        { id: "operation", focus: "太短" },
        { id: "backoffice", focus: "长".repeat(500) },
      ],
    })!;
    expect(sel.find((s) => s.id === "operation")!.focus).toBe(lib("operation").focus);
    expect(sel.find((s) => s.id === "backoffice")!.focus).toBe(lib("backoffice").focus);
    expect(sel.every((s) => s.adapted === false)).toBe(true);
  });
});

describe("#PERSPECTIVES — selectLenses（LLM 选配，永不 throw）", () => {
  it("llm 抛错 → 默认三视角回退（库原文 focus、source:fallback）", async () => {
    const sel = await selectLenses(ont(), dimResults, { llm: async () => { throw new Error("gateway down"); } });
    expect(sel.source).toBe("fallback");
    expect(sel.lenses.map((l) => l.id).sort()).toEqual([...DEFAULT_LENS_IDS].sort());
    for (const l of sel.lenses) {
      expect(l.adapted).toBe(false);
      expect(l.focus).toBe(STAKEHOLDER_LENSES.find((x) => x.id === l.id)!.focus);
    }
  });

  it("llm 返回不可用选择（全库外 id）→ 同样回退默认三视角", async () => {
    const sel = await selectLenses(ont(), dimResults, { llm: async () => JSON.stringify({ selected: [{ id: "ceo", focus: "x".repeat(60) }] }) });
    expect(sel.source).toBe("fallback");
    expect(sel.lenses.length).toBe(DEFAULT_LENS_IDS.length);
  });

  it("llm 合法选择 → 采纳；user 载荷含全域概况、视角库与四维要点（只喂 ok 的维度）", async () => {
    const calls: Array<{ system: string; user: string }> = [];
    const sel = await selectLenses(ont(), dimResults, {
      llm: async (system, user) => {
        calls.push({ system, user });
        return JSON.stringify({
          selected: [
            { id: "operation", focus: "贴合招聘域的运营检视——简历解析批量环节的积压与人工复核接管点。", why: "批量链路" },
            { id: "partner_integration", focus: "贴合招聘域的协作方检视——RoboHire 回传契约与幂等键是否闭合。", why: "外部依赖" },
          ],
        });
      },
    });
    expect(sel.source).toBe("llm");
    expect(sel.lenses.map((l) => l.id).sort()).toEqual(["operation", "partner_integration"]);
    expect(sel.lenses.every((l) => l.adapted)).toBe(true);
    expect(calls.length).toBe(1);
    const { system, user } = calls[0]!;
    expect(system).toContain("视角");
    expect(system).not.toMatch(PERSONA_RED_FLAGS);
    expect(user).toContain("business_customer"); // 库全文在载荷里
    expect(user).toContain("1 动作"); // 全域概况
    expect(user).toContain("强制规则集中在身份核验"); // ok 维度要点
    expect(user).not.toContain("分析失败"); // 失败维度不喂
  });
});

describe("#PERSPECTIVES — buildLensTasks（跨维读者的任务构建）", () => {
  it("任务 id=lens.<id>、role=label、无 coverage/batches/census（镜头不做逐条覆盖声明）", () => {
    const lenses = STAKEHOLDER_LENSES.slice(0, 3).map((l) => ({ id: l.id, label: l.label, focus: l.focus, adapted: false }));
    const tasks = buildLensTasks(ont(), lenses, dimResults);
    expect(tasks.length).toBe(3);
    for (const t of tasks) {
      expect(t.id.startsWith("lens.")).toBe(true);
      expect(t.coverage).toBeUndefined();
      expect(t.batches).toBeUndefined();
      expect(t.census).toBeUndefined();
      expect(t.maxTokens).toBe(1400);
      expect(t.system).toContain(t.role);
      expect(t.system).not.toMatch(PERSONA_RED_FLAGS);
    }
    const roles = tasks.map((t) => t.role);
    expect(roles).toContain("客户价值视角");
  });

  it("共享 user 素材：全域概况+动作/事件/对象/规则名单（含强制级别）+四维已有要点", () => {
    const lenses = [{ id: "operation", label: "运营视角", focus: STAKEHOLDER_LENSES.find((l) => l.id === "operation")!.focus, adapted: false }];
    const [task] = buildLensTasks(ont(), lenses, dimResults);
    const u = task!.user;
    expect(u).toContain("processResume"); // 动作名单
    expect(u).toContain("RESUME_PROCESSED"); // 事件名单
    expect(u).toContain("候选人"); // 对象名单
    expect(u).toContain("身份查重规则[mandatory]"); // 规则名单带强制级别（复用 ruleEnforcementTag）
    expect(u).toContain("强制规则集中在身份核验"); // 四维要点
    expect(u).toContain("不要复述"); // 明示补充而非重复
    // 同一份素材在多任务间共享（构建一次）
    const two = buildLensTasks(ont(), STAKEHOLDER_LENSES.slice(0, 2).map((l) => ({ id: l.id, label: l.label, focus: l.focus, adapted: false })), dimResults);
    expect(two[0]!.user).toBe(two[1]!.user);
  });
});

describe("#PERSPECTIVES — kill-switch", () => {
  it("默认开；0/false/off 关", () => {
    delete process.env.FACTORY_PERSPECTIVES;
    expect(perspectivesEnabled()).toBe(true);
    for (const v of ["0", "false", "off", " OFF "]) {
      process.env.FACTORY_PERSPECTIVES = v;
      expect(perspectivesEnabled()).toBe(false);
    }
    process.env.FACTORY_PERSPECTIVES = "1";
    expect(perspectivesEnabled()).toBe(true);
  });
});
