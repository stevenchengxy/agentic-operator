import type { OntologyAction } from "./ontology-types";
import type { PlanStep } from "./spec-types";

const SAFE_STEP_ID = /^[A-Za-z_$][A-Za-z0-9_$-]*$/;

export interface OntologyExecutionStep {
  /** Stable safe id that the generated plan must preserve for traceability/dataflow. */
  stepId: string;
  sourceName: string;
  kind?: string;
  condition?: string;
  description?: string;
}

export interface ExecutionPlanRequirement {
  required: boolean;
  ontologySteps: OntologyExecutionStep[];
  integrationSystems: Array<{ name: string; role?: string; capability?: string }>;
  /** Systems actually touched inside the handler. Pure trigger/consumer declarations do not
   * create an extra step.run boundary. */
  replayableIntegrationCount: number;
  dataChangeCount: number;
  notificationCount: number;
  /** Procedure prose exists without a structured execution contract. */
  unstructuredInstruction: boolean;
  reasons: string[];
}

function asRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((row): row is Record<string, unknown> => !!row && typeof row === "object" && !Array.isArray(row))
    : [];
}

function safeStepId(raw: string, index: number): string {
  return SAFE_STEP_ID.test(raw) ? raw : `ontology-step-${index + 1}`;
}

/** Derive execution requirements only from ontology facts. There are no domain/action-name
 * allowlists here: any declared workflow steps, system boundary, mutation, or notification makes
 * a single opaque logic action an invalid production projection. */
export function analyzeExecutionPlanRequirement(action: OntologyAction): ExecutionPlanRequirement {
  const seenStepIds = new Set<string>();
  const ontologySteps = asRecords(action.action_steps).map((row, index) => {
    const sourceName = String(row.step_id ?? row.stepId ?? row.id ?? row.name ?? `ontology-step-${index + 1}`).trim();
    const baseId = safeStepId(sourceName, index);
    const stepId = seenStepIds.has(baseId) ? `${baseId}-${index + 1}` : baseId;
    seenStepIds.add(stepId);
    return {
      stepId,
      sourceName,
      kind: row.type != null ? String(row.type) : row.object_type != null ? String(row.object_type) : undefined,
      condition: row.condition != null ? String(row.condition) : undefined,
      description: row.description != null ? String(row.description) : undefined,
    };
  });
  const integration = action.integration && typeof action.integration === "object"
    ? action.integration as Record<string, unknown>
    : {};
  const integrationSystems = asRecords(integration.systems).map((row) => ({
    name: String(row.name ?? row.system ?? "unknown"),
    role: row.role != null ? String(row.role) : undefined,
    capability: row.capability != null ? String(row.capability) : undefined,
  }));
  const sideEffects = action.side_effects && typeof action.side_effects === "object"
    ? action.side_effects as Record<string, unknown>
    : {};
  const dataChangeCount = asRecords(sideEffects.data_changes).length;
  const notificationCount = asRecords(sideEffects.notifications).length;
  const replayableIntegrationCount = integrationSystems.filter((system) => !/^(triggers?|consumes?)$/i.test(system.role ?? "")).length;
  const unstructuredInstruction = action.actor.includes("Agent")
    && !!action.instruction?.trim()
    && ontologySteps.length === 0
    && integrationSystems.length === 0
    && dataChangeCount === 0
    && notificationCount === 0
    && (action.tool_use ?? []).length === 0;
  const reasons: string[] = [];
  if (ontologySteps.length > 1) reasons.push(`ontology declares ${ontologySteps.length} ordered action_steps`);
  else if (ontologySteps.some((step) => /tool|invoke|external|write|notify/i.test(step.kind ?? ""))) reasons.push("ontology declares an effectful action_step");
  if (replayableIntegrationCount) reasons.push(`ontology declares ${replayableIntegrationCount} integration system boundary(s)`);
  if (dataChangeCount) reasons.push(`ontology declares ${dataChangeCount} data mutation(s)`);
  if (notificationCount) reasons.push(`ontology declares ${notificationCount} notification side effect(s)`);
  if (unstructuredInstruction) reasons.push("action carries business instruction without structured action_steps/integration/side_effects");
  return {
    required: reasons.length > 0,
    ontologySteps,
    integrationSystems,
    replayableIntegrationCount,
    dataChangeCount,
    notificationCount,
    unstructuredInstruction,
    reasons,
  };
}

/** Validate that a generated plan does not erase ontology-declared operations. Additional
 * implementation steps are allowed; the ontology step ids are the minimum traceability floor. */
export function validatePlanAgainstOntology(action: OntologyAction, plan: PlanStep[]): string[] {
  const requirement = analyzeExecutionPlanRequirement(action);
  if (!requirement.required) return [];
  if (!plan.length) {
    return [`structured plan required: ${requirement.reasons.join("; ")}`];
  }
  const flattened = plan.flatMap(function walk(step: PlanStep): PlanStep[] {
    return [step, ...(step.body ?? []).flatMap(walk)];
  });
  const actual = new Set(flattened.map((step) => step.stepId));
  const missing = requirement.ontologySteps.filter((step) => !actual.has(step.stepId));
  const errors: string[] = [];
  if (missing.length) errors.push(`plan does not cover ontology action_steps: ${missing.map((step) => `${step.sourceName}→${step.stepId}`).join(", ")}`);
  const boundarySteps = flattened.filter((step) => step.kind === "tool" || step.kind === "invoke").length;
  if (requirement.replayableIntegrationCount && boundarySteps === 0) {
    // This is only the early structural floor. Exact requirement→tool/runtime
    // step references are established by integration binding and rechecked by
    // acceptance; step counts are never treated as execution evidence.
    errors.push(`plan has no external boundary step, but ontology declares ${requirement.replayableIntegrationCount} integration system boundary(s)`);
  } else if (!requirement.replayableIntegrationCount && (requirement.dataChangeCount || requirement.notificationCount) && boundarySteps === 0) {
    errors.push("plan declares data/notification side effects but has no tool/invoke boundary step");
  }
  return errors;
}
