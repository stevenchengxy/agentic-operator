import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// #BLUEPRINT-SCOPE / #JSON-DIAG 回归 —— 真实事故的后半段。
//
// 用户在"路线A=只生成 createJD / 路线B=补齐全部6个"里选了 A，AI 却去 build_blueprint 铺开
// 【6 个】agent 的蓝图，然后失败并报「蓝图推理没有返回可解析的 JSON（网关空响应或格式错误）」，
// 还写死 next=ask_user 把运行强制挂起去问用户。三处问题：
//   1. 没有任何参数能表达"只画 createJD"——focus 只是 digest 顶部一句软提示，全量动作清单照列；
//   2. 网关故障被逐字报成"格式错误"（当时 400k 上下文 + fast 档，多半是网关挂了）；
//   3. 网关故障/模型没吐 JSON 都不是用户能回答的问题，却去 ask_user 挂起用户。

// 注意：不能靠 mock `chatOnce` 来驱动 chatJsonResult —— chatJsonResult 在【模块内部】直接引用
// chatOnce，vi.mock 换掉的是导出给外部的绑定，拦不到内部调用（会真打网关）。
// 所以这里 mock `chatJsonResult` 本身：本文件测的是 build_blueprint 【怎么处理各种失败】；
// chatJsonResult 自己的提取/重试/诊断逻辑由 json-extract.test.ts 用 callFn 钩子真跑覆盖。
const captured: Array<{ sys: string; user: string }> = [];
type JsonResult = { ok: true; value: unknown } | { ok: false; failure: Record<string, unknown> };
const OK_BLUEPRINT: JsonResult = {
  ok: true,
  value: {
    phases: [{ id: "p1", title: "建档", intent: "生成 JD", anchors: [{ kind: "action", id: "createJD" }], steps: [] }],
    diagram_kinds: ["phase-flow"],
    reasoning: "ok",
  },
};
let nextResult: () => Promise<JsonResult> = async () => OK_BLUEPRINT;

vi.mock("./stream-gateway", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./stream-gateway")>();
  return {
    ...actual,
    isGatewayConfigured: () => true,
    setLlmCallContext: () => undefined,
    chatJsonResult: async (sys: string, user: string) => {
      captured.push({ sys, user });
      return nextResult();
    },
  };
});

import { FACTORY_TOOLS } from "./tools";
import type { BrainCtx } from "./brain-types";

const buildBlueprint = FACTORY_TOOLS.find((t) => t.name === "build_blueprint")!;

const ontology = {
  domainId: "Agents-generation",
  objects: [{ id: "Job_Posting", name: "职位" }],
  actions: [
    { id: "createJD", name: "createJD", actor: ["Agent"] },
    { id: "processResume", name: "processResume", actor: ["Agent"] },
    { id: "matchResume", name: "matchResume", actor: ["Agent"] },
  ],
  rules: [{ id: "r1", name: "规则一" }],
  events: [{ id: "REQUIREMENT_LOGGED", name: "REQUIREMENT_LOGGED" }],
  workflow: [],
  source: "allmeta",
};

const ctxOf = (extra: Partial<BrainCtx> = {}): BrainCtx =>
  ({
    ontology,
    domain: "Agents-generation",
    emit: () => undefined,
    budgetLedger: { tokens: 0, maxTokens: 10 }, // 低预算 → 跳过逐阶段深化，测试只关心范围/诊断
    ...extra,
  }) as unknown as BrainCtx;

