import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  FACTORY_TEST_FIXTURE_ASSET_SCHEMA,
  SANDBOX_CLEANUP_RECEIPT_SCHEMA,
  SANDBOX_RUN_DRAIN_RECEIPT_SCHEMA,
  sandboxCleanupReceiptHash,
  sandboxDesignReviewSubjectDigest,
  sandboxRunDrainReceiptHash,
  type AgentDraftRegressionEvidence,
  type FactoryTestFixtureAssetBinding,
  type GeneratedAgentSpec,
  type SandboxCleanupReceipt,
} from "@agentic/agent-factory";

import { makePromotableSandboxExecutionEvidence } from "./factory-sandbox-execution-fixture";
import { makePromotableSandboxRegistrationEvidence } from "./factory-sandbox-registration-fixture";
import { FsAgentDraftStore } from "../src/services/agent-factory/agent-draft-store";
import { FsFactoryFixtureAssetStore } from "../src/services/agent-factory/fixture-asset-store";
import {
  exportFactoryRegressionBundle,
  verifyFactoryRegressionExportBundle,
} from "../src/services/agent-factory/factory-regression-export-bundle";
import {
  factoryPromotionFixtureCapsuleManifestHash,
  verifyFactoryPromotionFixtureCapsule,
  type FactoryPromotionFixtureCapsuleManifest,
} from "../src/services/agent-factory/promotion-regression-fixture-capsule";
import {
  factoryPromotionDeploymentNote,
  stageFactoryPromotionRegression,
  type StagedFactoryPromotionRegression,
} from "../src/services/agent-factory/promotion-regression-ledger";
import type { PersistedRegressionArtifact } from "../src/services/agent-factory/regression-artifact";
import { replayAllPromotedRegressions } from "../src/services/agent-factory/replay-promoted-regressions";

const tenantId = "ten-fixture-capsule";
const tenantSlug = "fixture-capsule-tenant";
const domain = "fixture-capsule-domain";
const conversationId = "factory-fixture-capsule-run";
const caseId = "tc-binary-document";

function spec(): GeneratedAgentSpec {
  return {
    key: "verifyBinaryDocument",
    actionName: "verifyBinaryDocument",
    slug: "verify-binary-document",
    short: "VerifyBinaryDocument",
    domainId: domain,
    nameZh: "验证二进制文档",
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
    sandboxAttemptId: "99999999-9999-4999-8999-999999999999",
    appId: "factory-fixture-capsule-af-sbx",
    sandboxTenantSlug: "af-sbx-fixture-capsule",
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

function evidence(binding: FactoryTestFixtureAssetBinding): AgentDraftRegressionEvidence {
  const fingerprint = "sandbox-evidence:v2:fixture-capsule";
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
      contentHash: `ontology:v2:${"2".repeat(64)}`,
    },
    cleanupReceipt: cleanup,
    ...makePromotableSandboxRegistrationEvidence(cleanup.appId, ["verify-binary-document"]),
    ...makePromotableSandboxExecutionEvidence({
      candidateFingerprint: fingerprint,
      targetDomainId: domain,
      targetTenantId: tenantId,
      targetTenantSlug: tenantSlug,
      sandboxAttemptId: cleanup.sandboxAttemptId,
      agentRefs: ["verify-binary-document"],
    }),
    approvedTestCases: [
      {
        id: caseId,
        name: "带文件的文档验证",
        scenario: "输入已批准的二进制文件",
        kind: "pass",
        entryEvent: "DOCUMENT_READY",
        payload: { document: binding },
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
        short: "VerifyBinaryDocument",
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
        challengeId: "fac-fixture-capsule-review",
        kind: "sandbox_design_review",
        protocolVersion: 1,
        digest: "f".repeat(64),
        subjectDigest,
        authorizationDigest: "a".repeat(64),
        actor: "usr-fixture-reviewer",
        runId: conversationId,
        conversationId,
        consumedAt: "1970-01-01T00:00:00.000Z",
        expiresAt: "1970-01-01T00:15:00.000Z",
      },
    },
  };
}

interface Scenario {
  fixtureStore: FsFactoryFixtureAssetStore;
  advanceSourceClock(): void;
  stage: StagedFactoryPromotionRegression;
  artifact: PersistedRegressionArtifact;
  artifactPath: string;
  versionId: string;
  suiteFingerprint: string;
}

