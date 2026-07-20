import type {
  GeneratedAgentSpec,
  SandboxDeployer,
} from "@agentic/agent-factory";
import { canonicalEvidenceJson } from "@agentic/agent-factory";
import type { CanonicalCassetteDocument } from "@agentic/shared/cassette";
import {
  TARGET_INNGEST_ISOLATION_IDENTITY_SCHEMA,
  type TargetInngestIsolationIdentity,
} from "@agentic/runtime";

import {
  mapToManifest,
  sandboxTenantSlug,
  type SandboxTenantScope,
} from "./sandbox-deployer";
import {
  assertRemoteSandboxJson,
  assertRemoteSandboxSecretFree,
  canonicalSandboxSha256,
  RemoteSandboxProtocolError,
} from "./sandbox-remote-protocol";

export const SANDBOX_CANDIDATE_BUNDLE_SCHEMA =
  "agent-factory-sandbox-candidate-bundle/v2" as const;
export const MAX_SANDBOX_CANDIDATE_RUN_MS = 15 * 60_000;

type SandboxDeployOptions = NonNullable<
  Parameters<SandboxDeployer["deployAndObserve"]>[2]
>;

export type SandboxBundleTestCase = NonNullable<
  SandboxDeployOptions["testCases"]
>[number];

export interface SandboxBundleToolDefinitionInput {
  /** Stable, bundle-local identity for one tool/config variant. */
  bindingId: string;
  /** Exact generated functions that selected this variant. The list is
   * canonical, complete, and may contain more than one spec only when those
   * specs selected the same config-bound definition. */
  specSlugs: string[];
  toolName: string;
  configHash: string;
  /** `declarative` carries the complete persisted HTTP definition;
   * `catalog` carries the immutable global registry descriptor. */
  source: "declarative" | "catalog";
  definition: Record<string, unknown>;
  definitionHash: string;
  schemaHash?: string;
}

export interface SandboxBundleToolEvidenceInput {
  bindingId: string;
  specSlugs: string[];
  toolName: string;
  configHash: string;
  definitionHash: string;
  schemaHash?: string;
  cassette: CanonicalCassetteDocument;
}

export interface SandboxBundleToolDefinition {
  bindingId: string;
  specSlugs: string[];
  toolName: string;
  configHash: string;
  source: SandboxBundleToolDefinitionInput["source"];
  definition: Record<string, unknown>;
  definitionHash: string;
  schemaHash?: string;
}

export interface SandboxBundleToolEvidence {
  bindingId: string;
  specSlugs: string[];
  toolName: string;
  configHash: string;
  definitionHash: string;
  schemaHash?: string;
  contentHash: string;
  cassette: CanonicalCassetteDocument;
}

/** Secret-free shape of the target tenant registry that the trusted API saw
 * while it built the bundle. Dynamic adapter code is never serialized; this
 * descriptor lets the workload prove whether a tool-only replay projection is
 * equivalent, and fail closed when custom prompts/event codecs would be lost. */
export interface SandboxBundleTenantRegistryDescriptor {
  schema: "agent-factory-sandbox-tenant-registry/v1";
  tenantSlug: string;
  selectedVersion: string;
  registrySource: Record<string, unknown> | null;
  promptNames: string[];
  eventAdapter: null | { name: string | null };
}