describe("build_blueprint 范围表达力 (#BLUEPRINT-SCOPE)", () => {
  beforeEach(() => {
    vi.stubEnv("FACTORY_AI_MODEL", "test/m");
    captured.splice(0);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("传 actions → 动作清单【真的被裁剪】，模型看不到范围外的动作", async () => {
    await buildBlueprint.execute({ actions: ["createJD"] }, ctxOf());
    const digest = captured[0]!.user;
    expect(digest).toContain("【本次范围】只画这些动作：createJD");
    expect(digest).toContain("createJD");
    // 关键：范围外的动作不能出现在动作清单里——否则模型照样给它们出 phase。
    expect(digest).not.toContain("processResume");
    expect(digest).not.toContain("matchResume");
    // 实体/规则/事件仍需全量：范围内动作要读写它们、要引上下游事件。
    expect(digest).toContain("Job_Posting");
    expect(digest).toContain("REQUIREMENT_LOGGED");
  });

  it("不传 actions → 保持整域全画（旧行为不变）", async () => {
    await buildBlueprint.execute({}, ctxOf());
    const digest = captured[0]!.user;
    expect(digest).not.toContain("【本次范围】");
    expect(digest).toContain("createJD");
    expect(digest).toContain("processResume");
    expect(digest).toContain("matchResume");
  });

  it("用户此前已声明 partial 计划范围 → 蓝图自动只画范围内的（不用大脑再传一遍）", async () => {
    await buildBlueprint.execute({}, ctxOf({ planScope: { kind: "partial", reason: "用户只要 createJD", missedActions: ["processResume", "matchResume"] } }));
    const digest = captured[0]!.user;
    expect(digest).toContain("【本次范围】只画这些动作：createJD");
    expect(digest).not.toContain("processResume");
  });

  it("actions 写了本体不存在的名字 → 当场纠偏并列出真名（不静默忽略范围）", async () => {
    const r = await buildBlueprint.execute({ actions: ["createJd", "编的动作"] }, ctxOf());
    expect(r.ok).toBe(false);
    expect(r.summary).toContain("本体不存在的动作名");
    expect(r.summary).toContain("createJD"); // 给出真名
    expect(captured).toHaveLength(0); // 没白烧一次 LLM
  });

  it("focus 只是视角、不裁剪范围（别再拿它当范围用）", async () => {
    await buildBlueprint.execute({ focus: "只看 createJD" }, ctxOf());
    const digest = captured[0]!.user;
    expect(digest).toContain("【重点视角】只看 createJD");
    expect(digest).toContain("processResume"); // 证明 focus 确实不裁剪
  });
});

describe("build_blueprint 失败诊断 (#JSON-DIAG)", () => {
  beforeEach(() => {
    vi.stubEnv("FACTORY_AI_MODEL", "test/m");
    captured.splice(0);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    nextResult = async () => OK_BLUEPRINT;
  });

  it("网关过载 → 说清是网关临时故障、可重试，且【不】伪造一个问题去挂起用户", async () => {
    nextResult = async () => ({ ok: false, failure: { kind: "llm_error", message: "503 system cpu overloaded", transient: true } });
    const r = await buildBlueprint.execute({}, ctxOf());
    expect(r.ok).toBe(false);
    expect(r.summary).toContain("网关临时故障");
    expect(r.summary).toContain("不是你的输入问题");
    expect(r.summary).not.toContain("格式错误"); // 旧版就是在这里撒谎
    const out = r.output as { next?: string; retryable?: boolean; reason?: string };
    expect(out.next).toBeUndefined(); // ← 核心：不再写死 next=ask_user 强制挂起
    expect(out.retryable).toBe(true);
    expect(out.reason).toBe("blueprint_gateway_transient");
  });

  it("模型没吐 JSON → 如实说是模型输出问题（不赖网关），也不挂起用户", async () => {
    nextResult = async () => ({ ok: false, failure: { kind: "no_json", sample: "我觉得这个本体挺复杂的，我先说说想法……" } });
    const r = await buildBlueprint.execute({}, ctxOf());
    expect(r.ok).toBe(false);
    expect(r.summary).toContain("没有可解析的 JSON");
    const out = r.output as { next?: string; reason?: string };
    expect(out.next).toBeUndefined();
    expect(out.reason).toBe("blueprint_no_json");
  });

  it("鉴权失败 → 标成不可重试，并要求如实告诉用户（而不是假装画出了图）", async () => {
    nextResult = async () => ({ ok: false, failure: { kind: "llm_error", message: "401 invalid api key", transient: false } });
    const r = await buildBlueprint.execute({}, ctxOf());
    expect(r.ok).toBe(false);
    const out = r.output as { next?: string; retryable?: boolean; reason?: string };
    expect(out.retryable).toBe(false);
    expect(out.reason).toBe("blueprint_gateway_error");
    expect(r.summary).toContain("如实告诉用户");
    expect(out.next).toBeUndefined();
  });
});
