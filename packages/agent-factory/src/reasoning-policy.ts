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

/** #BUDGET-ROUTE (P1-5, arXiv 2408.03314) — difficulty-aware compute allocation. The paper's
 *  compute-optimal result (~4× efficiency over uniform budgets): easy → SEQUENTIAL revision on one
 *  draft; medium → verifier-guided PARALLEL candidates; hardest bands get almost nothing from more
 *  test-time compute — escalate the MODEL TIER or go to the human (ask_user), don't grind. Also the
 *  theory behind our old 12s-fixed-poll bug: any fixed budget is simultaneously too much and too
 *  little. Pure + deterministic; the conductor/design loop reads this instead of hardcoded counts. */
export interface ComputeBudget {
  /** parallel candidate drafts per agent design (Monkeys: only worth >1 when a REAL verifier exists) */
  candidates: number;
  /** revise/debug turns per agent before reset (Self-Debug: gains land in first 2-3 turns) */
  reviseTurns: number;
  /** on persistent failure at this band: keep iterating, escalate model tier, or ask the human */
  escalation: "iterate" | "tier_up" | "ask_user";
  reasons: string[];
}
export function budgetForDifficulty(band: DifficultyBand, opts: { realVerifier?: boolean } = {}): ComputeBudget {
  const verified = opts.realVerifier !== false; // default true — our sandbox IS a real verifier
  if (band === "simple") {
    return { candidates: 1, reviseTurns: 2, escalation: "iterate", reasons: ["简单域：单稿顺序修订最优（并行采样浪费）"] };
  }
  if (band === "standard") {
    return {
      candidates: verified ? 2 : 1,
      reviseTurns: 3,
      escalation: "tier_up",
      reasons: [verified ? "标准域：2 候选并行 + 真验收择优（coverage 曲线的免费收益）" : "标准域但无真验证器：并行采样无法兑现，保持单稿", "卡住时升 model tier 而非加轮次"],
    };
  }
  return {
    candidates: verified ? 2 : 1,
    reviseTurns: 3,
    escalation: "ask_user",
    reasons: ["复杂域：最难分位加推理预算几乎无益（2408.03314）——反复失败时问人（ask_user）或升 tier，不无限磨"],
  };
}

// #OPEN-VOCAB — 流水线形状同样开放：已知四形给现有路由；未来 AI/配置可提出新形状（消费端
// 未识别时按 full 处理）。DifficultyBand 保持封闭——它是我们计算出的【度量视图】，不是 AI
// 提出的概念，三档是刻度不是认知框。
export type KnownPipelineShape = "full" | "skinny" | "analyze" | "ask_first";
export type PipelineShape = KnownPipelineShape | (string & {});

// ── 轴2：推理策略（#STRATEGY，融合蓝图 §09 双轴选择器的第二轴）──────────────────
// #OPEN-VOCAB — 策略是【开放词汇】：三个 Day-1 一等策略（react/reflection/debate，各自映射到真实
// 执行原语）+ tot/cot 预算内跟进；AI/配置可提新策略（消费端未识别时按 react 处理）。
//   react      → streamTurn 工具循环（写→编译→读诊断→精修）= 默认，最便宜
//   reflection → designSelfCheck→internalDesignRefine（产出→自评→一次性重写）= 返工/锁定 span
//   debate     → critique_plan 作挑战者 + 评委综合 = 高风险裁决（仲裁/finish/评审）/复杂设计
//   tot        → runSpecialists K 分叉 + 打分剪枝 = 复杂生成/设计（贵，门控）
//   cot        → 单 scratchpad chatOnce = 纯分析/答疑（便宜）
export type KnownReasoningStrategy = "react" | "reflection" | "debate" | "tot" | "cot";
export type ReasoningStrategy = KnownReasoningStrategy | (string & {});
/** 昂贵策略集：门控给复杂/返工/高风险场景，简单场景一律降到 react/cot。 */
const EXPENSIVE_STRATEGIES: ReadonlySet<string> = new Set(["debate", "tot", "combo"]);

/** 做决策的语境（哪个工位 / 哪种裁决）。决定默认策略。 */
export type StrategyContext =
  | "plan" | "design" | "code" | "review" | "arbitrate" | "finish" | "analyze" | "subproblem";

export type StrategySelection = {
  strategy: ReasoningStrategy;
  /** 是否昂贵策略（供预算门控 + UI 标注）。 */
  expensive: boolean;
  reasons: string[];
};

