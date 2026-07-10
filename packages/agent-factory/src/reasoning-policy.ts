// #POLICY — 前置自适应路由（Contract-First 报告 §6.2 的第一层）。
//
// 现状问题：工厂对"生成整条 workflow / 只改一个 agent / 只是分析答疑"一视同仁地走同一条
// 6 阶段流水线，深度分治只按本体规模（rules>60）触发，与问题类型无关（AdaptThink/ADaPT/
// Meta-Reasoner 的一致结论：推理深度应按任务类型+难度决定，而非静态一套）。
//
// 这一层在【意图门之后、任何工具调用之前】运行：从意图门产出的分类行 + 本体规模信号，
// 确定性地选出【流水线形状 + 分治深度 + 模型档位偏置】。它是"被选择的推理组合"的 v1 ——
// 确定性、可测试、可解释（reasons 全程携带）；学习型 bandit（按 runs 成败回喂调 arm）是
// v2，在这个接口后面换实现即可。
//
// #NATIVE 原则（2026-07-09 定稿）：policy 只按【意图类型】选流水线形状与档位偏置；
// 规模/难度/历史教训一律只作为【事实与建议】进 reasons（经 [推理路线] 消息呈给 AI），
// 分治深度（understand/critique 的 deep 参数）由 AI 原生决定——本模块绝不替 AI 做推理决策。

import type { DomainOntology } from "./ontology-types";

/** #OPEN-VOCAB — 意图类型是【开放词汇】：已知六类给路由规则用；意图门写出词表外的新类型
 *  （如「对比」「迁移」）时【原样透传】而不是塌缩成 other——selectPolicy 对未知类型走安全的
 *  full 默认，但新词保留在 policy.reasons/遥测里，反复出现 = 该给它立专门路由规则了。 */
export type KnownIntentKind = "generate" | "modify" | "analyze" | "question" | "report" | "other";
export type IntentKind = KnownIntentKind | (string & {});

const KIND_WORD: Array<[RegExp, KnownIntentKind]> = [
  [/\[生成\]/, "generate"],
  [/\[修改\]/, "modify"],
  [/\[分析\]/, "analyze"],
  [/\[提问\]/, "question"],
  [/\[报告\]/, "report"],
  [/\[其它\]|\[其他\]/, "other"],
];

/** 从意图门累积行里取【最近一条】的类型标签（意图门逐条追加，最后一行是当前请求）。
 *  词表命中 → 规范英文名；词表外的 [新词] → 原样返回新词（开放词汇）；没有标签 → other。 */
export function classifyIntentKind(userIntent: string | undefined): IntentKind {
  const last = (userIntent ?? "").trim().split("\n").filter(Boolean).pop() ?? "";
  for (const [re, kind] of KIND_WORD) if (re.test(last)) return kind;
  const novel = last.match(/^\+?\s*\[([^\]\s]{1,12})\]/)?.[1];
  return novel ?? "other";
}

export type DifficultyBand = "simple" | "standard" | "complex";

export type Difficulty = {
  band: DifficultyBand;
  score: number;
  reasons: string[];
};

/** 本体规模 + 结构信号 → 难度分。分支多（一个 action 多个 emit）、外部交接多、规则密度高
 *  都是"链路容易断/契约容易漂"的先导信号，比单看 rules 数量更贴近实际返工成本。 */
export function estimateDifficulty(ontology: DomainOntology | null | undefined): Difficulty {
  if (!ontology) return { band: "standard", score: 40, reasons: ["无本体信息，按标准难度处理"] };
  const nActions = ontology.actions?.length ?? 0;
  const nRules = ontology.rules?.length ?? 0;
  const nObjects = ontology.objects?.length ?? 0;
  const agentActions = (ontology.actions ?? []).filter((a) => (a.actor ?? []).includes("Agent"));
  const branchy = agentActions.filter((a) => (a.triggered_event ?? []).length > 2).length;
  let score = 0;
  const reasons: string[] = [];
  if (agentActions.length > 8) { score += 30; reasons.push(`Agent 动作 ${agentActions.length} 个（>8）`); }
  else if (agentActions.length > 4) { score += 18; reasons.push(`Agent 动作 ${agentActions.length} 个`); }
  else { score += 6; }
  if (nRules > 60) { score += 30; reasons.push(`规则 ${nRules} 条（>60）`); }
  else if (nRules > 20) { score += 15; reasons.push(`规则 ${nRules} 条`); }
  if (nObjects > 20) { score += 15; reasons.push(`对象 ${nObjects} 个（>20）`); }
  if (branchy >= 2) { score += 15; reasons.push(`${branchy} 个多分支动作（emit>2，链路易断）`); }
  if (nActions && !reasons.length) reasons.push("小规模域");
  const band: DifficultyBand = score >= 55 ? "complex" : score >= 25 ? "standard" : "simple";
  return { band, score, reasons };
}

