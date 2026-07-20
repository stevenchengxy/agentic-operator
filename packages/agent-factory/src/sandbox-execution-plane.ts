import { createHash } from "node:crypto";

import { canonicalEvidenceJson } from "./evidence-fingerprint";

export const SANDBOX_EXECUTION_RECEIPT_SCHEMA =
  "agent-factory-sandbox-execution/v2" as const;

export const SANDBOX_INFRASTRUCTURE_CLEANUP_SCHEMA =
  "agent-factory-sandbox-infrastructure-cleanup/v1" as const;

const OCI_SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/;

export interface SandboxInfrastructureCleanupEvidence {
  schema: typeof SANDBOX_INFRASTRUCTURE_CLEANUP_SCHEMA;
  /** The per-invocation generated-code workers have terminated. The trusted
   * workload service may remain up to serve future signed attempts. */
  candidateExecutionAbsent: true;
  /** Attempt manifest, tenant/tool snapshot and replay workspace were removed. */
  workspaceAbsent: true;
  /** False only when the OS isolation boundary also prevented ambient access
   * to runner-mounted credentials. An empty worker env is not such proof. */
  candidateSecretsIssued: boolean;
  /** Actual candidate boundary reported by the executor implementation. The
   * worker values are retained solely so old/non-promotable evidence parses;
   * validation below never accepts them for promotion. */
  isolation:
    | "worker_thread_env_empty"
    | "worker_thread_untrusted"
    | "isolated_subprocess"
    | "isolated_container";
  executionOwners: {
    declarativeFunctions: number;
    codeactFunctions: number;
  };
  /** One immutable record per one-shot candidate container. The control signer
   * validates these independently instead of trusting a workload tier label. */
  candidateExecutions: Array<{
    schema: "agentic-codeact-container-execution/v1";
    attemptId?: string;
    containerIdHash: string;
    codeSha256: string;
    candidateImageDigest: string;
    imageId: string;
    policyHash: string;
    isolation: "isolated_container";
    startedAt: string;
    completedAt: string;
    removedAt: string;
    exitCode: number;
    oomKilled: boolean;
    rpcCount: number;
    removed: true;
    absenceVerified: true;
  }>;
  verifiedAt: string;
  evidenceHash: string;
}

/**
 * Attestation produced by the execution plane that actually loaded the
 * generated functions.  The existing SandboxCleanupReceipt continues to prove
 * that the nonce Inngest App disappeared; this receipt proves that the code did
 * not run inside the Agent Factory control-plane process.
 *
 * `signature` is verified by the API adapter before this object enters the
 * Harness.  It is retained in immutable regression evidence so promotion can
 * verify it again instead of trusting a historical green badge.
 */
export interface SandboxExecutionPlaneReceipt {
  schema: typeof SANDBOX_EXECUTION_RECEIPT_SCHEMA;
  executionOrigin: "remote";
  /** `same_host_container` is valid diagnostic evidence but is deliberately
   * non-promotable: a launcher with the primary host Docker socket can affect
   * the final system even when each candidate container is hardened. */
  isolationTier: "same_host_container" | "remote_container" | "remote_vm";
  candidateFingerprint: string;
  targetDomainId: string;
  targetTenantId: string;
  targetTenantSlug: string;
  sandboxAttemptId: string;
  bundleHash: string;
  resultHash: string;
  runnerId: string;
  runnerBuildId: string;
  runtimeImageDigest: string;
  brokerOriginHash: string;
  serveOriginHash: string;
  policyHash: string;
  networkPolicy: "deny_public_egress";
  externalLiveCalls: 0;
  /** Hash of the secret-free semantic-model ledger embedded in resultHash.
   * externalLiveCalls is tool-only and must never be used as a model-call
   * proxy. */
  modelUsageHash: string;
  startedAt: string;
  completedAt: string;
  infrastructureCleanup: SandboxInfrastructureCleanupEvidence;
  attestationHash: string;
  signatureAlgorithm: "hmac-sha256";
  signature: string;
}

function digest(value: unknown): string {
  return createHash("sha256")
    .update(canonicalEvidenceJson(value), "utf8")
    .digest("hex");
}

export function sandboxExecutionReceiptHash(
  receipt:
    | SandboxExecutionPlaneReceipt
    | Omit<SandboxExecutionPlaneReceipt, "attestationHash" | "signature">,
): string {
  const {
    attestationHash: _attestationHash,
    signature: _signature,
    ...body
  } = receipt as SandboxExecutionPlaneReceipt;
  return `sandbox-execution:v1:${digest(body)}`;
}