async function createScenario(): Promise<Scenario> {
  let sourceNow = new Date();
  const fixtureStore = new FsFactoryFixtureAssetStore({
    root: path.join(root, "factory-fixture-assets"),
    ttlSeconds: 60,
    now: () => sourceNow,
  });
  const metadata = await fixtureStore.put(
    { tenantId, domain, conversationId },
    {
      caseId,
      path: "/document",
      base64: Buffer.from("approved-private-document", "utf8").toString("base64"),
      mimeType: "application/pdf",
      filename: "document.pdf",
    },
  );
  const binding: FactoryTestFixtureAssetBinding = {
    schema: FACTORY_TEST_FIXTURE_ASSET_SCHEMA,
    conversationId,
    as: "object",
    ...metadata,
  };
  const store = new FsAgentDraftStore(
    { tenantId, tenantSlug, ontologyDomainId: domain },
    fixtureStore,
  );
  await store.save(domain, [spec()], evidence(binding));
  const [draft] = await store.list(domain);
  const replay = await store.replayRegression(
    domain,
    ["verify-binary-document"],
    draft!.versionId,
  );
  expect(replay.pass, replay.errors.join("; ")).toBe(true);
  const stage = await stageFactoryPromotionRegression({
    tenantId,
    tenantSlug,
    domain,
    versionId: draft!.versionId!,
    slugs: ["verify-binary-document"],
    artifactPath: replay.artifact,
    evidenceFingerprint: replay.evidenceFingerprint!,
    suiteFingerprint: replay.suiteFingerprint!,
    sandboxCleanupReceiptHash: replay.sandboxCleanupReceiptHash!,
    reviewReceiptId: "review-fixture-capsule",
  });
  const artifact = JSON.parse(
    await fs.readFile(replay.artifact, "utf8"),
  ) as PersistedRegressionArtifact;
  return {
    fixtureStore,
    advanceSourceClock() {
      sourceNow = new Date(sourceNow.getTime() + 2 * 60 * 1000);
    },
    stage,
    artifact,
    artifactPath: replay.artifact,
    versionId: draft!.versionId!,
    suiteFingerprint: replay.suiteFingerprint!,
  };
}

async function capsulePaths(stage: StagedFactoryPromotionRegression): Promise<{
  manifestPath: string;
  capsuleDirectory: string;
  contentPath: string;
}> {
  const ref = stage.record.fixtureCapsule!;
  const manifestPath = path.join(root, ...ref.manifest.split("/"));
  const manifest = JSON.parse(
    await fs.readFile(manifestPath, "utf8"),
  ) as FactoryPromotionFixtureCapsuleManifest;
  return {
    manifestPath,
    capsuleDirectory: path.dirname(manifestPath),
    contentPath: path.join(path.dirname(manifestPath), ...manifest.entries[0]!.content.split("/")),
  };
}

let root: string;
let previousRoot: string | undefined;

beforeEach(async () => {
  previousRoot = process.env.AGENTIC_DATA_ROOT;
  root = await fs.mkdtemp(path.join(os.tmpdir(), "factory-fixture-capsule-"));
  process.env.AGENTIC_DATA_ROOT = root;
});

afterEach(async () => {
  if (previousRoot === undefined) delete process.env.AGENTIC_DATA_ROOT;
  else process.env.AGENTIC_DATA_ROOT = previousRoot;
  await fs.rm(root, { recursive: true, force: true });
});

