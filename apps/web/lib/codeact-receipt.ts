/**
 * Presentation guard for persisted CodeAct runtime receipts.
 *
 * The deployed manifest also contains a `codeExecuted` request flag. That
 * declaration is not evidence, so the UI renders CodeAct state only when the
 * complete, internally-consistent runtime receipt is present.
 */

export const CODEACT_ATTESTATION_STATUSES = [
  "production_verified",
  "sandbox_verified",
  "sandbox_not_required",
  "not_authorized",
  "missing",
  "mismatch",
  "not_checked",
] as const;

export type CodeActAttestationStatus =
  (typeof CODEACT_ATTESTATION_STATUSES)[number];
export type CodeActIsolation =
  | "worker_thread"
  | "isolated_subprocess"
  | "isolated_container";
export type CodeActReceiptState = "ran" | "failed" | "blocked";

export interface CodeActReceiptLike {
  codeRan?: unknown;
  codeExecuted?: unknown;
  codeIsolation?: unknown;
  codeSha256?: unknown;
  codeAttestation?: unknown;
  codeExecutionFailure?: unknown;
}

export interface CodeActReceiptView {
  state: CodeActReceiptState;
  codeRan: boolean;
  codeExecuted: boolean;
  isolation: CodeActIsolation | null;
  sha256: string | null;
  attestation: CodeActAttestationStatus;
  failure: string | null;
}

const SHA256 = /^[a-f0-9]{64}$/;
const ATTESTATIONS = new Set<string>(CODEACT_ATTESTATION_STATUSES);
const PREFLIGHT_DENIALS = new Set<CodeActAttestationStatus>([
  "not_authorized",
  "missing",
  "mismatch",
  "not_checked",
]);

export function getCodeActReceiptView(
  value: CodeActReceiptLike,
): CodeActReceiptView | null {
  if (
    typeof value.codeRan !== "boolean" ||
    typeof value.codeExecuted !== "boolean" ||
    typeof value.codeAttestation !== "string" ||
    !ATTESTATIONS.has(value.codeAttestation)
  ) {
    return null;
  }

  const attestation = value.codeAttestation as CodeActAttestationStatus;
  const isolation =
    value.codeIsolation === null
      ? null
      : value.codeIsolation === "worker_thread" ||
          value.codeIsolation === "isolated_subprocess" ||
          value.codeIsolation === "isolated_container"
        ? (value.codeIsolation as CodeActIsolation)
        : undefined;
  const sha256 =
    value.codeSha256 === null
      ? null
      : typeof value.codeSha256 === "string" && SHA256.test(value.codeSha256)
        ? value.codeSha256
        : undefined;
  const failure =
    value.codeExecutionFailure === null
      ? null
      : typeof value.codeExecutionFailure === "string" &&
          value.codeExecutionFailure.length > 0
        ? value.codeExecutionFailure
        : undefined;

  if (
    isolation === undefined ||
    sha256 === undefined ||
    failure === undefined
  ) {
    return null;
  }
  if (value.codeRan && !value.codeExecuted) return null;
  if (value.codeRan && failure !== null) return null;
  if (!value.codeRan && failure === null) return null;
  if (
    value.codeExecuted &&
    (isolation !== "worker_thread" || sha256 === null)
  ) {
    return null;
  }
  if (!value.codeExecuted && isolation !== null) return null;
  if (PREFLIGHT_DENIALS.has(attestation) && value.codeExecuted) return null;

  return {
    state: value.codeRan ? "ran" : value.codeExecuted ? "failed" : "blocked",
    codeRan: value.codeRan,
    codeExecuted: value.codeExecuted,
    isolation,
    sha256,
    attestation,
    failure,
  };
}