export interface SandboxCandidateBundleBody {
  schema: typeof SANDBOX_CANDIDATE_BUNDLE_SCHEMA;
  attemptId: string;
  candidateFingerprint: string;
  specsFingerprint: string;
  targetDomainId: string;
  targetTenant: {
    id: string;
    slug: string;
    registryVersion?: string;
  };
  /** Secret-free target identity issued by the trusted Factory API. */
  targetInngestIsolation: TargetInngestIsolationIdentity;
  sandboxTenantSlug: string;
  controlPlaneBuildId: string;
  createdAt: string;
  expiresAt: string;
  specs: GeneratedAgentSpec[];
  manifest: unknown[];
  manifestHash: string;
  testCases: SandboxBundleTestCase[];
  boundaryEvents: Array<{ event: string; kind: string }>;
  tenantRegistry?: SandboxBundleTenantRegistryDescriptor;
  /** Executable descriptors for every selected tool.  The runner never reads
   * the production/shared tool row or native registry by name. */
  toolDefinitions: SandboxBundleToolDefinition[];
  /** Replay evidence is separate from executable definitions. V2 binds every
   * cassette to its exact generated-function/tool/config variant. */
  toolEvidence: SandboxBundleToolEvidence[];
  policy: {
    requiredIsolation: "remote_container" | "remote_vm";
    networkPolicy: "deny_public_egress";
    externalLiveCalls: 0;
    functionModuleFallbackAllowed: false;
    maxRunMs: number;
    maxMemoryMb: number;
    maxCpu: number;
    maxProcesses: number;
    /** Attempt-wide semantic model envelopes. They are enforced atomically by
     * the primary API proxy and copied into signed usage evidence. */
    maxModelCalls: number;
    maxModelTotalTokens: number;
  };
}

export interface SandboxCandidateBundle extends SandboxCandidateBundleBody {
  bundleHash: string;
}

export interface BuildSandboxCandidateBundleInput {
  attemptId: string;
  candidateFingerprint: string;
  targetDomainId: string;
  targetTenant: SandboxTenantScope & { registryVersion?: string };
  targetInngestIsolation: TargetInngestIsolationIdentity;
  controlPlaneBuildId: string;
  specs: GeneratedAgentSpec[];
  testCases?: SandboxBundleTestCase[];
  boundaryEvents?: Array<{ event: string; kind: string }>;
  toolDefinitions?: SandboxBundleToolDefinitionInput[];
  toolEvidence?: SandboxBundleToolEvidenceInput[];
  tenantRegistry?: SandboxBundleTenantRegistryDescriptor;
  now?: Date;
  expiresInMs?: number;
  policy?: Partial<SandboxCandidateBundleBody["policy"]>;
}

const SHA256_HEX = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;
const MAX_SANDBOX_BUNDLE_BYTES = 32 * 1024 * 1024;
const TOOL_BINDING_ID = /^tool-binding:v1:[a-f0-9]{64}$/;

export function sandboxToolBindingId(input: {
  specSlugs: readonly string[];
  toolName: string;
  configHash: string;
  definitionHash: string;
}): string {
  return `tool-binding:v1:${canonicalSandboxSha256({
    specSlugs: [...input.specSlugs].sort(),
    toolName: input.toolName,
    configHash: input.configHash,
    definitionHash: input.definitionHash,
  })}`;
}

function requiredText(value: unknown, label: string, max = 256): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (
    !text ||
    text.length > max ||
    /[\u0000-\u001f\u007f]/.test(text)
  ) {
    throw new RemoteSandboxProtocolError(
      "invalid_bundle",
      `${label} must be a non-empty safe string`,
    );
  }
  return text;
}

function safeId(value: unknown, label: string): string {
  const text = requiredText(value, label);
  if (!SAFE_ID.test(text)) {
    throw new RemoteSandboxProtocolError(
      "invalid_bundle",
      `${label} contains unsupported characters`,
    );
  }
  return text;
}

function normalizedJson<T>(value: T, label: string): T {
  assertRemoteSandboxJson(value, label);
  return JSON.parse(canonicalEvidenceJson(value)) as T;
}

