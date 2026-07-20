import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  catalogToolDefinitionHash,
  declarativeToolDefinitionHash,
  type DeclarativeTool,
  type GeneratedAgentSpec,
} from "@agentic/agent-factory";
import { and, eq } from "drizzle-orm";
import { factoryToolProbes, factoryTools, getDb, tenants } from "@agentic/db";
import {
  makeToolCassetteEntry,
  type CanonicalCassetteDocument,
} from "@agentic/shared/cassette";
import { listGlobalTools } from "@agentic/tools";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { resolveSandboxBundleToolSnapshot } from "../src/services/agent-factory/sandbox-bundle-tool-snapshot";
import { buildSandboxCandidateBundle } from "../src/services/agent-factory/sandbox-bundle-builder";
import {
  attestLiveProbeCassette,
  cassetteConfigHash,
} from "../src/services/agent-factory/cassette-evidence-attestation";
import { saveGlobalToolProbeReceipt } from "../src/services/agent-factory/tool-probe-store";
import { DrizzleToolStore } from "../src/services/agent-factory/stores";
import { preloadedEvidence } from "../src/services/agent-factory/sandbox-runner-executor";
import { bindRemoteSandboxCassetteRefs } from "../src/services/agent-factory/remote-sandbox-deployer";
import { makeTargetInngestIsolationIdentity } from "./factory-sandbox-execution-fixture";

const domain = "Agents-generation";
const tenantId = "tenant-snapshot-test";
const tenantSlug = "agents-generation-snapshot-test";
const directories: string[] = [];

beforeAll(() => {
  getDb()
    .insert(tenants)
    .values({ id: tenantId, slug: tenantSlug, name: "Sandbox tool snapshot test" })
    .onConflictDoNothing()
    .run();
});

function spec(
  toolName: string,
  policy: NonNullable<GeneratedAgentSpec["toolPolicies"]>[string],
  config: Record<string, unknown> = {},
  sideEffect?: "read" | "write" | "dual" | "call",
): GeneratedAgentSpec {
  return {
    key: "GenerateFunction",
    actionName: "GenerateFunction",
    slug: `agents-generation-${toolName.replace(/[^a-z0-9]+/gi, "-")}`,
    short: "GenerateFunctionAgent",
    domainId: domain,
    nameZh: "生成 Function",
    kind: "llm",
    trigger: ["FUNCTION_REQUESTED"],
    emit: ["FUNCTION_GENERATED"],
    tools: [toolName],
    ...(sideEffect ? { toolSideEffects: { [toolName]: sideEffect } } : {}),
    toolPolicies: { [toolName]: policy },
    sandboxToolConfigs: { [toolName]: config },
    unresolvedTools: [],
    objects: ["AgentDraft"],
    systemPrompt: "生成并验证 Function。",
    userPrompt: "",
    steps: [],
    ruleRefs: [],
    retries: 1,
    hitl: false,
    confidence: 1,
    plan: [{
      stepId: "run-tool",
      kind: "tool",
      tool: toolName,
      onError: "terminal",
    }],
    generatedCode: "export const generatedFunction = { id: 'generated' };",
    // Tool-bearing agents execute through durable declarative actions; the
    // generated source is retained only as the reviewed reference artifact.
    codeExecuted: false,
  } as GeneratedAgentSpec;
}