describe("promotion regression binary fixture capsule", () => {
  it("deletes an aborted capsule, retains a finalized capsule, and exports/replays after the source fixture expires", async () => {
    const abandoned = await createScenario();
    const abandonedPaths = await capsulePaths(abandoned.stage);
    await expect(fs.access(abandonedPaths.contentPath)).resolves.toBeUndefined();
    await abandoned.stage.abort();
    await expect(fs.access(abandonedPaths.capsuleDirectory)).rejects.toMatchObject({
      code: "ENOENT",
    });

    const scenario = await createScenario();
    const paths = await capsulePaths(scenario.stage);
    expect((await fs.stat(paths.capsuleDirectory)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(paths.manifestPath)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(paths.contentPath)).mode & 0o777).toBe(0o600);
    scenario.advanceSourceClock();
    const binding = scenario.artifact.effectiveTestCases[0]!.payload
      .document as FactoryTestFixtureAssetBinding;
    await expect(
      scenario.fixtureStore.inspect(
        { tenantId, domain, conversationId },
        binding.assetId,
      ),
    ).resolves.toBeNull();

    const committed = await scenario.stage.finalize("dpl-fixture-capsule");
    await expect(fs.access(paths.contentPath)).resolves.toBeUndefined();

    const exportParent = await fs.mkdtemp(
      path.join(os.tmpdir(), "factory-fixture-capsule-export-"),
    );
    const exportRoot = path.join(exportParent, "bundle");
    try {
      const signingKey = "fixture-capsule-signing-key-at-least-32-bytes";
      const source = {
        repository: "example/agentic-operator",
        workflow: ".github/workflows/factory-regression-export.yml" as const,
        event: "push" as const,
        ref: "refs/heads/main" as const,
        sha: "2".repeat(40),
        runId: "24680",
        runAttempt: "1",
        consumerWorkflow: ".github/workflows/ci.yml" as const,
        consumerRunId: "86420",
        consumerRunAttempt: "1",
        requestNonce: "b".repeat(64),
      };
      const now = new Date(Date.now() + 5 * 60 * 1000);
      const exported = await exportFactoryRegressionBundle({
        dataRoot: root,
        outputRoot: exportRoot,
        signingKey,
        source,
        now,
        deployments: [
          {
            deploymentId: committed.deploymentId!,
            tenantId,
            tenantSlug,
            target: "workflow",
            status: "live",
            note: factoryPromotionDeploymentNote(committed.promotionId),
            manifest: [
              {
                id: "verify-binary-document",
                generated: true,
                factory_domain_id: domain,
                factory_promotion_version_id: scenario.versionId,
                factory_regression_suite_fingerprint: scenario.suiteFingerprint,
                factory_execution_scope: {
                  kind: "production",
                  target_domain_id: domain,
                },
              },
            ],
          },
        ],
      });
      const inventory = await verifyFactoryRegressionExportBundle({
        dataRoot: exportRoot,
        signingKey,
        expected: {
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
        },
        now: new Date(now.getTime() + 1_000),
      });
      const replay = await replayAllPromotedRegressions(exportRoot, {
        inventory,
      });
      expect(replay.pass, JSON.stringify(replay)).toBe(true);
      expect(replay.replayedCount).toBe(1);
    } finally {
      await fs.rm(exportParent, { recursive: true, force: true });
    }
  });

  it("fails closed when binary evidence has no capsule or a sidecar is missing", async () => {
    const scenario = await createScenario();
    await expect(
      verifyFactoryPromotionFixtureCapsule({
        dataRoot: root,
        record: { ...scenario.stage.record, fixtureCapsule: undefined },
        artifact: scenario.artifact,
      }),
    ).rejects.toThrow("has no immutable fixture capsule");

    const paths = await capsulePaths(scenario.stage);
    await fs.unlink(paths.contentPath);
    await expect(
      scenario.stage.finalize("dpl-missing-capsule-sidecar"),
    ).rejects.toThrow();
    await scenario.stage.abort();
  });

  it("rejects sidecar hash drift before finalize", async () => {
    const scenario = await createScenario();
    const paths = await capsulePaths(scenario.stage);
    await fs.appendFile(paths.contentPath, "drift");
    await expect(
      scenario.stage.finalize("dpl-drifted-capsule"),
    ).rejects.toThrow("content hash or size drifted");
    await scenario.stage.abort();
  });

  it("rejects a capsule content path escape even when its manifest hash is recomputed", async () => {
    const scenario = await createScenario();
    const paths = await capsulePaths(scenario.stage);
    const manifest = JSON.parse(
      await fs.readFile(paths.manifestPath, "utf8"),
    ) as FactoryPromotionFixtureCapsuleManifest;
    manifest.entries[0]!.content = "../escaped.bin";
    const { manifestHash: _oldHash, ...body } = manifest;
    manifest.manifestHash = factoryPromotionFixtureCapsuleManifestHash(body);
    await fs.writeFile(paths.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await expect(
      verifyFactoryPromotionFixtureCapsule({
        dataRoot: root,
        record: {
          ...scenario.stage.record,
          fixtureCapsule: {
            ...scenario.stage.record.fixtureCapsule!,
            manifestHash: manifest.manifestHash,
          },
        },
        artifact: scenario.artifact,
      }),
    ).rejects.toThrow("not a contained portable path");
    await scenario.stage.abort();
  });
});
