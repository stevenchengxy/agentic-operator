import type { Translate } from "@/app/portal/lib/preferences-context";
import type {
  ReasoningRunResponse,
  ReasoningRunStep,
} from "@/lib/hooks/useReasoningAgentContext";
import type { ReasoningOutput, RuntimeAgent, RuntimeStatus } from "./contracts";

const ORDER = ["reasoning", "query", "compiler", "qualified", "fold"] as const;

function projectedStatusLabel(status: string, t: Translate): string {
  const keyByStatus: Record<string, string> = {
    queued: "reasoningAgent.page.status.queued",
    running: "reasoningAgent.page.status.running",
    ok: "reasoningAgent.page.status.ok",
    failed: "reasoningAgent.page.status.failed",
    cancelled: "reasoningAgent.page.status.cancelled",
  };
  const key = keyByStatus[status];
  return key ? t(key) : status;
}

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
  t: Translate,
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
      label: t("reasoningAgent.runProjection.agent.reasoning.label"),
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
        ? t("reasoningAgent.runProjection.agent.reasoning.detailReady")
        : t("reasoningAgent.runProjection.agent.reasoning.detailWorking"),
    },
    {
      id: "query",
      label: t("reasoningAgent.runProjection.agent.query.label"),
      status: projectedStepStatus(selector),
      detail: selector
        ? selector.status === "ok"
          ? t("reasoningAgent.runProjection.agent.query.detailOk")
          : t("reasoningAgent.runProjection.agent.query.detailStatus", {
              status: projectedStatusLabel(selector.status, t),
            })
        : t("reasoningAgent.runProjection.agent.query.detailWaiting"),
    },
    {
      id: "compiler",
      label: t("reasoningAgent.runProjection.agent.compiler.label"),
      status:
        !compiler && runFailed ? "blocked" : projectedStepStatus(compiler),
      detail: compiler
        ? compiler.status === "ok"
          ? t("reasoningAgent.runProjection.agent.compiler.detailOk")
          : t("reasoningAgent.runProjection.agent.compiler.detailStatus", {
              status: projectedStatusLabel(compiler.status, t),
            })
        : runFailed
          ? t(
              "reasoningAgent.runProjection.agent.compiler.detailUpstreamFailed",
            )
          : t("reasoningAgent.runProjection.agent.compiler.detailWaiting"),
    },
    {
      id: "qualified",
      label: t("reasoningAgent.runProjection.agent.qualified.label"),
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
          ? t("reasoningAgent.runProjection.agent.qualified.detailDone", {
              runId: qualifiedChild.run.id,
            })
          : t("reasoningAgent.runProjection.agent.qualified.detailStatus", {
              runId: qualifiedChild.run.id,
              status: projectedStatusLabel(qualifiedChild.run.status, t),
            })
        : runFailed
          ? t(
              "reasoningAgent.runProjection.agent.qualified.detailUpstreamFailed",
            )
          : t("reasoningAgent.runProjection.agent.qualified.detailWaiting"),
    },
    {
      id: "fold",
      label: t("reasoningAgent.runProjection.agent.fold.label"),
      status: runFailed ? "blocked" : "waiting",
      detail: runFailed
        ? t("reasoningAgent.runProjection.agent.fold.detailFailed")
        : t("reasoningAgent.runProjection.agent.fold.detailWaiting"),
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
  t: Translate,
  steps: ReasoningRunStep[] = [],
  runtimeRole: "primary" | "qualified" = "primary",
): string {
  if (runtimeRole === "qualified") {
    if (step.name === "llm.repair")
      return t("reasoningAgent.runProjection.stepName.qualifiedJsonRepair");
    if (step.name === "llm.call")
      return t("reasoningAgent.runProjection.stepName.qualifiedPerRuleVerdict");
    return t("reasoningAgent.runProjection.stepName.qualifiedGeneric", {
      name: step.name,
    });
  }
  if (step.name === "select_applicable_rules")
    return t("reasoningAgent.runProjection.stepName.ruleSelector");
  if (step.name === "compile_qualified_prompt")
    return t("reasoningAgent.runProjection.stepName.promptCompiler");
  if (step.name === "search_ontology_resources")
    return t("reasoningAgent.runProjection.stepName.ontologySearch");
  if (step.name === "get_ontology_resource_detail")
    return t("reasoningAgent.runProjection.stepName.ontologyDetail");
  if (step.name === "llm.repair")
    return t("reasoningAgent.runProjection.stepName.orchestratorJsonRepair");
  if (step.name === "llm.call") {
    const selectorOrd = steps.find(
      (candidate) => candidate.name === "select_applicable_rules",
    )?.ord;
    const compilerOrd = steps.find(
      (candidate) => candidate.name === "compile_qualified_prompt",
    )?.ord;
    if (compilerOrd !== undefined && step.ord > compilerOrd) {
      return t(
        "reasoningAgent.runProjection.stepName.orchestratorChildHandoff",
      );
    }
    if (selectorOrd === undefined || step.ord < selectorOrd) {
      return t("reasoningAgent.runProjection.stepName.intentReasonerPlanning");
    }
    return t("reasoningAgent.runProjection.stepName.orchestratorToolReceipt");
  }
  return step.name;
}
