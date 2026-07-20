import { describe, expect, it } from "vitest";

import type { GeneratedAgentSpec } from "./spec-types";
import {
  generatedFleetModelRequirement,
  generatedSpecModelRequirement,
  sandboxModelUsageEvidenceHash,
  sandboxModelUsageEvidenceIssues,
  type SandboxModelUsageEvidence,
} from "./sandbox-model-usage";

function spec(short: string, generatedCode: string): GeneratedAgentSpec {
  return {
    short,
    generatedCode,
    codeExecuted: true,
    plan: [],
  } as unknown as GeneratedAgentSpec;
}

function evidence(): SandboxModelUsageEvidence {
  const body: Omit<SandboxModelUsageEvidence, "evidenceHash"> = {
    schema: "agent-factory-sandbox-model-usage/v1",
    sandboxAttemptId: "attempt-model-evidence",
    bundleHash: "bundle-model-evidence",
    targetTenantId: "tenant-model-evidence",
    targetTenantSlug: "model-evidence",
    calls: 1,
    successfulCalls: 1,
    failedCalls: 0,
    rejectedCalls: 0,
    agentCalls: [{ agentRef: "ReasonA", calls: 1, successfulCalls: 1, failedCalls: 0, rejectedCalls: 0 }],
    rejectedReasons: [],
    providerModels: [{ provider: "openai", model: "gpt-test" }],
    inputTokens: 10,
    outputTokens: 4,
    totalTokens: 14,
    budget: { enforced: true, maxCalls: 8, maxTotalTokens: 10_000, reservedTotalTokens: 2_000 },
    startedAt: new Date(1_000).toISOString(),
    completedAt: new Date(2_000).toISOString(),
  };
  return { ...body, evidenceHash: sandboxModelUsageEvidenceHash(body) };
}

describe("sandbox semantic-model requirement and evidence", () => {
  it("does not treat comments or strings containing ctx.reason as execution", () => {
    const inspected = generatedSpecModelRequirement(spec("CommentOnly", `
      // ctx.reason("not executed", input)
      const note = "ctx.reason(also not executed)";
      export const value = { handler: async () => ({ ok: true, note }) };
    `));
    expect(inspected).toEqual({ required: false, issues: [] });
  });

  it("finds a direct reason call on a renamed handler context", () => {
    expect(generatedSpecModelRequirement(spec("ReasonA", `
      export const value = {
        async handler(input, runtime) { return runtime.reason("decide", input); }
      };
    `))).toEqual({ required: true, issues: [] });
  });

  it("counts a literal bracket call but fails closed on an aliased reason function", () => {
    expect(generatedSpecModelRequirement(spec("Bracket", `
      export const value = { async handler(input, ctx) { return ctx["reason"]("decide", input); } };
    `))).toEqual({ required: true, issues: [] });
    const aliased = generatedSpecModelRequirement(spec("Aliased", `
      export const value = { async handler(input, ctx) {
        const decide = ctx.reason;
        return decide("decide", input);
      } };
    `));
    expect(aliased.required).toBe(true);
    expect(aliased.issues.join(" ")).toMatch(/直接调用 ctx\.reason/);
  });

  it("fails closed with an explanation when generated code cannot be parsed", () => {
    const inspected = generatedSpecModelRequirement(spec("Broken", "export const = ; ctx.reason("));
    expect(inspected.required).toBe(true);
    expect(inspected.issues.join(" ")).toMatch(/语法错误|不能确认/);
  });

  it("requires successful model attribution for every reasoning agent", () => {
    const requirement = generatedFleetModelRequirement([
      spec("ReasonA", `export const a = { async handler(i, ctx) { return ctx.reason("a", i); } };`),
      spec("ReasonB", `export const b = { async handler(i, ctx) { return ctx.reason("b", i); } };`),
    ]);
    expect(requirement.requiredAgentRefs).toEqual(["ReasonA", "ReasonB"]);
    expect(sandboxModelUsageEvidenceIssues(evidence(), {
      modelRequired: true,
      requiredAgentRefs: requirement.requiredAgentRefs,
    })).toContain("candidate agent ReasonB requires semantic reasoning but made zero successful model calls");
  });
});
