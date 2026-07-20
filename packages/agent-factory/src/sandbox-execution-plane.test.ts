import { describe, expect, it } from "vitest";

import {
  SANDBOX_EXECUTION_RECEIPT_SCHEMA,
  sandboxInfrastructureCleanupEvidenceHash,
  sandboxExecutionReceiptHash,
  sandboxExecutionReceiptIssues,
  type SandboxExecutionPlaneReceipt,
} from "./sandbox-execution-plane";

function receipt(): SandboxExecutionPlaneReceipt {
  const cleanupBody = {
    schema: "agent-factory-sandbox-infrastructure-cleanup/v1" as const,
    candidateExecutionAbsent: true as const,
    workspaceAbsent: true as const,
    candidateSecretsIssued: false as const,
    isolation: "isolated_container" as const,
    executionOwners: { declarativeFunctions: 0, codeactFunctions: 1 },
    candidateExecutions: [{
      schema: "agentic-codeact-container-execution/v1" as const,
      attemptId: "attempt-1",
      containerIdHash: `sha256:${"1".repeat(64)}`,
      codeSha256: "2".repeat(64),
      candidateImageDigest: `test/codeact-candidate@sha256:${"3".repeat(64)}`,
      imageId: `sha256:${"4".repeat(64)}`,
      policyHash: `sha256:${"5".repeat(64)}`,
      isolation: "isolated_container" as const,
      startedAt: new Date(1_000).toISOString(),
      completedAt: new Date(2_000).toISOString(),
      removedAt: new Date(3_000).toISOString(),
      exitCode: 0,
      oomKilled: false,
      rpcCount: 1,
      removed: true as const,
      absenceVerified: true as const,
    }],
    verifiedAt: new Date(3_000).toISOString(),
  };
  const unsigned: Omit<SandboxExecutionPlaneReceipt, "attestationHash" | "signature"> = {
    schema: SANDBOX_EXECUTION_RECEIPT_SCHEMA,
    executionOrigin: "remote",
    isolationTier: "remote_container",
    candidateFingerprint: "candidate-1",
    targetDomainId: "agents-generation",
    targetTenantId: "tenant-1",
    targetTenantSlug: "agents-generation",
    sandboxAttemptId: "attempt-1",
    bundleHash: "bundle-1",
    resultHash: "result-1",
    runnerId: "runner-1",
    runnerBuildId: "build-1",
    runtimeImageDigest: `sha256:${"a".repeat(64)}`,
    brokerOriginHash: "sha256:broker",
    serveOriginHash: "sha256:serve",
    policyHash: "sha256:policy",
    networkPolicy: "deny_public_egress",
    externalLiveCalls: 0,
    modelUsageHash: `sandbox-model-usage:v1:${"e".repeat(64)}`,
    startedAt: new Date(1_000).toISOString(),
    completedAt: new Date(2_000).toISOString(),
    infrastructureCleanup: {
      ...cleanupBody,
      evidenceHash: sandboxInfrastructureCleanupEvidenceHash(cleanupBody),
    },
    signatureAlgorithm: "hmac-sha256",
  };
  return {
    ...unsigned,
    attestationHash: sandboxExecutionReceiptHash(unsigned),
    signature: "server-verified-signature",
  };
}

describe("sandbox execution-plane promotion receipt", () => {
  it("accepts only the exact remote candidate/domain/tenant/attempt tuple", () => {
    const value = receipt();
    expect(sandboxExecutionReceiptIssues(value, {
      candidateFingerprint: "candidate-1",
      targetDomainId: "agents-generation",
      targetTenantId: "tenant-1",
      targetTenantSlug: "agents-generation",
      sandboxAttemptId: "attempt-1",
      bundleHash: "bundle-1",
      resultHash: "result-1",
    })).toEqual([]);
  });

  it("rejects a downgraded or tampered receipt instead of accepting a green badge", () => {
    const value = receipt();
    const tampered = {
      ...value,
      isolationTier: "worker",
      policyHash: "sha256:changed-policy",
    } as unknown as SandboxExecutionPlaneReceipt;
    expect(sandboxExecutionReceiptIssues(tampered, {
      candidateFingerprint: "another-candidate",
    })).toEqual(expect.arrayContaining([
      "sandbox isolation tier is not promotable",
      "sandbox execution attestation hash mismatch",
      "sandbox execution candidateFingerprint mismatch",
    ]));
  });

  it("records same-host container evidence but never treats it as promotable isolation", () => {
    const value = {
      ...receipt(),
      isolationTier: "same_host_container" as const,
      attestationHash: "",
    };
    value.attestationHash = sandboxExecutionReceiptHash(value);
    expect(sandboxExecutionReceiptIssues(value)).toContain(
      "sandbox isolation tier is not promotable",
    );
  });

  it("rejects a correctly hashed remote_container receipt backed only by worker/vm evidence", () => {
    const value = receipt();
    const cleanupBody = {
      ...value.infrastructureCleanup,
      candidateSecretsIssued: false,
      isolation: "worker_thread_untrusted" as const,
      evidenceHash: "",
    };
    cleanupBody.evidenceHash = sandboxInfrastructureCleanupEvidenceHash(cleanupBody);
    const forged = {
      ...value,
      infrastructureCleanup: cleanupBody,
      attestationHash: "",
    };
    forged.attestationHash = sandboxExecutionReceiptHash(forged);

    expect(sandboxExecutionReceiptIssues(forged)).toContain(
      "sandbox infrastructure cleanup is incomplete",
    );
  });

  it("rejects a tag, short digest or self-described image label as supply-chain identity", () => {
    const value = receipt();
    const malformed = {
      ...value,
      runtimeImageDigest: "agentic-sandbox-workload:latest",
    };
    malformed.attestationHash = sandboxExecutionReceiptHash(malformed);
    expect(sandboxExecutionReceiptIssues(malformed)).toContain(
      "runtime image digest is not a canonical OCI sha256 digest",
    );
  });
});
