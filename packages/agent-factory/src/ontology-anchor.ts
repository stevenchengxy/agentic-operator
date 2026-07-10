// #ANCHOR — 本体记忆锚点循环：确保 agent 在整个运行过程中【永远不忘本体】。
//
// 已有的两道防线只覆盖"折叠时不丢"：ctx.ontologyUnderstanding 是 buildStateSummary 的
// 折叠幸存者（压缩后仍在），serializeCtx 让它跨重启存活。但两次折叠之间的长跑里，
// 早期的理解会被几十轮工具结果稀释——模型不是"丢了"而是"注意力淡了"（读了就忘的
// 另一种形态）。这条锚点循环按节拍把【本体核心事实 + 消化结论 + 还欠的覆盖】重新注入
// 对话，作为持续的 re-grounding 心跳。
//
// 原则：锚点是【事实提醒】不是【指令】——只陈述本体状态与未覆盖清单，不指挥下一步
// （下一步仍由大脑 + policy 决定）；短（≤~800 字符）、确定性、可测试；节拍可调
// （FACTORY_ONTOLOGY_ANCHOR_EVERY，默认每 8 轮，0=关闭）。

import type { BrainCtx } from "./brain-types";

export const DEFAULT_ANCHOR_EVERY = 8;

/** 这一轮是否该注入锚点：有本体、节拍命中、且不是第 0 轮（首轮上下文本来就新鲜）。 */
export function anchorDue(turn: number, everyN: number = DEFAULT_ANCHOR_EVERY): boolean {
  if (!Number.isFinite(everyN) || everyN <= 0) return false;
  return turn > 0 && turn % everyN === 0;
}

/** 组装锚点文本（纯函数）。没有本体 → null（无事实可锚）。 */
export function buildOntologyAnchor(
  ctx: Pick<BrainCtx, "ontology" | "ontologyUnderstanding" | "specs" | "policy">,
  turn: number,
): string | null {
  const ont = ctx.ontology;
  if (!ont) return null;
  const agentActions = (ont.actions ?? []).filter((a) => (a.actor ?? []).includes("Agent")).map((a) => a.name);
  const designed = new Set((ctx.specs ?? []).map((s) => s.actionName));
  const uncovered = agentActions.filter((a) => !designed.has(a));
  const lines: string[] = [
    `[本体锚点·第${turn}轮] 域「${ont.domainId}」：${agentActions.length} 个 Agent 动作 · ${ont.events?.length ?? 0} 事件 · ${ont.rules?.length ?? 0} 规则。这是你工作的业务事实基础，任何事件名/字段/规则引用都必须来自它。`,
  ];
  if (uncovered.length) {
    lines.push(`还欠覆盖的动作(${uncovered.length})：${uncovered.slice(0, 8).join("、")}${uncovered.length > 8 ? " …" : ""}`);
  } else if (agentActions.length) {
    lines.push(`Agent 动作已全部有 spec 覆盖（${designed.size}/${agentActions.length}）——接下来以验证/保真为准，别重复设计。`);
  }
  if (ctx.ontologyUnderstanding) {
    lines.push(`此前的消化结论（继续沿用，别重读一遍本体）：${ctx.ontologyUnderstanding.slice(0, 420)}`);
  } else {
    lines.push(`尚未做过 understand_ontology 深度消化——若接下来要规划/设计，先消化再动。`);
  }
  if (ctx.policy?.pipeline) lines.push(`本次推理路线：${ctx.policy.pipeline}。`);
  return lines.join("\n");
}