export function sandboxInfrastructureCleanupEvidenceHash(
  evidence: Omit<SandboxInfrastructureCleanupEvidence, "evidenceHash">
    | SandboxInfrastructureCleanupEvidence,
): string {
  const { evidenceHash: _evidenceHash, ...body } = evidence as SandboxInfrastructureCleanupEvidence;
  return `sandbox-infrastructure-cleanup:v1:${digest(body)}`;
}

export function sandboxInfrastructureCleanupEvidenceIssues(
  evidence: SandboxInfrastructureCleanupEvidence | null | undefined,
  expectedAttemptId?: string,
): string[] {
  if (!evidence) return ["missing sandbox infrastructure cleanup evidence"];
  const issues: string[] = [];
  if (evidence.schema !== SANDBOX_INFRASTRUCTURE_CLEANUP_SCHEMA) issues.push("unsupported cleanup evidence schema");
  if (evidence.candidateExecutionAbsent !== true) issues.push("candidate execution is not absent");
  if (evidence.workspaceAbsent !== true) issues.push("candidate workspace is not absent");
  if (evidence.candidateSecretsIssued !== false) issues.push("candidate may have received ambient credentials");
  if (evidence.isolation !== "isolated_subprocess" && evidence.isolation !== "isolated_container") {
    issues.push("candidate isolation is not a real subprocess/container boundary");
  }
  if (
    !Number.isSafeInteger(evidence.executionOwners?.declarativeFunctions) ||
    evidence.executionOwners.declarativeFunctions < 0 ||
    !Number.isSafeInteger(evidence.executionOwners?.codeactFunctions) ||
    evidence.executionOwners.codeactFunctions < 0 ||
    evidence.executionOwners.declarativeFunctions + evidence.executionOwners.codeactFunctions < 1
  ) {
    issues.push("candidate execution-owner counts are invalid");
  }
  if (
    evidence.executionOwners?.codeactFunctions > 0 &&
    evidence.candidateExecutions.length < evidence.executionOwners.codeactFunctions
  ) {
    issues.push("candidate container execution evidence does not cover every CodeAct function");
  }
  if (
    evidence.executionOwners?.codeactFunctions === 0 &&
    evidence.candidateExecutions.length > 0
  ) {
    issues.push("candidate container evidence exists without a CodeAct execution owner");
  }
  for (const execution of evidence.candidateExecutions) {
    if (execution.schema !== "agentic-codeact-container-execution/v1") issues.push("unsupported candidate execution schema");
    if (expectedAttemptId && execution.attemptId !== expectedAttemptId) issues.push("candidate execution attempt mismatch");
    if (execution.isolation !== "isolated_container") issues.push("candidate execution did not use an isolated container");
    if (execution.removed !== true || execution.absenceVerified !== true) issues.push("candidate container removal was not verified");
    if (!/^sha256:[a-f0-9]{64}$/.test(execution.containerIdHash)) issues.push("candidate container identity hash is invalid");
    if (!/^[a-f0-9]{64}$/.test(execution.codeSha256)) issues.push("candidate code hash is invalid");
    if (!/^(?:[a-z0-9][a-z0-9._/-]*@)?sha256:[a-f0-9]{64}$/.test(execution.candidateImageDigest)) issues.push("candidate image is not digest pinned");
    if (!/^sha256:[a-f0-9]{64}$/.test(execution.imageId)) issues.push("candidate daemon image id is invalid");
    if (!/^sha256:[a-f0-9]{64}$/.test(execution.policyHash)) issues.push("candidate container policy hash is invalid");
    if (!Number.isInteger(execution.exitCode)) issues.push("candidate exit code is invalid");
    if (!Number.isSafeInteger(execution.rpcCount) || execution.rpcCount < 0) issues.push("candidate RPC count is invalid");
    if ([execution.startedAt, execution.completedAt, execution.removedAt].some((value) => !value || Number.isNaN(Date.parse(value)))) {
      issues.push("candidate execution timestamps are invalid");
    } else if (
      Date.parse(execution.completedAt) < Date.parse(execution.startedAt) ||
      Date.parse(execution.removedAt) < Date.parse(execution.completedAt)
    ) {
      issues.push("candidate execution timestamp order is invalid");
    }
  }
  if (evidence.evidenceHash !== sandboxInfrastructureCleanupEvidenceHash(evidence)) {
    issues.push("sandbox infrastructure cleanup hash mismatch");
  }
  return [...new Set(issues)];
}

