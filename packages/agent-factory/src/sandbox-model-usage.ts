import { createHash } from "node:crypto";

import { canonicalEvidenceJson } from "./evidence-fingerprint";
import { inspectGeneratedContextMethodCalls } from "./code-lint";
import type { GeneratedAgentSpec, PlanStep } from "./spec-types";

export const SANDBOX_MODEL_USAGE_SCHEMA =
  "agent-factory-sandbox-model-usage/v1" as const;

/** Secret-free, attempt-bound aggregate of semantic model calls. Provider raw
 * payloads, prompts, business data and credentials are deliberately absent. */
export interface SandboxModelUsageEvidence {
  schema: typeof SANDBOX_MODEL_USAGE_SCHEMA;
  sandboxAttemptId: string;
  bundleHash: string;
  targetTenantId: string;
  targetTenantSlug: string;
  calls: number;
  successfulCalls: number;
  failedCalls: number;
  rejectedCalls: number;
  /** Sanitized runtime agent identifiers parsed from `purpose=agent:<id>/…`.
   * No prompt, payload, run subject or provider raw data is retained. */
  agentCalls: Array<{
    agentRef: string;
    calls: number;
    successfulCalls: number;
    failedCalls: number;
    rejectedCalls: number;
  }>;
  rejectedReasons: Array<{ agentRef: string; reasonCode: string; count: number }>;
  providerModels: Array<{ provider: string; model: string }>;
  /** Null means at least one successful provider response omitted measured
   * usage. Promotion rejects that ambiguity whenever a model was called. */
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  budget: {
    enforced: true;
    maxCalls: number;
    maxTotalTokens: number;
    reservedTotalTokens: number;
  };
  startedAt: string;
  completedAt: string;
  evidenceHash: string;
}

export function sandboxModelUsageEvidenceHash(
  evidence:
    | SandboxModelUsageEvidence
    | Omit<SandboxModelUsageEvidence, "evidenceHash">,
): string {
  const { evidenceHash: _evidenceHash, ...body } =
    evidence as SandboxModelUsageEvidence;
  return `sandbox-model-usage:v1:${createHash("sha256")
    .update(canonicalEvidenceJson(body), "utf8")
    .digest("hex")}`;
}

