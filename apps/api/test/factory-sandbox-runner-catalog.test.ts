import { defineTool, type TenantRegistry } from "@agentic/agent-kit";
import {
  canonicalEvidenceJson,
  catalogToolDefinitionHash,
  type GeneratedAgentSpec,
} from "@agentic/agent-factory";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildSandboxCandidateBundle,
  sandboxToolBindingId,
  type SandboxBundleTenantRegistryDescriptor,
} from "../src/services/agent-factory/sandbox-bundle-builder";
import { canonicalSandboxSha256 } from "../src/services/agent-factory/sandbox-remote-protocol";
import { prepareSandboxRunnerCatalog } from "../src/services/agent-factory/sandbox-runner-catalog";
import {
  clearRuntimeTenantRegistrySnapshots,
  publishRuntimeTenantRegistrySnapshot,
  resolveTenantNativeFactoryTool,
} from "../src/services/agent-factory/tenant-native-tool-provider";
import { makeTargetInngestIsolationIdentity } from "./factory-sandbox-execution-fixture";

const domain = "Agents-generation";
const targetSlug = "dynamic-registry-target";
const registryVersion = "tenant-code@sha256:dynamic-v1";
const toolName = "dynamic.external.lookup";

function spec(): GeneratedAgentSpec {
  return {
    key: "DynamicLookup",
    actionName: "DynamicLookup",
    slug: "agents-generation-dynamic-lookup",
    short: "DynamicLookupAgent",
    domainId: domain,
    nameZh: "动态查询",
    kind: "llm",
    trigger: ["LOOKUP_REQUESTED"],
    emit: ["LOOKUP_COMPLETED"],
    tools: [toolName],
    toolSideEffects: { [toolName]: "read" },
    toolPolicies: {
      [toolName]: {
        operation: "read",
        effectScope: "external",
        sandboxPolicy: "live_external",
      },
    },
    sandboxToolConfigs: { [toolName]: {} },
    unresolvedTools: [],
    objects: [],
    systemPrompt: "Use the reviewed lookup evidence.",
    userPrompt: "",
    steps: [],
    ruleRefs: [],
    retries: 1,
    hitl: false,
    confidence: 1,
    plan: [{
      stepId: "lookup",
      kind: "tool",
      tool: toolName,
      onError: "terminal",
    }],
    generatedCode: "export async function handler(input, ctx) { return ctx.tool('dynamic.external.lookup', input); }",
    // The generated TypeScript remains a review artifact. A tool call belongs
    // to the declarative durable plan and must not claim CodeAct ownership.
    codeExecuted: false,
  } as GeneratedAgentSpec;
}

function registrySource() {
  return { kind: "tenant-code", id: targetSlug, version: "1.0.0" };
}

function catalogDefinition(handlerSha256 = "a".repeat(64)) {
  return {
    name: toolName,
    category: "dynamic-test",
    sourcePath: "tenant-code/tools/dynamic-lookup.ts",
    sourceIdentity: {
      provider: "tenant_registry",
      tenantSlug: targetSlug,
      selectedVersion: registryVersion,
      registry: registrySource(),
      tool: { modulePath: "tenant-code/tools/dynamic-lookup.ts", exportName: "dynamicLookup" },
      handlerSha256,
    },
    sideEffect: "read",
    operation: "read",
    effectScope: "external",
    sandboxPolicy: "live_external",
    argsSchema: { query: { type: "string", required: true } },
    returnsSchema: { found: { type: "boolean", required: true } },
    capabilities: [],
  };
}

function registryDescriptor(
  overrides: Partial<SandboxBundleTenantRegistryDescriptor> = {},
): SandboxBundleTenantRegistryDescriptor {
  return {
    schema: "agent-factory-sandbox-tenant-registry/v1",
    tenantSlug: targetSlug,
    selectedVersion: registryVersion,
    registrySource: registrySource(),
    promptNames: [],
    eventAdapter: null,
    ...overrides,
  };
}

