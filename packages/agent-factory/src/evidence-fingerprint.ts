import { createHash } from "node:crypto";
import { canonicalEvidenceJson } from "@agentic/shared";

export { canonicalEvidenceJson } from "@agentic/shared";

import type { BoundaryEvent, TestCase } from "./brain-types";
import type { DomainOntology } from "./ontology-types";
import type { DeclarativeTool, SandboxCleanupReceipt, SandboxRunDrainReceipt } from "./ports";
import type { GeneratedAgentSpec } from "./spec-types";
import type { RealTool } from "./tool-catalog";
import type { IntegrationCapabilityProvider } from "./integration-binding";

const EVIDENCE_VERSION = 6;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function digest(value: unknown): string {
  return sha256(canonicalEvidenceJson(value));
}

/** Recompute the tamper-evident identity of a secret-free sandbox cleanup
 * receipt. The hash deliberately covers the candidate/domain/app/attempt and
 * the exact broker absence verdict, so a receipt cannot be moved between
 * revisions or target domains. */
export function sandboxCleanupReceiptHash(
  receipt: Omit<SandboxCleanupReceipt, "absenceProbeHash"> | SandboxCleanupReceipt,
): string {
  const { absenceProbeHash: _ignored, ...body } = receipt as SandboxCleanupReceipt;
  return `sandbox-cleanup:v1:${digest(body)}`;
}

export function sandboxRunDrainReceiptHash(
  receipt: Omit<SandboxRunDrainReceipt, "evidenceHash"> | SandboxRunDrainReceipt,
): string {
  const { evidenceHash: _ignored, ...body } = receipt as SandboxRunDrainReceipt;
  return `sandbox-run-drain:v1:${digest(body)}`;
}

export function sandboxRunDrainReceiptIssues(
  receipt: SandboxRunDrainReceipt | null | undefined,
  expected?: { sandboxAttemptId?: string; appId?: string; sandboxTenantSlug?: string },
): string[] {
  if (!receipt) return ["missing sandbox run-drain receipt"];
  const issues: string[] = [];
  if (receipt.schema !== "agent-factory-sandbox-run-drain/v1") issues.push("unsupported sandbox run-drain receipt schema");
  if (!receipt.sandboxAttemptId?.trim()) issues.push("missing run-drain attempt identity");
  if (!receipt.appId?.trim()) issues.push("missing run-drain app identity");
  if (!receipt.sandboxTenantSlug?.trim()) issues.push("missing run-drain tenant identity");
  if (!receipt.startedAt || Number.isNaN(Date.parse(receipt.startedAt))) issues.push("invalid run-drain start timestamp");
  if (!receipt.completedAt || Number.isNaN(Date.parse(receipt.completedAt))) issues.push("invalid run-drain completion timestamp");
  if (
    receipt.startedAt && receipt.completedAt &&
    !Number.isNaN(Date.parse(receipt.startedAt)) &&
    !Number.isNaN(Date.parse(receipt.completedAt)) &&
    Date.parse(receipt.completedAt) < Date.parse(receipt.startedAt)
  ) issues.push("run-drain completion precedes start");
  const ids = new Set<string>();
  for (const run of receipt.observedRuns ?? []) {
    if (!run.runId?.trim()) issues.push("run-drain contains a run without id");
    if (ids.has(run.runId)) issues.push(`run-drain contains duplicate run ${run.runId}`);
    ids.add(run.runId);
    if (!new Set(["ok", "failed", "cancelled"]).has(run.finalStatus)) issues.push(`run ${run.runId} is not terminal`);
    if (!/^sha256:[a-f0-9]{64}$/.test(run.subjectHash ?? "")) issues.push(`run ${run.runId} has invalid subject hash`);
    if (run.cancelAcceptedAt && Number.isNaN(Date.parse(run.cancelAcceptedAt))) issues.push(`run ${run.runId} has invalid cancel acceptance timestamp`);
  }
  if (receipt.evidenceHash !== sandboxRunDrainReceiptHash(receipt)) issues.push("sandbox run-drain receipt hash mismatch");
  if (expected?.sandboxAttemptId && receipt.sandboxAttemptId !== expected.sandboxAttemptId) issues.push("sandbox run-drain attempt mismatch");
  if (expected?.appId && receipt.appId !== expected.appId) issues.push("sandbox run-drain app mismatch");
  if (expected?.sandboxTenantSlug && receipt.sandboxTenantSlug !== expected.sandboxTenantSlug) issues.push("sandbox run-drain tenant mismatch");
  return issues;
}

