import { createHash } from "node:crypto";

import type { TenantRegistry } from "@agentic/agent-kit";
import {
  canonicalEvidenceJson,
  isGeneratedToolExecutionPolicy,
  sandboxInfrastructureCleanupEvidenceHash,
  type SandboxDeployResult,
  type SandboxInfrastructureCleanupEvidence,
} from "@agentic/agent-factory";
import {
  TARGET_INNGEST_ISOLATION_IDENTITY_SCHEMA,
  beginCodeActContainerAttempt,
  finishCodeActContainerAttempt,
  type CodeActContainerExecutionEvidence,
} from "@agentic/runtime";
import {
  eq,
  factoryTools,
  getDb,
  tenants,
} from "@agentic/db";

import {
  SANDBOX_CANDIDATE_BUNDLE_SCHEMA,
  sandboxCandidateBundleHash,
  type SandboxBundleToolDefinition,
  type SandboxCandidateBundle,
} from "./sandbox-bundle-builder";
import {
  canonicalSandboxSha256,
  assertRemoteSandboxJson,
  assertRemoteSandboxSecretFree,
  RemoteSandboxProtocolError,
} from "./sandbox-remote-protocol";
import {
  attestSandboxCandidateResult,
  type SandboxRunnerExecutionIdentity,
} from "./sandbox-runner-attestation";
import {
  ManifestSandboxDeployer,
  sandboxTenantSlug,
  type BundledFunctionTestToolEvidence,
} from "./sandbox-deployer";
import { installSandboxModelExecutionContext } from "./sandbox-model-client";
import { prepareSandboxRunnerCatalog } from "./sandbox-runner-catalog";

export {
  attestSandboxCandidateResult,
  type SandboxRunnerExecutionIdentity,
} from "./sandbox-runner-attestation";

function sha(value: unknown): string {
  return createHash("sha256")
    .update(canonicalEvidenceJson(value), "utf8")
    .digest("hex");
}

export function validateSandboxCandidateBundle(
  bundle: SandboxCandidateBundle,
  now = new Date(),
): void {
  assertRemoteSandboxJson(bundle, "bundle");
  assertRemoteSandboxSecretFree(bundle, "bundle");
  if (
    bundle.schema !== SANDBOX_CANDIDATE_BUNDLE_SCHEMA
    || bundle.bundleHash !== sandboxCandidateBundleHash(bundle)
    || bundle.specsFingerprint !== `specs:v2:${canonicalSandboxSha256(bundle.specs)}`
    || bundle.manifestHash !== `manifest:v1:${canonicalSandboxSha256(bundle.manifest)}`
  ) {
    throw new RemoteSandboxProtocolError(
      "bundle_identity_mismatch",
      "Sandbox candidate bundle identity is invalid",
    );
  }
  const isolationFingerprint = /^sha256:[a-f0-9]{64}$/;
  if (
    bundle.targetInngestIsolation?.schema !== TARGET_INNGEST_ISOLATION_IDENTITY_SCHEMA
    || bundle.targetInngestIsolation.targetTenantSlug !== bundle.targetTenant.slug
    || !isolationFingerprint.test(bundle.targetInngestIsolation.eventChannelFingerprint)
    || !isolationFingerprint.test(bundle.targetInngestIsolation.signatureChannelFingerprint)
    || !isolationFingerprint.test(bundle.targetInngestIsolation.brokerFingerprint)
    || !isolationFingerprint.test(bundle.targetInngestIsolation.appNamespaceFingerprint)
  ) {
    throw new RemoteSandboxProtocolError(
      "runner_target_isolation_invalid",
      "Signed bundle has no valid target Inngest isolation identity",
    );
  }
  const expectedSlug = sandboxTenantSlug(
    bundle.targetDomainId,
    {
      tenantId: bundle.targetTenant.id,
      tenantSlug: bundle.targetTenant.slug,
    },
    bundle.candidateFingerprint,
    bundle.attemptId,
  );
  const createdAt = Date.parse(bundle.createdAt);
  const expiresAt = Date.parse(bundle.expiresAt);
  if (
    expectedSlug !== bundle.sandboxTenantSlug
    || !Number.isFinite(createdAt)
    || !Number.isFinite(expiresAt)
    || expiresAt <= createdAt
    || now.getTime() < createdAt - 5_000
    || now.getTime() > expiresAt + 5_000
  ) {
    throw new RemoteSandboxProtocolError(
      "bundle_expired_or_mismatched",
      "Sandbox candidate bundle is expired or targets a different nonce tenant",
    );
  }
  if (
    bundle.policy.networkPolicy !== "deny_public_egress"
    || bundle.policy.externalLiveCalls !== 0
    || bundle.policy.functionModuleFallbackAllowed !== false
    || !Number.isSafeInteger(bundle.policy.maxModelCalls)
    || bundle.policy.maxModelCalls < 1
    || bundle.policy.maxModelCalls > 1_024
    || !Number.isSafeInteger(bundle.policy.maxModelTotalTokens)
    || bundle.policy.maxModelTotalTokens < 1
    || bundle.policy.maxModelTotalTokens > 100_000_000
  ) {
    throw new RemoteSandboxProtocolError(
      "bundle_policy_invalid",
      "Sandbox candidate bundle requests a non-promotable execution policy",
    );
  }
  if (
    bundle.specs.length === 0
    || bundle.specs.some((spec) =>
      spec.domainId !== bundle.targetDomainId
      || (spec.codeExecuted === true
        ? !spec.generatedCode?.trim()
        : !((spec.plan?.length ?? 0) > 0)))
  ) {
    throw new RemoteSandboxProtocolError(
      "bundle_candidate_invalid",
      "Sandbox bundle has no executable CodeAct/declarative artifact or crosses domain boundaries",
    );
  }
}

