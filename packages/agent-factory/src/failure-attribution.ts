// #ATTRIB — 结构化回退归因 v1（Contract-First 报告 §6.5）。
//
// 论据：LLM 事后读 transcript 归因只有 53.5% 准（ICML 2025 Spotlight, arXiv:2505.00212）——
// 所以"交付有问题该回哪个 agent 节点"绝不能让大脑读日志猜。本模块把执行保真结果
// (ExecutionFidelity) 与契约图 (ContractGraph) 做确定性 join：
//   违约 agent → 违约事件 → 受影响的下游消费者 → 推荐的工厂动作（refine 谁、对齐什么）。
// 输出既给大脑（sandbox_run summary 里的结构化指令，替代自由猜测），也给 UI（下钻卡）。
// 纯函数、无 LLM、无 IO —— 同输入必同输出，可单测。

import type { ContractGraph } from "./contract";
import type { ExecutionFidelity, AgentFidelity } from "./execution-fidelity";

// #OPEN-VOCAB — 修复动作是开放词汇：三个已知动作供归因规则产出；未来的归因来源（学习/人工）
// 可提出新动作词，消费端未识别时按 refine_producer 兜底处理。
export type KnownRecommendedAction =
  /** 产出方的输出契约错了（缺权威字段 / 类型不符 / 根本不是对象）→ 定点 refine 产出方。 */
  | "refine_producer"
  /** 产出方与消费方对同一字段声明分歧 → 先对齐契约（改一方的 I/O schema），再 refine。 */
  | "align_contract"
  /** 缺的字段本体里没有权威定义 → 信息缺口，问用户该字段从哪来。 */
  | "ask_user";
export type RecommendedAction = KnownRecommendedAction | (string & {});

export type AttributionEntry = {
  /** 责任 agent（产出方）。 */
  agentShort: string;
  agentSlug: string;
  /** 违约的 emit 事件。 */
  event: string | null;
  /** 受影响的下游消费者（actionName）。 */
  affectedConsumers: string[];
  recommend: RecommendedAction;
  /** 给大脑的一句话修复指令（中文，可直接进 summary）。 */
  instruction: string;
};

function consumersOf(graph: ContractGraph, event: string | null): string[] {
  if (!event) return [];
  return graph.events.find((e) => e.name === event)?.consumers ?? [];
}

function attributeOne(f: AgentFidelity, graph: ContractGraph): AttributionEntry {
  const affected = consumersOf(graph, f.outputEvent);
  const evName = f.outputEvent ?? "（未知事件）";
  const notObject = f.errors.find((e) => e.kind === "not_object");
  if (notObject) {
    return {
      agentShort: f.agentShort,
      agentSlug: f.agentSlug,
      event: f.outputEvent,
      affectedConsumers: affected,
      recommend: "refine_producer",
      instruction: `「${f.agentShort}」emit「${evName}」的真实 payload 不是对象(${notObject.actualType})——refine_agent ${f.agentShort}：让最后一步产出结构化对象并映射到输出 schema。`,
    };
  }
  const missing = f.errors.filter((e) => e.kind === "missing");
  const mismatch = f.errors.filter((e) => e.kind === "type_mismatch");
  if (mismatch.length) {
    // 类型不符：产出方发的类型 ≠ 下游期待——契约层先对齐（谁改由大脑按业务判断，但目标明确）。
    const fields = mismatch.map((e) => `${e.field}(${e.actualType}≠${e.expectedType})`).join("、");
    return {
      agentShort: f.agentShort,
      agentSlug: f.agentSlug,
      event: f.outputEvent,
      affectedConsumers: affected,
      recommend: "align_contract",
      instruction: `「${f.agentShort}」emit「${evName}」字段类型与下游期待不符：${fields}${affected.length ? `（下游 ${affected.join("、")} 会 output_parse_error）` : ""}——对齐双方 I/O schema 后 refine_agent ${f.agentShort}。`,
    };
  }
  if (missing.length) {
    const fields = missing.map((e) => `${e.field}(${e.expectedType})`).join("、");
    return {
      agentShort: f.agentShort,
      agentSlug: f.agentSlug,
      event: f.outputEvent,
      affectedConsumers: affected,
      recommend: "refine_producer",
      instruction: `「${f.agentShort}」emit「${evName}」缺权威字段：${fields}${affected.length ? `（${affected.join("、")} 依赖这些字段）` : ""}——refine_agent ${f.agentShort}：在输出映射里补齐这些字段（从输入透传或步骤产出取）。`,
    };
  }
  // 理论上不会到这（failed 必有 errors）；兜底为信息缺口。
  return {
    agentShort: f.agentShort,
    agentSlug: f.agentSlug,
    event: f.outputEvent,
    affectedConsumers: affected,
    recommend: "ask_user",
    instruction: `「${f.agentShort}」emit「${evName}」保真失败但无具体字段错误——向用户确认该事件的期望 payload。`,
  };
}

/** 保真失败 → 逐 agent 的定点回退指令。稳定排序（按 agentShort）保证同输入同输出。 */
export function attributeFidelityFailures(fidelity: ExecutionFidelity, graph: ContractGraph): AttributionEntry[] {
  return fidelity.failed
    .map((f) => attributeOne(f, graph))
    .sort((a, b) => a.agentShort.localeCompare(b.agentShort));
}

/** 给大脑的定位块（拼进 sandbox_run 的 summary）：有违约时直接给"回哪个 agent 做什么"。 */
export function attributionSummary(entries: AttributionEntry[]): string {
  if (!entries.length) return "";
  const lines = entries.map((e, i) => `${i + 1}. ${e.instruction}`);
  return `【保真违约定位（结构化，按此修，别猜）】\n${lines.join("\n")}`;
}
