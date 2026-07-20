/**
 * Runtime-authored CodeAct execution receipt.
 *
 * This object is created only from `runGeneratedCodeIsolated()` results. A
 * manifest's `codeExecuted` declaration is an execution request, never a
 * receipt, and must not be projected into these fields by itself.
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

export interface CodeActExecutionReceipt {
  source: "runtime_codeact";
  /** The isolate was actually started with the exact handler bytes. */
  codeExecuted: boolean;
  /** The isolated handler completed successfully. */
  codeRan: boolean;
  /** Actual isolate used; null when policy rejected execution before start. */
  isolation: CodeActIsolation | null;
  /** SHA-256 computed by the runtime from the exact bytes it evaluated. */
  codeSha256: string | null;
  /** Result of the runtime attestation gate, not a manifest declaration. */
  attestation: CodeActAttestationStatus;
  durationMs: number;
  failure: string | null;
}

const SHA256 = /^[a-f0-9]{64}$/;
const ATTESTATIONS = new Set<string>(CODEACT_ATTESTATION_STATUSES);

export function makeCodeActExecutionReceipt(
  input: Omit<CodeActExecutionReceipt, "source">,
): CodeActExecutionReceipt {
  if (
    (input.attestation === "production_verified" ||
      input.attestation === "sandbox_verified") &&
    input.isolation !== "isolated_subprocess" &&
    input.isolation !== "isolated_container"
  ) {
    throw new Error(
      `${input.attestation} CodeAct receipts require an actual isolated subprocess/container executor`,
    );
  }
  return { source: "runtime_codeact", ...input };
}

/** Strictly recover the trusted runtime receipt from a StepOutput meta bag. */
export function codeActExecutionReceiptFromMeta(
  meta: unknown,
): CodeActExecutionReceipt | null {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
  const value = (meta as { codeExecutionReceipt?: unknown })
    .codeExecutionReceipt;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.source !== "runtime_codeact") return null;
  if (typeof row.codeExecuted !== "boolean" || typeof row.codeRan !== "boolean")
    return null;
  if (
    row.isolation !== null &&
    row.isolation !== "worker_thread" &&
    row.isolation !== "isolated_subprocess" &&
    row.isolation !== "isolated_container"
  ) return null;
  if (
    row.codeSha256 !== null &&
    (typeof row.codeSha256 !== "string" || !SHA256.test(row.codeSha256))
  )
    return null;
  if (typeof row.attestation !== "string" || !ATTESTATIONS.has(row.attestation))
    return null;
  if (
    typeof row.durationMs !== "number" ||
    !Number.isFinite(row.durationMs) ||
    row.durationMs < 0
  )
    return null;
  if (row.failure !== null && typeof row.failure !== "string") return null;
  // A handler cannot complete unless its worker started, and a started worker
  // must name the actual isolation tier and exact code digest.
  if (row.codeRan && !row.codeExecuted) return null;
  if (row.codeRan !== (row.failure === null)) return null;
  if (
    row.codeExecuted &&
    (row.isolation === null || typeof row.codeSha256 !== "string")
  )
    return null;
  if (!row.codeExecuted && row.isolation !== null) return null;
  if (
    (row.attestation === "production_verified" ||
      row.attestation === "sandbox_verified") &&
    row.isolation !== "isolated_subprocess" &&
    row.isolation !== "isolated_container"
  ) return null;
  return row as unknown as CodeActExecutionReceipt;
}
