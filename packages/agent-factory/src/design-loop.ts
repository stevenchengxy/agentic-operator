/**
 * design-loop — design_agent 的内部 ReAct 循环（架构书 §5 内推演，附录 B G3 姊妹件）。
 *
 * 现状：design_agent 单次产出 spec + 代码，深层问题（规则硬编码 / 分支没覆盖全 / 字段没透传 /
 * decision_logic 太薄）留给【外层】review→refine 反复打回——真实轨迹里 8 次回环、评分 ±1 化妆式。
 *
 * 本模块把那道审查【前移到设计当下】：draft → 确定性自检（零 LLM）→ 命中硬问题就跑【一次】内部
 * 精修（LLM 针对性重写 system_prompt/decision_logic）→ 提交改进版。确定性自检永远跑（免费、可测）；
 * 内部精修 gateway-gated + env 可关（FACTORY_DESIGN_INNER_LOOP=0）+ 失败兜底原稿——绝不比现在差。
 */

import { isGeneratedToolExecutionPolicy } from "./tool-execution-policy";
export { isGeneratedToolExecutionPolicy as isReviewedToolExecutionPolicy } from "./tool-execution-policy";

export interface DesignIssue {
  /** 稳定编码，供测试/UI 归类。#OPEN-VOCAB：已知码给测试/UI 锚点，新码可开放追加。 */
  code: "branch_uncovered" | "rule_leak" | "ungrounded_event" | "shallow_logic" | "side_effect_no_compensation" | "missing_role_name" | (string & {});
  /** hard = 外层几乎必然打回；soft = 提示。hard 才触发内部精修。 */
  hard: boolean;
  message: string;
  fix: string;
}

/** #SAGA — decide exclusively from a reviewed policy triple. Missing/invalid
 * policy is rejected by generation before this compensation check runs. */
export function requiresAttemptGrantPolicy(policy: unknown): boolean {
  return isGeneratedToolExecutionPolicy(policy)
    && (policy as { sandboxPolicy?: unknown }).sandboxPolicy === "requires_attempt_grant";
}

export interface DesignDraft {
  actionName: string;
  emitEvents: string[]; // spec 声明会产出的事件（每个都应在 decision_logic 里有明确分支）
  systemPrompt: string;
  decisionLogic: string;
  toolCount: number;
  hitl: boolean;
  isGate: boolean;
  /** 由 design_agent 预算好传入（promptEmbedsRule 对非闸口 agent）。 */
  ruleLeak: boolean;
  /** 由 design_agent 预算好传入（prompt 里出现本体没有的事件名）。 */
  ungroundedEvents: string[];
  /** #SAGA — 绑定了需要 attempt grant 的外部写工具。 */
  sideEffectful?: boolean;
  /** #SAGA — 已声明补偿事件（spec.compensationEvent）。 */
  hasCompensation?: boolean;
}

