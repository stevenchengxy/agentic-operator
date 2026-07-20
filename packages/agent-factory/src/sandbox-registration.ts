import {
  SANDBOX_BROKER_REGISTRATION_SCHEMA,
  type SandboxBrokerRegistrationProof,
} from "./ports";

export interface SandboxRegistrationEvidence {
  appId?: string;
  committedManifestFunctionIds?: readonly string[];
  brokerRegistration?: SandboxBrokerRegistrationProof;
  /** Explicit compatibility switch for compact unit fixtures only. It is
   * ignored outside NODE_ENV=test and therefore cannot open a production gate. */
  testOnlyRegistrationBypass?: boolean;
}

function exactIds(actual: readonly string[], expected: readonly string[]): boolean {
  if (actual.length !== expected.length) return false;
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  return actualSet.size === actual.length
    && expectedSet.size === expected.length
    && actualSet.size === expectedSet.size
    && [...expectedSet].every((id) => actualSet.has(id));
}

/** Validate both halves of registration evidence. Production sandboxes use a
 * dedicated self-hosted broker, so only its independent GraphQL readback is
 * promotable. Cloud sync acceptance remains diagnostic until Inngest exposes
 * an independent exact registry read API. */
export function sandboxRegistrationEvidenceIssues(
  evidence: SandboxRegistrationEvidence | null | undefined,
  expectedFunctionIds: readonly string[],
): string[] {
  if (
    process.env.NODE_ENV === "test"
    && evidence?.testOnlyRegistrationBypass === true
  ) {
    return [];
  }

  const expected = [...expectedFunctionIds];
  const issues: string[] = [];
  if (expected.length === 0 || new Set(expected).size !== expected.length) {
    issues.push("expected function ID set is empty or contains duplicates");
  }

  const committed = evidence?.committedManifestFunctionIds;
  if (!committed) {
    issues.push("missing committed manifest function IDs");
  } else if (!exactIds(committed, expected)) {
    issues.push("committed manifest function IDs do not exactly match the candidate fleet");
  }

  const proof = evidence?.brokerRegistration;
  if (!proof) {
    issues.push("missing independent Inngest broker registration proof");
    return issues;
  }
  if (proof.schema !== SANDBOX_BROKER_REGISTRATION_SCHEMA) {
    issues.push("broker registration proof schema is invalid");
  }
  if (evidence?.appId && proof.appId !== evidence.appId) {
    issues.push("broker registration proof app identity does not match the sandbox App");
  }
  if (proof.expectedFunctionCount !== expected.length) {
    issues.push(`broker proof expected ${proof.expectedFunctionCount}, candidate requires ${expected.length}`);
  }
  if (proof.observedFunctionCount !== expected.length) {
    issues.push(`broker observed ${proof.observedFunctionCount ?? "unknown"}/${expected.length} functions`);
  }
  if (proof.connected !== true || proof.verified !== true) {
    issues.push("broker did not verify the App as connected with the exact function count");
  }
  if (proof.evidence === "test_only_bypass") {
    if (process.env.NODE_ENV !== "test") {
      issues.push("test-only registration evidence is forbidden outside tests");
    }
  } else if (proof.evidence !== "dev_graphql") {
    issues.push("registration evidence is not an independent broker registry readback");
  }
  return issues;
}