function bundle(args: {
  definition?: ReturnType<typeof catalogDefinition>;
  descriptor?: SandboxBundleTenantRegistryDescriptor;
} = {}) {
  const definition = args.definition ?? catalogDefinition();
  const definitionHash = catalogToolDefinitionHash(definition, {});
  const configHash = canonicalSandboxSha256({});
  const specSlugs = [spec().slug];
  const bindingId = sandboxToolBindingId({
    specSlugs,
    toolName,
    configHash,
    definitionHash,
  });
  // The production snapshot builder crosses a JSON-only protocol boundary.
  // Runtime catalog objects may contain optional `undefined` properties, so
  // mirror that boundary here instead of passing an in-memory TS object.
  const wireDefinition = JSON.parse(
    canonicalEvidenceJson(definition),
  ) as ReturnType<typeof catalogDefinition>;
  return buildSandboxCandidateBundle({
    attemptId: "00000000-0000-4000-8000-000000000051",
    candidateFingerprint: "sandbox-evidence:v5:dynamic-registry",
    targetDomainId: domain,
    targetTenant: {
      tenantId: "tenant-dynamic-registry",
      tenantSlug: targetSlug,
      registryVersion,
    },
    tenantRegistry: args.descriptor ?? registryDescriptor(),
    targetInngestIsolation: makeTargetInngestIsolationIdentity(targetSlug),
    controlPlaneBuildId: "catalog-test-build",
    specs: [spec()],
    toolDefinitions: [{
      bindingId,
      specSlugs,
      toolName,
      configHash,
      source: "catalog",
      definition: {
        schema: "agent-factory-catalog-tool/v1",
        source: "tenant_registry",
        selectedName: toolName,
        registryVersion,
        catalogDefinition: wireDefinition,
      },
      definitionHash,
    }],
    toolEvidence: [{
      bindingId,
      specSlugs,
      toolName,
      configHash,
      definitionHash,
      cassette: {
        version: 1,
        tool: { name: toolName, definitionHash },
        evidence: { recordedAt: "2026-07-16T00:00:00.000Z", mode: "signed-fixture" },
        entries: [{
          key: "dynamic-lookup",
          request: { kind: "tool", toolName, argsHash: "args-hash" },
          response: { status: 200, body: { found: true } },
        }],
      },
    }],
    now: new Date("2026-07-16T00:00:00.000Z"),
  });
}

function packagedRegistry(handlerValue: string): TenantRegistry {
  const handler = handlerValue === "found"
    ? async function packagedLookupV1() { return { data: { found: true } }; }
    : async function packagedLookupV2() { return { data: { found: false, revision: 2 } }; };
  const tool = defineTool({
    name: toolName,
    factory: {
      category: "dynamic-test",
      sideEffect: "read",
      operation: "read",
      effectScope: "external",
      sandboxPolicy: "live_external",
      source: {
        modulePath: "tenant-code/tools/dynamic-lookup.ts",
        exportName: "dynamicLookup",
      },
      argsSchema: { query: { type: "string", required: true } },
      returnsSchema: { found: { type: "boolean", required: true } },
      capabilities: [],
    },
    handler,
  });
  return {
    tools: { [toolName]: tool },
    factory: { source: registrySource() },
  };
}

afterEach(() => clearRuntimeTenantRegistrySnapshots());

describe("sandbox workload registry projection", () => {
  it("builds an attempt-only fail-closed descriptor for dynamic external replay", async () => {
    const prepared = prepareSandboxRunnerCatalog(bundle());
    const descriptor = prepared.targetReplayRegistry?.tools?.[toolName];
    expect(descriptor).toMatchObject({ kind: "tool", name: toolName });
    await expect(descriptor!.handler({} as never)).rejects.toThrow(/replay invariant failed/);
  });

  it("blocks a dynamic registry whose prompt/event behavior cannot be projected", () => {
    expect(() => prepareSandboxRunnerCatalog(bundle({
      descriptor: registryDescriptor({ promptNames: ["customPrompt"] }),
    }))).toThrow(/不能等价验证|当前工具回放/);
  });

  it("rejects a packaged tenant tool when the handler SHA changed after bundle creation", () => {
    const first = packagedRegistry("found");
    publishRuntimeTenantRegistrySnapshot({
      tenantSlug: targetSlug,
      selectedVersion: registryVersion,
      registry: first,
    });
    const signed = resolveTenantNativeFactoryTool({
      tenantSlug: targetSlug,
      name: toolName,
      expectedVersion: registryVersion,
    })!.realTool.catalogDefinition!;
    const candidate = bundle({ definition: signed as ReturnType<typeof catalogDefinition> });

    publishRuntimeTenantRegistrySnapshot({
      tenantSlug: targetSlug,
      selectedVersion: registryVersion,
      registry: packagedRegistry("missing"),
    });
    expect(() => prepareSandboxRunnerCatalog(candidate)).toThrow(/handler SHA|definition/);
  });
});
