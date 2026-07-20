import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { factoryToolProbes, getDb } from "@agentic/db";

export interface GlobalToolProbeReceipt {
  toolName: string;
  status: "verified" | "failed" | "required";
  definitionHash: string;
  schemaHash?: string;
  evidence?: Record<string, unknown>;
  verifiedAt?: string;
}

export interface GlobalToolProbeSummary {
  status: "verified" | "failed" | "required";
  /** Every definition/config hash that still has a verified receipt. */
  verifiedDefinitionHashes: string[];
  /** Only API-attested live probes are production evidence. Signed fixtures
   * and runtime recordings remain useful for sandbox simulation/replay. */
  productionVerifiedDefinitionHashes: string[];
  evidenceMode?: "live-probe" | "signed-fixture" | "runtime-record";
  productionVerified: boolean;
  writeProbeComplete: boolean;
  /** Most recent receipt, retained for backwards-compatible catalog display. */
  definitionHash?: string;
  schemaHash?: string;
  evidence?: Record<string, unknown>;
  verifiedAt?: string;
}

export function toolProbeReceiptEvidenceMode(
  receipt: Pick<GlobalToolProbeReceipt, "evidence">,
): GlobalToolProbeSummary["evidenceMode"] | undefined {
  const mode = receipt.evidence?.evidenceMode;
  return mode === "live-probe" || mode === "signed-fixture" || mode === "runtime-record"
    ? mode
    : undefined;
}

/** Minimum persisted metadata for sandbox replay readiness. This is still a
 * fast index check only; snapshot loading re-verifies the cassette HMAC and
 * exact tenant/domain/tool/config binding before any replay is admitted. */
export function isSandboxReplayToolProbeReceipt(
  receipt: GlobalToolProbeReceipt,
  now = Date.now(),
): boolean {
  return receipt.status === "verified"
    && Boolean(receipt.verifiedAt)
    && toolProbeReceiptEvidenceMode(receipt) !== undefined
    && typeof receipt.evidence?.attestationKeyId === "string"
    && receipt.evidence.attestationKeyId.trim().length > 0
    && typeof receipt.evidence?.attestationExpiresAt === "string"
    && Date.parse(receipt.evidence.attestationExpiresAt) > now;
}

/** A production hash is deliberately stricter than a generic verified
 * receipt: it must be an API-attested live probe whose attestation has not
 * expired. The cassette/HMAC is verified again when the artifact is loaded. */
export function isProductionLiveToolProbeReceipt(
  receipt: GlobalToolProbeReceipt,
  now = Date.now(),
): boolean {
  return isSandboxReplayToolProbeReceipt(receipt, now)
    && toolProbeReceiptEvidenceMode(receipt) === "live-probe";
}

/** Exact receipt selection shared by declarative, tenant-native and global
 * tools. Callers must supply the already recomputed definition+config hash;
 * there is intentionally no fallback to the latest receipt for the name. */
export function findVerifiedToolProbeReceipt(
  receipts: readonly GlobalToolProbeReceipt[],
  input: {
    toolName: string;
    definitionHash: string;
    productionOnly?: boolean;
    now?: number;
  },
): GlobalToolProbeReceipt | undefined {
  return receipts
    .filter((receipt) =>
      receipt.toolName === input.toolName
      && receipt.definitionHash === input.definitionHash
      && isSandboxReplayToolProbeReceipt(receipt, input.now)
      && (!input.productionOnly || isProductionLiveToolProbeReceipt(receipt, input.now)))
    .sort((left, right) =>
      (right.verifiedAt ?? "").localeCompare(left.verifiedAt ?? ""))[0];
}

/** Collapse per-definition receipts into the registry view without discarding
 * older, still-valid configurations. The representative receipt is only for
 * display; binding must use verifiedDefinitionHashes. */
