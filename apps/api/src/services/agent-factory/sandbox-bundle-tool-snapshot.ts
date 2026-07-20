import {
  canonicalEvidenceJson,
  catalogToolDefinitionHash,
  declarativeToolDefinitionHash,
  type CatalogToolDefinition,
  type DeclarativeTool,
  type GeneratedAgentSpec,
  type GeneratedToolExecutionPolicy,
} from "@agentic/agent-factory";
import { listGlobalTools, type ToolCatalogEntry } from "@agentic/tools";
import type { CanonicalCassetteDocument } from "@agentic/shared/cassette";

import { loadApprovedFunctionTestCassette } from "./function-tester-run";
import {
  cassetteConfigHash,
  type CassetteEvidenceSummary,
} from "./cassette-evidence-attestation";
import type {
  RemoteSandboxToolEvidenceRequest,
  RemoteSandboxToolSnapshot,
} from "./remote-sandbox-deployer";
import { sandboxToolBindingId } from "./sandbox-bundle-builder";
import { RemoteSandboxProtocolError } from "./sandbox-remote-protocol";
import { DrizzleToolStore } from "./stores";
import {
  getRuntimeTenantRegistrySnapshot,
  resolveTenantNativeFactoryTool,
  type ResolvedTenantNativeFactoryTool,
} from "./tenant-native-tool-provider";
import {
  findVerifiedToolProbeReceipt,
  listGlobalToolProbeReceipts,
  type GlobalToolProbeReceipt,
} from "./tool-probe-store";

interface SelectedToolUse {
  name: string;
  config: Record<string, unknown>;
  configHash: string;
  policy: GeneratedToolExecutionPolicy;
  sideEffect?: "read" | "write" | "dual" | "call";
  specs: string[];
}

const SHA256_HEX = /^[a-f0-9]{64}$/;

function selectedNames(spec: GeneratedAgentSpec): Set<string> {
  const names = new Set<string>();
  for (const name of spec.tools ?? []) {
    if (name.trim()) names.add(name.trim());
  }
  const visit = (steps: GeneratedAgentSpec["plan"]): void => {
    for (const step of steps ?? []) {
      if (step.kind === "tool" && step.tool?.trim()) names.add(step.tool.trim());
      if (step.body?.length) visit(step.body);
    }
  };
  visit(spec.plan);
  return names;
}

function selectedToolUses(specs: GeneratedAgentSpec[]): SelectedToolUse[] {
  const uses = new Map<string, SelectedToolUse>();
  const policyByName = new Map<string, Omit<SelectedToolUse, "config" | "configHash" | "specs">>();
  for (const spec of specs) {
    for (const name of selectedNames(spec)) {
      const policy = spec.toolPolicies?.[name];
      if (!policy) {
        throw new RemoteSandboxProtocolError(
          "tool_policy_missing",
          `工具「${name}」没有经过审查的执行策略，无法创建外部沙箱快照。`,
        );
      }
      const config = spec.sandboxToolConfigs?.[name] ?? {};
      const configHash = cassetteConfigHash(config);
      const bindingKey = `${name}\u0000${configHash}`;
      const priorPolicy = policyByName.get(name);
      if (priorPolicy && (
        priorPolicy.policy.operation !== policy.operation
        || priorPolicy.policy.effectScope !== policy.effectScope
        || priorPolicy.policy.sandboxPolicy !== policy.sandboxPolicy
      )) {
        throw new RemoteSandboxProtocolError(
          "tool_policy_conflict",
          `工具「${name}」在不同 Agent 中的执行策略不一致，无法生成可信沙箱快照。`,
        );
      }
      const sideEffect = spec.toolSideEffects?.[name];
      if (
        priorPolicy?.sideEffect
        && sideEffect
        && priorPolicy.sideEffect !== sideEffect
      ) {
        throw new RemoteSandboxProtocolError(
          "tool_policy_conflict",
          `工具「${name}」在不同 Agent 中的副作用声明不一致，无法生成可信沙箱快照。`,
        );
      }
      policyByName.set(name, {
        name,
        policy,
        ...(sideEffect ?? priorPolicy?.sideEffect
          ? { sideEffect: sideEffect ?? priorPolicy?.sideEffect }
          : {}),
      });
      const prior = uses.get(bindingKey);
      if (!prior) {
        uses.set(bindingKey, {
          name,
          config,
          configHash,
          policy,
          ...(sideEffect
            ? { sideEffect }
            : {}),
          specs: [spec.slug],
        });
        continue;
      }
      if (!prior.sideEffect && sideEffect) prior.sideEffect = sideEffect;
      prior.specs.push(spec.slug);
    }
  }
  return [...uses.values()]
    .map((use) => ({ ...use, specs: [...use.specs].sort() }))
    .sort((left, right) =>
      left.name.localeCompare(right.name)
      || left.configHash.localeCompare(right.configHash));
}

