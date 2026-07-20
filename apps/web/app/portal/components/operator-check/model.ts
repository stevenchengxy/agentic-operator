import type {
  OperatorCheckRecord,
  OperatorCheckScenarioId,
  OperatorCheckStatus,
} from "@agentic/contracts";

export interface OperatorCheckScenarioDefinition {
  id: OperatorCheckScenarioId;
  title: string;
  description: string;
  purpose: string;
}

/** Fixed catalog keeps the result surface at exactly two scenario cards. */
export const OPERATOR_CHECK_SCENARIOS: readonly OperatorCheckScenarioDefinition[] =
  [
    {
      id: "support-triage",
      title: "Support request triage",
      description:
        "Builds an agent that classifies a realistic customer request and returns structured JSON.",
      purpose:
        "Checks prompt input, schema enforcement, publishing, event delivery, and stored output.",
    },
    {
      id: "context-probe",
      title: "Runtime context probe",
      description:
        "Builds a different agent that verifies structured variables and runtime context survive a full run.",
      purpose:
        "Checks manifest compatibility, mappings, runtime execution, trace evidence, logs, and artifacts.",
    },
  ] as const;

export function isOperatorCheckTerminal(status: OperatorCheckStatus): boolean {
  return status === "passed" || status === "failed";
}

/**
 * The API seeds the complete stage list before work begins. Terminal states
 * are always 100%; active checks advance as persisted stages finish, while
 * staying below 100 until the final verdict arrives.
 */
export function operatorCheckProgress(check: OperatorCheckRecord): number {
  if (isOperatorCheckTerminal(check.status)) return 100;
  if (check.status === "queued") return 0;
  const stageCount = check.stages.length;
  if (stageCount === 0) return 4;
  const completed = check.stages.filter((stage) =>
    isOperatorCheckTerminal(stage.status),
  ).length;
  return Math.min(96, Math.max(4, Math.round((completed / stageCount) * 100)));
}

export function operatorCheckStatusLabel(status: OperatorCheckStatus): string {
  if (status === "passed") return "Passed";
  if (status === "failed") return "Failed";
  if (status === "running") return "Running";
  return "Queued";
}
