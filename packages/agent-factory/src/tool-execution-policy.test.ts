import { describe, expect, it } from "vitest";
import type { GeneratedAgentSpec } from "./spec-types";
import type { RealTool } from "./tool-catalog";
import {
  assertGeneratedSpecToolPoliciesCurrent,
  ToolPolicyDriftError,
} from "./tool-execution-policy";

const pure = {
  operation: "compute",
  effectScope: "none",
  sandboxPolicy: "pure",
} as const;

function spec(): GeneratedAgentSpec {
  return {
    key: "a",
    actionName: "a",
    slug: "domain-a",
    short: "A",
    domainId: "domain",
    nameZh: "A",
    kind: "llm",
    trigger: [],
    emit: [],
    tools: ["hash.alias"],
    toolPolicies: { "hash.alias": pure },
    unresolvedTools: [],
    objects: [],
    systemPrompt: "x",
    userPrompt: "",
    steps: [],
    plan: [{ stepId: "nested", kind: "foreach", body: [{ stepId: "hash", kind: "tool", tool: "hash.alias" }] }],
    ruleRefs: [],
    retries: 1,
    hitl: false,
    confidence: 1,
    promptSource: "llm",
  } as GeneratedAgentSpec;
}

const registry: RealTool[] = [{
  name: "crypto.sha256",
  aliases: ["hash.alias"],
  ...pure,
}];

describe("assertGeneratedSpecToolPoliciesCurrent", () => {
  it("accepts an exact policy resolved through an alias and nested plan", () => {
    expect(() => assertGeneratedSpecToolPoliciesCurrent([spec()], registry)).not.toThrow();
  });

  it("rejects policy drift", () => {
    const changed = [{
      ...registry[0]!,
      operation: "write" as const,
      effectScope: "external" as const,
      sandboxPolicy: "requires_attempt_grant" as const,
    }];
    expect(() => assertGeneratedSpecToolPoliciesCurrent([spec()], changed))
      .toThrow(ToolPolicyDriftError);
  });

  it("rejects a missing spec snapshot or incomplete current registry metadata", () => {
    const missingSpec = spec();
    missingSpec.toolPolicies = {};
    expect(() => assertGeneratedSpecToolPoliciesCurrent([missingSpec], registry))
      .toThrow(/spec 未携带完整/);
    expect(() => assertGeneratedSpecToolPoliciesCurrent([spec()], [{ name: "crypto.sha256", aliases: ["hash.alias"] }]))
      .toThrow(/registry 未声明完整/);
  });
});
