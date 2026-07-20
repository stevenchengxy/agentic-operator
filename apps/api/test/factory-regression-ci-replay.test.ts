import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  SANDBOX_CLEANUP_RECEIPT_SCHEMA,
  SANDBOX_RUN_DRAIN_RECEIPT_SCHEMA,
  sandboxCleanupReceiptHash,
  sandboxDesignReviewSubjectDigest,
  sandboxRunDrainReceiptHash,
  type AgentDraftRegressionEvidence,
  type GeneratedAgentSpec,
  type SandboxCleanupReceipt,
} from "@agentic/agent-factory";

import { makePromotableSandboxExecutionEvidence } from "./factory-sandbox-execution-fixture";
import { makePromotableSandboxRegistrationEvidence } from "./factory-sandbox-registration-fixture";

import { FsAgentDraftStore } from "../src/services/agent-factory/agent-draft-store";
import {
  FACTORY_REGRESSION_INVENTORY_FILE,
  exportFactoryRegressionBundle,
  verifyFactoryRegressionExportBundle,
} from "../src/services/agent-factory/factory-regression-export-bundle";
import {
  factoryPromotionDeploymentNote,
  readFactoryPromotionRegressionLedger,
  stageFactoryPromotionRegression,
} from "../src/services/agent-factory/promotion-regression-ledger";
import { reconcilePendingFactoryPromotions } from "../src/services/agent-factory/promotion-recovery";
import type { FactoryProductionRegressionInventory } from "../src/services/agent-factory/production-regression-inventory";
import {
  redactRegressionDiagnostic,
  redactRegressionReplayResult,
} from "../src/services/agent-factory/regression-diagnostic-redaction";
import { replayAllPromotedRegressions } from "../src/services/agent-factory/replay-promoted-regressions";

const tenantId = "ten-ci-regression";
const tenantSlug = "ci-regression-tenant";
const domain = "ci-regression-domain";

const unavailableInventory: FactoryProductionRegressionInventory = {
  schema: "agent-factory-production-regression-inventory/v1",
  generatedAt: new Date(0).toISOString(),
  highWatermark: {
    committedCount: 0,
    ledgerDigest: "unavailable",
    stateHash: "unavailable",
  },
  liveAgents: [],
  promotions: [],
};

function expectRedacted(values: string[], forbidden: string[] = []): void {
  expect(values.length).toBeGreaterThan(0);
  for (const value of values) {
    expect(value).toMatch(/^regression_[a-z]+ \[ref:[a-f0-9]{12}\]$/);
    for (const secret of forbidden) expect(value).not.toContain(secret);
  }
}

async function committedInventory(): Promise<FactoryProductionRegressionInventory> {
  const ledger = await readFactoryPromotionRegressionLedger(root);
  const records = ledger.committed.map((entry) => entry.record!);
  expect(ledger.highWatermark).toBeTruthy();
  return {
    schema: "agent-factory-production-regression-inventory/v1",
    generatedAt: new Date().toISOString(),
    highWatermark: {
      committedCount: ledger.highWatermark!.committedCount,
      ledgerDigest: ledger.highWatermark!.ledgerDigest,
      stateHash: ledger.highWatermark!.stateHash,
    },
    liveAgents: records.flatMap((record) =>
      record.slugs.map((slug) => ({
        tenantId: record.tenantId,
        tenantSlug: record.tenantSlug,
        domain: record.domain,
        slug,
        versionId: record.versionId,
        suiteFingerprint: record.suiteFingerprint,
        deploymentId: record.deploymentId!,
      })),
    ),
    promotions: records
      .map((record) => ({
        promotionId: record.promotionId,
        tenantId: record.tenantId,
        tenantSlug: record.tenantSlug,
        domain: record.domain,
        slugs: [...record.slugs].sort(),
        versionId: record.versionId,
        suiteFingerprint: record.suiteFingerprint,
        deploymentId: record.deploymentId!,
        recordHash: record.recordHash,
      }))
      .sort((a, b) => a.promotionId.localeCompare(b.promotionId)),
  };
}

function spec(): GeneratedAgentSpec {
  return {
    key: "verifyDocument",
    actionName: "verifyDocument",
    slug: "verify-document",
    short: "VerifyDocument",
    domainId: domain,
    nameZh: "验证文档",
    kind: "llm",
    trigger: ["DOCUMENT_READY"],
    emit: ["DOCUMENT_VERIFIED"],
    tools: [],
    unresolvedTools: [],
    objects: ["Document"],
    systemPrompt: "验证输入并发出完成事件。",
    userPrompt: "",
    steps: [],
    ruleRefs: [],
    retries: 0,
    hitl: false,
    confidence: 1,
    promptSource: "llm",
  } as GeneratedAgentSpec;
}