function selectedToolNames(bundle: SandboxCandidateBundle): string[] {
  const names = new Set<string>();
  const visit = (steps: SandboxCandidateBundle["specs"][number]["plan"]): void => {
    for (const step of steps ?? []) {
      if (step.kind === "tool" && step.tool?.trim()) names.add(step.tool.trim());
      if (step.body?.length) visit(step.body);
    }
  };
  for (const spec of bundle.specs) {
    for (const name of spec.tools ?? []) if (name.trim()) names.add(name.trim());
    visit(spec.plan);
  }
  return [...names].sort();
}

function selectedSpecToolNames(spec: SandboxCandidateBundle["specs"][number]): string[] {
  const names = new Set<string>();
  for (const name of spec.tools ?? []) if (name.trim()) names.add(name.trim());
  const visit = (steps: typeof spec.plan): void => {
    for (const step of steps ?? []) {
      if (step.kind === "tool" && step.tool?.trim()) names.add(step.tool.trim());
      if (step.body?.length) visit(step.body);
    }
  };
  visit(spec.plan);
  return [...names].sort();
}

/** sandbox-runner-catalog intentionally verifies one config-bound hash at a
 * time. A v2 bundle may carry several variants of the same implementation, so
 * project each spec independently and merge only replay descriptors after all
 * variants have passed the existing implementation/config drift checks. */
function prepareVariantAwareRunnerCatalog(bundle: SandboxCandidateBundle): {
  targetReplayRegistry?: TenantRegistry;
} {
  let merged: TenantRegistry | undefined;
  for (const spec of bundle.specs) {
    const required = new Set(selectedSpecToolNames(spec));
    const toolDefinitions = bundle.toolDefinitions.filter((entry) =>
      required.has(entry.toolName) && entry.specSlugs.includes(spec.slug));
    const toolEvidence = bundle.toolEvidence.filter((entry) =>
      required.has(entry.toolName) && entry.specSlugs.includes(spec.slug));
    for (const toolName of required) {
      if (toolDefinitions.filter((entry) => entry.toolName === toolName).length !== 1) {
        throw new RemoteSandboxProtocolError(
          "runner_tool_binding_invalid",
          `Generated function '${spec.slug}' does not have exactly one definition binding for '${toolName}'`,
        );
      }
    }
    const prepared = prepareSandboxRunnerCatalog({
      ...bundle,
      specs: [spec],
      toolDefinitions,
      toolEvidence,
    });
    if (!prepared.targetReplayRegistry) continue;
    if (!merged) {
      merged = {
        ...prepared.targetReplayRegistry,
        tools: { ...(prepared.targetReplayRegistry.tools ?? {}) },
      };
      continue;
    }
    if (
      canonicalEvidenceJson(merged.factory ?? null)
      !== canonicalEvidenceJson(prepared.targetReplayRegistry.factory ?? null)
    ) {
      throw new RemoteSandboxProtocolError(
        "runner_tool_catalog_invalid",
        "Per-function replay projections disagree on the target tenant registry identity",
      );
    }
    for (const [name, descriptor] of Object.entries(
      prepared.targetReplayRegistry.tools ?? {},
    )) {
      merged.tools ??= {};
      merged.tools[name] ??= descriptor;
    }
  }
  return merged ? { targetReplayRegistry: merged } : {};
}