afterEach(async () => {
  getDb().delete(factoryToolProbes).where(and(
    eq(factoryToolProbes.tenantId, tenantId),
    eq(factoryToolProbes.domainKey, domain),
  )).run();
  getDb().delete(factoryTools).where(and(
    eq(factoryTools.scopeKey, tenantId),
    eq(factoryTools.domainKey, domain),
  )).run();
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function recordVerifiedCassette(input: {
  toolName: string;
  definitionHash: string;
  config: Record<string, unknown>;
  suffix: string;
}): Promise<{ cassette: CanonicalCassetteDocument; cassettePath: string }> {
  const recordedAt = new Date("2026-07-15T08:00:00.000Z");
  const cassette = attestLiveProbeCassette({
    version: 1,
    tool: { name: input.toolName, definitionHash: input.definitionHash },
    evidence: {
      recordedAt: recordedAt.toISOString(),
      mode: "live-probe",
    },
    entries: [makeToolCassetteEntry({
      toolName: input.toolName,
      args: { variant: input.suffix },
      status: 200,
      body: { digest: "f".repeat(64), variant: input.suffix },
      recordedAt: recordedAt.toISOString(),
    })],
  }, {
    tenantId,
    tenantSlug,
    domainId: domain,
    toolName: input.toolName,
    definitionHash: input.definitionHash,
    config: input.config,
    actor: "factory-sandbox-tool-snapshot-test",
  }, { now: recordedAt });
  const directory = await mkdtemp(path.join(os.tmpdir(), "factory-tool-snapshot-"));
  directories.push(directory);
  const cassettePath = path.join(directory, `${input.suffix}.json`);
  await writeFile(cassettePath, JSON.stringify(cassette), "utf8");
  saveGlobalToolProbeReceipt(tenantId, domain, {
    toolName: input.toolName,
    status: "verified",
    definitionHash: input.definitionHash,
    evidence: {
      cassettePath,
      evidenceMode: cassette.evidence!.mode,
      attestationKeyId: cassette.evidence!.attestation!.keyId,
      attestationExpiresAt: cassette.evidence!.attestation!.expiresAt,
    },
    verifiedAt: recordedAt.toISOString(),
  });
  return { cassette, cassettePath };
}

describe("external sandbox tool snapshot resolver", () => {
  it("binds a global implementation to the exact config hash and verified cassette", async () => {
    const catalog = listGlobalTools().find((tool) => tool.name === "crypto.sha256");
    expect(catalog).toBeDefined();
    const definitionHash = catalogToolDefinitionHash(catalog!, {});
    const { cassette, cassettePath } = await recordVerifiedCassette({
      toolName: catalog!.name,
      definitionHash,
      config: {},
      suffix: "crypto-sha256-empty",
    });

    const generatedSpec = spec(
      catalog!.name,
      {
        operation: catalog!.operation,
        effectScope: catalog!.effectScope,
        sandboxPolicy: catalog!.sandboxPolicy,
      },
      {},
      catalog!.sideEffect,
    );
    const snapshot = await resolveSandboxBundleToolSnapshot({
      targetDomainId: domain,
      targetTenant: { tenantId, tenantSlug },
      attemptId: "00000000-0000-4000-8000-000000000021",
      candidateFingerprint: "sandbox-evidence:v5:tool-snapshot",
      specs: [generatedSpec],
      testCases: [],
    });

    expect(snapshot.definitions).toEqual([
      expect.objectContaining({
        toolName: catalog!.name,
        source: "catalog",
        definitionHash,
        definition: expect.objectContaining({
          source: "global_catalog",
          selectedName: catalog!.name,
        }),
      }),
    ]);
    expect(snapshot.evidence).toEqual([
      expect.objectContaining({
        toolName: catalog!.name,
        definitionHash,
        cassette,
      }),
    ]);
    expect(snapshot.cassetteRefs).toEqual([
      expect.objectContaining({
        bindingId: snapshot.evidence[0]!.bindingId,
        specSlugs: [generatedSpec.slug],
        tool: catalog!.name,
        path: cassettePath,
        definitionHash,
        configHash: cassetteConfigHash({}),
        evidenceMode: "live-probe",
        attestationKeyId: cassette.evidence!.attestation!.keyId,
        attestationExpiresAt: cassette.evidence!.attestation!.expiresAt,
      }),
    ]);
    expect(() =>
      buildSandboxCandidateBundle({
        attemptId: "00000000-0000-4000-8000-000000000021",
        candidateFingerprint: "sandbox-evidence:v5:tool-snapshot",
        targetDomainId: domain,
        targetTenant: { tenantId, tenantSlug },
        targetInngestIsolation: makeTargetInngestIsolationIdentity(tenantSlug),
        controlPlaneBuildId: "api-build-tool-snapshot-test",
        specs: [generatedSpec],
        toolDefinitions: snapshot.definitions,
        toolEvidence: snapshot.evidence,
        now: new Date("2026-07-15T08:00:00.000Z"),
      }),
    ).not.toThrow();
  });

  it("deduplicates one config variant while retaining its exact spec roster", async () => {
    const catalog = listGlobalTools().find((tool) => tool.name === "crypto.sha256")!;
    const definitionHash = catalogToolDefinitionHash(catalog, {});
    await recordVerifiedCassette({
      toolName: catalog.name,
      definitionHash,
      config: {},
      suffix: "shared-config",
    });
    const policy = {
      operation: catalog.operation,
      effectScope: catalog.effectScope,
      sandboxPolicy: catalog.sandboxPolicy,
    };
    const first = spec(catalog.name, policy, {}, catalog.sideEffect);
    const second = {
      ...spec(catalog.name, policy, {}, catalog.sideEffect),
      slug: "agents-generation-crypto-sha256-shared-second",
    };
    const snapshot = await resolveSandboxBundleToolSnapshot({
      targetDomainId: domain,
      targetTenant: { tenantId, tenantSlug },
      attemptId: "00000000-0000-4000-8000-000000000023",
      candidateFingerprint: "sandbox-evidence:v5:tool-shared-config",
      specs: [first, second],
      testCases: [],
    });
    expect(snapshot.definitions).toHaveLength(1);
    expect(snapshot.evidence).toHaveLength(1);
    expect(snapshot.evidence[0]?.specSlugs).toEqual([first.slug, second.slug].sort());
    expect(snapshot.cassetteRefs[0]?.specSlugs).toEqual([first.slug, second.slug].sort());
  });

  it("keeps two specs using one tool with different configs as exact replay bindings", async () => {
    const toolName = "crypto.sha256";
    const policy = {
      operation: "compute" as const,
      effectScope: "none" as const,
      sandboxPolicy: "pure" as const,
    };
    const first = spec(toolName, policy, { encoding: "utf8" }, "read");
    const second = {
      ...spec(toolName, policy, { encoding: "base64" }, "read"),
      slug: "agents-generation-crypto-sha256-second",
    };
    for (const [config, suffix] of [
      [{ encoding: "utf8" }, "utf8"],
      [{ encoding: "base64" }, "base64"],
    ] as const) {
      await recordVerifiedCassette({
        toolName,
        definitionHash: catalogToolDefinitionHash(
          listGlobalTools().find((tool) => tool.name === toolName)!,
          config,
        ),
        config,
        suffix,
      });
    }
    const snapshot = await resolveSandboxBundleToolSnapshot({
      targetDomainId: domain,
      targetTenant: { tenantId, tenantSlug },
      attemptId: "00000000-0000-4000-8000-000000000022",
      candidateFingerprint: "sandbox-evidence:v5:tool-config-variants",
      specs: [first, second],
      testCases: [],
    });
    expect(snapshot.definitions).toHaveLength(2);
    expect(snapshot.evidence).toHaveLength(2);
    expect(new Set(snapshot.evidence.map((entry) => entry.bindingId)).size).toBe(2);
    expect(new Set(snapshot.evidence.map((entry) => entry.configHash))).toEqual(new Set([
      cassetteConfigHash({ encoding: "utf8" }),
      cassetteConfigHash({ encoding: "base64" }),
    ]));
    const bundle = buildSandboxCandidateBundle({
      attemptId: "00000000-0000-4000-8000-000000000022",
      candidateFingerprint: "sandbox-evidence:v5:tool-config-variants",
      targetDomainId: domain,
      targetTenant: { tenantId, tenantSlug },
      targetInngestIsolation: makeTargetInngestIsolationIdentity(tenantSlug),
      controlPlaneBuildId: "api-build-tool-variant-test",
      specs: [first, second],
      toolDefinitions: snapshot.definitions,
      toolEvidence: snapshot.evidence,
      now: new Date("2026-07-15T08:00:00.000Z"),
    });
    expect(() => buildSandboxCandidateBundle({
      attemptId: "00000000-0000-4000-8000-000000000024",
      candidateFingerprint: "sandbox-evidence:v5:tool-definition-tamper",
      targetDomainId: domain,
      targetTenant: { tenantId, tenantSlug },
      targetInngestIsolation: makeTargetInngestIsolationIdentity(tenantSlug),
      controlPlaneBuildId: "api-build-tool-definition-tamper",
      specs: [first, second],
      toolDefinitions: snapshot.definitions.map((entry, index) => index === 0
        ? { ...entry, definition: { ...entry.definition, selectedName: "tampered.tool" } }
        : entry),
      toolEvidence: snapshot.evidence,
      now: new Date("2026-07-15T08:00:00.000Z"),
    })).toThrow(/do not share one exact executable implementation/i);
    const manifests = bundle.manifest as Array<{
      id: string;
      factory_tool_replay_refs: Record<string, { definition_hash: string; content_hash: string }>;
    }>;
    const firstRef = manifests.find((entry) => entry.id === first.slug)
      ?.factory_tool_replay_refs[toolName];
    const secondRef = manifests.find((entry) => entry.id === second.slug)
      ?.factory_tool_replay_refs[toolName];
    expect(firstRef?.definition_hash).not.toBe(secondRef?.definition_hash);
    expect(firstRef?.content_hash).not.toBe(secondRef?.content_hash);
    const replay = preloadedEvidence(bundle);
    expect(replay[first.slug]?.[toolName]?.definitionHash).toBe(firstRef?.definition_hash);
    expect(replay[second.slug]?.[toolName]?.definitionHash).toBe(secondRef?.definition_hash);
    expect(replay[first.slug]?.[toolName]?.document).not.toEqual(
      replay[second.slug]?.[toolName]?.document,
    );
    const boundRefs = bindRemoteSandboxCassetteRefs(snapshot, bundle) as Array<{
      bindingId: string;
      specSlugs: string[];
      configHash: string;
      contentHash: string;
    }>;
    expect(boundRefs).toHaveLength(2);
    expect(new Set(boundRefs.map((ref) => ref.bindingId))).toEqual(
      new Set(bundle.toolEvidence.map((entry) => entry.bindingId)),
    );
    expect(() => bindRemoteSandboxCassetteRefs({
      ...snapshot,
      cassetteRefs: snapshot.cassetteRefs.map((ref, index) => index === 0
        ? { ...ref, specSlugs: ["agents-generation-wrong-binding"] }
        : ref),
    }, bundle)).toThrow(/not bound to the submitted bundle/i);
    expect(() => bindRemoteSandboxCassetteRefs({
      ...snapshot,
      cassetteRefs: [snapshot.cassetteRefs[0]!, snapshot.cassetteRefs[0]!],
    }, bundle)).toThrow(/do not cover the exact submitted bundle/i);
    expect(() => bindRemoteSandboxCassetteRefs({
      ...snapshot,
      cassetteRefs: snapshot.cassetteRefs.slice(0, 1),
    }, bundle)).toThrow(/do not cover the exact submitted bundle/i);
  });

  it("resolves two declarative configs from exact receipts and rejects an unverified config", async () => {
    const toolName = "vendor.multi-config-lookup";
    const declarative: DeclarativeTool = {
      name: toolName,
      description: "Lookup a record in one reviewed vendor environment",
      method: "POST",
      urlTemplate: "https://vendor.invalid/lookup",
      sideEffect: "read",
      operation: "read",
      effectScope: "external",
      sandboxPolicy: "live_external",
      domain,
      paramsSchema: { variant: { type: "string" } },
      returnsSchema: {
        digest: { type: "string" },
        variant: { type: "string" },
      },
      capabilities: [{
        systems: ["Vendor"],
        kinds: ["external_api"],
        roles: ["reads"],
        operations: ["lookup"],
        probeRequired: true,
      }],
    };
    const store = new DrizzleToolStore(tenantId, domain, tenantSlug);
    await store.save(declarative);
    const firstConfig = { environment: "sandbox-a" };
    const secondConfig = { environment: "sandbox-b" };
    const firstHash = declarativeToolDefinitionHash(declarative, firstConfig);
    const secondHash = declarativeToolDefinitionHash(declarative, secondConfig);
    await recordVerifiedCassette({
      toolName,
      definitionHash: firstHash,
      config: firstConfig,
      suffix: "declarative-a",
    });
    await recordVerifiedCassette({
      toolName,
      definitionHash: secondHash,
      config: secondConfig,
      suffix: "declarative-b",
    });

    const [listed] = await store.list(domain);
    expect(listed).toMatchObject({
      name: toolName,
      probeStatus: "verified",
      verifiedDefinitionHashes: [firstHash, secondHash].sort(),
      productionVerifiedDefinitionHashes: [firstHash, secondHash].sort(),
    });

    const policy = {
      operation: declarative.operation,
      effectScope: declarative.effectScope,
      sandboxPolicy: declarative.sandboxPolicy,
    };
    const first = spec(toolName, policy, firstConfig, "read");
    const second = {
      ...spec(toolName, policy, secondConfig, "read"),
      slug: "agents-generation-vendor-multi-config-second",
    };
    const snapshot = await resolveSandboxBundleToolSnapshot({
      targetDomainId: domain,
      targetTenant: { tenantId, tenantSlug },
      attemptId: "00000000-0000-4000-8000-000000000025",
      candidateFingerprint: "sandbox-evidence:v5:declarative-config-variants",
      specs: [first, second],
      testCases: [],
    });
    expect(snapshot.definitions).toHaveLength(2);
    expect(snapshot.evidence.map((entry) => entry.definitionHash).sort())
      .toEqual([firstHash, secondHash].sort());
    expect(new Set(snapshot.evidence.map((entry) => entry.bindingId)).size).toBe(2);

    const missing = spec(toolName, policy, { environment: "not-probed" }, "read");
    await expect(resolveSandboxBundleToolSnapshot({
      targetDomainId: domain,
      targetTenant: { tenantId, tenantSlug },
      attemptId: "00000000-0000-4000-8000-000000000026",
      candidateFingerprint: "sandbox-evidence:v5:declarative-missing-config",
      specs: [missing],
      testCases: [],
    })).rejects.toThrow(/没有与当前 sandbox profile、定义和目标 domain 一致/);
  });
});
