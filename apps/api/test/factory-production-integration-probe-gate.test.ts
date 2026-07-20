import { describe, expect, it } from "vitest";
import {
  probeDefinitionHash,
  type GeneratedAgentSpec,
  type RealTool,
} from "@agentic/agent-factory";
import {
  productionIntegrationProbeIssues,
} from "../src/services/agent-factory/production-integration-probe-gate";

const env = {
  SANDBOX_VENDOR_KEY: "sandbox-secret",
  PRODUCTION_VENDOR_KEY: "production-secret",
};

function tool(over: Partial<RealTool> = {}): RealTool {
  return {
    name: "vendor.send",
    summary: "Send to vendor",
    sideEffect: "write",
    operation: "write",
    effectScope: "external",
    sandboxPolicy: "requires_attempt_grant",
    capabilities: [],
    catalogDefinition: {
      name: "vendor.send",
      category: "vendor",
      sourcePath: "vendor/send.ts",
      sourceIdentity: { buildId: "build-1", handlerSha256: "a".repeat(64) },
      sideEffect: "write",
      operation: "write",
      effectScope: "external",
      sandboxPolicy: "requires_attempt_grant",
      configSchema: {
        base_url: { type: "string", required: true },
        api_key_env: { type: "string", required: true },
      },
    },
    ...over,
  };
}

function spec(config: Record<string, unknown>): GeneratedAgentSpec {
  return {
    key: "send",
    actionName: "send",
    slug: "send-agent",
    short: "SendAgent",
    domainId: "Agents-generation",
    nameZh: "发送",
    kind: "llm",
    trigger: ["READY"],
    emit: ["SENT"],
    tools: ["vendor.send"],
    toolConfigs: { "vendor.send": config },
    toolPolicies: {
      "vendor.send": {
        operation: "write",
        effectScope: "external",
        sandboxPolicy: "requires_attempt_grant",
      },
    },
    toolSideEffects: { "vendor.send": "write" },
    unresolvedTools: [],
    objects: [],
    systemPrompt: "发送",
    userPrompt: "",
    steps: [],
    ruleRefs: [],
    retries: 1,
    hitl: false,
    confidence: 1,
    promptSource: "llm",
  } as GeneratedAgentSpec;
}

describe("production integration live-probe gate", () => {
  it("does not let a sandbox config live probe authorize a different production endpoint/credential", () => {
    const current = tool();
    const sandboxConfig = {
      base_url: "https://sandbox.vendor.test",
      api_key_env: "SANDBOX_VENDOR_KEY",
    };
    const productionConfig = {
      base_url: "https://api.vendor.example",
      api_key_env: "PRODUCTION_VENDOR_KEY",
    };
    const sandboxHash = probeDefinitionHash(current, sandboxConfig, env)!;
    const issues = productionIntegrationProbeIssues(
      [spec(productionConfig)],
      [{
        ...current,
        verifiedDefinitionHashes: [sandboxHash],
        productionVerifiedDefinitionHashes: [sandboxHash],
      }],
      env,
    );
    expect(issues).toEqual([
      expect.objectContaining({
        code: "production_live_probe_missing",
        tool: "vendor.send",
      }),
    ]);
  });

  it("accepts only the exact current production implementation/config hash", () => {
    const current = tool();
    const productionConfig = {
      base_url: "https://api.vendor.example",
      api_key_env: "PRODUCTION_VENDOR_KEY",
    };
    const productionHash = probeDefinitionHash(current, productionConfig, env)!;
    expect(productionIntegrationProbeIssues(
      [spec(productionConfig)],
      [{ ...current, productionVerifiedDefinitionHashes: [productionHash] }],
      env,
    )).toEqual([]);

    expect(productionIntegrationProbeIssues(
      [spec(productionConfig)],
      [{
        ...current,
        catalogDefinition: {
          ...current.catalogDefinition!,
          sourceIdentity: { buildId: "build-2", handlerSha256: "b".repeat(64) },
        },
        productionVerifiedDefinitionHashes: [productionHash],
      }],
      env,
    )[0]).toMatchObject({ code: "production_live_probe_missing" });
  });

  it("treats external/write policy as risky even when capability metadata omits probeRequired", () => {
    const current = tool({ capabilities: [] });
    expect(productionIntegrationProbeIssues(
      [spec({ base_url: "https://api.vendor.example", api_key_env: "PRODUCTION_VENDOR_KEY" })],
      [current],
      env,
    )[0]).toMatchObject({ code: "production_live_probe_missing" });
  });

  it("does not demand production probes for a pure local utility", () => {
    const pure = tool({
      name: "local.compute",
      sideEffect: "read",
      operation: "compute",
      effectScope: "none",
      sandboxPolicy: "pure",
      catalogDefinition: {
        name: "local.compute",
        sideEffect: "read",
        operation: "compute",
        effectScope: "none",
        sandboxPolicy: "pure",
      },
    });
    const pureSpec = {
      ...spec({}),
      tools: [],
      plan: [{ stepId: "nested", kind: "foreach", itemsFrom: "input.items", itemKeyFrom: "item.id", body: [
        { stepId: "compute", kind: "tool", tool: "local.compute" },
      ] }],
      toolConfigs: {},
    } as GeneratedAgentSpec;
    expect(productionIntegrationProbeIssues([pureSpec], [pure], env)).toEqual([]);
  });
});