function declarativeRow(
  bundle: SandboxCandidateBundle,
  entry: SandboxBundleToolDefinition,
): typeof factoryTools.$inferInsert {
  const definition = entry.definition;
  const policy = {
    operation: definition.operation,
    effectScope: definition.effectScope,
    sandboxPolicy: definition.sandboxPolicy,
  };
  if (
    entry.source !== "declarative"
    || definition.name !== entry.toolName
    || !isGeneratedToolExecutionPolicy(policy)
    || typeof definition.sideEffect !== "string"
    || typeof definition.method !== "string"
    || typeof definition.urlTemplate !== "string"
  ) {
    throw new RemoteSandboxProtocolError(
      "bundle_tool_definition_invalid",
      `Declarative tool '${entry.toolName}' has an incomplete executable contract`,
    );
  }
  const now = new Date();
  return {
    id: `tol-rsb-${sha({ attemptId: bundle.attemptId, name: entry.toolName }).slice(0, 32)}`,
    scopeKey: bundle.targetTenant.id,
    domainKey: bundle.targetDomainId,
    name: entry.toolName,
    tenantId: bundle.targetTenant.id,
    description: typeof definition.description === "string" ? definition.description : "",
    method: definition.method,
    urlTemplate: definition.urlTemplate,
    headers: definition.headers as typeof factoryTools.$inferInsert.headers,
    bodyTemplate: typeof definition.bodyTemplate === "string" ? definition.bodyTemplate : null,
    requestSpec: definition.requestSpec as typeof factoryTools.$inferInsert.requestSpec,
    responseSpec: definition.responseSpec as typeof factoryTools.$inferInsert.responseSpec,
    examples: definition.examples as typeof factoryTools.$inferInsert.examples,
    sideEffect: definition.sideEffect,
    operation: policy.operation,
    effectScope: policy.effectScope,
    sandboxPolicy: policy.sandboxPolicy,
    domain: bundle.targetDomainId,
    paramsSchema: definition.paramsSchema as typeof factoryTools.$inferInsert.paramsSchema,
    returnsSchema: definition.returnsSchema as typeof factoryTools.$inferInsert.returnsSchema,
    capabilities: definition.capabilities as typeof factoryTools.$inferInsert.capabilities,
    probeStatus: "verified",
    definitionHash: entry.definitionHash,
    probeEvidence: {
      source: "signed_remote_bundle",
      bundleHash: bundle.bundleHash,
      schemaHash: entry.schemaHash ?? null,
    },
    verifiedAt: now,
    createdAt: now,
    updatedAt: now,
  };
}

