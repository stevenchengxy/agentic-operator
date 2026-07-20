import { describe, expect, it } from "vitest";
import type { RealTool } from "./tool-catalog";
import type { GeneratedAgentSpec } from "./spec-types";
import { catalogToolDefinitionHash, type CatalogToolDefinition } from "./declarative-tool-hash";
import {
  createIntegrationProfileAuthorizationBinding,
  INTEGRATION_PROFILE_AUTHORIZATION_PROTOCOL_VERSION,
  integrationProfileConfigDigest,
  integrationProfileIdentityIssues,
  integrationProfileScopeIssues,
  integrationProfileToolDefinitionDigest,
  validateGeneratedSpecIntegrationProfiles,
} from "./integration-profile-authorization";

const tool: RealTool = {
  name: "vendor.lookup",
  catalogDefinition: {
    name: "vendor.lookup",
    configSchema: {
      api_key_env: { type: "string", required: true },
      region: { type: "string", required: true },
    },
  },
};

describe("integration profile authorization", () => {
  it("is deterministic and binds tool, domain, profile key and config", () => {
    const first = createIntegrationProfileAuthorizationBinding({
      tool,
      domainId: "domain-a",
      profileKey: "primary",
      environment: "production",
      config: { region: "cn", api_key_env: "VENDOR_KEY" },
    });
    const reordered = createIntegrationProfileAuthorizationBinding({
      tool,
      domainId: "domain-a",
      profileKey: "primary",
      environment: "production",
      config: { api_key_env: "VENDOR_KEY", region: "cn" },
    });
    expect(first).toEqual(reordered);
    expect(first.token).toMatch(/^authorize_integration_profile:v3:[a-f0-9]{64}$/);
    expect(first.token).not.toContain("VENDOR_KEY");
    expect(createIntegrationProfileAuthorizationBinding({
      tool,
      domainId: "domain-b",
      profileKey: "primary",
      environment: "production",
      config: { api_key_env: "VENDOR_KEY", region: "cn" },
    }).token).not.toBe(first.token);
    expect(createIntegrationProfileAuthorizationBinding({
      tool,
      domainId: "domain-a",
      profileKey: "primary",
      environment: "production",
      config: { api_key_env: "VENDOR_KEY", region: "cn" },
      scope: { runId: "run-2", conversationId: "conversation-1" },
    }).token).not.toBe(createIntegrationProfileAuthorizationBinding({
      tool,
      domainId: "domain-a",
      profileKey: "primary",
      environment: "production",
      config: { api_key_env: "VENDOR_KEY", region: "cn" },
      scope: { runId: "run-1", conversationId: "conversation-1" },
    }).token);
    expect(createIntegrationProfileAuthorizationBinding({
      tool,
      domainId: "domain-a",
      profileKey: "secondary",
      environment: "production",
      config: { api_key_env: "VENDOR_KEY", region: "cn" },
    }).token).not.toBe(first.token);
    expect(createIntegrationProfileAuthorizationBinding({
      tool,
      domainId: "domain-a",
      profileKey: "primary",
      environment: "production",
      config: { api_key_env: "VENDOR_KEY", region: "us" },
    }).token).not.toBe(first.token);
    expect(createIntegrationProfileAuthorizationBinding({
      tool: {
        ...tool,
        catalogDefinition: {
          ...tool.catalogDefinition!,
          configSchema: {
            ...tool.catalogDefinition!.configSchema,
            timeout_ms: { type: "integer" },
          },
        },
      },
      domainId: "domain-a",
      profileKey: "primary",
      environment: "production",
      config: { api_key_env: "VENDOR_KEY", region: "cn" },
    }).token).not.toBe(first.token);

    expect(createIntegrationProfileAuthorizationBinding({
      tool,
      domainId: "domain-a",
      profileKey: "primary",
      environment: "sandbox",
      config: { api_key_env: "VENDOR_KEY", region: "cn" },
    }).token).not.toBe(first.token);
  });

  it("invalidates probe and profile identity when the config contract changes", () => {
    const definition: CatalogToolDefinition = {
      name: "vendor.lookup",
      configSchema: {
        endpoint: { type: "string" },
        endpoint_env: { type: "string" },
      },
    };
    const contracted: CatalogToolDefinition = {
      ...definition,
      configContract: {
        atLeastOne: [{ keys: ["endpoint", "endpoint_env"] }],
        mutuallyExclusive: [{ keys: ["endpoint", "endpoint_env"] }],
      },
    };
    const config = { endpoint: "https://vendor.example.test" };

    expect(catalogToolDefinitionHash(definition, config, {})).not.toBe(
      catalogToolDefinitionHash(contracted, config, {}),
    );
    expect(integrationProfileToolDefinitionDigest({ name: definition.name, catalogDefinition: definition })).not.toBe(
      integrationProfileToolDefinitionDigest({ name: contracted.name, catalogDefinition: contracted }),
    );
  });

  it("rejects legacy confirmations and prevents production/sandbox cross-use", () => {
    const config = { api_key_env: "VENDOR_KEY", region: "cn" };
    const profile = {
      id: "profile-1",
      tenantId: "tenant-1",
      profileKey: "primary",
      toolName: tool.name,
      domainId: "domain-a",
      environment: "production" as const,
      config,
      confirmedBy: "user-1",
      toolDefinitionDigest: integrationProfileToolDefinitionDigest(tool),
      configDigest: integrationProfileConfigDigest(config),
      authorizationProtocolVersion: 2,
      confirmedAt: "2026-07-14T00:00:00.000Z",
    };
    expect(INTEGRATION_PROFILE_AUTHORIZATION_PROTOCOL_VERSION).toBe(3);
    expect(integrationProfileIdentityIssues(profile, tool)).toContain("profile authorization protocol 2 已失效");
    expect(integrationProfileScopeIssues({
      ...profile,
      authorizationProtocolVersion: INTEGRATION_PROFILE_AUTHORIZATION_PROTOCOL_VERSION,
    }, tool, {
      tenantId: "tenant-1",
      domainId: "domain-a",
      environment: "sandbox",
      actionName: "lookup",
    })).toContain("profile 属于 production，不能用于 sandbox");
  });

  it("purely revalidates both profile environments and immutable spec config digests", () => {
    const productionConfig = { api_key_env: "VENDOR_PRODUCTION_KEY", region: "cn" };
    const sandboxConfig = { api_key_env: "VENDOR_SANDBOX_KEY", region: "sandbox" };
    const profile = (environment: "production" | "sandbox", config: Record<string, unknown>) => ({
      id: `profile-${environment}`,
      tenantId: "tenant-1",
      profileKey: "primary",
      toolName: tool.name,
      domainId: "domain-a",
      environment,
      config,
      confirmedBy: "user-1",
      toolDefinitionDigest: integrationProfileToolDefinitionDigest(tool),
      configDigest: integrationProfileConfigDigest(config),
      authorizationProtocolVersion: INTEGRATION_PROFILE_AUTHORIZATION_PROTOCOL_VERSION,
      confirmedAt: "2026-07-14T00:00:00.000Z",
    });
    const profiles = [profile("production", productionConfig), profile("sandbox", sandboxConfig)];
    const spec: GeneratedAgentSpec = {
      key: "lookup",
      actionName: "lookup",
      slug: "domain-a-lookup",
      short: "LookupAgent",
      domainId: "domain-a",
      nameZh: "查询",
      kind: "llm",
      trigger: ["LOOKUP_REQUESTED"],
      emit: ["LOOKUP_COMPLETED"],
      tools: [tool.name],
      toolConfigs: { [tool.name]: productionConfig },
      toolProfileRefs: { [tool.name]: "profile-production" },
      sandboxToolConfigs: { [tool.name]: sandboxConfig },
      sandboxToolProfileRefs: { [tool.name]: "profile-sandbox" },
      unresolvedTools: [],
      objects: [],
      systemPrompt: "lookup",
      userPrompt: "",
      decisionLogic: "emit LOOKUP_COMPLETED",
      steps: [],
      ruleRefs: [],
      retries: 1,
      hitl: false,
      confidence: 1,
      promptSource: "llm",
      inputSchema: [],
      outputSchema: [],
      generatedCode: "export async function handler() { return {}; }",
      codeSource: "ai",
      codeExecuted: false,
    };
    const scope = { tenantId: "tenant-1", tenantSlug: "tenant-one", domainId: "domain-a" };

    expect(validateGeneratedSpecIntegrationProfiles({ specs: [spec], tools: [tool], profiles, scope })).toEqual({
      ok: true,
      issues: [],
    });
    expect(validateGeneratedSpecIntegrationProfiles({
      specs: [{ ...spec, sandboxToolProfileRefs: { [tool.name]: "profile-production" } }],
      tools: [tool],
      profiles,
      scope,
    }).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "profile_environment_mismatch", environment: "sandbox" }),
    ]));
    expect(validateGeneratedSpecIntegrationProfiles({
      specs: [{ ...spec, toolConfigs: { [tool.name]: { ...productionConfig, region: "us" } } }],
      tools: [tool],
      profiles,
      scope,
    }).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "spec_config_digest_mismatch", environment: "production" }),
    ]));
    expect(validateGeneratedSpecIntegrationProfiles({
      specs: [spec],
      tools: [tool],
      profiles: [{ ...profiles[0]!, authorizationProtocolVersion: 2 }, profiles[1]!],
      scope,
    }).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "profile_identity_invalid", environment: "production" }),
    ]));
  });

  it("validates only the integration environment required by the current lifecycle stage", () => {
    const productionConfig = { api_key_env: "VENDOR_PRODUCTION_KEY", region: "cn" };
    const productionProfile = {
      id: "profile-production",
      tenantId: "tenant-1",
      profileKey: "primary",
      toolName: tool.name,
      domainId: "domain-a",
      environment: "production" as const,
      config: productionConfig,
      confirmedBy: "user-1",
      toolDefinitionDigest: integrationProfileToolDefinitionDigest(tool),
      configDigest: integrationProfileConfigDigest(productionConfig),
      authorizationProtocolVersion: INTEGRATION_PROFILE_AUTHORIZATION_PROTOCOL_VERSION,
      confirmedAt: "2026-07-14T00:00:00.000Z",
    };
    const spec: GeneratedAgentSpec = {
      key: "lookup",
      actionName: "lookup",
      slug: "domain-a-lookup",
      short: "LookupAgent",
      domainId: "domain-a",
      nameZh: "查询",
      kind: "llm",
      trigger: ["LOOKUP_REQUESTED"],
      emit: ["LOOKUP_COMPLETED"],
      tools: [tool.name],
      toolConfigs: { [tool.name]: productionConfig },
      toolProfileRefs: { [tool.name]: productionProfile.id },
      sandboxToolConfigs: {},
      sandboxToolProfileRefs: {},
      unresolvedTools: [],
      objects: [],
      systemPrompt: "lookup",
      userPrompt: "",
      decisionLogic: "emit LOOKUP_COMPLETED",
      steps: [],
      ruleRefs: [],
      retries: 1,
      hitl: false,
      confidence: 1,
      promptSource: "llm",
      inputSchema: [],
      outputSchema: [],
      generatedCode: "export async function handler() { return {}; }",
      codeSource: "ai",
      codeExecuted: false,
    };
    const input = {
      specs: [spec],
      tools: [tool],
      profiles: [productionProfile],
      scope: { tenantId: "tenant-1", tenantSlug: "tenant-one", domainId: "domain-a" },
    };

    expect(validateGeneratedSpecIntegrationProfiles({
      ...input,
      environments: ["production"],
    })).toEqual({ ok: true, issues: [] });
    expect(validateGeneratedSpecIntegrationProfiles({
      ...input,
      environments: ["sandbox"],
    }).issues).toEqual([
      expect.objectContaining({
        code: "profile_required",
        environment: "sandbox",
        toolName: tool.name,
      }),
    ]);
  });
});