function normalizeTenantRegistryDescriptor(
  raw: SandboxBundleTenantRegistryDescriptor | undefined,
  targetTenant: { slug: string; registryVersion?: string },
): SandboxBundleTenantRegistryDescriptor | undefined {
  if (!raw) return undefined;
  const normalized = normalizedJson(raw, "tenantRegistry");
  if (
    normalized.schema !== "agent-factory-sandbox-tenant-registry/v1"
    || normalized.tenantSlug !== targetTenant.slug
    || normalized.selectedVersion !== targetTenant.registryVersion
    || (normalized.registrySource !== null
      && (!normalized.registrySource
        || typeof normalized.registrySource !== "object"
        || Array.isArray(normalized.registrySource)))
    || !Array.isArray(normalized.promptNames)
    || (normalized.eventAdapter !== null
      && (!normalized.eventAdapter
        || typeof normalized.eventAdapter !== "object"
        || Array.isArray(normalized.eventAdapter)
        || (normalized.eventAdapter.name !== null
          && typeof normalized.eventAdapter.name !== "string")))
  ) {
    throw new RemoteSandboxProtocolError(
      "tenant_registry_descriptor_invalid",
      "Target tenant registry descriptor is malformed or bound to another registry version",
    );
  }
  const promptNames = normalized.promptNames.map((name) =>
    requiredText(name, "tenantRegistry.promptNames[]", 200));
  if (
    new Set(promptNames).size !== promptNames.length
    || canonicalEvidenceJson(promptNames) !== canonicalEvidenceJson([...promptNames].sort())
  ) {
    throw new RemoteSandboxProtocolError(
      "tenant_registry_descriptor_invalid",
      "Target tenant prompt names must be unique and canonically sorted",
    );
  }
  if (normalized.eventAdapter && normalized.eventAdapter.name !== null) {
    requiredText(normalized.eventAdapter.name, "tenantRegistry.eventAdapter.name", 200);
  }
  assertRemoteSandboxSecretFree(normalized, "tenantRegistry");
  return normalized;
}

function selectedTools(spec: GeneratedAgentSpec): string[] {
  const tools = new Set<string>();
  for (const name of spec.tools ?? []) if (name.trim()) tools.add(name.trim());
  const visit = (steps: GeneratedAgentSpec["plan"]): void => {
    for (const step of steps ?? []) {
      if (step.kind === "tool" && step.tool?.trim()) tools.add(step.tool.trim());
      if (step.body?.length) visit(step.body);
    }
  };
  visit(spec.plan);
  return [...tools].sort();
}

interface RequiredToolBinding {
  toolName: string;
  configHash: string;
  specSlugs: string[];
}

function selectedToolPolicies(specs: GeneratedAgentSpec[]): Map<string, {
  operation: string;
  effectScope: "external" | "sandbox_local" | "none";
  sandboxPolicy: string;
  sideEffect?: string;
}> {
  const names = new Map<string, {
    operation: string;
    effectScope: "external" | "sandbox_local" | "none";
    sandboxPolicy: string;
    sideEffect?: string;
  }>();
  for (const spec of specs) {
    for (const name of selectedTools(spec)) {
      const policy = spec.toolPolicies?.[name];
      if (!policy) {
        throw new RemoteSandboxProtocolError(
          "tool_policy_missing",
          `Tool '${name}' has no reviewed execution policy`,
        );
      }
      const prior = names.get(name);
      const sideEffect = spec.toolSideEffects?.[name];
      if (prior && (
        prior.operation !== policy.operation
        || prior.effectScope !== policy.effectScope
        || prior.sandboxPolicy !== policy.sandboxPolicy
        || (prior.sideEffect !== undefined
          && sideEffect !== undefined
          && prior.sideEffect !== sideEffect)
      )) {
        throw new RemoteSandboxProtocolError(
          "tool_policy_conflict",
          `Tool '${name}' has conflicting reviewed policies across generated functions`,
        );
      }
      names.set(name, {
        operation: policy.operation,
        effectScope: policy.effectScope,
        sandboxPolicy: policy.sandboxPolicy,
        ...(sideEffect ?? prior?.sideEffect
          ? { sideEffect: sideEffect ?? prior?.sideEffect }
          : {}),
      });
    }
  }
  return names;
}

function requiredToolBindings(specs: GeneratedAgentSpec[]): RequiredToolBinding[] {
  const grouped = new Map<string, RequiredToolBinding>();
  for (const spec of specs) {
    for (const toolName of selectedTools(spec)) {
      const config = spec.sandboxToolConfigs?.[toolName] ?? {};
      const configHash = canonicalSandboxSha256(config);
      const key = `${toolName}\u0000${configHash}`;
      const current = grouped.get(key) ?? { toolName, configHash, specSlugs: [] };
      current.specSlugs.push(spec.slug);
      grouped.set(key, current);
    }
  }
  return [...grouped.values()]
    .map((binding) => ({
      ...binding,
      specSlugs: [...binding.specSlugs].sort(),
    }))
    .sort((left, right) =>
      left.toolName.localeCompare(right.toolName)
      || left.configHash.localeCompare(right.configHash));
}