function prepareRunnerSourceSnapshot(bundle: SandboxCandidateBundle): {
  remove(): void;
} {
  const db = getDb();
  const byId = db.select().from(tenants).where(eq(tenants.id, bundle.targetTenant.id)).all()[0];
  const bySlug = db.select().from(tenants).where(eq(tenants.slug, bundle.targetTenant.slug)).all()[0];
  if ((byId && byId.slug !== bundle.targetTenant.slug) || (bySlug && bySlug.id !== bundle.targetTenant.id)) {
    throw new RemoteSandboxProtocolError(
      "runner_target_collision",
      "Runner database already contains a different target tenant identity",
    );
  }
  const createdTenant = !byId && !bySlug;
  if (createdTenant) {
    const now = new Date();
    db.insert(tenants).values({
      id: bundle.targetTenant.id,
      slug: bundle.targetTenant.slug,
      name: `${bundle.targetTenant.slug} · remote sandbox source`,
      subtitle: `Isolated source snapshot for ${bundle.attemptId}`,
      createdAt: now,
      updatedAt: now,
    }).run();
  }

  const required = selectedToolNames(bundle);
  const definitions = new Map<string, SandboxBundleToolDefinition>();
  for (const entry of bundle.toolDefinitions) {
    const prior = definitions.get(entry.toolName);
    if (prior && (
      prior.source !== entry.source
      || canonicalEvidenceJson(prior.definition) !== canonicalEvidenceJson(entry.definition)
    )) {
      throw new RemoteSandboxProtocolError(
        "bundle_tool_definition_conflict",
        `Runner bundle contains different executable implementations for '${entry.toolName}'`,
      );
    }
    definitions.set(entry.toolName, prior ?? entry);
  }
  const missing = required.filter((name) => !definitions.has(name));
  if (missing.length) {
    throw new RemoteSandboxProtocolError(
      "bundle_tool_definition_missing",
      `Runner bundle is missing selected tool definitions: ${missing.join(", ")}`,
    );
  }
  const insertedIds: string[] = [];
  try {
    for (const entry of definitions.values()) {
      if (entry.source !== "declarative") continue;
      const row = declarativeRow(bundle, entry);
      const existing = db.select().from(factoryTools).where(eq(factoryTools.id, row.id!)).all()[0];
      if (existing) {
        throw new RemoteSandboxProtocolError(
          "runner_tool_collision",
          `Runner tool snapshot collision: ${entry.toolName}`,
        );
      }
      db.insert(factoryTools).values(row).run();
      insertedIds.push(row.id!);
    }
  } catch (error) {
    for (const id of insertedIds) db.delete(factoryTools).where(eq(factoryTools.id, id)).run();
    if (createdTenant) db.delete(tenants).where(eq(tenants.id, bundle.targetTenant.id)).run();
    throw error;
  }
  return {
    remove() {
      for (const id of insertedIds) db.delete(factoryTools).where(eq(factoryTools.id, id)).run();
      if (createdTenant) db.delete(tenants).where(eq(tenants.id, bundle.targetTenant.id)).run();
    },
  };
}

/** Remove source rows left by a workload-process crash before readiness can
 * become green. These rows are tagged by immutable runner provenance and the
 * tenant marker written above; normal tenant/tool records never match. */
export function reconcileRunnerSourceSnapshots(): {
  removedTools: number;
  removedTenants: number;
} {
  const db = getDb();
  let removedTools = 0;
  for (const row of db.select().from(factoryTools).all()) {
    const evidence = row.probeEvidence as { source?: unknown } | null;
    if (evidence?.source !== "signed_remote_bundle") continue;
    db.delete(factoryTools).where(eq(factoryTools.id, row.id)).run();
    removedTools += 1;
  }
  let removedTenants = 0;
  for (const row of db.select().from(tenants).all()) {
    if (!row.subtitle?.startsWith("Isolated source snapshot for ")) continue;
    const remainingTools = db
      .select({ id: factoryTools.id })
      .from(factoryTools)
      .where(eq(factoryTools.tenantId, row.id))
      .all();
    if (remainingTools.length) {
      throw new Error(`runner source tenant ${row.slug} still owns non-snapshot tools`);
    }
    db.delete(tenants).where(eq(tenants.id, row.id)).run();
    removedTenants += 1;
  }
  return { removedTools, removedTenants };
}

export function preloadedEvidence(
  bundle: SandboxCandidateBundle,
): Record<string, Record<string, BundledFunctionTestToolEvidence>> {
  return Object.fromEntries(bundle.specs.map((spec) => {
    const names = new Set(spec.tools ?? []);
    const visit = (steps: typeof spec.plan): void => {
      for (const step of steps ?? []) {
        if (step.kind === "tool" && step.tool?.trim()) names.add(step.tool.trim());
        if (step.body?.length) visit(step.body);
      }
    };
    visit(spec.plan);
    return [spec.slug, Object.fromEntries([...names].sort().map((name) => {
      const matches = bundle.toolEvidence.filter((entry) =>
        entry.toolName === name && entry.specSlugs.includes(spec.slug));
      if (matches.length > 1) {
        throw new RemoteSandboxProtocolError(
          "runner_tool_binding_invalid",
          `Generated function '${spec.slug}' has duplicate replay bindings for '${name}'`,
        );
      }
      const evidence = matches[0];
      return [name, evidence
        ? {
            definitionHash: evidence.definitionHash,
            ...(evidence.schemaHash ? { schemaHash: evidence.schemaHash } : {}),
            document: evidence.cassette,
          }
        : {
            definitionHash: bundle.toolDefinitions.find((entry) =>
              entry.toolName === name && entry.specSlugs.includes(spec.slug))?.definitionHash ?? "",
            blockedReason: `签名候选包没有工具「${name}」的精确参数回放证据。`,
          }];
    }))];
  }));
}