export function sandboxCleanupReceiptIssues(
  receipt: SandboxCleanupReceipt | null | undefined,
  expected?: { candidateFingerprint?: string; targetDomainId?: string },
): string[] {
  if (!receipt) return ["missing sandbox cleanup receipt"];
  const issues: string[] = [];
  if (receipt.schema !== "agent-factory-sandbox-cleanup/v2") issues.push("unsupported sandbox cleanup receipt schema");
  if (!receipt.appId?.trim()) issues.push("missing sandbox app id");
  if (!receipt.sandboxTenantSlug?.trim()) issues.push("missing sandbox tenant identity");
  if (!receipt.sandboxAttemptId?.trim()) issues.push("missing sandbox attempt identity");
  if (!receipt.candidateFingerprint?.trim()) issues.push("missing sandbox candidate fingerprint");
  if (!receipt.targetDomainId?.trim()) issues.push("missing sandbox target domain");
  issues.push(...sandboxRunDrainReceiptIssues(receipt.runDrain, {
    sandboxAttemptId: receipt.sandboxAttemptId,
    appId: receipt.appId,
    sandboxTenantSlug: receipt.sandboxTenantSlug,
  }));
  if (!receipt.deletedAt || Number.isNaN(Date.parse(receipt.deletedAt))) issues.push("invalid sandbox deletion timestamp");
  if (
    receipt.absence?.connected !== false ||
    receipt.absence?.functionCount !== null ||
    receipt.absence?.registryState !== "not_registered"
  ) {
    issues.push("sandbox broker did not attest exact app absence");
  }
  if (receipt.absenceProbeHash !== sandboxCleanupReceiptHash(receipt)) issues.push("sandbox cleanup receipt hash mismatch");
  if (expected?.candidateFingerprint && receipt.candidateFingerprint !== expected.candidateFingerprint) {
    issues.push("sandbox cleanup candidate fingerprint mismatch");
  }
  if (expected?.targetDomainId && receipt.targetDomainId !== expected.targetDomainId) {
    issues.push("sandbox cleanup target domain mismatch");
  }
  return issues;
}