function normalizeSpecSlugs(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new RemoteSandboxProtocolError(
      "invalid_tool_binding",
      `${label} must contain at least one generated function slug`,
    );
  }
  const slugs = value.map((slug) => safeId(slug, `${label}[]`));
  if (
    new Set(slugs).size !== slugs.length
    || canonicalEvidenceJson(slugs) !== canonicalEvidenceJson([...slugs].sort())
  ) {
    throw new RemoteSandboxProtocolError(
      "invalid_tool_binding",
      `${label} must be unique and canonically sorted`,
    );
  }
  return slugs;
}

function requiredBindingKey(binding: Pick<RequiredToolBinding, "toolName" | "configHash" | "specSlugs">): string {
  return canonicalEvidenceJson({
    toolName: binding.toolName,
    configHash: binding.configHash,
    specSlugs: binding.specSlugs,
  });
}

function normalizeToolDefinitions(
  entries: readonly SandboxBundleToolDefinitionInput[],
  requiredBindings: readonly RequiredToolBinding[],
): SandboxBundleToolDefinition[] {
  const byBindingId = new Map<string, SandboxBundleToolDefinition>();
  const byRequiredBinding = new Map<string, SandboxBundleToolDefinition>();
  const requiredByKey = new Map(
    requiredBindings.map((binding) => [requiredBindingKey(binding), binding]),
  );
  const implementationByName = new Map<string, {
    source: SandboxBundleToolDefinitionInput["source"];
    definition: Record<string, unknown>;
  }>();
  for (const raw of entries) {
    const toolName = requiredText(raw.toolName, "tool definition name", 200);
    const specSlugs = normalizeSpecSlugs(
      raw.specSlugs,
      `toolDefinitions.${toolName}.specSlugs`,
    );
    const configHash = requiredText(
      raw.configHash,
      `tool '${toolName}' config hash`,
      64,
    ).toLowerCase();
    if (!SHA256_HEX.test(configHash)) {
      throw new RemoteSandboxProtocolError(
        "invalid_tool_binding",
        `Tool '${toolName}' has an invalid config hash`,
      );
    }
    const requiredKey = requiredBindingKey({ toolName, configHash, specSlugs });
    if (!requiredByKey.has(requiredKey)) {
      throw new RemoteSandboxProtocolError(
        "unexpected_tool_binding",
        `Tool '${toolName}' definition is bound to the wrong generated function or config`,
      );
    }
    if (byRequiredBinding.has(requiredKey)) {
      throw new RemoteSandboxProtocolError(
        "duplicate_tool_definition",
        `Tool '${toolName}' has duplicate executable definitions for one binding`,
      );
    }
    const definitionHash = requiredText(
      raw.definitionHash,
      `tool '${toolName}' definition hash`,
      64,
    ).toLowerCase();
    if (!SHA256_HEX.test(definitionHash)) {
      throw new RemoteSandboxProtocolError(
        "invalid_tool_evidence",
        `Tool '${toolName}' has an invalid definition hash`,
      );
    }
    const schemaHash = raw.schemaHash?.trim().toLowerCase();
    if (schemaHash && !SHA256_HEX.test(schemaHash)) {
      throw new RemoteSandboxProtocolError(
        "invalid_tool_evidence",
        `Tool '${toolName}' has an invalid schema hash`,
      );
    }
    const definition = normalizedJson(raw.definition, `toolDefinitions.${toolName}.definition`);
    const bindingId = requiredText(
      raw.bindingId,
      `tool '${toolName}' binding id`,
      96,
    );
    if (
      !TOOL_BINDING_ID.test(bindingId)
      || bindingId !== sandboxToolBindingId({
        specSlugs,
        toolName,
        configHash,
        definitionHash,
      })
    ) {
      throw new RemoteSandboxProtocolError(
        "invalid_tool_binding",
        `Tool '${toolName}' has an invalid or mismatched binding identity`,
      );
    }
    if (byBindingId.has(bindingId)) {
      throw new RemoteSandboxProtocolError(
        "duplicate_tool_definition",
        `Tool binding '${bindingId}' has duplicate executable definitions`,
      );
    }
    const priorImplementation = implementationByName.get(toolName);
    if (priorImplementation && (
      priorImplementation.source !== raw.source
      || canonicalEvidenceJson(priorImplementation.definition)
        !== canonicalEvidenceJson(definition)
    )) {
      throw new RemoteSandboxProtocolError(
        "tool_definition_conflict",
        `Tool '${toolName}' variants do not share one exact executable implementation`,
      );
    }
    implementationByName.set(toolName, { source: raw.source, definition });
    const normalized: SandboxBundleToolDefinition = {
      bindingId,
      specSlugs,
      toolName,
      configHash,
      source: raw.source,
      definition,
      definitionHash,
      ...(schemaHash ? { schemaHash } : {}),
    };
    assertRemoteSandboxSecretFree(normalized, `toolDefinitions.${toolName}`);
    byBindingId.set(bindingId, normalized);
    byRequiredBinding.set(requiredKey, normalized);
  }
  const missing = requiredBindings.filter(
    (binding) => !byRequiredBinding.has(requiredBindingKey(binding)),
  );
  if (missing.length) {
    throw new RemoteSandboxProtocolError(
      "tool_definition_missing",
      `Selected tool bindings have no transportable executable definition: ${missing
        .map((binding) => `${binding.specSlugs.join("+")}:${binding.toolName}:${binding.configHash.slice(0, 12)}`)
        .join(", ")}`,
    );
  }
  return [...byBindingId.values()].sort((left, right) =>
    left.toolName.localeCompare(right.toolName)
    || left.configHash.localeCompare(right.configHash)
    || left.bindingId.localeCompare(right.bindingId),
  );
}

