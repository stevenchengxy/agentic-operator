import type { TenantRegistry, ToolDescriptor } from "@agentic/agent-kit";
import {
  canonicalEvidenceJson,
  catalogToolDefinitionHash,
  type CatalogToolDefinition,
} from "@agentic/agent-factory";
import { listGlobalTools } from "@agentic/tools";

import type {
  SandboxBundleTenantRegistryDescriptor,
  SandboxBundleToolDefinition,
  SandboxCandidateBundle,
} from "./sandbox-bundle-builder";
import { catalogHashableDefinition } from "./sandbox-bundle-tool-snapshot";
import { RemoteSandboxProtocolError } from "./sandbox-remote-protocol";
import {
  getRuntimeTenantRegistrySnapshot,
  resolveTenantNativeFactoryTool,
  type RuntimeTenantRegistrySnapshot,
} from "./tenant-native-tool-provider";

const SHA256_HEX = /^[a-f0-9]{64}$/;

interface CatalogWireDefinition {
  schema: "agent-factory-catalog-tool/v1";
  source: "global_catalog" | "tenant_registry";
  selectedName: string;
  registryVersion?: string;
  catalogDefinition: CatalogToolDefinition;
}

function fail(code: string, message: string): never {
  throw new RemoteSandboxProtocolError(code, message);
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function wire(entry: SandboxBundleToolDefinition): CatalogWireDefinition | null {
  if (entry.source !== "catalog") return null;
  const value = object(entry.definition);
  const definition = object(value?.catalogDefinition);
  const unknown = value
    ? Object.keys(value).find((key) => ![
        "schema",
        "source",
        "selectedName",
        "registryVersion",
        "catalogDefinition",
      ].includes(key))
    : undefined;
  if (
    !value
    || unknown
    || value.schema !== "agent-factory-catalog-tool/v1"
    || !["global_catalog", "tenant_registry"].includes(String(value.source))
    || value.selectedName !== entry.toolName
    || !definition
    || definition.name !== entry.toolName
  ) {
    fail(
      "runner_tool_catalog_invalid",
      `签名候选包里的工具「${entry.toolName}」不是可验证的 catalog descriptor。`,
    );
  }
  if (
    value.registryVersion !== undefined
    && (typeof value.registryVersion !== "string" || !value.registryVersion.trim())
  ) {
    fail("runner_tool_catalog_invalid", `工具「${entry.toolName}」的 registry 版本无效。`);
  }
  return value as unknown as CatalogWireDefinition;
}

function toolConfigs(bundle: SandboxCandidateBundle): Map<string, Record<string, unknown>> {
  const configs = new Map<string, Record<string, unknown>>();
  for (const spec of bundle.specs) {
    const names = new Set(spec.tools ?? []);
    const visit = (steps: typeof spec.plan): void => {
      for (const step of steps ?? []) {
        if (step.kind === "tool" && step.tool?.trim()) names.add(step.tool.trim());
        if (step.body?.length) visit(step.body);
      }
    };
    visit(spec.plan);
    for (const name of names) {
      if (!name.trim()) continue;
      const config = spec.sandboxToolConfigs?.[name] ?? {};
      const prior = configs.get(name);
      if (prior && canonicalEvidenceJson(prior) !== canonicalEvidenceJson(config)) {
        fail(
          "runner_tool_catalog_invalid",
          `工具「${name}」在签名候选包里出现了多个不同的 sandbox 配置。`,
        );
      }
      configs.set(name, config);
    }
  }
  return configs;
}

function registryDescriptor(
  snapshot: RuntimeTenantRegistrySnapshot,
): SandboxBundleTenantRegistryDescriptor {
  return {
    schema: "agent-factory-sandbox-tenant-registry/v1",
    tenantSlug: snapshot.tenantSlug,
    selectedVersion: snapshot.selectedVersion,
    registrySource: snapshot.registry.factory?.source
      ? JSON.parse(canonicalEvidenceJson(snapshot.registry.factory.source)) as Record<string, unknown>
      : null,
    promptNames: Object.keys(snapshot.registry.prompts ?? {}).sort(),
    eventAdapter: snapshot.registry.eventAdapter
      ? { name: snapshot.registry.eventAdapter.name?.trim() || null }
      : null,
  };
}

function assertRegistryDescriptorMatches(
  signed: SandboxBundleTenantRegistryDescriptor | undefined,
  current: RuntimeTenantRegistrySnapshot,
): void {
  if (!signed || canonicalEvidenceJson(signed) !== canonicalEvidenceJson(registryDescriptor(current))) {
    fail(
      "tenant_registry_drift",
      `目标 tenant adapter「${current.tenantSlug}」的版本、prompt 或 event adapter 已与签名候选包不同。请重新生成沙箱候选。`,
    );
  }
}

function assertDefinitionHash(
  entry: SandboxBundleToolDefinition,
  definition: CatalogToolDefinition,
  config: Record<string, unknown>,
): void {
  const current = catalogToolDefinitionHash(definition, config);
  if (entry.definitionHash !== current) {
    fail(
      "runner_tool_catalog_drift",
      `工具「${entry.toolName}」的实现/配置 identity 已变化，旧 cassette 不能继续使用。请重新 probe 并生成候选包。`,
    );
  }
}

function assertSourceIdentity(
  definition: CatalogToolDefinition,
  expected: {
    provider: "tenant_registry";
    tenantSlug: string;
    selectedVersion: string;
    registrySource: Record<string, unknown> | null;
  },
  toolName: string,
): void {
  const identity = object(definition.sourceIdentity);
  if (
    !identity
    || identity.provider !== expected.provider
    || identity.tenantSlug !== expected.tenantSlug
    || identity.selectedVersion !== expected.selectedVersion
    || typeof identity.handlerSha256 !== "string"
    || !SHA256_HEX.test(identity.handlerSha256)
    || canonicalEvidenceJson(identity.registry ?? null)
      !== canonicalEvidenceJson(expected.registrySource)
  ) {
    fail(
      "tenant_registry_drift",
      `工具「${toolName}」没有绑定目标 tenant、registry 版本和 handler SHA，不能在沙箱中重放。`,
    );
  }
}

function registryFactory(
  source: Record<string, unknown> | null,
): TenantRegistry["factory"] | undefined {
  if (!source) return undefined;
  if (
    typeof source.kind !== "string" || !source.kind.trim()
    || typeof source.id !== "string" || !source.id.trim()
    || typeof source.version !== "string" || !source.version.trim()
    || (source.revision !== undefined && typeof source.revision !== "string")
  ) {
    fail("tenant_registry_drift", "签名候选包里的 tenant registry source identity 不完整。");
  }
  return {
    source: {
      kind: source.kind,
      id: source.id,
      version: source.version,
      ...(typeof source.revision === "string" ? { revision: source.revision } : {}),
    },
  };
}

/**
 * Re-verify every catalog-backed tool inside the workload. Packaged tools must
 * still match their exact implementation identity. A dynamic tenant registry
 * is projected into fail-closed descriptors only; its code is never imported.
 */
export function prepareSandboxRunnerCatalog(bundle: SandboxCandidateBundle): {
  targetReplayRegistry?: TenantRegistry;
} {
  const configs = toolConfigs(bundle);
  const globalByName = new Map(listGlobalTools().map((tool) => [tool.name, tool]));
  const targetSnapshot = getRuntimeTenantRegistrySnapshot(bundle.targetTenant.slug);
  const selectedVersion = bundle.targetTenant.registryVersion;

  if (targetSnapshot) {
    if (!selectedVersion || targetSnapshot.selectedVersion !== selectedVersion) {
      fail(
        "tenant_registry_drift",
        `workload 中的目标 tenant adapter 版本是「${targetSnapshot.selectedVersion}」，签名候选要求「${selectedVersion ?? "未声明"}」。`,
      );
    }
    assertRegistryDescriptorMatches(bundle.tenantRegistry, targetSnapshot);
  } else if (selectedVersion) {
    if (!bundle.tenantRegistry || bundle.tenantRegistry.selectedVersion !== selectedVersion) {
      fail(
        "tenant_registry_descriptor_missing",
        "目标 tenant-code 不在 workload 镜像中，且签名候选包没有完整的 registry descriptor。请重新预检。",
      );
    }
    if (bundle.tenantRegistry.eventAdapter || bundle.tenantRegistry.promptNames.length > 0) {
      fail(
        "tenant_registry_replay_unverifiable",
        `目标 tenant-code 含自定义 ${[
          bundle.tenantRegistry.eventAdapter ? "event adapter" : "",
          bundle.tenantRegistry.promptNames.length ? "prompt" : "",
        ].filter(Boolean).join(" 和 ")}；当前工具回放不能等价验证这些代码。请把该 adapter 做成受审镜像，或由你确认新的验证方案。`,
      );
    }
  } else if (bundle.tenantRegistry) {
    fail(
      "tenant_registry_drift",
      "签名候选包携带了 tenant registry descriptor，但目标 tenant 没有声明对应版本。",
    );
  }

  const replayTools: Record<string, ToolDescriptor> = {};
  for (const entry of bundle.toolDefinitions) {
    const descriptor = wire(entry);
    if (!descriptor) continue;
    const config = configs.get(entry.toolName) ?? {};
    if (descriptor.source === "global_catalog") {
      if (descriptor.registryVersion !== undefined) {
        fail("runner_tool_catalog_invalid", `全局工具「${entry.toolName}」不能声明 tenant registry 版本。`);
      }
      const current = globalByName.get(entry.toolName);
      if (!current) {
        fail("runner_tool_catalog_drift", `workload 镜像里没有签名候选要求的全局工具「${entry.toolName}」。`);
      }
      const currentDefinition = catalogHashableDefinition(current);
      if (
        canonicalEvidenceJson(descriptor.catalogDefinition)
        !== canonicalEvidenceJson(currentDefinition)
      ) {
        fail(
          "runner_tool_catalog_drift",
          `全局工具「${entry.toolName}」的 build/handler/definition 已与控制面快照不同。`,
        );
      }
      assertDefinitionHash(entry, currentDefinition, config);
      continue;
    }

    if (!selectedVersion || descriptor.registryVersion !== selectedVersion) {
      fail(
        "tenant_registry_drift",
        `tenant 工具「${entry.toolName}」没有绑定签名目标 registry 版本「${selectedVersion ?? "未声明"}」。`,
      );
    }
    assertSourceIdentity(descriptor.catalogDefinition, {
      provider: "tenant_registry",
      tenantSlug: bundle.targetTenant.slug,
      selectedVersion,
      registrySource: bundle.tenantRegistry?.registrySource ?? null,
    }, entry.toolName);

    if (targetSnapshot) {
      const current = resolveTenantNativeFactoryTool({
        tenantSlug: bundle.targetTenant.slug,
        name: entry.toolName,
        expectedVersion: selectedVersion,
      });
      if (!current || current.registryKey !== entry.toolName || !current.realTool.catalogDefinition) {
        fail(
          "tenant_registry_drift",
          `workload 中的目标 tenant adapter 没有 canonical 工具「${entry.toolName}」。`,
        );
      }
      if (
        canonicalEvidenceJson(descriptor.catalogDefinition)
        !== canonicalEvidenceJson(current.realTool.catalogDefinition)
      ) {
        fail(
          "tenant_registry_drift",
          `tenant 工具「${entry.toolName}」的 handler SHA 或 catalog definition 已变化。`,
        );
      }
      assertDefinitionHash(entry, current.realTool.catalogDefinition, config);
      continue;
    }

    // Dynamic tenant-code is not a trusted workload dependency. Only external
    // evidence replay is equivalent today; pure/sandbox-local behavior would
    // require executing adapter code and therefore must stop at ask_user.
    if (
      descriptor.catalogDefinition.effectScope !== "external"
      || !["live_external", "requires_attempt_grant"].includes(
        String(descriptor.catalogDefinition.sandboxPolicy),
      )
    ) {
      fail(
        "tenant_registry_replay_unverifiable",
        `动态 tenant 工具「${entry.toolName}」不是 external replay 能力；不加载它的 adapter 代码就无法等价验证。请把实现加入受审 workload 镜像后重试。`,
      );
    }
    assertDefinitionHash(entry, descriptor.catalogDefinition, config);
    replayTools[entry.toolName] = {
      kind: "tool",
      name: entry.toolName,
      description: `Replay-only descriptor for ${entry.toolName}`,
      async handler() {
        throw new Error(
          `sandbox replay invariant failed: dynamic tenant handler '${entry.toolName}' was reached`,
        );
      },
    };
  }

  if (targetSnapshot || !selectedVersion) return {};
  return {
    targetReplayRegistry: {
      tools: replayTools,
      ...(registryFactory(bundle.tenantRegistry!.registrySource)
        ? { factory: registryFactory(bundle.tenantRegistry!.registrySource) }
        : {}),
    },
  };
}