export interface SandboxWorkloadExecutionResult {
  schema: "agent-factory-sandbox-workload-result/v1";
  bundleHash: string;
  startedAt: string;
  completedAt: string;
  result: SandboxDeployResult;
  infrastructureCleanup: SandboxInfrastructureCleanupEvidence;
}

function buildInfrastructureCleanupEvidence(input: {
  bundle: SandboxCandidateBundle;
  result: SandboxDeployResult;
  verifiedAt: string;
  candidateExecutions: CodeActContainerExecutionEvidence[];
}): SandboxInfrastructureCleanupEvidence {
  // This receipt proves absence after the attempt, not business success. A
  // handler that returns the wrong event (or a replay miss) must still be able
  // to finish cleanup and hand its red test result back for another draft
  // iteration. This evidence records the ACTUAL boundary. A worker can prove
  // termination, but cannot prove ambient process/network/credential denial,
  // so the control signer must refuse to turn it into a remote_container
  // receipt.
  const expectedCodeAgents = input.bundle.specs
    .filter((spec) => spec.codeExecuted === true)
    .map((spec) => spec.short);
  const expectedCodeHashes = input.bundle.specs
    .filter((spec) => spec.codeExecuted === true)
    .map((spec) => createHash("sha256").update(spec.generatedCode ?? "", "utf8").digest("hex"));
  const expectedDeclarative = input.bundle.specs
    .filter((spec) => spec.codeExecuted !== true);
  const ranAgents = new Set(input.result.codeRanAgents ?? []);
  const runtimeRanAgents = new Set((input.result.agentRuns ?? []).flatMap((run) => [
    run.agentSlug,
    run.agentShort,
  ]));
  if (
    input.candidateExecutions.length < expectedCodeAgents.length
    || expectedCodeAgents.some((agent) => !ranAgents.has(agent))
    || expectedCodeHashes.some((hash) =>
      !input.candidateExecutions.some((execution) => execution.codeSha256 === hash))
    || expectedDeclarative.some((spec) =>
      !runtimeRanAgents.has(spec.slug)
      && !runtimeRanAgents.has(spec.short)
      && !runtimeRanAgents.has(spec.nameZh))
    || input.candidateExecutions.some((execution) =>
      execution.attemptId !== input.bundle.attemptId
      || execution.isolation !== "isolated_container"
      || execution.removed !== true
      || execution.absenceVerified !== true)
  ) {
    throw new RemoteSandboxProtocolError(
      "runner_candidate_isolation_unproven",
      "Every generated function must run under its declared execution owner; every CodeAct owner additionally requires an identity-bound one-shot container with verified removal",
    );
  }
  const body = {
    schema: "agent-factory-sandbox-infrastructure-cleanup/v1" as const,
    candidateExecutionAbsent: true as const,
    workspaceAbsent: true as const,
    candidateSecretsIssued: false,
    isolation: "isolated_container" as const,
    executionOwners: {
      declarativeFunctions: expectedDeclarative.length,
      codeactFunctions: expectedCodeAgents.length,
    },
    candidateExecutions: input.candidateExecutions,
    verifiedAt: input.verifiedAt,
  };
  return {
    ...body,
    evidenceHash: sandboxInfrastructureCleanupEvidenceHash(body),
  };
}

/** Execute one already-authenticated candidate bundle. The caller owns job
 * concurrency and cancellation; this function owns tenant/tool snapshot
 * cleanup and returns only after the nonce App cleanup receipt exists. */