function normalizeToolEvidence(
  entries: readonly SandboxBundleToolEvidenceInput[],
  definitions: readonly SandboxBundleToolDefinition[],
): SandboxBundleToolEvidence[] {
  const byBindingId = new Map<string, SandboxBundleToolEvidence>();
  const definitionByBindingId = new Map(
    definitions.map((entry) => [entry.bindingId, entry]),
  );
  for (const raw of entries) {
    const toolName = requiredText(raw.toolName, "tool evidence name", 200);
    const bindingId = requiredText(
      raw.bindingId,
      `tool '${toolName}' evidence binding id`,
      96,
    );
    if (byBindingId.has(bindingId)) {
      throw new RemoteSandboxProtocolError(
        "duplicate_tool_evidence",
        `Tool binding '${bindingId}' has duplicate sandbox evidence`,
      );
    }
    const definition = definitionByBindingId.get(bindingId);
    const specSlugs = normalizeSpecSlugs(
      raw.specSlugs,
      `toolEvidence.${toolName}.specSlugs`,
    );
    const configHash = requiredText(
      raw.configHash,
      `tool '${toolName}' evidence config hash`,
      64,
    ).toLowerCase();
    if (
      !definition
      || definition.toolName !== toolName
      || definition.configHash !== configHash
      || canonicalEvidenceJson(definition.specSlugs) !== canonicalEvidenceJson(specSlugs)
    ) {
      throw new RemoteSandboxProtocolError(
        "invalid_tool_evidence",
        `Tool '${toolName}' evidence has no exact executable binding`,
      );
    }
    const definitionHash = requiredText(
      raw.definitionHash,
      `tool '${toolName}' evidence definition hash`,
      64,
    ).toLowerCase();
    if (!SHA256_HEX.test(definitionHash) || definitionHash !== definition.definitionHash) {
      throw new RemoteSandboxProtocolError(
        "invalid_tool_evidence",
        `Tool '${toolName}' evidence does not match its executable definition hash`,
      );
    }
    const schemaHash = raw.schemaHash?.trim().toLowerCase();
    if (
      (schemaHash && !SHA256_HEX.test(schemaHash)) ||
      schemaHash !== definition.schemaHash
    ) {
      throw new RemoteSandboxProtocolError(
        "invalid_tool_evidence",
        `Tool '${toolName}' evidence schema does not match its executable definition`,
      );
    }
    const cassette = normalizedJson(raw.cassette, `toolEvidence.${toolName}.cassette`);
    if (
      cassette.version !== 1 ||
      cassette.tool?.name !== toolName ||
      cassette.tool.definitionHash?.toLowerCase() !== definitionHash ||
      (schemaHash !== undefined && cassette.tool.schemaHash?.toLowerCase() !== schemaHash) ||
      !cassette.evidence?.recordedAt ||
      Number.isNaN(Date.parse(cassette.evidence.recordedAt)) ||
      !["live-probe", "signed-fixture", "runtime-record"].includes(
        cassette.evidence.mode,
      ) ||
      cassette.entries.length === 0
    ) {
      throw new RemoteSandboxProtocolError(
        "invalid_tool_evidence",
        `Tool '${toolName}' cassette is not bound to the current definition/schema`,
      );
    }
    const usable = cassette.entries.some(
      (entry) =>
        entry.request.kind === "tool" &&
        entry.request.toolName === toolName &&
        typeof entry.request.argsHash === "string" &&
        Object.prototype.hasOwnProperty.call(entry.response, "body"),
    );
    if (!usable) {
      throw new RemoteSandboxProtocolError(
        "invalid_tool_evidence",
        `Tool '${toolName}' cassette has no replayable tool exchange`,
      );
    }
    const normalized: SandboxBundleToolEvidence = {
      bindingId,
      specSlugs,
      toolName,
      configHash,
      definitionHash,
      ...(schemaHash ? { schemaHash } : {}),
      // The runner stages this canonical object verbatim.  Therefore its
      // runtime JSON.stringify hash equals the canonical document hash.
      contentHash: canonicalSandboxSha256(cassette),
      cassette,
    };
    assertRemoteSandboxSecretFree(normalized, `toolEvidence.${toolName}`);
    byBindingId.set(bindingId, normalized);
  }

  const missing = definitions.filter((definition) => !byBindingId.has(definition.bindingId));
  if (missing.length) {
    throw new RemoteSandboxProtocolError(
      "tool_evidence_missing",
      `Selected tool bindings have no definition-bound replay evidence: ${missing
        .map((binding) => `${binding.specSlugs.join("+")}:${binding.toolName}:${binding.configHash.slice(0, 12)}`)
        .join(", ")}`,
    );
  }
  return [...byBindingId.values()].sort((left, right) =>
    left.toolName.localeCompare(right.toolName)
    || left.configHash.localeCompare(right.configHash)
    || left.bindingId.localeCompare(right.bindingId),
  );
}