export function sandboxExecutionReceiptIssues(
  receipt: SandboxExecutionPlaneReceipt | null | undefined,
  expected: {
    candidateFingerprint?: string;
    targetDomainId?: string;
    targetTenantId?: string;
    targetTenantSlug?: string;
    sandboxAttemptId?: string;
    bundleHash?: string;
    resultHash?: string;
    modelUsageHash?: string;
  } = {},
): string[] {
  if (!receipt) return ["missing external sandbox execution receipt"];
  const issues: string[] = [];
  if (receipt.schema !== SANDBOX_EXECUTION_RECEIPT_SCHEMA) {
    issues.push("unsupported sandbox execution receipt schema");
  }
  if (receipt.executionOrigin !== "remote") {
    issues.push("sandbox execution did not originate from the remote plane");
  }
  if (
    receipt.isolationTier !== "remote_container" &&
    receipt.isolationTier !== "remote_vm"
  ) {
    issues.push("sandbox isolation tier is not promotable");
  }
  for (const [label, value] of [
    ["candidate fingerprint", receipt.candidateFingerprint],
    ["target domain", receipt.targetDomainId],
    ["target tenant id", receipt.targetTenantId],
    ["target tenant slug", receipt.targetTenantSlug],
    ["sandbox attempt", receipt.sandboxAttemptId],
    ["bundle hash", receipt.bundleHash],
    ["result hash", receipt.resultHash],
    ["runner id", receipt.runnerId],
    ["runner build id", receipt.runnerBuildId],
    ["runtime image digest", receipt.runtimeImageDigest],
    ["broker origin hash", receipt.brokerOriginHash],
    ["serve origin hash", receipt.serveOriginHash],
    ["policy hash", receipt.policyHash],
    ["model usage hash", receipt.modelUsageHash],
  ] as const) {
    if (!value?.trim()) issues.push(`missing ${label}`);
  }
  if (!OCI_SHA256_DIGEST.test(receipt.runtimeImageDigest)) {
    issues.push("runtime image digest is not a canonical OCI sha256 digest");
  }
  if (receipt.networkPolicy !== "deny_public_egress") {
    issues.push("sandbox network policy permits public egress");
  }
  if (receipt.externalLiveCalls !== 0) {
    issues.push("sandbox execution receipt did not prove zero external live calls");
  }
  if (!/^sandbox-model-usage:v1:[a-f0-9]{64}$/.test(receipt.modelUsageHash ?? "")) {
    issues.push("sandbox execution model-usage hash is invalid");
  }
  for (const [label, value] of [
    ["startedAt", receipt.startedAt],
    ["completedAt", receipt.completedAt],
    ["cleanup verifiedAt", receipt.infrastructureCleanup?.verifiedAt],
  ] as const) {
    if (!value || Number.isNaN(Date.parse(value))) issues.push(`invalid ${label}`);
  }
  if (
    receipt.startedAt &&
    receipt.completedAt &&
    !Number.isNaN(Date.parse(receipt.startedAt)) &&
    !Number.isNaN(Date.parse(receipt.completedAt)) &&
    Date.parse(receipt.completedAt) < Date.parse(receipt.startedAt)
  ) {
    issues.push("sandbox execution completed before it started");
  }
  if (sandboxInfrastructureCleanupEvidenceIssues(
    receipt.infrastructureCleanup,
    receipt.sandboxAttemptId,
  ).length) {
    issues.push("sandbox infrastructure cleanup is incomplete");
  }
  if (receipt.signatureAlgorithm !== "hmac-sha256" || !receipt.signature?.trim()) {
    issues.push("sandbox execution signature is missing or unsupported");
  }
  if (receipt.attestationHash !== sandboxExecutionReceiptHash(receipt)) {
    issues.push("sandbox execution attestation hash mismatch");
  }
  const comparisons: Array<[keyof typeof expected, string, string]> = [
    ["candidateFingerprint", expected.candidateFingerprint ?? "", receipt.candidateFingerprint],
    ["targetDomainId", expected.targetDomainId ?? "", receipt.targetDomainId],
    ["targetTenantId", expected.targetTenantId ?? "", receipt.targetTenantId],
    ["targetTenantSlug", expected.targetTenantSlug ?? "", receipt.targetTenantSlug],
    ["sandboxAttemptId", expected.sandboxAttemptId ?? "", receipt.sandboxAttemptId],
    ["bundleHash", expected.bundleHash ?? "", receipt.bundleHash],
    ["resultHash", expected.resultHash ?? "", receipt.resultHash],
    ["modelUsageHash", expected.modelUsageHash ?? "", receipt.modelUsageHash],
  ];
  for (const [key, wanted, actual] of comparisons) {
    if (wanted && wanted !== actual) issues.push(`sandbox execution ${String(key)} mismatch`);
  }
  return issues;
}