function assertCurrentPolicy(
  use: SelectedToolUse,
  current: {
    operation?: string;
    effectScope?: string;
    sandboxPolicy?: string;
    sideEffect?: string;
  },
): void {
  if (
    use.policy.operation !== current.operation ||
    use.policy.effectScope !== current.effectScope ||
    use.policy.sandboxPolicy !== current.sandboxPolicy
  ) {
    throw new RemoteSandboxProtocolError(
      "tool_definition_drift",
      `工具「${use.name}」的当前执行策略已经与生成时快照不同。请让 Agent Factory 重新选择并审查工具后再测试。`,
    );
  }
  if (use.sideEffect && use.sideEffect !== current.sideEffect) {
    throw new RemoteSandboxProtocolError(
      "tool_definition_drift",
      `工具「${use.name}」的当前副作用声明已经与生成时快照不同。请重新审查工具绑定。`,
    );
  }
}

function bindingFields(use: SelectedToolUse, definitionHash: string): {
  bindingId: string;
  specSlugs: string[];
  configHash: string;
} {
  return {
    bindingId: sandboxToolBindingId({
      specSlugs: use.specs,
      toolName: use.name,
      configHash: use.configHash,
      definitionHash,
    }),
    specSlugs: [...use.specs],
    configHash: use.configHash,
  };
}

function exactSchemaHash(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!SHA256_HEX.test(normalized)) {
    throw new RemoteSandboxProtocolError(
      "tool_evidence_invalid",
      "工具 probe 证据包含无效的 schema hash，无法进入沙箱。",
    );
  }
  return normalized;
}

function verifiedReceipt(
  toolName: string,
  definitionHash: string,
  receipts: readonly GlobalToolProbeReceipt[],
): GlobalToolProbeReceipt {
  const receipt = findVerifiedToolProbeReceipt(receipts, {
    toolName,
    definitionHash,
  });
  if (!receipt) {
    throw new RemoteSandboxProtocolError(
      "tool_evidence_missing",
      `工具「${toolName}」没有与当前 sandbox profile、定义和目标 domain 一致的已验证 cassette。请先完成 probe/record；系统不会改用真实外部调用。`,
    );
  }
  return receipt;
}

function cassettePath(evidence: Record<string, unknown> | undefined): string {
  return typeof evidence?.cassettePath === "string"
    ? evidence.cassettePath.trim()
    : "";
}

function loadCassette(args: {
  toolName: string;
  definitionHash: string;
  schemaHash?: string;
  evidence?: Record<string, unknown>;
  tenantId: string;
  tenantSlug: string;
  domainId: string;
  config: Record<string, unknown>;
}): { document: CanonicalCassetteDocument; path: string; summary: CassetteEvidenceSummary } {
  const path = cassettePath(args.evidence);
  const loaded = loadApprovedFunctionTestCassette({
    toolName: args.toolName,
    cassettePath: path,
    definitionHash: args.definitionHash,
    ...(args.schemaHash ? { schemaHash: args.schemaHash } : {}),
    trustBinding: {
      tenantId: args.tenantId,
      tenantSlug: args.tenantSlug,
      domainId: args.domainId,
      toolName: args.toolName,
      definitionHash: args.definitionHash,
      configHash: cassetteConfigHash(args.config),
      allowedModes: ["live-probe", "signed-fixture", "runtime-record"],
    },
  });
  if (!loaded.document) {
    throw new RemoteSandboxProtocolError(
      "tool_evidence_invalid",
      loaded.blockedReason,
    );
  }
  // loadApprovedFunctionTestCassette already verified this exact scope.  The
  // attestation is therefore present and its summary can safely cross the
  // control-plane boundary without reclassifying fixture evidence later.
  const attestation = loaded.document.evidence!.attestation!;
  const proof = loaded.document.evidence?.writeProbe;
  return {
    document: loaded.document,
    path,
    summary: {
      mode: loaded.document.evidence!.mode,
      configHash: attestation.binding.configHash,
      attestationKeyId: attestation.keyId,
      attestationExpiresAt: attestation.expiresAt,
      ...(proof ? {
        writeProbe: {
          schema: proof.schema,
          createCompleted: proof.create?.completed === true,
          cleanupCompleted: proof.cleanup?.completed === true,
          absenceVerified: proof.absence?.verified === true,
          idempotencyKeyHash: proof.idempotencyKeyHash,
        },
      } : {}),
    },
  };
}