function manifestReplayRefs(
  specs: GeneratedAgentSpec[],
  evidence: readonly SandboxBundleToolEvidence[],
): Record<string, Record<string, { definition_hash: string; content_hash: string }>> {
  return Object.fromEntries(specs.map((spec) => [
    spec.slug,
    Object.fromEntries(selectedTools(spec).flatMap((name) => {
      const matches = evidence.filter((entry) =>
        entry.toolName === name && entry.specSlugs.includes(spec.slug));
      if (matches.length !== 1) {
        throw new RemoteSandboxProtocolError(
          "tool_evidence_binding_mismatch",
          `Generated function '${spec.slug}' does not have exactly one replay binding for '${name}'`,
        );
      }
      const entry = matches[0];
      return entry
        ? [[name, {
            definition_hash: entry.definitionHash,
            content_hash: entry.contentHash,
          }]]
        : [];
    })),
  ]));
}

export function sandboxCandidateBundleHash(
  bundle: SandboxCandidateBundle | SandboxCandidateBundleBody,
): string {
  const { bundleHash: _ignored, ...body } = bundle as SandboxCandidateBundle;
  return `sandbox-bundle:v2:${canonicalSandboxSha256(body)}`;
}

/** Build one transport-complete, secret-free candidate package.  The runner
 * needs no control-plane filesystem paths or production tool rows. */