export function sandboxModelUsageEvidenceIssues(
  evidence: SandboxModelUsageEvidence | null | undefined,
  expected: {
    sandboxAttemptId?: string;
    bundleHash?: string;
    targetTenantId?: string;
    targetTenantSlug?: string;
    modelRequired?: boolean;
    requiredAgentRefs?: string[];
  } = {},
): string[] {
  if (!evidence) return ["missing sandbox model-usage evidence"];
  const issues: string[] = [];
  if (evidence.schema !== SANDBOX_MODEL_USAGE_SCHEMA) {
    issues.push("unsupported sandbox model-usage schema");
  }
  for (const [label, value] of [
    ["sandbox attempt", evidence.sandboxAttemptId],
    ["bundle hash", evidence.bundleHash],
    ["target tenant id", evidence.targetTenantId],
    ["target tenant slug", evidence.targetTenantSlug],
  ] as const) {
    if (!value?.trim()) issues.push(`missing model-usage ${label}`);
  }
  const integers = [
    ["calls", evidence.calls],
    ["successfulCalls", evidence.successfulCalls],
    ["failedCalls", evidence.failedCalls],
    ["rejectedCalls", evidence.rejectedCalls],
    ["maxCalls", evidence.budget?.maxCalls],
    ["maxTotalTokens", evidence.budget?.maxTotalTokens],
    ["reservedTotalTokens", evidence.budget?.reservedTotalTokens],
  ] as const;
  for (const [label, value] of integers) {
    if (!Number.isSafeInteger(value) || value < 0) {
      issues.push(`invalid model-usage ${label}`);
    }
  }
  if (evidence.calls !== evidence.successfulCalls + evidence.failedCalls + evidence.rejectedCalls) {
    issues.push("model-usage call totals do not reconcile");
  }
  if (evidence.successfulCalls + evidence.failedCalls > evidence.budget?.maxCalls) {
    issues.push("model-call budget was exceeded");
  }
  if (
    evidence.budget?.enforced !== true
    || evidence.budget.maxCalls < 1
    || evidence.budget.maxTotalTokens < 1
    || evidence.budget.reservedTotalTokens > evidence.budget.maxTotalTokens
  ) {
    issues.push("model budget was not enforceably bounded");
  }
  if (evidence.failedCalls !== 0 || evidence.rejectedCalls !== 0) {
    issues.push("one or more sandbox model calls failed or were rejected");
  }
  if (expected.modelRequired === true && evidence.successfulCalls < 1) {
    issues.push("candidate requires semantic reasoning but made zero model calls");
  }
  const tokenFields = [evidence.inputTokens, evidence.outputTokens, evidence.totalTokens];
  if (evidence.successfulCalls > 0) {
    if (tokenFields.some((value) => !Number.isSafeInteger(value) || (value ?? -1) < 0)) {
      issues.push("provider did not report complete measured token usage");
    } else if (evidence.totalTokens !== evidence.inputTokens! + evidence.outputTokens!) {
      issues.push("model token totals do not reconcile");
    }
    if (
      evidence.outputTokens !== null
      && evidence.totalTokens !== null
      && evidence.totalTokens > evidence.budget.reservedTotalTokens
    ) {
      issues.push("measured tokens exceeded their reserved model budget");
    }
    if (!Array.isArray(evidence.providerModels) || evidence.providerModels.length < 1) {
      issues.push("model provider/model attribution is missing");
    }
  } else if (tokenFields.some((value) => value !== 0)) {
    issues.push("zero-call model evidence must report zero tokens");
  }
  const identities = new Set<string>();
  for (const identity of evidence.providerModels ?? []) {
    if (!identity?.provider?.trim() || !identity?.model?.trim()) {
      issues.push("model provider/model attribution is invalid");
      continue;
    }
    const key = `${identity.provider}\u0000${identity.model}`;
    if (identities.has(key)) issues.push("model provider/model attribution is duplicated");
    identities.add(key);
  }
  const agentRefs = new Set<string>();
  let agentCallTotal = 0;
  for (const agent of evidence.agentCalls ?? []) {
    if (!agent?.agentRef?.trim() || agentRefs.has(agent.agentRef)) {
      issues.push("model agent-call attribution is invalid or duplicated");
      continue;
    }
    agentRefs.add(agent.agentRef);
    if (
      ![agent.calls, agent.successfulCalls, agent.failedCalls, agent.rejectedCalls]
        .every((value) => Number.isSafeInteger(value) && value >= 0)
      || agent.calls !== agent.successfulCalls + agent.failedCalls + agent.rejectedCalls
    ) {
      issues.push(`model agent-call totals do not reconcile for ${agent.agentRef}`);
    }
    agentCallTotal += agent.calls;
  }
  if (agentCallTotal !== evidence.calls) issues.push("model agent-call attribution does not cover every request");
  const rejectedReasonTotal = (evidence.rejectedReasons ?? []).reduce((total, row) => {
    if (
      !row?.agentRef?.trim()
      || !/^[A-Za-z0-9_:-]{1,100}$/.test(row.reasonCode ?? "")
      || !Number.isSafeInteger(row.count)
      || row.count < 1
    ) issues.push("model rejection attribution is invalid");
    return total + (Number.isSafeInteger(row?.count) ? row.count : 0);
  }, 0);
  if (rejectedReasonTotal !== evidence.rejectedCalls) {
    issues.push("model rejection attribution does not cover every rejected request");
  }
  for (const required of expected.requiredAgentRefs ?? []) {
    const row = evidence.agentCalls?.find((agent) => agent.agentRef === required);
    if (!row || row.successfulCalls < 1) {
      issues.push(`candidate agent ${required} requires semantic reasoning but made zero successful model calls`);
    }
  }
  if (
    !evidence.startedAt
    || !evidence.completedAt
    || Number.isNaN(Date.parse(evidence.startedAt))
    || Number.isNaN(Date.parse(evidence.completedAt))
    || Date.parse(evidence.completedAt) < Date.parse(evidence.startedAt)
  ) {
    issues.push("model-usage timestamps are invalid");
  }
  const comparisons: Array<[string, string | undefined, string]> = [
    ["attempt", expected.sandboxAttemptId, evidence.sandboxAttemptId],
    ["bundle", expected.bundleHash, evidence.bundleHash],
    ["tenant id", expected.targetTenantId, evidence.targetTenantId],
    ["tenant slug", expected.targetTenantSlug, evidence.targetTenantSlug],
  ];
  for (const [label, wanted, actual] of comparisons) {
    if (wanted && wanted !== actual) issues.push(`sandbox model-usage ${label} mismatch`);
  }
  if (evidence.evidenceHash !== sandboxModelUsageEvidenceHash(evidence)) {
    issues.push("sandbox model-usage evidence hash mismatch");
  }
  return [...new Set(issues)];
}

function planRequiresModel(steps: PlanStep[] | undefined): boolean {
  return (steps ?? []).some((step) =>
    step.kind === "logic" || planRequiresModel(step.body));
}

/** Conservative static declaration used only for the promotion gate. It reads
 * executable AST calls; comments and string literals never count. */
export function generatedSpecRequiresModel(spec: GeneratedAgentSpec): boolean {
  return generatedSpecModelRequirement(spec).required;
}

export function generatedFleetRequiresModel(specs: GeneratedAgentSpec[]): boolean {
  return generatedFleetModelRequirement(specs).requiredAgentRefs.length > 0;
}

export function generatedSpecModelRequirement(spec: GeneratedAgentSpec): {
  required: boolean;
  issues: string[];
} {
  if (planRequiresModel(spec.plan)) return { required: true, issues: [] };
  if (spec.codeExecuted !== true) {
    // The manifest projector inserts one default logic action when no plan is
    // authored; runtime executes that action through the model gateway.
    return { required: (spec.plan?.length ?? 0) === 0, issues: [] };
  }
  const inspected = inspectGeneratedContextMethodCalls(spec.generatedCode ?? "", "reason");
  return {
    // Parser uncertainty is fail-closed: the caller also surfaces `issues`.
    required: inspected.calls > 0 || inspected.issues.length > 0,
    issues: inspected.issues.map((issue) => `${spec.short}: ${issue}`),
  };
}

export function generatedFleetModelRequirement(specs: GeneratedAgentSpec[]): {
  requiredAgentRefs: string[];
  issues: string[];
} {
  const requiredAgentRefs: string[] = [];
  const issues: string[] = [];
  for (const spec of specs) {
    const requirement = generatedSpecModelRequirement(spec);
    // Runtime/model purposes use the deployed agent name, which is the stable
    // slug. Falling back to short only keeps partial legacy/test specs
    // diagnosable; production GeneratedAgentSpec always carries a slug.
    if (requirement.required) requiredAgentRefs.push(spec.slug || spec.short);
    issues.push(...requirement.issues);
  }
  return { requiredAgentRefs: [...new Set(requiredAgentRefs)].sort(), issues };
}