export function summarizeGlobalToolProbeReceipts(
  receipts: readonly GlobalToolProbeReceipt[],
): GlobalToolProbeSummary | undefined {
  if (receipts.length === 0) return undefined;
  const verified = receipts
    .filter((receipt) => isSandboxReplayToolProbeReceipt(receipt))
    .sort((left, right) =>
      (right.verifiedAt ?? "").localeCompare(left.verifiedAt ?? "")
      || left.definitionHash.localeCompare(right.definitionHash));
  const representative = verified[0] ?? [...receipts].sort((left, right) =>
    (right.verifiedAt ?? "").localeCompare(left.verifiedAt ?? "")
    || left.definitionHash.localeCompare(right.definitionHash))[0]!;
  const evidenceMode = toolProbeReceiptEvidenceMode(representative);
  const productionVerifiedReceipts = verified.filter((receipt) =>
    isProductionLiveToolProbeReceipt(receipt));
  const proof = representative.evidence?.writeProbeProof as {
    create?: { completed?: unknown };
    cleanup?: { completed?: unknown };
    absence?: { verified?: unknown };
    idempotencyKeyHash?: unknown;
  } | undefined;
  return {
    status: verified.length > 0
      ? "verified"
      : receipts.some((receipt) => receipt.status === "failed")
        ? "failed"
        : "required",
    verifiedDefinitionHashes: [...new Set(verified.map((receipt) => receipt.definitionHash))].sort(),
    productionVerifiedDefinitionHashes: [...new Set(productionVerifiedReceipts.map((receipt) => receipt.definitionHash))].sort(),
    ...(evidenceMode ? { evidenceMode } : {}),
    productionVerified: productionVerifiedReceipts.some((receipt) => receipt === representative),
    writeProbeComplete: Boolean(
      proof?.create?.completed === true
      && proof.cleanup?.completed === true
      && proof.absence?.verified === true
      && typeof proof.idempotencyKeyHash === "string"
      && /^[a-f0-9]{64}$/i.test(proof.idempotencyKeyHash),
    ),
    definitionHash: representative.definitionHash,
    schemaHash: representative.schemaHash,
    evidence: representative.evidence,
    verifiedAt: representative.verifiedAt,
  };
}

export function summarizeGlobalToolProbeReceiptsByTool(
  receipts: readonly GlobalToolProbeReceipt[],
): Map<string, GlobalToolProbeSummary> {
  const grouped = new Map<string, GlobalToolProbeReceipt[]>();
  for (const receipt of receipts) {
    const current = grouped.get(receipt.toolName) ?? [];
    current.push(receipt);
    grouped.set(receipt.toolName, current);
  }
  return new Map([...grouped].flatMap(([toolName, rows]) => {
    const summary = summarizeGlobalToolProbeReceipts(rows);
    return summary ? [[toolName, summary] as const] : [];
  }));
}

export function listGlobalToolProbeReceipts(tenantId: string, domainId?: string | null): GlobalToolProbeReceipt[] {
  return getDb()
    .select()
    .from(factoryToolProbes)
    .where(and(eq(factoryToolProbes.tenantId, tenantId), eq(factoryToolProbes.domainKey, domainId ?? "")))
    .all()
    .map((row) => ({
      toolName: row.toolName,
      status: row.status === "verified" || row.status === "failed" ? row.status : "required",
      definitionHash: row.definitionHash,
      schemaHash: row.schemaHash ?? undefined,
      evidence: (row.evidence as Record<string, unknown>) ?? undefined,
      verifiedAt: row.verifiedAt?.toISOString(),
    }));
}

export function saveGlobalToolProbeReceipt(
  tenantId: string,
  domainId: string | null | undefined,
  receipt: GlobalToolProbeReceipt,
): void {
  const now = new Date();
  const db = getDb();
  const exactScope = and(
    eq(factoryToolProbes.tenantId, tenantId),
    eq(factoryToolProbes.domainKey, domainId ?? ""),
    eq(factoryToolProbes.toolName, receipt.toolName),
    eq(factoryToolProbes.definitionHash, receipt.definitionHash),
  );
  const existing = db.select().from(factoryToolProbes).where(exactScope).get();
  // A sandbox-only fixture/recording must never downgrade a still-valid live
  // receipt for the same exact definition+config hash. The live cassette can
  // already be replayed in sandbox, while retaining it preserves production
  // eligibility. A failed or newer live probe may still invalidate/replace it.
  if (
    receipt.status === "verified"
    && toolProbeReceiptEvidenceMode(receipt) !== "live-probe"
    && existing
    && isProductionLiveToolProbeReceipt({
      toolName: existing.toolName,
      status: existing.status === "verified" || existing.status === "failed"
        ? existing.status
        : "required",
      definitionHash: existing.definitionHash,
      schemaHash: existing.schemaHash ?? undefined,
      evidence: (existing.evidence as Record<string, unknown>) ?? undefined,
      verifiedAt: existing.verifiedAt?.toISOString(),
    }, now.getTime())
  ) return;

  db
    .insert(factoryToolProbes)
    .values({
      id: `tpr-${randomUUID()}`,
      tenantId,
      domainKey: domainId ?? "",
      toolName: receipt.toolName,
      status: receipt.status,
      definitionHash: receipt.definitionHash,
      schemaHash: receipt.schemaHash ?? null,
      evidence: receipt.evidence ?? null,
      verifiedAt: receipt.verifiedAt ? new Date(receipt.verifiedAt) : null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        factoryToolProbes.tenantId,
        factoryToolProbes.domainKey,
        factoryToolProbes.toolName,
        factoryToolProbes.definitionHash,
      ],
      set: {
        status: receipt.status,
        schemaHash: receipt.schemaHash ?? null,
        evidence: receipt.evidence ?? null,
        verifiedAt: receipt.verifiedAt ? new Date(receipt.verifiedAt) : null,
        updatedAt: now,
      },
    })
    .run();
}