export type ReasoningPolicy = {
  /** 流水线形状：full=完整生成流程；skinny=定位→refine→verify（已有 specs 的修改）；
   *  analyze=只读分析/答疑（不 sandbox）；ask_first=先澄清再动。 */
  pipeline: PipelineShape;
  /** #STRATEGY — 轴2：本次运行主语境的默认推理策略（L1 建议）。站内子问题可经 select_strategy
   *  就该子问题的意图重新分类。与 #NATIVE 一致：这是【建议+reasons】，AI 保留带理由的否决权。 */
  strategy: ReasoningStrategy;
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

/** #STRATEGY — 轴2 策略选择器：按语境 + 难度 + 返工/歧义 选一个推理策略。承重的是这张手调表 +
 *  策略→原语映射（policy-learning 只作保守降级，不探索），与融合蓝图 §09 的诚实版一致。
 *  高风险语境（仲裁/finish/评审）默认 debate；返工默认 reflection；复杂生成/设计升 tot；
 *  纯分析降 cot；其余 react。fast 偏置或简单难度会把昂贵策略降回 react/cot。 */
export function selectStrategy(input: {
  intentKind: IntentKind;
  difficulty: Difficulty;
  context: StrategyContext;
  isRework?: boolean;
  ambiguityCount?: number;
  tierBias?: "fast" | null;
}): StrategySelection {
  const { context, difficulty } = input;
  const isRework = !!input.isRework;
  const complex = difficulty.band === "complex";
  const wantCheap = input.tierBias === "fast" || difficulty.band === "simple";
  const reasons: string[] = [`语境=${context}`, `难度=${difficulty.band}`];

  let strategy: ReasoningStrategy;
  if (isRework) { strategy = "reflection"; reasons.push("返工 → reflection（锁定失败 span，产出→自评→重写）"); }
  else if (context === "arbitrate" || context === "finish") { strategy = "debate"; reasons.push("高风险裁决 → debate（挑战者+评委，不轻信单次判断）"); }
  else if (context === "review") { strategy = "debate"; reasons.push("评审 → debate（独立评委对抗式）"); }
  else if (context === "analyze") { strategy = "cot"; reasons.push("纯分析/答疑 → cot（单 scratchpad，便宜）"); }
  else if (context === "code") { strategy = "react"; reasons.push("编码 → react（写→编译→读诊断→精修）+ reflection 自审"); }
  else if ((context === "plan" || context === "design") && complex) { strategy = "tot"; reasons.push("复杂生成/设计 → tot（K 分叉打分剪枝）"); }
  else { strategy = "react"; reasons.push("默认 → react（工具循环）"); }

  // 预算门控：便宜语境不用昂贵策略（高风险语境例外——仲裁/finish/评审值这个钱）。
  const highStakes = context === "arbitrate" || context === "finish" || context === "review";
  if (wantCheap && EXPENSIVE_STRATEGIES.has(strategy) && !highStakes) {
    reasons.push(`${input.tierBias === "fast" ? "fast 偏置" : "简单难度"} → 昂贵策略 ${strategy} 降为 ${context === "analyze" ? "cot" : "react"}`);
    strategy = context === "analyze" ? "cot" : "react";
  }
  return { strategy, expensive: EXPENSIVE_STRATEGIES.has(strategy), reasons };
}

// ── AI 自选推理【组合】(#STRATEGY-COMBO) ─────────────────────────────────────
// 用户要求(2026-07-10):推理【不默认 ReAct】——AI 按任务/意图自选推理方法【组合】。有的任务不适合
// ReAct,有的适合组合。所以:selectStrategy 的手调表只作【先验建议】,AI 经 select_strategy 工具【声明】
// 自己就当前子问题选的策略(单个或组合 DAG)+ 理由;这里是纯解析/校验层(确定性、可测)。
export const KNOWN_STRATEGIES: ReadonlySet<string> = new Set(["react", "reflection", "debate", "tot", "cot"]);

/** 每个策略【是什么/何时用】——注入给 AI 做选择依据(不是替它选)。 */
export const STRATEGY_DESC: Record<string, string> = {
  react: "工具循环:观察→行动→再观察(写→编译→读诊断→精修)。适合边做边探、有工具反馈的任务。",
  reflection: "产出→自评→重写:先给一版再自我批评并定点重写。适合返工、锁定失败 span、质量打磨。",
  debate: "挑战者+评委:多方对抗式论证后综合。适合高风险裁决、评审、易错的设计决策。",
  tot: "思维树:K 个分叉并行探索→打分→剪枝。适合解空间大、需发散再收敛的复杂设计。",
  cot: "单链思维:一段连续推理直接给结论。适合纯分析/答疑等无需工具、无需探索的任务。",
};

export type StrategyStep = { strategy: ReasoningStrategy; note?: string };
export type StrategyPlan = {
  mode: "single" | "combo";
  /** single=1 步;combo=有序步骤(依次执行,如 tot→debate→reflection)。 */
  steps: StrategyStep[];
  rationale: string;
  /** ai=AI 自己选的;default=没选到 → 表建议/兜底。 */
  chosenBy: "ai" | "default";
  /** 词表外策略名(开放词汇:保留,消费端未识别时按 react 处理,反复出现=值得立新原语)。 */
  unknown: string[];
};

/** 解析 AI 提出的策略选择:接受单策略("reflection")或组合("tot→debate→reflection"、"cot+debate"、
 *  数组)。分隔符 →/->/|/,/、/+/空格 都认。空/全空 → 回退 react 并标 chosenBy=default。开放词汇:
 *  未知策略名保留在 steps + unknown(不静默塌缩),便于遥测与将来立新原语。 */
export function parseStrategyPlan(
  raw: string | string[] | undefined,
  opts: { rationale?: string; chosenBy?: "ai" | "default" } = {},
): StrategyPlan {
  const rationale = (opts.rationale ?? "").trim();
  const tokens = (Array.isArray(raw) ? raw : String(raw ?? "").split(/\s*(?:→|->|\||,|、|\+|\s)+\s*/))
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  if (!tokens.length) {
    return { mode: "single", steps: [{ strategy: "react" }], rationale: rationale || "未指定 → 默认 react", chosenBy: "default", unknown: [] };
  }
  const unknown = tokens.filter((t) => !KNOWN_STRATEGIES.has(t));
  const steps: StrategyStep[] = tokens.map((t) => ({ strategy: t }));
  return { mode: steps.length > 1 ? "combo" : "single", steps, rationale, chosenBy: opts.chosenBy ?? "ai", unknown };
}

/** 一句话描述一个策略计划(供 UI 卡片 + 上下文注入)。 */
export function describeStrategyPlan(plan: StrategyPlan): string {
  const chain = plan.steps.map((s) => s.strategy).join(" → ");
  return `${plan.mode === "combo" ? "组合" : "策略"} ${chain}${plan.chosenBy === "ai" ? "(AI 自选)" : "(默认)"}${plan.rationale ? ` — ${plan.rationale}` : ""}`;
}

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

  // #STRATEGY — 轴2 默认策略随主语境 + 档位偏置一起选出，进 policy.strategy + reasons。
  const strat = (context: StrategyContext, tierBias: "fast" | null): ReasoningStrategy => {
    const s = selectStrategy({ intentKind, difficulty, context, ambiguityCount: ambiguity, tierBias });
    reasons.push(`策略=${s.strategy}${s.expensive ? "(贵)" : ""}：${s.reasons[s.reasons.length - 1]}`);
    return s.strategy;
  };

  // 纯答疑/报告：不进生成流水线，降档省钱。
  if (intentKind === "question" || intentKind === "report" || intentKind === "analyze") {
    reasons.push("只读请求 → analyze 轻路径 + fast 档");
    return { pipeline: "analyze", strategy: strat("analyze", "fast"), deepUnderstand: false, deepCritique: false, tierBias: "fast", reasons };
  }

  // 歧义重的生成：建议先澄清（policy 只建议，ask_user 门控仍由大脑执行）。
  if (ambiguity >= 2 && intentKind === "generate") {
    reasons.push(`歧义 ${ambiguity} 处 → 建议先 ask_user 再设计`);
    return { pipeline: "ask_first", strategy: strat("plan", null), deepUnderstand: false, deepCritique: false, tierBias: null, reasons };
  }

  // 修改类 + 已有 specs：跳过全量重走，定位→refine→verify。
  if (intentKind === "modify" && hasSpecs) {
    reasons.push("修改已有 agent → skinny 路径（定位→refine→verify）");
    return { pipeline: "skinny", strategy: strat("code", null), deepUnderstand: false, deepCritique: false, tierBias: null, reasons };
  }

  // #OPEN-VOCAB — 词表外的新意图类型：走 full 安全默认，但把新词显式带进 reasons（遥测可见，
  // 反复出现 = 该给它立专门路由规则），绝不静默当成 generate。
  const KNOWN = new Set(["generate", "modify", "analyze", "question", "report", "other"]);
  if (!KNOWN.has(intentKind)) reasons.push(`新意图类型「${intentKind}」（词表外）→ 走 full 安全默认`);

  // #NATIVE — 生成类：规模/难度只作为【事实】进 reasons（AI 参考后自行决定 deep 参数），
  // 不再由 difficulty.band 确定性地强制分治深度（那是"Ontology 理念替 AI 推理"的残留）。
  reasons.push("分治深度由你决定：understand_ontology / critique_plan 的 deep 参数按需传 true");
  return { pipeline: "full", strategy: strat("plan", null), deepUnderstand: false, deepCritique: false, tierBias: null, reasons };
}

/** #ADAPT — "卡住才拆"（ADaPT, NAACL 2024）的分解触发判定：一个 agent 反复 refine 无效且
 *  本身足够复杂（工具多 / plan 步骤多）时，正确动作是把它拆成父 + invoke 子 agent，而不是
 *  继续磨 prompt。纯启发式：≥4 工具 或 ≥6 步 plan 视为"复杂到值得拆"。 */
export function shouldSuggestSplit(spec: { tools?: string[]; plan?: unknown[] } | undefined | null): boolean {
  if (!spec) return false;
  return (spec.tools?.length ?? 0) >= 4 || (Array.isArray(spec.plan) ? spec.plan.length : 0) >= 6;
}
