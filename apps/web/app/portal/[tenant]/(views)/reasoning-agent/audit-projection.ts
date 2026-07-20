import type {
  ReasoningRunResponse,
  ReasoningRunStep,
} from "@/lib/hooks/useReasoningAgentContext";
import {
  compiledPromptToolOutputSchema,
  ruleSelectionToolOutputSchema,
  type CompiledPrompt,
  type QualificationCompilerReceipt,
  type QualifiedAgentRunReceipt,
  type RuleSelectionToolData,
} from "./contracts";

export interface ProjectedQualificationCompilerReceipt {
  compilerReceipt: QualificationCompilerReceipt;
  ruleCount: number;
  qualifiedRun: QualifiedAgentRunReceipt | null;
  assessmentCount: number | null;
}

export interface ExecutedQualifiedPrompt {
  source: "verified-qualified-child-step";
  runId: string;
  parentRunId: string | null;
  runStatus: string;
  provider: string | null;
  model: string | null;
  systemPrompt: string;
  userPrompt: string;
}

export interface ReasoningToolAudit {
  input: {
    userPrompt: string;
    evidence: Record<string, unknown>;
    evidenceKeys: string[];
  } | null;
  ruleSelection: RuleSelectionToolData | null;
  compiledPrompt: CompiledPrompt | null;
  compilerReceipt: ProjectedQualificationCompilerReceipt | null;
  executedQualifiedPrompt: ExecutedQualifiedPrompt | null;
}

function inputFromFirstLlmStep(steps: ReasoningRunStep[]) {
  const firstLlm = steps.find(
    (step) => step.name === "llm.call" && step.status === "ok",
  );
  if (!firstLlm?.input || typeof firstLlm.input !== "object") return null;
  const messages = (firstLlm.input as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return null;
  const userMessage = messages.find(
    (message) =>
      message &&
      typeof message === "object" &&
      (message as { role?: unknown }).role === "user" &&
      typeof (message as { content?: unknown }).content === "string",
  ) as { content: string } | undefined;
  if (!userMessage) return null;

  const evidenceMarker = "通用输入证据：\n";
  const evidenceAt = userMessage.content.lastIndexOf(evidenceMarker);
  if (evidenceAt < 0) return null;
  const promptMarker = "用户请求：\n";
  const scenarioMarker = "\n\n业务场景：";
  const promptAt = userMessage.content.indexOf(promptMarker);
  const scenarioAt = userMessage.content.indexOf(scenarioMarker, promptAt);
  try {
    const parsed = JSON.parse(
      userMessage.content.slice(evidenceAt + evidenceMarker.length),
    ) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const evidence = parsed as Record<string, unknown>;
    return {
      userPrompt:
        promptAt >= 0 && scenarioAt > promptAt
          ? userMessage.content.slice(
              promptAt + promptMarker.length,
              scenarioAt,
            )
          : "",
      evidence,
      evidenceKeys: Object.keys(evidence).sort(),
    };
  } catch {
    return null;
  }
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * The dedicated Reasoning API exposes only tenant/correlation/role-verified
 * QualifiedAgent children. Recover the exact messages sent to that child so a
 * compiled prompt stays inspectable when the parent fails after compilation
 * but before the final reasoning-result artifact is written.
 */
export function projectExecutedQualifiedPrompt(
  children: ReasoningRunResponse["children"],
): ExecutedQualifiedPrompt | null {
  if (children.length !== 1) return null;
  const child = children[0]!;
  if (child.role !== "qualified" || child.runtimeRole !== "qualified") {
    return null;
  }
  const firstLlmStep = [...child.steps]
    .sort((left, right) => left.ord - right.ord)
    .find((step) => step.name === "llm.call");
  const artifact = recordValue(firstLlmStep?.input);
  if (
    artifact.agent !== "reasoningAgent" ||
    artifact.runtimeRole !== "qualified" ||
    artifact.parentRunId !== child.run.parentRunId
  ) {
    return null;
  }
  const messages = Array.isArray(artifact.messages) ? artifact.messages : [];
  const systemMessages = messages.filter((message) => {
    const candidate = recordValue(message);
    return candidate.role === "system" && typeof candidate.content === "string";
  });
  const userMessages = messages.filter((message) => {
    const candidate = recordValue(message);
    return candidate.role === "user" && typeof candidate.content === "string";
  });
  if (systemMessages.length !== 1 || userMessages.length !== 1) return null;
  return {
    source: "verified-qualified-child-step",
    runId: child.run.id,
    parentRunId: child.run.parentRunId ?? null,
    runStatus: child.run.status,
    provider:
      typeof artifact.provider === "string"
        ? artifact.provider
        : child.run.model
          ? "runtime"
          : null,
    model:
      typeof artifact.model === "string" ? artifact.model : child.run.model,
    systemPrompt: recordValue(systemMessages[0]).content as string,
    userPrompt: recordValue(userMessages[0]).content as string,
  };
}

/**
 * Recover completed tool receipts even when a later LLM/provider call fails.
 * This keeps the inspector honest: already-selected Allmeta rules and an
 * already-compiled prompt remain visible instead of disappearing with the
 * missing final result artifact.
 */
export function projectReasoningToolAudit(
  steps: ReasoningRunStep[],
  children: ReasoningRunResponse["children"] = [],
): ReasoningToolAudit {
  let ruleSelection: RuleSelectionToolData | null = null;
  let compiledPrompt: CompiledPrompt | null = null;
  let compilerReceipt: ProjectedQualificationCompilerReceipt | null = null;

  for (const step of steps) {
    if (step.status !== "ok") continue;
    if (step.name === "select_applicable_rules") {
      const parsed = ruleSelectionToolOutputSchema.safeParse(step.output);
      if (parsed.success) ruleSelection = parsed.data.data;
    }
    if (step.name === "compile_qualified_prompt") {
      const parsed = compiledPromptToolOutputSchema.safeParse(step.output);
      if (parsed.success) {
        const data = parsed.data.data;
        if ("compilerReceipt" in data) {
          compilerReceipt = data;
        } else {
          compiledPrompt = data;
          compilerReceipt = {
            compilerReceipt: {
              compilerId: data.compilerId,
              compilerVersion: data.compilerVersion,
              promptSha256: data.promptSha256 ?? "legacy / hash unverified",
              ...(data.fullSemanticPathsSha256
                ? {
                    fullSemanticPathsSha256: data.fullSemanticPathsSha256,
                  }
                : {}),
            } as QualificationCompilerReceipt,
            ruleCount: data.ruleIds.length,
            qualifiedRun: data.qualifiedRun ?? null,
            assessmentCount: data.assessmentCount ?? null,
          };
        }
      }
    }
  }

  return {
    input: ruleSelection?.auditInput ?? inputFromFirstLlmStep(steps),
    ruleSelection,
    compiledPrompt,
    compilerReceipt,
    executedQualifiedPrompt: projectExecutedQualifiedPrompt(children),
  };
}