function cleanupReceipt(fingerprint: string): SandboxCleanupReceipt {
  const drain = {
    schema: SANDBOX_RUN_DRAIN_RECEIPT_SCHEMA,
    sandboxAttemptId: "88888888-8888-4888-8888-888888888888",
    appId: "factory-ci-af-sbx",
    sandboxTenantSlug: "af-sbx-ci-regression-sb",
    startedAt: new Date(0).toISOString(),
    completedAt: new Date(0).toISOString(),
    observedRuns: [],
  };
  const body: Omit<SandboxCleanupReceipt, "absenceProbeHash"> = {
    schema: SANDBOX_CLEANUP_RECEIPT_SCHEMA,
    appId: drain.appId,
    sandboxTenantSlug: drain.sandboxTenantSlug,
    sandboxAttemptId: drain.sandboxAttemptId,
    candidateFingerprint: fingerprint,
    targetDomainId: domain,
    runDrain: { ...drain, evidenceHash: sandboxRunDrainReceiptHash(drain) },
    deletedAt: new Date(0).toISOString(),
    absence: {
      connected: false,
      functionCount: null,
      registryState: "not_registered",
    },
  };
  return { ...body, absenceProbeHash: sandboxCleanupReceiptHash(body) };
}

function evidence(): AgentDraftRegressionEvidence {
  const fingerprint = "sandbox-evidence:v2:ci-regression";
  const cleanup = cleanupReceipt(fingerprint);
  const subjectDigest = sandboxDesignReviewSubjectDigest({
    domain,
    fingerprint,
  });
  return {
    evidenceFingerprint: fingerprint,
    authoritativeOntology: {
      schema: "agent-factory-authoritative-ontology/v1",
      tenantId,
      tenantSlug,
      domainId: domain,
      source: "allmeta",
      contentHash: `ontology:v2:${"3".repeat(64)}`,
    },
    cleanupReceipt: cleanup,
    ...makePromotableSandboxRegistrationEvidence(cleanup.appId, ["verify-document"]),
    ...makePromotableSandboxExecutionEvidence({
      candidateFingerprint: fingerprint,
      targetDomainId: domain,
      targetTenantId: tenantId,
      targetTenantSlug: tenantSlug,
      sandboxAttemptId: cleanup.sandboxAttemptId,
      agentRefs: ["verify-document"],
    }),
    approvedTestCases: [
      {
        id: "tc-ci-pass",
        name: "文档验证成功",
        scenario: "输入完整文档",
        kind: "pass",
        entryEvent: "DOCUMENT_READY",
        payload: { document_id: "doc-ci-1" },
        expectedOutcome: "发出 DOCUMENT_VERIFIED",
        expectedEvent: "DOCUMENT_VERIFIED",
        functionAssertions: {
          emits: [{ event: "DOCUMENT_VERIFIED", count: 1 }],
        },
      },
    ],
    testDataOverrides: {},
    functionTester: [
      {
        short: "VerifyDocument",
        pass: true,
        ran: true,
        emitNames: ["DOCUMENT_VERIFIED"],
        reasons: [],
        tier: "worker",
        fixtureMode: "scripted",
        qualification: "promotable",
      },
    ],
    toolMode: "evidence_replay",
    externalLiveCalls: 0,
    sandboxReplayEvidenceComplete: true,
    replayReceipts: [],
    cassetteRefs: [],
    sandboxDesignReview: {
      fingerprint,
      subjectDigest,
      receipt: {
        challengeId: "fac-ci-review",
        kind: "sandbox_design_review",
        protocolVersion: 1,
        digest: "f".repeat(64),
        subjectDigest,
        authorizationDigest: "a".repeat(64),
        actor: "usr-ci-reviewer",
        runId: "factory-ci-run",
        conversationId: "factory-ci-run",
        consumedAt: "1970-01-01T00:00:00.000Z",
        expiresAt: "1970-01-01T00:15:00.000Z",
      },
    },
  };
}

let root: string;
let previousRoot: string | undefined;

beforeEach(async () => {
  previousRoot = process.env.AGENTIC_DATA_ROOT;
  root = await fs.mkdtemp(path.join(os.tmpdir(), "factory-regression-ci-"));
  process.env.AGENTIC_DATA_ROOT = root;
});

