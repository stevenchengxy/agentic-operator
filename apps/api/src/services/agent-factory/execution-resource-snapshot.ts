import {
  persistedToolAsRealTool,
  type RealTool,
} from "@agentic/agent-factory";
import { listGlobalTools } from "@agentic/tools";
import { DrizzleToolStore } from "./stores";
import { listIntegrationProfiles } from "./integration-profile-store";
import {
  listGlobalToolProbeReceipts,
  summarizeGlobalToolProbeReceiptsByTool,
} from "./tool-probe-store";
import { listTenantNativeFactoryTools } from "./tenant-native-tool-provider";

export interface FactoryExecutionResourceScope {
  tenantId: string;
  tenantSlug: string;
  domainId: string;
  /** Optional caller-held runtime version; mismatch fails closed. */
  tenantVersion?: string;
}

/**
 * Rebuild the execution-bearing tool snapshot at a commit boundary.
 *
 * This deliberately does not reuse a draft's in-memory catalog: global
 * registry definitions, tenant/domain declarative rows and both integration
 * profile environments are read again from their authoritative stores.  The
 * returned objects contain metadata only; no credential value is resolved and
 * no tool handler is invoked.
 */
export async function currentFactoryExecutionTools(
  scope: FactoryExecutionResourceScope,
): Promise<RealTool[]> {
  const [declarative, profiles] = await Promise.all([
    new DrizzleToolStore(
      scope.tenantId,
      scope.domainId,
      scope.tenantSlug,
    ).list(scope.domainId),
    Promise.resolve(listIntegrationProfiles(scope.tenantId, scope.domainId)),
  ]);
  const probeReceipts = summarizeGlobalToolProbeReceiptsByTool(
    listGlobalToolProbeReceipts(scope.tenantId, scope.domainId),
  );

  const profilesByTool = new Map<string, typeof profiles>();
  for (const profile of profiles) {
    const rows = profilesByTool.get(profile.toolName) ?? [];
    rows.push(profile);
    profilesByTool.set(profile.toolName, rows);
  }

  const globals: RealTool[] = listGlobalTools().map((tool) => {
    const probe = probeReceipts.get(tool.name);
    const probeRequired =
      tool.effectScope === "external"
      || tool.operation === "write"
      || tool.operation === "read_write"
      || tool.sideEffect === "write"
      || tool.sideEffect === "dual"
      || tool.capabilities?.some((capability) => capability.probeRequired) === true;
    return {
      name: tool.name,
      summary: tool.summary,
      aliases: tool.aliases,
      category: tool.category,
      sideEffect: tool.sideEffect,
      operation: tool.operation,
      effectScope: tool.effectScope,
      sandboxPolicy: tool.sandboxPolicy,
      configKeys: tool.configSchema ? Object.keys(tool.configSchema) : [],
      credentialEnv: tool.credentialEnv ?? [],
      capabilities: tool.capabilities ?? [],
      probeStatus: probeRequired ? (probe?.status ?? "required") : "verified",
      definitionHash: probe?.definitionHash,
      verifiedDefinitionHashes: probe?.verifiedDefinitionHashes,
      productionVerifiedDefinitionHashes:
        probe?.productionVerifiedDefinitionHashes,
      probeEvidenceMode: probe?.evidenceMode,
      integrationProfiles: profilesByTool.get(tool.name) ?? [],
      catalogDefinition: {
        name: tool.name,
        category: tool.category,
        sourcePath: tool.sourcePath,
        ...(tool.sourceIdentity !== undefined ? { sourceIdentity: tool.sourceIdentity } : {}),
        sideEffect: tool.sideEffect,
        operation: tool.operation,
        effectScope: tool.effectScope,
        sandboxPolicy: tool.sandboxPolicy,
        argsSchema: tool.argsSchema,
        returnsSchema: tool.returnsSchema,
        configSchema: tool.configSchema,
        ...(tool.configContract !== undefined
          ? { configContract: tool.configContract }
          : {}),
        capabilities: tool.capabilities,
        probeSafety: tool.probeSafety,
        profileScope: tool.profileScope,
      },
    };
  });

  const tenantNative = listTenantNativeFactoryTools({
    tenantSlug: scope.tenantSlug,
    expectedVersion: scope.tenantVersion,
    probesByTool: probeReceipts,
  }).map((tool) => ({
    ...tool,
    integrationProfiles: profilesByTool.get(tool.name) ?? [],
  }));
  const declarativeTools = declarative
    .map((tool) => ({
      ...persistedToolAsRealTool(tool),
      integrationProfiles: profilesByTool.get(tool.name) ?? [],
    }));

  // Match runtime precedence: global < tenant-native < declarative overlay.
  const selected = new Map<string, RealTool>();
  for (const tool of globals) selected.set(tool.name, tool);
  for (const tool of tenantNative) {
    for (const [name, current] of selected) {
      if (current.aliases?.includes(tool.name) || tool.aliases?.includes(name)) {
        selected.delete(name);
      }
    }
    selected.set(tool.name, tool);
  }
  for (const tool of declarativeTools) selected.set(tool.name, tool);
  return [...selected.values()];
}