export function buildSandboxCandidateBundle(
  input: BuildSandboxCandidateBundleInput,
): SandboxCandidateBundle {
  const attemptId = safeId(input.attemptId, "attemptId");
  const candidateFingerprint = requiredText(
    input.candidateFingerprint,
    "candidateFingerprint",
    512,
  );
  const targetDomainId = requiredText(input.targetDomainId, "targetDomainId");
  const targetTenant = {
    id: safeId(input.targetTenant?.tenantId, "targetTenant.id"),
    slug: safeId(input.targetTenant?.tenantSlug, "targetTenant.slug"),
    ...(input.targetTenant?.registryVersion
      ? {
          registryVersion: requiredText(
            input.targetTenant.registryVersion,
            "targetTenant.registryVersion",
          ),
        }
      : {}),
  };
  const targetInngestIsolation = normalizedJson(
    input.targetInngestIsolation,
    "targetInngestIsolation",
  );
  const tenantRegistry = normalizeTenantRegistryDescriptor(
    input.tenantRegistry,
    targetTenant,
  );
  const isolationFingerprint = /^sha256:[a-f0-9]{64}$/;
  if (
    targetInngestIsolation.schema !== TARGET_INNGEST_ISOLATION_IDENTITY_SCHEMA
    || targetInngestIsolation.targetTenantSlug !== targetTenant.slug
    || !isolationFingerprint.test(targetInngestIsolation.eventChannelFingerprint)
    || !isolationFingerprint.test(targetInngestIsolation.signatureChannelFingerprint)
    || !isolationFingerprint.test(targetInngestIsolation.brokerFingerprint)
    || !isolationFingerprint.test(targetInngestIsolation.appNamespaceFingerprint)
  ) {
    throw new RemoteSandboxProtocolError(
      "target_isolation_identity_invalid",
      "Target Inngest isolation identity is missing, malformed, or bound to another tenant",
    );
  }
  if (!input.specs.length) {
    throw new RemoteSandboxProtocolError(
      "invalid_bundle",
      "A remote sandbox bundle must contain at least one generated function",
    );
  }
  const specs = normalizedJson(input.specs, "specs");
  const specSlugs = specs.map((spec) => safeId(spec.slug, "spec.slug"));
  if (new Set(specSlugs).size !== specSlugs.length) {
    throw new RemoteSandboxProtocolError(
      "duplicate_spec_slug",
      "Remote sandbox bundle contains duplicate generated function slugs",
    );
  }
  const wrongDomain = specs.filter((spec) => spec.domainId !== targetDomainId);
  if (wrongDomain.length) {
    throw new RemoteSandboxProtocolError(
      "candidate_domain_mismatch",
      `Generated functions do not all belong to '${targetDomainId}'`,
    );
  }
  const missingArtifacts = specs.flatMap((spec) => {
    if (spec.codeExecuted === true && !spec.generatedCode?.trim()) {
      return [`${spec.slug}:exact CodeAct bytes`];
    }
    if (spec.codeExecuted !== true && !((spec.plan?.length ?? 0) > 0)) {
      return [`${spec.slug}:declarative action plan`];
    }
    return [];
  });
  if (missingArtifacts.length) {
    throw new RemoteSandboxProtocolError(
      "candidate_artifact_missing",
      `Remote sandbox bundle is missing an executable generated artifact: ${missingArtifacts.join(", ")}`,
    );
  }
  const unresolved = specs.flatMap((spec) =>
    (spec.unresolvedTools ?? []).map((tool) => `${spec.slug}:${tool}`),
  );
  if (unresolved.length) {
    throw new RemoteSandboxProtocolError(
      "unresolved_tools",
      `Remote sandbox bundle contains unresolved tools: ${unresolved.join(", ")}`,
    );
  }
  selectedToolPolicies(specs);
  const requiredBindings = requiredToolBindings(specs);
  const toolDefinitions = normalizeToolDefinitions(
    input.toolDefinitions ?? [],
    requiredBindings,
  );
  const toolEvidence = normalizeToolEvidence(
    input.toolEvidence ?? [],
    toolDefinitions,
  );
  const replayRefs = manifestReplayRefs(specs, toolEvidence);
  const manifest = normalizedJson(mapToManifest(specs, {
    target: "sandbox",
    targetDomainId,
    candidateFingerprint,
    sandboxAttemptId: attemptId,
    sandboxReplayRefs: replayRefs,
  }), "manifest");
  const now = input.now ?? new Date();
  const expiresInMs = input.expiresInMs ?? 10 * 60_000;
  if (
    !Number.isSafeInteger(expiresInMs) ||
    expiresInMs < 30_000 ||
    expiresInMs > 60 * 60_000
  ) {
    throw new RemoteSandboxProtocolError(
      "invalid_bundle_ttl",
      "Sandbox bundle TTL must be between 30 seconds and 1 hour",
    );
  }
  const policy: SandboxCandidateBundleBody["policy"] = {
    requiredIsolation: input.policy?.requiredIsolation ?? "remote_container",
    networkPolicy: "deny_public_egress",
    externalLiveCalls: 0,
    functionModuleFallbackAllowed: false,
    maxRunMs: input.policy?.maxRunMs ?? 120_000,
    maxMemoryMb: input.policy?.maxMemoryMb ?? 256,
    maxCpu: input.policy?.maxCpu ?? 1,
    maxProcesses: input.policy?.maxProcesses ?? 128,
    maxModelCalls: input.policy?.maxModelCalls ?? 64,
    maxModelTotalTokens: input.policy?.maxModelTotalTokens ?? 262_144,
  };
  if (
    !Number.isSafeInteger(policy.maxRunMs) || policy.maxRunMs < 1_000 || policy.maxRunMs > MAX_SANDBOX_CANDIDATE_RUN_MS ||
    !Number.isSafeInteger(policy.maxMemoryMb) || policy.maxMemoryMb < 64 || policy.maxMemoryMb > 4_096 ||
    !Number.isFinite(policy.maxCpu) || policy.maxCpu <= 0 || policy.maxCpu > 8 ||
    !Number.isSafeInteger(policy.maxProcesses) || policy.maxProcesses < 16 || policy.maxProcesses > 1_024 ||
    !Number.isSafeInteger(policy.maxModelCalls) || policy.maxModelCalls < 1 || policy.maxModelCalls > 1_024 ||
    !Number.isSafeInteger(policy.maxModelTotalTokens) || policy.maxModelTotalTokens < 1 || policy.maxModelTotalTokens > 100_000_000
  ) {
    throw new RemoteSandboxProtocolError(
      "invalid_execution_policy",
      "Remote sandbox resource policy is outside the supported safety bounds",
    );
  }

  const body: SandboxCandidateBundleBody = {
    schema: SANDBOX_CANDIDATE_BUNDLE_SCHEMA,
    attemptId,
    candidateFingerprint,
    specsFingerprint: `specs:v2:${canonicalSandboxSha256(specs)}`,
    targetDomainId,
    targetTenant,
    targetInngestIsolation,
    sandboxTenantSlug: sandboxTenantSlug(
      targetDomainId,
      { tenantId: targetTenant.id, tenantSlug: targetTenant.slug },
      candidateFingerprint,
      attemptId,
    ),
    controlPlaneBuildId: requiredText(
      input.controlPlaneBuildId,
      "controlPlaneBuildId",
    ),
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + expiresInMs).toISOString(),
    specs,
    manifest,
    manifestHash: `manifest:v1:${canonicalSandboxSha256(manifest)}`,
    testCases: normalizedJson(input.testCases ?? [], "testCases"),
    boundaryEvents: normalizedJson(input.boundaryEvents ?? [], "boundaryEvents"),
    ...(tenantRegistry ? { tenantRegistry } : {}),
    toolDefinitions,
    toolEvidence,
    policy,
  };
  assertRemoteSandboxSecretFree(body, "bundle");
  if (
    Buffer.byteLength(canonicalEvidenceJson(body), "utf8") >
    MAX_SANDBOX_BUNDLE_BYTES
  ) {
    throw new RemoteSandboxProtocolError(
      "bundle_too_large",
      "Remote sandbox bundle exceeds the 32 MiB transport limit",
    );
  }
  const bundle: SandboxCandidateBundle = {
    ...body,
    bundleHash: sandboxCandidateBundleHash(body),
  };
  assertRemoteSandboxJson(bundle, "bundle");
  return bundle;
}
