import type {
  GeneratedAgentSpec,
  GeneratedToolExecutionPolicy,
  PlanStep,
} from "./spec-types";
import type { RealTool } from "./tool-catalog";

export function isGeneratedToolExecutionPolicy(
  value: unknown,
): value is GeneratedToolExecutionPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const policy = value as Partial<GeneratedToolExecutionPolicy>;
  return (
    policy.sandboxPolicy === "pure"
    && policy.effectScope === "none"
    && (policy.operation === "read" || policy.operation === "compute")
  ) || (
    policy.sandboxPolicy === "sandbox_local"
    && policy.effectScope === "sandbox_local"
    && ["read", "compute", "write", "read_write"].includes(String(policy.operation))
  ) || (
    policy.sandboxPolicy === "live_external"
    && policy.effectScope === "external"
    && (policy.operation === "read" || policy.operation === "compute")
  ) || (
    policy.sandboxPolicy === "requires_attempt_grant"
    && policy.effectScope === "external"
    && (policy.operation === "write" || policy.operation === "read_write")
  );
}

export function realToolExecutionPolicy(
  tool: RealTool | undefined,
): GeneratedToolExecutionPolicy | undefined {
  if (!tool) return undefined;
  const policy = {
    operation: tool.operation,
    effectScope: tool.effectScope,
    sandboxPolicy: tool.sandboxPolicy,
  };
  return isGeneratedToolExecutionPolicy(policy) ? policy : undefined;
}

export function generatedToolPoliciesEqual(
  left: GeneratedToolExecutionPolicy,
  right: GeneratedToolExecutionPolicy,
): boolean {
  return left.operation === right.operation
    && left.effectScope === right.effectScope
    && left.sandboxPolicy === right.sandboxPolicy;
}

function planToolNames(steps: readonly PlanStep[] | undefined): string[] {
  return (steps ?? []).flatMap((step) => [
    ...(step.kind === "tool" && step.tool ? [step.tool] : []),
    ...planToolNames(step.body),
  ]);
}

export function generatedSpecToolNames(spec: GeneratedAgentSpec): string[] {
  return [...new Set([...(spec.tools ?? []), ...planToolNames(spec.plan)])].sort();
}

export class ToolPolicyDriftError extends Error {
  constructor(
    readonly issues: string[],
    readonly missing: string[],
  ) {
    super(`工具执行策略与当前 registry 不一致：${issues.join("；")}`);
    this.name = "ToolPolicyDriftError";
  }
}

/** Promotion/sandbox commit-time guard. It re-resolves every selected name
 * (including aliases and nested plan tools) against the current registry and
 * compares all three reviewed fields. Missing/invalid metadata and alias
 * collisions fail closed; tool names and HTTP verbs are never interpreted. */
export function assertGeneratedSpecToolPoliciesCurrent(
  specs: readonly GeneratedAgentSpec[],
  realTools: readonly RealTool[],
): void {
  const byName = new Map<string, RealTool>();
  const issues: string[] = [];
  const missing: string[] = [];
  for (const tool of realTools) {
    for (const name of [tool.name, ...(tool.aliases ?? [])]) {
      const existing = byName.get(name);
      if (existing && existing !== tool) {
        issues.push(`registry 名称/别名冲突：${name}`);
      } else {
        byName.set(name, tool);
      }
    }
  }

  for (const spec of specs) {
    for (const name of generatedSpecToolNames(spec)) {
      const current = realToolExecutionPolicy(byName.get(name));
      const captured = spec.toolPolicies?.[name];
      if (!current) {
        missing.push(`${spec.slug}:${name}`);
        issues.push(`${spec.slug}/${name} 当前 registry 未声明完整 execution policy`);
      } else if (!isGeneratedToolExecutionPolicy(captured)) {
        missing.push(`${spec.slug}:${name}`);
        issues.push(`${spec.slug}/${name} spec 未携带完整 execution policy`);
      } else if (!generatedToolPoliciesEqual(captured, current)) {
        issues.push(`${spec.slug}/${name} spec policy 与当前 registry 不一致`);
      }
    }
  }

  if (issues.length) throw new ToolPolicyDriftError(issues, missing);
}