/** 纯确定性自检——单个 agent 设计时就能查的、外层最常打回的点。零 LLM，完全可测。 */
export function designSelfCheck(d: DesignDraft): { issues: DesignIssue[]; hardCount: number } {
  const issues: DesignIssue[] = [];
  const logic = (d.decisionLogic || "").trim();

  // ① 分支覆盖：每个声明会 emit 的事件，都该在 decision_logic 里有明确的"何时发它"。少一个 = 一条
  //    分支没定义（外层 completeness/契约审查必打回）。
  const uncovered = (d.emitEvents ?? []).filter((e) => e && !logic.includes(e));
  for (const e of uncovered) {
    issues.push({ code: "branch_uncovered", hard: true, message: `声明会产出事件 ${e}，但 decision_logic 没写清楚"什么条件下发它"`, fix: `在 decision_logic 里补一条：满足<条件>时 emit ${e}（及其关键字段）` });
  }

  // ② 规则泄漏（非闸口 agent 把具体业务规则写进了 prompt）。
  if (d.ruleLeak) {
    issues.push({ code: "rule_leak", hard: true, message: "非校验类 agent 的 prompt 写进了具体业务规则", fix: "把规则内容删掉；规则只属于校验闸口 agent，且运行时用 ontology.fetchActionRules 动态抓" });
  }

  // ③ prompt 出现本体没有的事件名（幻觉，沙箱链会断）。
  if ((d.ungroundedEvents ?? []).length) {
    issues.push({ code: "ungrounded_event", hard: true, message: `prompt 出现本体里不存在的事件名：${d.ungroundedEvents.join("、")}`, fix: "只用 read_ontology 给的真实事件名；删掉或改成真名" });
  }

  // ④ decision_logic 太薄（既非空但内容明显不足以描述分支）。
  if (logic && logic.length < 40) {
    issues.push({ code: "shallow_logic", hard: false, message: "decision_logic 过于简略，可能没覆盖成功/失败/拦截各分支", fix: "把每个分支的触发条件、emit 的事件、异常兜底都写清楚" });
  }

  // ⑤ #SAGA — 有外部副作用却没有补偿事件：硬失败后外部世界已经变了（邀约已发/JD 已挂出），
  //    没有 compensation_event 就没有撤销/对账信号。软警告（不是每个副作用都必须补偿——由
  //    大脑按业务判断），但必须被看见。
  if (d.sideEffectful && !d.hasCompensation && !d.hitl) {
    issues.push({
      code: "side_effect_no_compensation",
      hard: false,
      message: "绑定了外部副作用类工具（发送/发布/写外部系统），但没有声明补偿事件 compensation_event",
      fix: "为硬失败设计一个补偿事件（如 XXX_CANCELLED / XXX_ROLLBACK_REQUESTED），design_agent 的 compensation_event 参数传入；若业务上确不需要撤销（幂等只读副作用），忽略本提示",
    });
  }

  return { issues, hardCount: issues.filter((i) => i.hard).length };
}

/** 内部精修的 LLM 调用抽象（默认 chatJson；测试注入假实现）。 */
export type DesignRefineFn = (
  system: string,
  user: string,
) => Promise<{ system_prompt?: string; decision_logic?: string } | null>;

/** 针对自检查出的硬问题，让 LLM【一次性】重写 system_prompt / decision_logic。失败/无改进 → 返回
 *  null，调用方沿用原稿（永不比现在差）。 */
export async function internalDesignRefine(
  d: DesignDraft,
  issues: DesignIssue[],
  refine: DesignRefineFn,
): Promise<{ systemPrompt: string; decisionLogic: string } | null> {
  const hard = issues.filter((i) => i.hard);
  if (!hard.length) return null;
  const sys =
    "你是 agent 工厂的设计自审员。下面这个 agent 的设计有几处【设计当下就能修】的确定性问题，请【只改 system_prompt 和 decision_logic】把它们修好，别引入本体里没有的事件/字段，别把具体业务规则写进非校验 agent。只输出 JSON：" +
    '{"system_prompt": string, "decision_logic": string}。保持中文、保持原有正确的部分，只补/改有问题的地方。不要任何其它文字。';
  const user = [
    `动作：${d.actionName}`,
    `它声明会产出的事件（每个都要在 decision_logic 里有明确分支）：${d.emitEvents.join("、") || "（无）"}`,
    `当前 system_prompt：\n${d.systemPrompt.slice(0, 4000)}`,
    `当前 decision_logic：\n${d.decisionLogic.slice(0, 2000)}`,
    `要修的问题：\n${hard.map((i, n) => `${n + 1}. ${i.message} → ${i.fix}`).join("\n")}`,
  ].join("\n\n");
  let out: { system_prompt?: string; decision_logic?: string } | null = null;
  try {
    out = await refine(sys, user);
  } catch {
    return null;
  }
  if (!out) return null;
  const systemPrompt = typeof out.system_prompt === "string" && out.system_prompt.trim().length > 20 ? out.system_prompt : d.systemPrompt;
  const decisionLogic = typeof out.decision_logic === "string" && out.decision_logic.trim().length > 10 ? out.decision_logic : d.decisionLogic;
  // 无实质改动就当没精修（避免刷一条空的 selfRefined）。
  if (systemPrompt === d.systemPrompt && decisionLogic === d.decisionLogic) return null;
  return { systemPrompt, decisionLogic };
}

export function innerLoopEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.FACTORY_DESIGN_INNER_LOOP !== "0";
}