export async function executeSandboxCandidateBundleWorkload(input: {
  bundle: SandboxCandidateBundle;
  signal?: AbortSignal;
  now?: () => Date;
}): Promise<SandboxWorkloadExecutionResult> {
  const now = input.now ?? (() => new Date());
  validateSandboxCandidateBundle(input.bundle, now());
  const sandboxTombstoneExpiresAt = new Date(Math.max(
    Date.parse(input.bundle.expiresAt) + 3 * 60_000,
    now().getTime() + input.bundle.policy.maxRunMs + 3 * 60_000,
  )).toISOString();
  const runnerCatalog = prepareVariantAwareRunnerCatalog(input.bundle);
  const startedAt = now().toISOString();
  const removeModelContext = installSandboxModelExecutionContext({
    sandboxTenantSlug: input.bundle.sandboxTenantSlug,
    attemptId: input.bundle.attemptId,
    bundleHash: input.bundle.bundleHash,
    targetTenantId: input.bundle.targetTenant.id,
    targetTenantSlug: input.bundle.targetTenant.slug,
    maxCalls: input.bundle.policy.maxModelCalls,
    maxTotalTokens: input.bundle.policy.maxModelTotalTokens,
  });
  try {
    beginCodeActContainerAttempt(input.bundle.attemptId);
  } catch (error) {
    try {
      removeModelContext();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "sandbox attempt setup and model-context cleanup both failed");
    }
    throw error;
  }
  let source: ReturnType<typeof prepareRunnerSourceSnapshot> | undefined;
  let candidateExecutions: CodeActContainerExecutionEvidence[] = [];
  let modelUsage: ReturnType<typeof removeModelContext>;
  let result: SandboxDeployResult;
  try {
    source = prepareRunnerSourceSnapshot(input.bundle);
    const deployer = new ManifestSandboxDeployer(
      {
        tenantId: input.bundle.targetTenant.id,
        tenantSlug: input.bundle.targetTenant.slug,
      },
      undefined,
      {
        sandboxAttemptId: input.bundle.attemptId,
        targetRegistryVersion: input.bundle.targetTenant.registryVersion,
        targetReplayRegistry: runnerCatalog.targetReplayRegistry,
        preloadedEvidenceBySpec: preloadedEvidence(input.bundle),
        executionQualification: "promotable",
        targetInngestIsolation: input.bundle.targetInngestIsolation,
        sandboxTombstoneExpiresAt,
      },
    );
    result = await deployer.deployAndObserve(
      input.bundle.targetDomainId,
      input.bundle.specs,
      {
        testCases: input.bundle.testCases,
        boundaryEvents: input.bundle.boundaryEvents,
        candidateFingerprint: input.bundle.candidateFingerprint,
        signal: input.signal,
      },
    );
    if (
      result.cleanupVerified !== true
      || result.sandboxAttemptId !== input.bundle.attemptId
      || result.sandboxTenantSlug !== input.bundle.sandboxTenantSlug
    ) {
      throw new RemoteSandboxProtocolError(
        "runner_cleanup_evidence_invalid",
        "Runner execution did not produce identity-bound cleanup evidence",
      );
    }
  } finally {
    try {
      source?.remove();
    } finally {
      try {
        modelUsage = removeModelContext();
      } finally {
        candidateExecutions = finishCodeActContainerAttempt(input.bundle.attemptId);
      }
    }
  }
  result = { ...result, modelUsage: modelUsage! };
  // Timestamp/sign only after both the nonce App cleanup and the runner-local
  // source snapshot removal have completed. A failed removal therefore cannot
  // produce `workspaceAbsent: true` evidence.
  const completedAt = now().toISOString();
  const infrastructureCleanup = buildInfrastructureCleanupEvidence({
    bundle: input.bundle,
    result,
    verifiedAt: completedAt,
    candidateExecutions,
  });
  return {
    schema: "agent-factory-sandbox-workload-result/v1",
    bundleHash: input.bundle.bundleHash,
    startedAt,
    completedAt,
    result,
    infrastructureCleanup,
  };
}

/** In-process composition retained for focused tests only. The deployed
 * topology calls the workload function in a different container, then the
 * control signer independently verifies broker absence before calling the
 * attestation function. */
export async function executeSandboxCandidateBundle(input: {
  bundle: SandboxCandidateBundle;
  identity: SandboxRunnerExecutionIdentity;
  signal?: AbortSignal;
  now?: () => Date;
}): Promise<SandboxDeployResult> {
  const workload = await executeSandboxCandidateBundleWorkload(input);
  const executionReceipt = attestSandboxCandidateResult({
    bundle: input.bundle,
    result: workload.result,
    identity: input.identity,
    startedAt: workload.startedAt,
    completedAt: workload.completedAt,
    infrastructureCleanup: workload.infrastructureCleanup,
  });
  return { ...workload.result, executionReceipt };
}