afterEach(async () => {
  if (previousRoot === undefined) delete process.env.AGENTIC_DATA_ROOT;
  else process.env.AGENTIC_DATA_ROOT = previousRoot;
  await fs.rm(root, { recursive: true, force: true });
});

describe("promoted Agent Factory regression CI replay", () => {
  it("recovers a production commit that crashed before the promotion ledger finalized", async () => {
    const store = new FsAgentDraftStore({
      tenantId,
      tenantSlug,
      ontologyDomainId: domain,
    });
    await store.save(domain, [spec()], evidence());
    const [draft] = await store.list(domain);
    const replay = await store.replayRegression(
      domain,
      ["verify-document"],
      draft!.versionId,
    );
    expect(replay.pass, replay.errors.join("; ")).toBe(true);
    const stage = await stageFactoryPromotionRegression({
      tenantId,
      tenantSlug,
      domain,
      versionId: draft!.versionId!,
      slugs: ["verify-document"],
      artifactPath: replay.artifact,
      evidenceFingerprint: replay.evidenceFingerprint!,
      suiteFingerprint: replay.suiteFingerprint!,
      sandboxCleanupReceiptHash: replay.sandboxCleanupReceiptHash!,
      reviewReceiptId: "review-bbbbbbbb",
    });

    const recovered = await reconcilePendingFactoryPromotions({
      dataRoot: root,
      startupExclusive: true,
      deployments: [{
        deploymentId: "dpl-recovered-production",
        tenantId,
        tenantSlug,
        target: "workflow",
        status: "live",
        note: factoryPromotionDeploymentNote(stage.record.promotionId),
        deployedAt: new Date(Date.parse(stage.record.stagedAt) + 1_000),
        manifest: [{
          id: "verify-document",
          generated: true,
          factory_domain_id: domain,
          factory_target_domain_id: domain,
          factory_promotion_version_id: draft!.versionId,
          factory_regression_suite_fingerprint: replay.suiteFingerprint,
          factory_execution_scope: {
            kind: "production",
            target_domain_id: domain,
          },
        }],
      }],
    });
    expect(recovered).toMatchObject({
      pendingSeen: 1,
      finalized: 1,
      abortedBeforeCommit: 0,
      failures: 0,
      protectedDeploymentIds: ["dpl-recovered-production"],
    });
    const ledger = await readFactoryPromotionRegressionLedger(root);
    expect(ledger.pending).toHaveLength(0);
    expect(ledger.committed).toHaveLength(1);
    expect(ledger.committed[0]!.record).toMatchObject({
      promotionId: stage.record.promotionId,
      deploymentId: "dpl-recovered-production",
    });
    expect(ledger.highWatermark?.committedCount).toBe(1);
  });

  it("removes an exclusive-startup stage that never crossed the production commit boundary", async () => {
    const store = new FsAgentDraftStore({
      tenantId,
      tenantSlug,
      ontologyDomainId: domain,
    });
    await store.save(domain, [spec()], evidence());
    const [draft] = await store.list(domain);
    const replay = await store.replayRegression(
      domain,
      ["verify-document"],
      draft!.versionId,
    );
    const stage = await stageFactoryPromotionRegression({
      tenantId,
      tenantSlug,
      domain,
      versionId: draft!.versionId!,
      slugs: ["verify-document"],
      artifactPath: replay.artifact,
      evidenceFingerprint: replay.evidenceFingerprint!,
      suiteFingerprint: replay.suiteFingerprint!,
      sandboxCleanupReceiptHash: replay.sandboxCleanupReceiptHash!,
      reviewReceiptId: "review-cccccccc",
    });
    expect(stage.record.promotionId).toMatch(/^fpr-/);

    const recovered = await reconcilePendingFactoryPromotions({
      dataRoot: root,
      startupExclusive: true,
      deployments: [],
    });
    expect(recovered).toMatchObject({
      pendingSeen: 1,
      finalized: 0,
      abortedBeforeCommit: 1,
      failures: 0,
    });
    const ledger = await readFactoryPromotionRegressionLedger(root);
    expect(ledger.pending).toHaveLength(0);
    expect(ledger.committed).toHaveLength(0);
  });

  it("fails on an incomplete promotion and replays every committed record after finalize", async () => {
    const store = new FsAgentDraftStore({
      tenantId,
      tenantSlug,
      ontologyDomainId: domain,
    });
    await store.save(domain, [spec()], evidence());
    const [draft] = await store.list(domain);
    const replay = await store.replayRegression(
      domain,
      ["verify-document"],
      draft!.versionId,
    );
    expect(replay.pass, replay.errors.join("; ")).toBe(true);

    const stage = await stageFactoryPromotionRegression({
      tenantId,
      tenantSlug,
      domain,
      versionId: draft!.versionId!,
      slugs: ["verify-document"],
      artifactPath: replay.artifact,
      evidenceFingerprint: replay.evidenceFingerprint!,
      suiteFingerprint: replay.suiteFingerprint!,
      sandboxCleanupReceiptHash: replay.sandboxCleanupReceiptHash!,
      reviewReceiptId: "review-aaaaaaaa",
    });

    const pending = await replayAllPromotedRegressions(root, {
      inventory: unavailableInventory,
    });
    expect(pending.pass).toBe(false);
    expect(pending.pendingCount).toBe(1);
    expectRedacted(pending.errors, [root, "incomplete production promotion"]);
    expect(pending.dataRoot).toBe("[verified-bundle-root]");

    const committed = await stage.finalize("dpl-ci-regression");
    expect(committed.committedAt).toBeTruthy();
    expect(committed.deploymentId).toBe("dpl-ci-regression");
    const inventory = await committedInventory();
    const omitted = await replayAllPromotedRegressions(root, {
      inventory: { ...inventory, promotions: [] },
    });
    expect(omitted.pass).toBe(false);
    expect(omitted.replayedCount).toBe(0);
    expectRedacted(omitted.errors, [root, committed.promotionId]);

    const report = await replayAllPromotedRegressions(root, { inventory });
    expect(report.pass, JSON.stringify(report)).toBe(true);
    expect(report).toMatchObject({
      promotedCount: 1,
      replayedCount: 1,
      pendingCount: 0,
    });
    expect(report.entries).toEqual([
      expect.objectContaining({
        promotionId: committed.promotionId,
        tenantId,
        domain,
        versionId: draft!.versionId,
        slugs: ["verify-document"],
        pass: true,
        cases: 1,
        errors: [],
      }),
    ]);

    const exportParent = await fs.mkdtemp(
      path.join(os.tmpdir(), "factory-regression-export-"),
    );
    const exportRoot = path.join(exportParent, "bundle");
    try {
      const signingKey = "test-only-signing-key-that-is-at-least-32-bytes";
      const source = {
        repository: "example/agentic-operator",
        workflow: ".github/workflows/factory-regression-export.yml" as const,
        event: "push" as const,
        ref: "refs/heads/main" as const,
        sha: "1".repeat(40),
        runId: "12345",
        runAttempt: "1",
        consumerWorkflow: ".github/workflows/ci.yml" as const,
        consumerRunId: "54321",
        consumerRunAttempt: "2",
        requestNonce: "a".repeat(64),
      };
      const productionAgent = {
        id: "verify-document",
        generated: true,
        factory_domain_id: domain,
        factory_promotion_version_id: draft!.versionId,
        factory_regression_suite_fingerprint: replay.suiteFingerprint,
        factory_execution_scope: {
          kind: "production",
          target_domain_id: domain,
        },
      };
      const productionDeployment = {
        deploymentId: "dpl-ci-regression",
        tenantId,
        tenantSlug,
        target: "workflow",
        status: "live",
        note: factoryPromotionDeploymentNote(committed.promotionId),
        manifest: [productionAgent],
      };
      const exported = await exportFactoryRegressionBundle({
        dataRoot: root,
        outputRoot: exportRoot,
        signingKey,
        source,
        now: new Date("2026-07-15T00:00:00.000Z"),
        deployments: [productionDeployment],
      });
      expect(exported.highWatermark.committedCount).toBe(1);

      const expected = {
        repository: source.repository,
        workflow: source.workflow,
        event: source.event,
        ref: source.ref,
        sha: source.sha,
        runId: source.runId,
        runAttempt: source.runAttempt,
        consumerWorkflow: source.consumerWorkflow,
        consumerRunId: source.consumerRunId,
        consumerRunAttempt: source.consumerRunAttempt,
        requestNonce: source.requestNonce,
        highWatermarkStateHash: exported.highWatermark.stateHash,
      };
      const verified = await verifyFactoryRegressionExportBundle({
        dataRoot: exportRoot,
        signingKey,
        expected,
        now: new Date("2026-07-15T00:01:00.000Z"),
      });
      expect(verified.liveAgents).toHaveLength(1);

      await expect(
        verifyFactoryRegressionExportBundle({
          dataRoot: exportRoot,
          signingKey: "different-test-signing-key-that-is-at-least-32-bytes",
          expected,
          now: new Date("2026-07-15T00:01:00.000Z"),
        }),
      ).rejects.toThrow("signature is invalid");

      await expect(
        verifyFactoryRegressionExportBundle({
          dataRoot: exportRoot,
          signingKey,
          expected: { ...expected, runId: "99999" },
          now: new Date("2026-07-15T00:01:00.000Z"),
        }),
      ).rejects.toThrow("identity does not match CI");

      await expect(
        verifyFactoryRegressionExportBundle({
          dataRoot: exportRoot,
          signingKey,
          expected,
          now: new Date("2026-07-16T00:00:00.000Z"),
        }),
      ).rejects.toThrow("expired or has invalid timestamps");

      let deploymentRead = 0;
      await expect(
        exportFactoryRegressionBundle({
          dataRoot: root,
          outputRoot: path.join(exportParent, "drift-bundle"),
          signingKey,
          source,
          now: new Date("2026-07-15T00:00:00.000Z"),
          readDeployments: () => {
            deploymentRead += 1;
            if (deploymentRead === 1) return [productionDeployment];
            return [
              { ...productionDeployment, status: "rolled_back" },
              {
                ...productionDeployment,
                deploymentId: "dpl-concurrent-winner",
                note: null,
                status: "live",
              },
            ];
          },
        }),
      ).rejects.toThrow("changed while the regression export was copied");

      await fs.appendFile(
        path.join(exportRoot, FACTORY_REGRESSION_INVENTORY_FILE),
        "\n",
      );
      await expect(
        verifyFactoryRegressionExportBundle({
          dataRoot: exportRoot,
          signingKey,
          expected,
          now: new Date("2026-07-15T00:01:00.000Z"),
        }),
      ).rejects.toThrow("file inventory is incomplete or has drifted");
    } finally {
      await fs.rm(exportParent, { recursive: true, force: true });
    }

    const checkpointed = await readFactoryPromotionRegressionLedger(root);
    await fs.unlink(checkpointed.committed[0]!.file);
    const next = await stageFactoryPromotionRegression({
      tenantId,
      tenantSlug,
      domain,
      versionId: draft!.versionId!,
      slugs: ["verify-document"],
      artifactPath: replay.artifact,
      evidenceFingerprint: replay.evidenceFingerprint!,
      suiteFingerprint: replay.suiteFingerprint!,
      sandboxCleanupReceiptHash: replay.sandboxCleanupReceiptHash!,
      reviewReceiptId: "review-dddddddd",
    });
    await expect(next.finalize("dpl-after-omission")).rejects.toThrow(
      "not the exact predecessor",
    );
  });

  it("does not turn an absent or corrupt promotion catalog into a green CI result", async () => {
    const empty = await replayAllPromotedRegressions(root, {
      inventory: unavailableInventory,
    });
    expect(empty.pass).toBe(false);
    expectRedacted(empty.errors, [root, "no committed"]);

    const directory = path.join(
      root,
      "factory-regression-promotions",
      "committed",
    );
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "broken.json"), "{}\n", "utf8");
    const corrupt = await replayAllPromotedRegressions(root, {
      inventory: unavailableInventory,
    });
    expect(corrupt.pass).toBe(false);
    expect(corrupt.promotedCount).toBe(1);
    expectRedacted(corrupt.errors, [root, "invalid committed", "broken.json"]);
  });

  it("does not leak paths, fixture values, worker reasons, or credentials in CI diagnostics", () => {
    const unsafe =
      "worker failed for 张三 at /private/data/resume.pdf with sk-live-secret";
    const diagnostic = redactRegressionDiagnostic(unsafe);
    expect(redactRegressionDiagnostic(unsafe)).toBe(diagnostic);
    expectRedacted(
      [diagnostic],
      ["张三", "/private/data", "sk-live-secret", "worker failed"],
    );

    const redacted = redactRegressionReplayResult({
      pass: false,
      artifact: "/private/data/regression.json",
      versionId: "v-test",
      sandboxExternalLiveCalls: null,
      sandboxReplayEvidenceComplete: false,
      sandboxReplayReceipts: [],
      effectiveEntryEvents: [],
      results: [
        {
          slug: "verify-document",
          caseId: "tc-secret",
          pass: false,
          ran: true,
          emitNames: [],
          reasons: [unsafe],
          tier: "worker",
        },
      ],
      errors: [unsafe],
    });
    expect(redacted.artifact).toBe("[withheld-artifact-path]");
    expectRedacted(redacted.errors, [unsafe]);
    expectRedacted(redacted.results[0]!.reasons, [unsafe]);
  });
});