function declarativeExecutableDefinition(tool: DeclarativeTool): Record<string, unknown> {
  return {
    schema: "agent-factory-declarative-http-tool/v1",
    name: tool.name,
    description: tool.description,
    method: tool.method,
    urlTemplate: tool.urlTemplate,
    headers: tool.headers ?? {},
    bodyTemplate: tool.bodyTemplate ?? null,
    requestSpec: tool.requestSpec ?? null,
    responseSpec: tool.responseSpec ?? null,
    examples: tool.examples ?? [],
    sideEffect: tool.sideEffect,
    operation: tool.operation,
    effectScope: tool.effectScope,
    sandboxPolicy: tool.sandboxPolicy,
    domain: tool.domain,
    paramsSchema: tool.paramsSchema ?? {},
    returnsSchema: tool.returnsSchema ?? {},
    capabilities: tool.capabilities ?? [],
    probeSafety: tool.probeSafety ?? null,
  };
}

export function catalogHashableDefinition(tool: ToolCatalogEntry): CatalogToolDefinition {
  return {
    name: tool.name,
    category: tool.category,
    sourcePath: tool.sourcePath,
    ...(tool.sourceIdentity !== undefined ? { sourceIdentity: tool.sourceIdentity } : {}),
    ...(tool.sideEffect !== undefined ? { sideEffect: tool.sideEffect } : {}),
    operation: tool.operation,
    effectScope: tool.effectScope,
    sandboxPolicy: tool.sandboxPolicy,
    ...(tool.argsSchema !== undefined ? { argsSchema: tool.argsSchema } : {}),
    ...(tool.returnsSchema !== undefined
      ? { returnsSchema: tool.returnsSchema }
      : {}),
    ...(tool.configSchema !== undefined
      ? { configSchema: tool.configSchema }
      : {}),
    ...(tool.configContract !== undefined
      ? { configContract: tool.configContract }
      : {}),
    ...(tool.capabilities !== undefined
      ? { capabilities: tool.capabilities }
      : {}),
    ...(tool.profileScope !== undefined
      ? { profileScope: tool.profileScope }
      : {}),
    ...(tool.probeSafety !== undefined
      ? { probeSafety: tool.probeSafety }
      : {}),
  };
}

function catalogExecutableDefinition(args: {
  source: "global_catalog" | "tenant_registry";
  selectedName: string;
  definition: CatalogToolDefinition;
  registryVersion?: string;
}): Record<string, unknown> {
  return {
    schema: "agent-factory-catalog-tool/v1",
    source: args.source,
    selectedName: args.selectedName,
    ...(args.registryVersion ? { registryVersion: args.registryVersion } : {}),
    // Registry descriptors are authored as TypeScript objects and may carry
    // optional keys whose runtime value is `undefined`.  The wire contract is
    // JSON-only, so omit those keys deterministically without changing the
    // catalog definition hash (the hasher treats omitted/undefined equally).
    catalogDefinition: JSON.parse(canonicalEvidenceJson(args.definition)) as Record<string, unknown>,
  };
}

function nativeDefinition(
  use: SelectedToolUse,
  native: ResolvedTenantNativeFactoryTool,
  selectedVersion: string,
): { hashable: CatalogToolDefinition; executable: Record<string, unknown> } {
  if (native.registryKey !== use.name || native.realTool.name !== use.name) {
    throw new RemoteSandboxProtocolError(
      "tool_alias_not_canonical",
      `工具「${use.name}」是 tenant adapter 的别名。请让 Agent Factory 保存 canonical 名称「${native.realTool.name}」后再测试；证据不能在沙箱边界被改名。`,
    );
  }
  const hashable = native.realTool.catalogDefinition;
  if (!hashable) {
    throw new RemoteSandboxProtocolError(
      "tool_definition_missing",
      `tenant adapter 工具「${use.name}」没有可验证的 catalog definition。`,
    );
  }
  return {
    hashable,
    executable: catalogExecutableDefinition({
      source: "tenant_registry",
      selectedName: use.name,
      definition: hashable,
      registryVersion: selectedVersion,
    }),
  };
}

/**
 * Resolve the exact executable descriptors and immutable cassette evidence for
 * an external sandbox bundle.  Resolution deliberately mirrors Factory/runtime
 * precedence: persisted tenant/domain declarative tool, then the currently
 * published tenant-native registry, then the global catalog.
 */
