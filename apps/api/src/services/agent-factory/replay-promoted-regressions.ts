import { promises as fs } from "node:fs";
import path from "node:path";

import { canonicalEvidenceJson } from "@agentic/agent-factory";

import { FsAgentDraftStore } from "./agent-draft-store";
import { createFactoryPromotionFixtureMaterializer } from "./promotion-regression-fixture-capsule";
import {
  readFactoryPromotionRegressionLedger,
  type FactoryPromotionRegressionRecord,
} from "./promotion-regression-ledger";
import type { FactoryProductionRegressionInventory } from "./production-regression-inventory";
import type { PersistedRegressionArtifact } from "./regression-artifact";
import { redactRegressionDiagnostic } from "./regression-diagnostic-redaction";

export interface PromotedRegressionReplayEntry {
  promotionId: string;
  tenantId: string;
  domain: string;
  versionId: string;
  slugs: string[];
  pass: boolean;
  cases: number;
  errors: string[];
}

export interface PromotedRegressionReplayReport {
  schema: "agent-factory-promoted-regression-report/v1";
  pass: boolean;
  dataRoot: string;
  promotedCount: number;
  replayedCount: number;
  pendingCount: number;
  entries: PromotedRegressionReplayEntry[];
  errors: string[];
}

async function containedArtifact(
  dataRoot: string,
  record: FactoryPromotionRegressionRecord,
): Promise<string> {
  const root = await fs.realpath(path.resolve(dataRoot));
  const candidate = path.resolve(root, ...record.artifact.split("/"));
  const real = await fs.realpath(candidate);
  if (real === root || !real.startsWith(`${root}${path.sep}`)) {
    throw new Error("record artifact escapes the supplied replay bundle");
  }
  return real;
}

function ledgerProjection(records: FactoryPromotionRegressionRecord[]) {
  return records
    .map((record) => ({
      promotionId: record.promotionId,
      tenantId: record.tenantId,
      tenantSlug: record.tenantSlug,
      domain: record.domain,
      slugs: [...record.slugs].sort(),
      versionId: record.versionId,
      suiteFingerprint: record.suiteFingerprint,
      deploymentId: record.deploymentId,
      recordHash: record.recordHash,
    }))
    .sort((a, b) => a.promotionId.localeCompare(b.promotionId));
}

