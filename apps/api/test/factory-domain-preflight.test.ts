import { describe, expect, it } from "vitest";
import type {
  DeclarativeTool,
  DomainOntology,
  IntegrationCapabilityProvider,
  RealTool,
} from "@agentic/agent-factory";
import {
  INTEGRATION_PROFILE_AUTHORIZATION_PROTOCOL_VERSION,
  catalogToolDefinitionHash,
  integrationProfileConfigDigest,
  integrationProfileToolDefinitionDigest,
} from "@agentic/agent-factory";
import {
  FactoryDomainPreflightUsageError,
  credentialPresence,
  enforceFactoryPreflightReadOnlyDatabase,
  factoryDomainPreflightExitCode,
  mergeFactoryPreflightTools,
  parseFactoryDomainPreflightArgs,
  preflightProfileHashKey,
  redactPreflightDiagnostic,
  summarizeFactoryDomainPreflight,
} from "../scripts/factory-domain-preflight";

const writeProbeSafety = {
  testDataContract: {
    kind: "synthetic_canary" as const,
    marker: { kind: "argument" as const, path: "probe.marker", valuePrefix: "factory-canary-" },
  },
  idempotency: { kind: "argument" as const, path: "probe.idempotency_key", valuePrefix: "factory-idem-" },
  isolation: {
    namespace: { kind: "argument" as const, path: "probe.namespace", valuePrefix: "factory-ns-" },
    target: { kind: "argument" as const, path: "probe.target", valuePrefix: "factory-target-" },
  },
  cleanup: { kind: "handler" as const, handler: "ontology.writeInstance.cleanupCanary" },
  absenceProof: { kind: "handler" as const, handler: "ontology.writeInstance.readCanary" },
};

const ontology: DomainOntology = {
  domainId: "generic-domain",
  source: "allmeta",
  objects: [{
    id: "Work",
    name: "Work",
    primary_key: "work_id",
    properties: [{ name: "work_id", type: "String" }],
  }],
  rules: [],
  actions: [{
    id: "work",
    name: "doWork",
    actor: ["Agent"],
    trigger: [],
    triggered_event: ["WORK_DONE"],
    target_objects: ["Work"],
    tool_use: [],
    system_prompt: "",
    user_prompt: "",
    inputs: [],
    outputs: [],
    side_effects: { notifications: [{ triggered_event: "WORK_DONE" }] },
    integration: {
      systems: [
        { name: "Vendor A", kind: "external_api", role: "calls", capability: "GET /lookup", objects: ["Work"] },
        { name: "Vendor B", kind: "external_api", role: "calls", capability: "POST /sync", objects: ["Work"] },
        { name: "LLM Gateway", kind: "external_api", role: "calls", objects: ["Work"] },
        { name: "Event Bus", kind: "event_bus", role: "notifies", objects: ["Work"] },
        { name: "Unimplemented System", kind: "external_api", role: "calls", capability: "POST /create", objects: ["Work"] },
      ],
    },
  }],
  events: [{
    name: "WORK_DONE",
    payload: { source_action: "doWork", event_data: [], state_mutations: [] },
  }],
  workflow: [],
};

const tools: RealTool[] = [
  {
    name: "vendorA.lookup",
    credentialEnv: ["VENDOR_A_KEY"],
    capabilities: [{
      systems: ["Vendor A"],
      kinds: ["external_api"],
      roles: ["calls"],
      operations: ["lookup"],
      objectTypes: ["Work"],
      probeRequired: false,
    }],
  },
  {
    name: "vendorB.sync",
    probeStatus: "required",
    capabilities: [{
      systems: ["Vendor B"],
      kinds: ["external_api"],
      roles: ["calls"],
      operations: ["sync"],
      objectTypes: ["Work"],
      probeRequired: true,
    }],
  },
];

const providers: IntegrationCapabilityProvider[] = [{
  id: "agent-runtime.reason",
  status: "available",
  capabilities: [{
    systems: ["LLM Gateway"],
    kinds: ["external_api"],
    roles: ["calls"],
    objectTypes: ["*"],
  }],
}];