function sortedCanonical<T>(values: readonly T[]): unknown[] {
  return values
    .map((value) => JSON.parse(canonicalEvidenceJson(value)) as unknown)
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

/** Content hash of the complete ontology snapshot. Top-level graph collections are sets for
 * drift purposes, so transport ordering does not invalidate evidence; every item and all other
 * ontology metadata remain content-addressed. */
export function ontologyContentHash(
  ontology: ({
    actions?: readonly unknown[];
    events?: readonly unknown[];
    rules?: readonly unknown[];
    objects?: readonly unknown[];
    links?: readonly unknown[];
    workflow?: readonly unknown[];
    [key: string]: unknown;
  }) | null | undefined,
): string {
  if (!ontology) return "0";
  const { actions = [], events = [], rules = [], objects = [], links, workflow = [], ...metadata } = ontology;
  return `ontology:v2:${digest({
    metadata,
    actions: sortedCanonical(actions),
    events: sortedCanonical(events),
    rules: sortedCanonical(rules),
    objects: sortedCanonical(objects),
    // Keep no-links legacy snapshots byte-for-byte compatible, while making a
    // supplied modern link set order-independent and execution-addressed.
    ...(links === undefined ? {} : { links: sortedCanonical(links) }),
    workflow: sortedCanonical(workflow),
  })}`;
}

/** Exact generated-spec snapshot, including the structured plan and generated source code.
 * Spec list order is not execution-bearing; ordering inside each spec remains significant. */
export function specsFingerprint(specs: readonly GeneratedAgentSpec[]): string {
  const ordered = [...specs].sort((a, b) =>
    `${a.slug}\u0000${a.actionName}`.localeCompare(`${b.slug}\u0000${b.actionName}`),
  );
  return `specs:v2:${digest(ordered)}`;
}

function selectedToolNames(specs: readonly GeneratedAgentSpec[]): string[] {
  const names = new Set<string>();
  const visit = (steps: GeneratedAgentSpec["plan"]): void => {
    for (const step of steps ?? []) {
      if (step.kind === "tool" && step.tool) names.add(step.tool);
      if (step.body?.length) visit(step.body);
    }
  };
  for (const spec of specs) {
    for (const name of spec.tools ?? []) if (name) names.add(name);
    visit(spec.plan);
  }
  return [...names].sort();
}

function toolBindings(specs: readonly GeneratedAgentSpec[]): unknown[] {
  const planBindings = (steps: GeneratedAgentSpec["plan"], prefix = ""): unknown[] =>
    (steps ?? []).flatMap((step, index) => {
      const path = prefix ? `${prefix}.${index}` : String(index);
      return [
        ...(step.kind === "tool" ? [{ path, stepId: step.stepId, name: step.tool ?? "" }] : []),
        ...(step.body?.length ? planBindings(step.body, `${path}.body`) : []),
      ];
    });
  return [...specs]
    .sort((a, b) => a.slug.localeCompare(b.slug))
    .map((spec) => ({
      slug: spec.slug,
      actionName: spec.actionName,
      domainId: spec.domainId,
      declared: (spec.tools ?? []).map((name, index) => ({ index, name })),
      plan: planBindings(spec.plan),
    }));
}

function configuredEnvRefsByTool(specs: readonly GeneratedAgentSpec[]): Map<string, Set<string>> {
  const refs = new Map<string, Set<string>>();
  for (const spec of specs) {
    for (const [toolName, config] of Object.entries(spec.toolConfigs ?? {})) {
      const names = refs.get(toolName) ?? new Set<string>();
      for (const [key, value] of Object.entries(config ?? {})) {
        if (/_env$/i.test(key) && typeof value === "string" && value.trim()) names.add(value.trim());
      }
      refs.set(toolName, names);
    }
  }
  return refs;
}

function normalizedRealToolEvidence(
  selected: readonly string[],
  realTools: readonly RealTool[],
  specs: readonly GeneratedAgentSpec[],
  env: Record<string, string | undefined>,
): unknown[] {
  const selectedSet = new Set(selected);
  const configuredRefs = configuredEnvRefsByTool(specs);
  return realTools
    .filter((tool) => selectedSet.has(tool.name) || (tool.aliases ?? []).some((name) => selectedSet.has(name)))
    .map((tool) => ({
      name: tool.name,
      aliases: [...(tool.aliases ?? [])].sort(),
      category: tool.category ?? "",
      sideEffect: tool.sideEffect ?? "",
      operation: tool.operation ?? null,
      effectScope: tool.effectScope ?? null,
      sandboxPolicy: tool.sandboxPolicy ?? null,
      configKeys: [...(tool.configKeys ?? [])].sort(),
      capabilities: sortedCanonical(tool.capabilities ?? []),
      probeStatus: tool.probeStatus ?? null,
      definitionHash: tool.definitionHash ?? null,
      verifiedDefinitionHashes: [...new Set(tool.verifiedDefinitionHashes ?? [])].sort(),
      declarativeDefinition: tool.declarativeDefinition ?? null,
      catalogDefinition: tool.catalogDefinition ?? null,
      credentialEnv: [...new Set([
        ...(tool.credentialEnv ?? []),
        ...(configuredRefs.get(tool.name) ?? []),
        ...(tool.aliases ?? []).flatMap((alias) => [...(configuredRefs.get(alias) ?? [])]),
      ])].sort().map((name) => {
        const value = env[name];
        return {
          name,
          configured: typeof value === "string" && value.trim().length > 0,
          // A rotation changes execution configuration and therefore invalidates prior evidence,
          // while the persisted evidence never contains the credential itself.
          valueDigest: typeof value === "string" && value.length > 0 ? sha256(value) : null,
        };
      }),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function normalizedRuntimeCapabilityEvidence(
  specs: readonly GeneratedAgentSpec[],
  providers: readonly IntegrationCapabilityProvider[],
): unknown[] {
  const selected = new Set(
    specs.flatMap((spec) => (spec.integrationBindings ?? [])
      .filter((binding) => binding.bindingKind === "runtime" && binding.bindingId)
      .map((binding) => binding.bindingId as string)),
  );
  return sortedCanonical(providers
    .filter((provider) => selected.has(provider.id))
    .map((provider) => ({
      id: provider.id,
      status: provider.status,
      reason: provider.reason ?? "",
      capabilities: sortedCanonical(provider.capabilities),
    })));
}

function normalizedDeclarativeToolEvidence(
  selected: readonly string[],
  tools: readonly DeclarativeTool[],
): unknown[] {
  const selectedSet = new Set(selected);
  return sortedCanonical(tools.filter((tool) => selectedSet.has(tool.name)));
}

export interface SandboxEvidenceFingerprintInput {
  domain: string;
  specs: readonly GeneratedAgentSpec[];
  ontology: DomainOntology | null;
  /** The user-reviewed cases actually supplied to the sandbox. */
  testCases?: readonly TestCase[];
  /** User-approved substitutions applied to the test payloads. */
  testDataOverrides?: Readonly<Record<string, unknown>>;
  /** Boundary classifications affect whether an emitted event closes the tested chain. */
  boundaryEvents?: readonly BoundaryEvent[];
  /** Explicit human acknowledgement of the exact data-dependent cells omitted
   * from the approved suite. Any change invalidates green evidence. */
  testCoverageWaiver?: { cells: readonly string[]; note?: string; confirmedAt: number };
  realTools?: readonly RealTool[];
  declarativeTools?: readonly DeclarativeTool[];
  integrationCapabilities?: readonly IntegrationCapabilityProvider[];
  env?: Record<string, string | undefined>;
}

/** One canonical identity for both sandbox_run and finish. It binds green evidence to every
 * execution-bearing input available to the factory: full specs/source, approved fixtures and
 * overrides, ontology content, boundary verdicts, plus selected tool bindings/configuration.
 * Any drift produces a new value and therefore fails closed. */
export function sandboxEvidenceFingerprint(input: SandboxEvidenceFingerprintInput): string {
  const selected = selectedToolNames(input.specs);
  const body = {
    version: EVIDENCE_VERSION,
    domain: input.domain,
    specs: specsFingerprint(input.specs),
    ontology: ontologyContentHash(input.ontology),
    tests: input.testCases ?? [],
    overrides: input.testDataOverrides ?? {},
    boundaries: input.boundaryEvents ?? [],
    coverageWaiver: input.testCoverageWaiver ?? null,
    tools: {
      selected,
      bindings: toolBindings(input.specs),
      registryConfig: normalizedRealToolEvidence(selected, input.realTools ?? [], input.specs, input.env ?? process.env),
      declarativeConfig: normalizedDeclarativeToolEvidence(selected, input.declarativeTools ?? []),
    },
    runtimeCapabilities: normalizedRuntimeCapabilityEvidence(input.specs, input.integrationCapabilities ?? []),
  };
  return `sandbox-evidence:v${EVIDENCE_VERSION}:${digest(body)}`;
}