/** Replay every committed promotion from a signed, inventory-reconciled export. */
export async function replayAllPromotedRegressions(
  dataRoot: string,
  options: { inventory: FactoryProductionRegressionInventory },
): Promise<PromotedRegressionReplayReport> {
  const resolvedRoot = path.resolve(dataRoot);
  const report: PromotedRegressionReplayReport = {
    schema: "agent-factory-promoted-regression-report/v1",
    pass: false,
    dataRoot: "[verified-bundle-root]",
    promotedCount: 0,
    replayedCount: 0,
    pendingCount: 0,
    entries: [],
    errors: [],
  };
  try {
    const rootStat = await fs.stat(resolvedRoot);
    if (!rootStat.isDirectory())
      throw new Error("replay bundle data root is not a directory");
  } catch (error) {
    report.errors.push(redactRegressionDiagnostic(error));
    return report;
  }

  const ledger = await readFactoryPromotionRegressionLedger(resolvedRoot);
  report.pendingCount = ledger.pending.length;
  report.promotedCount = ledger.committed.length;
  for (const pending of ledger.pending) {
    report.errors.push(
      redactRegressionDiagnostic(
        pending.error
          ? `invalid pending promotion ledger record: ${pending.error}`
          : "incomplete production promotion remains pending",
      ),
    );
  }
  for (const committed of ledger.committed) {
    if (committed.error || !committed.record) {
      report.errors.push(
        redactRegressionDiagnostic(
          `invalid committed promotion ledger record: ${committed.error ?? "missing record"}`,
        ),
      );
    }
  }
  if (!ledger.committed.length) {
    report.errors.push(
      redactRegressionDiagnostic(
        "no committed Agent Factory promotion records were supplied",
      ),
    );
  }
  const records = ledger.committed.flatMap((entry) =>
    entry.record ? [entry.record] : [],
  );
  if (ledger.highWatermarkError || !ledger.highWatermark) {
    report.errors.push(
      redactRegressionDiagnostic(
        "promotion ledger high-watermark is missing or invalid",
      ),
    );
  } else if (
    options.inventory.schema !==
      "agent-factory-production-regression-inventory/v1" ||
    canonicalEvidenceJson(options.inventory.highWatermark) !==
      canonicalEvidenceJson({
        committedCount: ledger.highWatermark.committedCount,
        ledgerDigest: ledger.highWatermark.ledgerDigest,
        stateHash: ledger.highWatermark.stateHash,
      }) ||
    canonicalEvidenceJson(options.inventory.promotions) !==
      canonicalEvidenceJson(ledgerProjection(records))
  ) {
    report.errors.push(
      redactRegressionDiagnostic(
        "signed production inventory does not exactly cover the committed promotion ledger",
      ),
    );
  }

  // Do not execute generated code from a bundle whose inventory/ledger gate
  // did not close. Verification errors are not merely a red report footer.
  if (report.errors.length > 0) return report;

  const previousDataRoot = process.env.AGENTIC_DATA_ROOT;
  process.env.AGENTIC_DATA_ROOT = resolvedRoot;
  try {
    for (const record of records) {
      const errors: string[] = [];
      let cases = 0;
      try {
        const expectedArtifact = await containedArtifact(resolvedRoot, record);
        const artifact = JSON.parse(
          await fs.readFile(expectedArtifact, "utf8"),
        ) as PersistedRegressionArtifact;
        const materializeTestPayload =
          await createFactoryPromotionFixtureMaterializer({
            dataRoot: resolvedRoot,
            record,
            artifact,
          });
        const store = new FsAgentDraftStore({
          tenantId: record.tenantId,
          tenantSlug: record.tenantSlug,
          ontologyDomainId: record.domain,
        });
        const replay = await store.replayRegression(
          record.domain,
          record.slugs,
          record.versionId,
          {
            materializeTestPayload,
            // The CLI reaches this function only after the independent export
            // HMAC, source identity, nonce, inventory and every file hash have
            // been verified. The exporter already checked the cassette HMAC
            // before signing; do not copy that production key into CI.
            cassetteTrust: "verified-regression-export",
          },
        );
        cases = replay.results.length;
        errors.push(...replay.errors.map(redactRegressionDiagnostic));
        errors.push(
          ...replay.results
            .filter((result) => !result.pass || !result.ran)
            .flatMap((result) =>
              result.reasons.map(redactRegressionDiagnostic),
            ),
        );
        if (!replay.pass)
          errors.push(
            redactRegressionDiagnostic(
              "exact persisted regression replay did not pass",
            ),
          );
        if (replay.promotionEvidenceReady !== true) {
          errors.push(
            redactRegressionDiagnostic(
              `promoted regression no longer has qualified immutable replay evidence: ${(replay.promotionEvidenceErrors ?? []).slice(0, 4).join("; ") || "blocked"}`,
            ),
          );
        }
        if (replay.sandboxExternalLiveCalls !== 0)
          errors.push(
            redactRegressionDiagnostic(
              "replay evidence does not prove externalLiveCalls=0",
            ),
          );
        if (replay.sandboxReplayEvidenceComplete !== true)
          errors.push(
            redactRegressionDiagnostic(
              "replay dispatch evidence is incomplete",
            ),
          );
        if (replay.versionId !== record.versionId)
          errors.push(
            redactRegressionDiagnostic(
              "replayed version does not match promotion record",
            ),
          );
        if (replay.evidenceFingerprint !== record.evidenceFingerprint)
          errors.push(
            redactRegressionDiagnostic(
              "replayed evidence fingerprint does not match promotion record",
            ),
          );
        if (replay.suiteFingerprint !== record.suiteFingerprint)
          errors.push(
            redactRegressionDiagnostic(
              "replayed suite fingerprint does not match promotion record",
            ),
          );
        if (
          replay.sandboxCleanupReceiptHash !== record.sandboxCleanupReceiptHash
        )
          errors.push(
            redactRegressionDiagnostic(
              "replayed cleanup receipt does not match promotion record",
            ),
          );
        const replayedArtifact = await fs.realpath(
          path.resolve(replay.artifact),
        );
        if (replayedArtifact !== expectedArtifact)
          errors.push(
            redactRegressionDiagnostic(
              "replayed artifact path does not match promotion record",
            ),
          );
        for (const slug of record.slugs) {
          if (
            !replay.results.some(
              (result) => result.slug === slug && result.pass && result.ran,
            )
          ) {
            errors.push(
              redactRegressionDiagnostic(
                "promoted agent has no passing executed regression case",
              ),
            );
          }
        }
      } catch (error) {
        errors.push(redactRegressionDiagnostic(error));
      }
      report.entries.push({
        promotionId: record.promotionId,
        tenantId: record.tenantId,
        domain: record.domain,
        versionId: record.versionId,
        slugs: record.slugs,
        pass: errors.length === 0,
        cases,
        errors,
      });
      report.replayedCount += 1;
    }
  } finally {
    if (previousDataRoot === undefined) delete process.env.AGENTIC_DATA_ROOT;
    else process.env.AGENTIC_DATA_ROOT = previousDataRoot;
  }
  report.pass =
    report.errors.length === 0 &&
    report.promotedCount > 0 &&
    report.replayedCount === report.promotedCount &&
    report.entries.every((entry) => entry.pass);
  return report;
}