export async function resolveSandboxBundleToolSnapshot(
  request: RemoteSandboxToolEvidenceRequest,
): Promise<RemoteSandboxToolSnapshot> {
  const uses = selectedToolUses(request.specs);
  const nativeSnapshot = getRuntimeTenantRegistrySnapshot(
    request.targetTenant.tenantSlug,
  );
  if (
    request.targetTenant.registryVersion &&
    nativeSnapshot?.selectedVersion !== request.targetTenant.registryVersion
  ) {
    throw new RemoteSandboxProtocolError(
      "tenant_registry_drift",
      nativeSnapshot
        ? `目标 tenant adapter 已从「${request.targetTenant.registryVersion}」切换到「${nativeSnapshot.selectedVersion}」。请重新生成沙箱候选。`
        : `目标 tenant 指定了 adapter 版本「${request.targetTenant.registryVersion}」，但当前运行时没有发布对应 registry snapshot。`,
    );
  }
  const tenantRegistry = nativeSnapshot
    ? {
        schema: "agent-factory-sandbox-tenant-registry/v1" as const,
        tenantSlug: nativeSnapshot.tenantSlug,
        selectedVersion: nativeSnapshot.selectedVersion,
        registrySource: nativeSnapshot.registry.factory?.source
          ? JSON.parse(canonicalEvidenceJson(nativeSnapshot.registry.factory.source)) as Record<string, unknown>
          : null,
        promptNames: Object.keys(nativeSnapshot.registry.prompts ?? {}).sort(),
        eventAdapter: nativeSnapshot.registry.eventAdapter
          ? { name: nativeSnapshot.registry.eventAdapter.name?.trim() || null }
          : null,
      }
    : undefined;
  if (!uses.length) {
    return {
      definitions: [],
      evidence: [],
      cassetteRefs: [],
      ...(tenantRegistry ? { tenantRegistry } : {}),
    };
  }

  const declarativeTools = await new DrizzleToolStore(
    request.targetTenant.tenantId,
    request.targetDomainId,
    request.targetTenant.tenantSlug,
  ).list(request.targetDomainId);
  const declarativeByName = new Map(
    declarativeTools.map((tool) => [tool.name, tool]),
  );
  const globalTools = listGlobalTools();
  const globalByName = new Map(globalTools.map((tool) => [tool.name, tool]));
  const globalReceipts = listGlobalToolProbeReceipts(
    request.targetTenant.tenantId,
    request.targetDomainId,
  );

  const definitions: RemoteSandboxToolSnapshot["definitions"] = [];
  const evidence: RemoteSandboxToolSnapshot["evidence"] = [];
  const cassetteRefs: RemoteSandboxToolSnapshot["cassetteRefs"] = [];

  for (const use of uses) {
    const declarative = declarativeByName.get(use.name);
    if (declarative) {
      assertCurrentPolicy(use, declarative);
      const definitionHash = declarativeToolDefinitionHash(
        declarative,
        use.config,
      );
      const receipt = verifiedReceipt(
        use.name,
        definitionHash,
        globalReceipts,
      );
      const schemaHash = exactSchemaHash(receipt.schemaHash);
      const cassette = loadCassette({
        toolName: use.name,
        definitionHash,
        ...(schemaHash ? { schemaHash } : {}),
        evidence: receipt.evidence,
        tenantId: request.targetTenant.tenantId,
        tenantSlug: request.targetTenant.tenantSlug,
        domainId: request.targetDomainId,
        config: use.config,
      });
      const binding = bindingFields(use, definitionHash);
      definitions.push({
        ...binding,
        toolName: use.name,
        source: "declarative",
        definition: declarativeExecutableDefinition(declarative),
        definitionHash,
        ...(schemaHash ? { schemaHash } : {}),
      });
      evidence.push({
        ...binding,
        toolName: use.name,
        definitionHash,
        ...(schemaHash ? { schemaHash } : {}),
        cassette: cassette.document,
      });
      cassetteRefs.push({
        ...binding,
        tool: use.name,
        path: cassette.path,
        definitionHash,
        ...(schemaHash ? { schemaHash } : {}),
        evidenceMode: cassette.summary.mode,
        configHash: cassette.summary.configHash,
        attestationKeyId: cassette.summary.attestationKeyId,
        attestationExpiresAt: cassette.summary.attestationExpiresAt,
        ...(cassette.summary.writeProbe ? { writeProbe: cassette.summary.writeProbe } : {}),
      });
      continue;
    }

    const native = nativeSnapshot
      ? resolveTenantNativeFactoryTool({
          tenantSlug: request.targetTenant.tenantSlug,
          name: use.name,
          expectedVersion: request.targetTenant.registryVersion,
        })
      : undefined;
    if (native && nativeSnapshot) {
      assertCurrentPolicy(use, native.catalog);
      const definition = nativeDefinition(
        use,
        native,
        nativeSnapshot.selectedVersion,
      );
      const definitionHash = catalogToolDefinitionHash(
        definition.hashable,
        use.config,
      );
      const receipt = verifiedReceipt(
        use.name,
        definitionHash,
        globalReceipts,
      );
      const schemaHash = exactSchemaHash(receipt.schemaHash);
      const cassette = loadCassette({
        toolName: use.name,
        definitionHash,
        ...(schemaHash ? { schemaHash } : {}),
        evidence: receipt.evidence,
        tenantId: request.targetTenant.tenantId,
        tenantSlug: request.targetTenant.tenantSlug,
        domainId: request.targetDomainId,
        config: use.config,
      });
      const binding = bindingFields(use, definitionHash);
      definitions.push({
        ...binding,
        toolName: use.name,
        source: "catalog",
        definition: definition.executable,
        definitionHash,
        ...(schemaHash ? { schemaHash } : {}),
      });
      evidence.push({
        ...binding,
        toolName: use.name,
        definitionHash,
        ...(schemaHash ? { schemaHash } : {}),
        cassette: cassette.document,
      });
      cassetteRefs.push({
        ...binding,
        tool: use.name,
        path: cassette.path,
        definitionHash,
        ...(schemaHash ? { schemaHash } : {}),
        evidenceMode: cassette.summary.mode,
        configHash: cassette.summary.configHash,
        attestationKeyId: cassette.summary.attestationKeyId,
        attestationExpiresAt: cassette.summary.attestationExpiresAt,
        ...(cassette.summary.writeProbe ? { writeProbe: cassette.summary.writeProbe } : {}),
      });
      continue;
    }

    const global = globalByName.get(use.name);
    if (!global) {
      const globalAlias = globalTools.find((tool) =>
        tool.aliases?.includes(use.name),
      );
      if (globalAlias) {
        throw new RemoteSandboxProtocolError(
          "tool_alias_not_canonical",
          `工具「${use.name}」是全局工具的别名。请让 Agent Factory 保存 canonical 名称「${globalAlias.name}」后再测试；probe 证据不能在沙箱边界被改名。`,
        );
      }
      throw new RemoteSandboxProtocolError(
        "tool_definition_missing",
        `工具「${use.name}」在目标 tenant/domain 的声明式工具、tenant adapter 和全局目录里都不存在。`,
      );
    }
    assertCurrentPolicy(use, global);
    const hashable = catalogHashableDefinition(global);
    const definitionHash = catalogToolDefinitionHash(hashable, use.config);
    const receipt = verifiedReceipt(use.name, definitionHash, globalReceipts);
    const schemaHash = exactSchemaHash(receipt.schemaHash);
    const cassette = loadCassette({
      toolName: use.name,
      definitionHash,
      ...(schemaHash ? { schemaHash } : {}),
      evidence: receipt.evidence,
      tenantId: request.targetTenant.tenantId,
      tenantSlug: request.targetTenant.tenantSlug,
      domainId: request.targetDomainId,
      config: use.config,
    });
    const binding = bindingFields(use, definitionHash);
    definitions.push({
      ...binding,
      toolName: use.name,
      source: "catalog",
      definition: catalogExecutableDefinition({
        source: "global_catalog",
        selectedName: use.name,
        definition: hashable,
      }),
      definitionHash,
      ...(schemaHash ? { schemaHash } : {}),
    });
    evidence.push({
      ...binding,
      toolName: use.name,
      definitionHash,
      ...(schemaHash ? { schemaHash } : {}),
      cassette: cassette.document,
    });
    cassetteRefs.push({
      ...binding,
      tool: use.name,
      path: cassette.path,
      definitionHash,
      ...(schemaHash ? { schemaHash } : {}),
      evidenceMode: cassette.summary.mode,
      configHash: cassette.summary.configHash,
      attestationKeyId: cassette.summary.attestationKeyId,
      attestationExpiresAt: cassette.summary.attestationExpiresAt,
      ...(cassette.summary.writeProbe ? { writeProbe: cassette.summary.writeProbe } : {}),
    });
  }

  return {
    definitions,
    evidence,
    cassetteRefs,
    ...(tenantRegistry ? { tenantRegistry } : {}),
  };
}

export function createSandboxBundleToolSnapshotResolver(): (
  request: RemoteSandboxToolEvidenceRequest,
) => Promise<RemoteSandboxToolSnapshot> {
  return resolveSandboxBundleToolSnapshot;
}
