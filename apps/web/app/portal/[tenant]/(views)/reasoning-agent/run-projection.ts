import type {
  ReasoningRunResponse,
  ReasoningRunStep,
} from "@/lib/hooks/useReasoningAgentContext";
import type { ReasoningOutput, RuntimeAgent, RuntimeStatus } from "./contracts";

const ORDER = ["reasoning", "query", "compiler", "qualified", "fold"] as const;

function terminalStepStatus(step: ReasoningRunStep | undefined): RuntimeStatus {
  if (!step) return "waiting";
  if (step.status === "running" || step.status === "queued") return "running";
  if (step.status === "failed" || step.status === "cancelled") return "blocked";
  return "completed";
}

function latest(
  steps: ReasoningRunStep[],
  predicate: (step: ReasoningRunStep) => boolean,
): ReasoningRunStep | undefined {
  return [...steps].reverse().find(predicate);
}

export function projectRuntimeAgents(
  runStatus: string | null,
  steps: ReasoningRunStep[],
  result: ReasoningOutput | null,
  children: ReasoningRunResponse["children"] = [],
): RuntimeAgent[] {
  if (result) return result.runtime.agents;
  if (!runStatus && steps.length === 0) return [];

  const selector = latest(
    steps,
    (step) => step.name === "select_applicable_rules",
  );
  const compiler = latest(
    steps,
    (step) => step.name === "compile_qualified_prompt",
  );
  const firstLlm = steps.find((step) => step.name === "llm.call");
  const qualifiedChild = children.find(
    (child) => child.runtimeRole === "qualified",
  );
  const runFailed =
    runStatus === "failed" ||
    runStatus === "cancelled" ||
    runStatus === "stalled";
  const projectedStepStatus = (
    step: ReasoningRunStep | undefined,
  ): RuntimeStatus => {
    const status = terminalStepStatus(step);
    return runFailed && status === "running" ? "blocked" : status;
  };

  const agents: RuntimeAgent[] = [
    {
      id: "reasoning",
      label: "Intent Reasoner",
      status: selector
        ? "completed"
        : runFailed
          ? "blocked"
            : projectedStepStatus(firstLlm) === "waiting"
            ? runStatus === "queued"
              ? "waiting"
              : "running"
            : projectedStepStatus(firstLlm),
      detail: selector
        ? "公开 Harness、语义锚点与证据结构已生成。"
        : "正在解析意图并设计动态 Reasoning Harness…",
    },
    {
      id: "query",
      label: "Rule Selector / QueryAgent",
      status: projectedStepStatus(selector),
      detail: selector
        ? selector.status === "ok"
          ? "Allmeta Link-only Cypher 与语义路径回执已完成。"
          : `Allmeta 规则筛选：${selector.status}`
        : "等待 Harness anchors…",
    },
    {
      id: "compiler",
      label: "Prompt Compiler",
      status: !compiler && runFailed ? "blocked" : projectedStepStatus(compiler),
      detail: compiler
        ? compiler.status === "ok"
          ? "QualifiedAgent prompt 已编译。"
          : `Prompt 编译：${compiler.status}`
        : runFailed
          ? "上游运行失败，Prompt Compiler 未执行。"
          : "等待 RuleBundle…",
    },
    {
      id: "qualified",
      label: "QualifiedAgent",
      status:
        runFailed && qualifiedChild?.run.status !== "ok"
          ? "blocked"
          : qualifiedChild
            ? qualifiedChild.run.status === "ok"
              ? "completed"
              : qualifiedChild.run.status === "failed" ||
                  qualifiedChild.run.status === "cancelled"
                ? "blocked"
                : "running"
            : "waiting",
      detail: qualifiedChild
        ? qualifiedChild.run.status === "ok"
          ? `独立 child run ${qualifiedChild.run.id} 已完成逐规则质量检查。`
          : `独立 child run ${qualifiedChild.run.id}：${qualifiedChild.run.status}`
        : runFailed
          ? "上游运行失败，QualifiedAgent 未产生判定。"
          : "等待编译后的规则判定 harness…",
    },
    {
      id: "fold",
      label: "Deterministic Fold",
      status: runFailed ? "blocked" : "waiting",
      detail: runFailed
        ? "运行失败，未产生可放行裁决。"
        : "等待 QualifiedAgent 输出…",
    },
  ];
  return ORDER.map((id) => agents.find((agent) => agent.id === id)!);
}

export const RUNTIME_EDGES = [
  { from: "reasoning", to: "query" },
  { from: "query", to: "compiler" },
  { from: "compiler", to: "qualified" },
  { from: "qualified", to: "fold" },
] as const;

export function humanStepName(
  step: ReasoningRunStep,
  steps: ReasoningRunStep[] = [],
  runtimeRole: "primary" | "qualified" = "primary",
): string {
  if (runtimeRole === "qualified") {
    if (step.name === "llm.repair") return "QualifiedAgent · JSON Repair";
    if (step.name === "llm.call") return "QualifiedAgent · 逐规则判定";
    return `QualifiedAgent · ${step.name}`;
  }
  if (step.name === "select_applicable_rules")
    return "Rule Selector / QueryAgent";
  if (step.name === "compile_qualified_prompt") return "Prompt Compiler";
  if (step.name === "search_ontology_resources") return "Ontology Search";
  if (step.name === "get_ontology_resource_detail") return "Ontology Detail";
  if (step.name === "llm.repair") return "Reasoning Orchestrator · JSON Repair";
  if (step.name === "llm.call") {
    const selectorOrd = steps.find(
      (candidate) => candidate.name === "select_applicable_rules",
    )?.ord;
    const compilerOrd = steps.find(
      (candidate) => candidate.name === "compile_qualified_prompt",
    )?.ord;
    if (compilerOrd !== undefined && step.ord > compilerOrd) {
      return "Reasoning Orchestrator · child handoff 确认";
    }
    if (selectorOrd === undefined || step.ord < selectorOrd) {
      return "Intent Reasoner · 规划与工具选择";
    }
    return "Reasoning Orchestrator · 工具回执处理";
  }
  return step.name;
}