// #OPEN-VOCAB — 流水线形状同样开放：已知四形给现有路由；未来 AI/配置可提出新形状（消费端
// 未识别时按 full 处理）。DifficultyBand 保持封闭——它是我们计算出的【度量视图】，不是 AI
// 提出的概念，三档是刻度不是认知框。
export type KnownPipelineShape = "full" | "skinny" | "analyze" | "ask_first";
export type PipelineShape = KnownPipelineShape | (string & {});

export type ReasoningPolicy = {
  /** 流水线形状：full=完整生成流程；skinny=定位→refine→verify（已有 specs 的修改）；
   *  analyze=只读分析/答疑（不 sandbox）；ask_first=先澄清再动。 */
  pipeline: PipelineShape;
  /** #NATIVE — 【建议】非强制：深读/深评与否由 AI 在调用 understand_ontology / critique_plan
   *  时用 deep 参数原生决定。这两个位只承载建议来源（如经验回喂"该难度下历史保真违约率高"），
   *  经 [推理路线] 消息呈给 AI 参考——绝不由本体规模等 schema 信号确定性地替 AI 做决定。 */
  deepUnderstand: boolean;
  deepCritique: boolean;
  /** 模型档位偏置：fast=纯答疑/分析可降档省钱；null=交给相位路由（tierForContext）。 */
  tierBias: "fast" | null;
  /** 全程携带的决策依据（emit 给 UI + 注入上下文，回答"为什么这么选"）。 */
  reasons: string[];
};

export function selectPolicy(input: {
  intentKind: IntentKind;
  difficulty: Difficulty;
  /** 会话里已有已设计的 specs（修改类请求走 skinny 的前提）。 */
  hasSpecs: boolean;
  /** 意图门/理解阶段已标出的歧义数（>=2 → 建议先问再动）。 */
  ambiguityCount?: number;
}): ReasoningPolicy {
  const { intentKind, difficulty, hasSpecs } = input;
  const ambiguity = input.ambiguityCount ?? 0;
  const reasons: string[] = [`意图=${intentKind}`, `难度=${difficulty.band}(${difficulty.score})`, ...difficulty.reasons.slice(0, 3)];

  // 纯答疑/报告：不进生成流水线，降档省钱。
  if (intentKind === "question" || intentKind === "report" || intentKind === "analyze") {
    reasons.push("只读请求 → analyze 轻路径 + fast 档");
    return { pipeline: "analyze", deepUnderstand: false, deepCritique: false, tierBias: "fast", reasons };
  }

  // 歧义重的生成：建议先澄清（policy 只建议，ask_user 门控仍由大脑执行）。
  if (ambiguity >= 2 && intentKind === "generate") {
    reasons.push(`歧义 ${ambiguity} 处 → 建议先 ask_user 再设计`);
    return { pipeline: "ask_first", deepUnderstand: false, deepCritique: false, tierBias: null, reasons };
  }

  // 修改类 + 已有 specs：跳过全量重走，定位→refine→verify。
  if (intentKind === "modify" && hasSpecs) {
    reasons.push("修改已有 agent → skinny 路径（定位→refine→verify）");
    return { pipeline: "skinny", deepUnderstand: false, deepCritique: false, tierBias: null, reasons };
  }

  // #OPEN-VOCAB — 词表外的新意图类型：走 full 安全默认，但把新词显式带进 reasons（遥测可见，
  // 反复出现 = 该给它立专门路由规则），绝不静默当成 generate。
  const KNOWN = new Set(["generate", "modify", "analyze", "question", "report", "other"]);
  if (!KNOWN.has(intentKind)) reasons.push(`新意图类型「${intentKind}」（词表外）→ 走 full 安全默认`);

  // #NATIVE — 生成类：规模/难度只作为【事实】进 reasons（AI 参考后自行决定 deep 参数），
  // 不再由 difficulty.band 确定性地强制分治深度（那是"Ontology 理念替 AI 推理"的残留）。
  reasons.push("分治深度由你决定：understand_ontology / critique_plan 的 deep 参数按需传 true");
  return { pipeline: "full", deepUnderstand: false, deepCritique: false, tierBias: null, reasons };
}

/** #ADAPT — "卡住才拆"（ADaPT, NAACL 2024）的分解触发判定：一个 agent 反复 refine 无效且
 *  本身足够复杂（工具多 / plan 步骤多）时，正确动作是把它拆成父 + invoke 子 agent，而不是
 *  继续磨 prompt。纯启发式：≥4 工具 或 ≥6 步 plan 视为"复杂到值得拆"。 */
export function shouldSuggestSplit(spec: { tools?: string[]; plan?: unknown[] } | undefined | null): boolean {
  if (!spec) return false;
  return (spec.tools?.length ?? 0) >= 4 || (Array.isArray(spec.plan) ? spec.plan.length : 0) >= 6;
}