describe("factory domain preflight CLI", () => {
  it("opens evidence storage read-only and rejects an explicit writable mode", () => {
    const unset = {} as NodeJS.ProcessEnv;
    enforceFactoryPreflightReadOnlyDatabase(unset);
    expect(unset.AGENTIC_DATABASE_READONLY).toBe("1");
    expect(() => enforceFactoryPreflightReadOnlyDatabase({
      AGENTIC_DATABASE_READONLY: "true",
    })).not.toThrow();
    expect(() => enforceFactoryPreflightReadOnlyDatabase({
      AGENTIC_DATABASE_READONLY: "0",
    })).toThrow(/writable preflight is forbidden/);
  });

  it("strictly parses required generic scope and diagnostic override", () => {
    expect(parseFactoryDomainPreflightArgs([
      "--",
      "--tenant-id=ten-1",
      "--tenant-slug", "acme",
      "--domain", "custom-domain",
      "--allow-blocked",
    ])).toEqual({
      tenantId: "ten-1",
      tenantSlug: "acme",
      domain: "custom-domain",
      allowBlocked: true,
    });
    expect(parseFactoryDomainPreflightArgs(["--help"])).toEqual({ help: true });
    expect(() => parseFactoryDomainPreflightArgs([
      "--tenant-id", "ten-1",
      "--tenant-slug", "acme",
    ])).toThrow(FactoryDomainPreflightUsageError);
    expect(() => parseFactoryDomainPreflightArgs([
      "--tenant-id", "ten-1",
      "--tenant-slug", "acme",
      "--domain", "custom-domain",
      "--unknown",
    ])).toThrow(/unknown argument/);
  });

  it("groups ontology and tool/runtime/event bindings and distinguishes gaps", () => {
    const report = summarizeFactoryDomainPreflight({
      scope: { tenantId: "ten-1", tenantSlug: "acme", domain: "generic-domain" },
      ontology,
      globalTools: tools,
      declarativeTools: [],
      runtimeProviders: providers,
      envPresence: {},
    });

    expect(report.ontologyReadiness.ready).toBe(true);
    expect(report.integrationBindings.counts).toEqual({
      resolved: 2,
      needs_config: 1,
      needs_profile_selection: 0,
      needs_probe: 1,
      missing: 1,
      // #HUMAN-BOUNDARY — a confirmed manual boundary is its own binding status. It is counted
      // here but never satisfies readiness; preflight must surface it rather than hide it.
      human_boundary: 0,
    });
    expect(report.integrationBindings.groups.tool).toHaveLength(3);
    expect(report.integrationBindings.groups.runtime).toMatchObject([
      { bindingId: "agent-runtime.reason", status: "resolved" },
    ]);
    expect(report.integrationBindings.groups.event).toMatchObject([
      { bindingId: "WORK_DONE", status: "resolved" },
    ]);
    expect(report.missing.config).toMatchObject([
      { toolName: "vendorA.lookup", missingCredentialEnv: ["VENDOR_A_KEY"] },
    ]);
    expect(report.missing.probe).toMatchObject([
      { toolName: "vendorB.sync", status: "needs_probe" },
    ]);
    expect(report.missing.binding).toMatchObject([
      { requirement: { system: "Unimplemented System" }, status: "missing" },
    ]);
    expect(report.blockedReasons).toEqual([
      "integration_needs_config:1",
      "integration_needs_probe:1",
      "integration_missing:1",
    ]);
    expect(report.inventory).toMatchObject({
      actions: 1,
      agentActions: 1,
      globalTools: 2,
      declarativeTools: 0,
      declarativeShadowedByGlobal: 0,
      executableTools: 2,
    });
    expect(factoryDomainPreflightExitCode(report, false)).toBe(1);
    expect(factoryDomainPreflightExitCode(report, true)).toBe(0);
    expect(report.blocked).toBe(true);
  });

  it("does not make Human workflow integrations block Agent function generation", () => {
    const humanAction = {
      ...ontology.actions[0]!,
      id: "manual-approval",
      name: "manualApproval",
      actor: ["Human"],
      triggered_event: [],
      side_effects: {},
      integration: {
        systems: [{ name: "Manual Platform", kind: "human_ui", role: "execute", objects: ["Work"] }],
      },
    };
    const report = summarizeFactoryDomainPreflight({
      scope: { tenantId: "ten-1", tenantSlug: "acme", domain: "generic-domain" },
      ontology: { ...ontology, actions: [ontology.actions[0]!, humanAction] },
      globalTools: tools,
      declarativeTools: [],
      runtimeProviders: providers,
      envPresence: {},
    });

    expect(report.inventory).toMatchObject({
      actions: 2,
      agentActions: 1,
      integrationRequirements: 5,
    });
    expect(report.integrationBindings.counts.missing).toBe(1);
    expect([
      ...report.integrationBindings.groups.tool,
      ...report.integrationBindings.groups.runtime,
      ...report.integrationBindings.groups.event,
    ].some((row) => row.action === "manualApproval")).toBe(false);
  });

  it("reports declarative cross-field gaps as needs_config before considering probe evidence", () => {
    const storageAction = {
      ...ontology.actions[0]!,
      tool_use: ["storage.read"],
      triggered_event: [],
      side_effects: {},
      integration: {
        systems: [{ name: "Tenant Object Storage", kind: "object_store", role: "reads", objects: ["Work"] }],
      },
    };
    const storageTool: RealTool = {
      name: "storage.read",
      probeStatus: "required",
      capabilities: [{
        systems: ["Tenant Object Storage"],
        kinds: ["object_store"],
        roles: ["reads"],
        objectTypes: ["Work"],
        probeRequired: true,
      }],
      catalogDefinition: {
        name: "storage.read",
        configSchema: {
          endpoint: { type: "string" },
          endpoint_env: { type: "string" },
          access_key_env: { type: "string" },
          secret_key_env: { type: "string" },
          auth: { type: "string" },
        },
        configContract: {
          atLeastOne: [{ keys: ["endpoint", "endpoint_env"] }],
          mutuallyExclusive: [{ keys: ["endpoint", "endpoint_env"] }],
          requiredUnless: [{
            keys: ["access_key_env", "secret_key_env"],
            unless: { key: "auth", equals: "anonymous" },
          }],
        },
      },
    };

    const report = summarizeFactoryDomainPreflight({
      scope: { tenantId: "ten-1", tenantSlug: "acme", domain: "generic-domain" },
      ontology: { ...ontology, actions: [storageAction], events: [] },
      globalTools: [storageTool],
      declarativeTools: [],
      runtimeProviders: [],
      envPresence: {},
    });

    expect(report.integrationBindings.counts).toEqual({
      resolved: 0,
      needs_config: 1,
      needs_profile_selection: 0,
      needs_probe: 0,
      missing: 0,
      human_boundary: 0,
    });
    expect(report.integrationBindings.groups.tool).toMatchObject([{
      status: "needs_config",
      toolName: "storage.read",
      missingConfigKeys: ["access_key_env", "endpoint|endpoint_env", "secret_key_env"],
      invalidConfigKeys: [],
    }]);
    expect(report.integrationBindings.groups.tool[0]?.reason).toContain("endpoint 或 endpoint_env");
    expect(report.missing.probe).toEqual([]);
  });

  it("groups ontology blocking issues independently from integration state", () => {
    const report = summarizeFactoryDomainPreflight({
      scope: { tenantId: "ten-1", tenantSlug: "acme", domain: "generic-domain" },
      ontology: {
        ...ontology,
        objects: [{ ...ontology.objects[0]!, primary_key: undefined }],
        actions: [],
        events: [],
      },
      globalTools: [],
      declarativeTools: [],
      runtimeProviders: [],
    });
    expect(report.ontologyReadiness.groups.blocking).toEqual([
      expect.objectContaining({ code: "object_primary_key_missing" }),
    ]);
    expect(report.integrationBindings.counts).toEqual({
      resolved: 0,
      needs_config: 0,
      needs_profile_selection: 0,
      needs_probe: 0,
      missing: 0,
      human_boundary: 0,
    });
    expect(report.blockedReasons).toContain("ontology_readiness:1");
  });

  it("requires an explicit action profile_ref even when only one compatible profile exists", () => {
    const capabilities = [{
      systems: ["Allmeta"],
      kinds: ["ontology"],
      roles: ["writes"],
      objectTypes: ["*"],
      probeRequired: true,
    }];
    const catalogDefinition = {
      name: "ontology.writeInstance",
      category: "ontology",
      sourcePath: "packages/tools/src/ontology/write-instance.ts",
      sideEffect: "write",
      probeSafety: writeProbeSafety,
      configSchema: {
        base_url_env: { type: "string", required: true },
        api_key_env: { type: "string", required: true },
        domain: { type: "string", required: true },
        action: { type: "string", required: true },
        allowed_tenants: { type: "string[]", required: true },
        allowed_domains: { type: "string[]", required: true },
        allowed_actions: { type: "string[]", required: true },
        allowed_objects: { type: "string[]", required: true },
        timeout_ms: { type: "integer" },
      },
      profileScope: {
        exact: [
          { configKey: "domain", source: "domain" as const },
          { configKey: "action", source: "action" as const },
        ],
        allowlists: [
          { configKey: "allowed_tenants", source: "tenant" as const, match: "any" as const },
          { configKey: "allowed_domains", source: "domain" as const, match: "all" as const },
          { configKey: "allowed_actions", source: "action" as const, match: "all" as const },
          { configKey: "allowed_objects", source: "objects" as const, match: "all" as const },
        ],
      },
      capabilities,
    };
    const config = {
      base_url_env: "ALLMETA_BASE_URL",
      api_key_env: "ALLMETA_API_KEY",
      domain: "generic-domain",
      action: "doWork",
      allowed_tenants: ["ten-1"],
      allowed_domains: ["generic-domain"],
      allowed_actions: ["doWork"],
      allowed_objects: ["Work"],
      timeout_ms: 3_000,
    };
    const realEnv = {
      ALLMETA_BASE_URL: "https://allmeta.example.test",
      ALLMETA_API_KEY: "test-only-key-material",
    };
    const envPresence = { ALLMETA_BASE_URL: "configured", ALLMETA_API_KEY: "configured" };
    const definitionHash = catalogToolDefinitionHash(catalogDefinition, config, realEnv);
    const tool: RealTool = {
      name: catalogDefinition.name,
      sideEffect: "write",
      catalogDefinition,
      capabilities,
      verifiedDefinitionHashes: [definitionHash],
    };
    tool.integrationProfiles = [{
        id: "profile-primary",
        tenantId: "ten-1",
        profileKey: "primary",
        toolName: catalogDefinition.name,
        domainId: "generic-domain",
        environment: "production",
        config,
        confirmedBy: "usr-profile-owner",
        toolDefinitionDigest: integrationProfileToolDefinitionDigest(tool),
        configDigest: integrationProfileConfigDigest(config),
        authorizationProtocolVersion: INTEGRATION_PROFILE_AUTHORIZATION_PROTOCOL_VERSION,
        confirmedAt: "2026-07-13T00:00:00.000Z",
      }, {
        id: "profile-sandbox",
        tenantId: "ten-1",
        profileKey: "primary",
        toolName: catalogDefinition.name,
        domainId: "generic-domain",
        environment: "sandbox",
        config,
        confirmedBy: "usr-profile-owner",
        toolDefinitionDigest: integrationProfileToolDefinitionDigest(tool),
        configDigest: integrationProfileConfigDigest(config),
        authorizationProtocolVersion: INTEGRATION_PROFILE_AUTHORIZATION_PROTOCOL_VERSION,
        confirmedAt: "2026-07-13T00:00:00.000Z",
      }];
    const profileOntology: DomainOntology = {
      ...ontology,
      actions: [{
        ...ontology.actions[0]!,
        triggered_event: [],
        side_effects: {},
        integration: {
          systems: [{ name: "Allmeta", kind: "ontology", role: "writes", objects: ["Work"] }],
        },
      }],
      events: [],
    };

    const unselected = summarizeFactoryDomainPreflight({
      scope: { tenantId: "ten-1", tenantSlug: "acme", domain: "generic-domain" },
      ontology: profileOntology,
      globalTools: [tool],
      declarativeTools: [],
      runtimeProviders: [],
      envPresence,
      profileDefinitionHashes: {
        [preflightProfileHashKey(tool.name, "profile-primary")]: definitionHash,
      },
    });

    expect(unselected.integrationBindings.groups.tool).toMatchObject([{
      status: "needs_profile_selection",
      toolName: tool.name,
      profileSelection: {
        state: "unselected",
        explicit: false,
        candidates: [{ id: "profile-primary", profileKey: "primary", compatible: true, ready: true }],
      },
    }]);
    expect(unselected.missing.profileSelection).toHaveLength(1);
    expect(unselected.ready).toBe(false);

    const explicitlySelectedOntology: DomainOntology = {
      ...profileOntology,
      actions: profileOntology.actions.map((action) => ({
        ...action,
        integration: {
          ...(action.integration as Record<string, unknown>),
          profile_refs: { [tool.name]: "profile-primary" },
        },
      })),
    };
    const report = summarizeFactoryDomainPreflight({
      scope: { tenantId: "ten-1", tenantSlug: "acme", domain: "generic-domain" },
      ontology: explicitlySelectedOntology,
      globalTools: [tool],
      declarativeTools: [],
      runtimeProviders: [],
      envPresence,
      profileDefinitionHashes: {
        [preflightProfileHashKey(tool.name, "profile-primary")]: definitionHash,
      },
    });
    expect(report.integrationBindings.counts).toEqual({
      resolved: 1,
      needs_config: 0,
      needs_profile_selection: 0,
      needs_probe: 0,
      missing: 0,
      human_boundary: 0,
    });
    expect(report.integrationBindings.groups.tool).toMatchObject([{
      status: "resolved",
      toolName: tool.name,
      profileSelection: {
        state: "selected",
        explicit: true,
        selectedProfileId: "profile-primary",
        selectedProfileKey: "primary",
      },
    }]);
    expect(JSON.stringify(report)).not.toContain(realEnv.ALLMETA_API_KEY);
    expect(JSON.stringify(report)).not.toContain(realEnv.ALLMETA_BASE_URL);
    expect(credentialPresence([tool], realEnv)).toEqual({
      ALLMETA_BASE_URL: "configured",
      ALLMETA_API_KEY: "configured",
    });

    const missingTrustedHash = summarizeFactoryDomainPreflight({
      scope: { tenantId: "ten-1", tenantSlug: "acme", domain: "generic-domain" },
      ontology: explicitlySelectedOntology,
      globalTools: [tool],
      declarativeTools: [],
      runtimeProviders: [],
      envPresence,
    });
    expect(missingTrustedHash.integrationBindings.groups.tool).toMatchObject([{
      status: "needs_probe",
      profileSelection: { state: "selected", selectedProfileId: "profile-primary" },
    }]);

    const missingServerEnv = summarizeFactoryDomainPreflight({
      scope: { tenantId: "ten-1", tenantSlug: "acme", domain: "generic-domain" },
      ontology: explicitlySelectedOntology,
      globalTools: [tool],
      declarativeTools: [],
      runtimeProviders: [],
      envPresence: {},
    });
    expect(missingServerEnv.integrationBindings.groups.tool).toMatchObject([{
      status: "needs_config",
      missingCredentialEnv: ["ALLMETA_API_KEY", "ALLMETA_BASE_URL"],
      profileSelection: { state: "selected", selectedProfileId: "profile-primary" },
    }]);
    expect(missingServerEnv.missing.profileSelection).toHaveLength(0);
  });

  it("blocks ambiguous profiles until the action explicitly selects one", () => {
    const capabilities = [{
      systems: ["Allmeta"],
      kinds: ["ontology"],
      roles: ["writes"],
      objectTypes: ["*"],
      probeRequired: true,
    }];
    const catalogDefinition = {
      name: "ontology.writeInstance",
      sideEffect: "write",
      probeSafety: writeProbeSafety,
      configSchema: {
        base_url_env: { type: "string", required: true },
        api_key_env: { type: "string", required: true },
        domain: { type: "string", required: true },
        action: { type: "string", required: true },
        allowed_tenants: { type: "string[]", required: true },
        allowed_domains: { type: "string[]", required: true },
        allowed_actions: { type: "string[]", required: true },
        allowed_objects: { type: "string[]", required: true },
        timeout_ms: { type: "integer" },
      },
      profileScope: {
        exact: [
          { configKey: "domain", source: "domain" as const },
          { configKey: "action", source: "action" as const },
        ],
        allowlists: [
          { configKey: "allowed_tenants", source: "tenant" as const, match: "any" as const },
          { configKey: "allowed_domains", source: "domain" as const, match: "all" as const },
          { configKey: "allowed_actions", source: "action" as const, match: "all" as const },
          { configKey: "allowed_objects", source: "objects" as const, match: "all" as const },
        ],
      },
      capabilities,
    };
    const baseConfig = {
      base_url_env: "ALLMETA_BASE_URL",
      api_key_env: "ALLMETA_API_KEY",
      domain: "generic-domain",
      action: "doWork",
      allowed_tenants: ["ten-1", "acme"],
      allowed_domains: ["generic-domain"],
      allowed_actions: ["doWork"],
      allowed_objects: ["Work"],
    };
    const primaryConfig = { ...baseConfig, timeout_ms: 3_000 };
    const secondaryConfig = { ...baseConfig, timeout_ms: 5_000 };
    const env = { ALLMETA_BASE_URL: "configured", ALLMETA_API_KEY: "configured" };
    const primaryHash = catalogToolDefinitionHash(catalogDefinition, primaryConfig, env);
    const secondaryHash = catalogToolDefinitionHash(catalogDefinition, secondaryConfig, env);
    const tool: RealTool = {
      name: catalogDefinition.name,
      sideEffect: "write",
      catalogDefinition,
      capabilities,
      verifiedDefinitionHashes: [primaryHash, secondaryHash],
    };
    tool.integrationProfiles = [
        {
          id: "profile-primary",
          tenantId: "ten-1",
          profileKey: "primary",
          toolName: catalogDefinition.name,
          domainId: "generic-domain",
          environment: "production",
          config: primaryConfig,
          confirmedBy: "usr-profile-owner",
          toolDefinitionDigest: integrationProfileToolDefinitionDigest(tool),
          configDigest: integrationProfileConfigDigest(primaryConfig),
          authorizationProtocolVersion: INTEGRATION_PROFILE_AUTHORIZATION_PROTOCOL_VERSION,
          confirmedAt: "2026-07-13T00:00:00.000Z",
        },
        {
          id: "profile-secondary",
          tenantId: "ten-1",
          profileKey: "secondary",
          toolName: catalogDefinition.name,
          domainId: "generic-domain",
          environment: "production",
          config: secondaryConfig,
          confirmedBy: "usr-profile-owner",
          toolDefinitionDigest: integrationProfileToolDefinitionDigest(tool),
          configDigest: integrationProfileConfigDigest(secondaryConfig),
          authorizationProtocolVersion: INTEGRATION_PROFILE_AUTHORIZATION_PROTOCOL_VERSION,
          confirmedAt: "2026-07-13T00:00:00.000Z",
        },
      ];
    const profileAction = {
      ...ontology.actions[0]!,
      triggered_event: [],
      side_effects: {},
      integration: {
        systems: [{ name: "Allmeta", kind: "ontology", role: "writes", objects: ["Work"] }],
      },
    };
    const summarize = (action: DomainOntology["actions"][number]) => summarizeFactoryDomainPreflight({
      scope: { tenantId: "ten-1", tenantSlug: "acme", domain: "generic-domain" },
      ontology: { ...ontology, actions: [action], events: [] },
      globalTools: [tool],
      declarativeTools: [],
      runtimeProviders: [],
      envPresence: env,
      profileDefinitionHashes: {
        [preflightProfileHashKey(tool.name, "profile-primary")]: primaryHash,
        [preflightProfileHashKey(tool.name, "profile-secondary")]: secondaryHash,
      },
    });

    const ambiguous = summarize(profileAction);
    expect(ambiguous.integrationBindings.groups.tool).toMatchObject([{
      status: "needs_profile_selection",
      profileSelection: { state: "ambiguous", explicit: false },
    }]);
    expect(ambiguous.integrationBindings.groups.tool[0]?.profileSelection?.candidates).toHaveLength(2);
    expect(ambiguous.missing.profileSelection).toHaveLength(1);
    expect(ambiguous.blockedReasons).toContain("integration_needs_profile_selection:1");

    const explicitlySelected = summarize({
      ...profileAction,
      integration: {
        ...profileAction.integration,
        profile_refs: { [tool.name]: "secondary" },
      },
    });
    expect(explicitlySelected.integrationBindings.groups.tool).toMatchObject([{
      status: "resolved",
      profileSelection: {
        state: "selected",
        explicit: true,
        selectedProfileId: "profile-secondary",
        selectedProfileKey: "secondary",
      },
    }]);
    expect(explicitlySelected.ready).toBe(true);
  });

  it("merges tenant declarative contracts while global names remain authoritative", () => {
    const persisted: DeclarativeTool = {
      name: "custom.lookup",
      description: "Lookup a custom record",
      method: "POST",
      urlTemplate: "https://vendor.example/v1/lookup",
      headers: { Authorization: "Bearer {api_key}" },
      sideEffect: "read",
      domain: "generic-domain",
      requestSpec: { encoding: "json", bodyPath: "payload" },
      responseSpec: {
        unwrapPath: "data",
        mappings: { record_id: "record.id" },
        assertions: [{ path: "record.id", op: "non_empty", failure: "terminal", code: "record_missing" }],
      },
      paramsSchema: { payload: { type: "object" } },
      returnsSchema: { record_id: { type: "string" } },
      capabilities: [{
        systems: ["Custom Vendor"],
        kinds: ["external_api"],
        roles: ["calls"],
        operations: ["lookup"],
        objectTypes: ["Work"],
        probeRequired: true,
      }],
      probeStatus: "verified",
      definitionHash: "definition-hash-1",
    };
    const globalCollision: RealTool = {
      name: "collision.lookup",
      summary: "authoritative global definition",
      credentialEnv: ["GLOBAL_COLLISION_KEY"],
      probeStatus: "verified",
      definitionHash: "global-hash",
      capabilities: [],
    };
    const merged = mergeFactoryPreflightTools(
      [globalCollision],
      [{ ...persisted, name: globalCollision.name }, persisted],
    );

    expect(merged.declarativeShadowedByGlobal).toBe(1);
    expect(merged.executableTools).toHaveLength(2);
    expect(merged.executableTools[0]).toBe(globalCollision);
    expect(merged.executableTools[0]?.declarativeDefinition).toBeUndefined();
    expect(merged.executableTools[1]).toMatchObject({
      name: "custom.lookup",
      probeStatus: "verified",
      definitionHash: "definition-hash-1",
      capabilities: persisted.capabilities,
      declarativeDefinition: {
        requestSpec: persisted.requestSpec,
        responseSpec: persisted.responseSpec,
        paramsSchema: persisted.paramsSchema,
        returnsSchema: persisted.returnsSchema,
      },
    });
    expect(credentialPresence(merged.executableTools, {
      GLOBAL_COLLISION_KEY: "must-never-appear-in-report",
    })).toEqual({ GLOBAL_COLLISION_KEY: "configured" });
  });

  it("redacts common secret shapes before any diagnostic is printed", () => {
    const text = redactPreflightDiagnostic(
      "Bearer token-value https://user:pass@example.test/path?api_key=topsecret sk-1234567890abcdef",
    );
    expect(text).not.toContain("token-value");
    expect(text).not.toContain("user:pass");
    expect(text).not.toContain("topsecret");
    expect(text).not.toContain("sk-1234567890abcdef");
  });
});
