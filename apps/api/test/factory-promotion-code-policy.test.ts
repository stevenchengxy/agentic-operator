import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ontologyContentHash,
  renderTsFunctionModule,
  type GeneratedAgentSpec,
} from "@agentic/agent-factory";
import { regressionModuleHash, regressionSpecHash } from "../src/services/agent-factory/regression-artifact";
import { makePromotableSandboxModelUsage } from "./factory-sandbox-execution-fixture";
import {
  expectedProductionImages,
  productionImageAttestationKeyId,
  signFactoryProductionImageAttestation,
  verifyProductionImageObservation,
} from "../src/services/agent-factory/production-image-attestation";

const promotionRoots: string[] = [];

const state = vi.hoisted(() => ({
  drafts: [] as Array<Record<string, unknown>>,
  live: [] as Array<Record<string, unknown>>,
  validatedWorkflow: null as unknown,
  committedWorkflow: null as unknown,
  replayPass: true,
  replayCodeHash: null as string | null,
  replayExecution: "codeact-runtime" as "codeact-runtime" | "rendered-module" | undefined,
  replayEntryEvents: ["START"] as string[],
  replayExternalLiveCalls: 0 as number | null,
  replayEvidenceComplete: true,
  replayModelUsage: null as unknown,
  moduleCode: "",
  signedSelection: [] as Array<Record<string, unknown>>,
  currentTools: [] as Array<Record<string, unknown>>,
  importAuthorization: null as unknown,
  validateAuthorization: null as unknown,
  commitAuthorization: null as unknown,
  commitNote: null as string | null,
  promotionRegressionStaged: null as unknown,
  promotionRegressionFinalized: false,
  promotionRegressionAborted: false,
  commitShouldFail: false,
  ontologyRevision: 1,
}));

const promotionOntology = (revision: number) => ({
  domainId: "truth-domain",
  source: "allmeta" as const,
  objects: [],
  rules: revision === 1 ? [] : [{ id: "changed-rule" }],
  actions: [],
  events: [],
  workflow: [],
});

const ontologyEvidence = {
  schema: "agent-factory-authoritative-ontology/v1" as const,
  tenantId: "ten-truth",
  tenantSlug: "truth-production",
  domainId: "truth-domain",
  source: "allmeta" as const,
  contentHash: ontologyContentHash(promotionOntology(1)),
};

const promotionOntologySource = {
  listDomains: async () => [{ id: "truth-domain" }],
  fetchOntology: async () => promotionOntology(state.ontologyRevision),
  fetchActionRules: async () => [],
};

vi.mock("../src/services/manifest-import", () => ({
  loadLiveManifest: () => state.live,
  createFactoryPromotionImportAuthorization: vi.fn((args: unknown) => {
    state.importAuthorization = args;
    return { opaqueFactoryAuthorization: true };
  }),
  validate: vi.fn(async (body: { workflow: unknown }, _ctx: unknown, _audit: unknown, authorization: unknown) => {
    state.validatedWorkflow = body.workflow;
    state.validateAuthorization = authorization;
    return { issues: [], deployment_id: "dpl-truth" };
  }),
  commit: vi.fn(async (body: { workflow: unknown; note?: string }, _ctx: unknown, _audit: unknown, authorization: unknown) => {
    if (state.commitShouldFail) throw new Error("manifest commit failed");
    state.committedWorkflow = body.workflow;
    state.commitNote = body.note ?? null;
    state.commitAuthorization = authorization;
    return { deployment_id: "dpl-truth", inngest_fns_registered: 1 };
  }),
}));

vi.mock("../src/services/agent-factory/agent-draft-store", () => ({
  FsAgentDraftStore: class {
    async getVersion() {
      return state.drafts;
    }
    async getCode() {
      return state.moduleCode;
    }
    async replayRegression() {
      return {
        pass: state.replayPass,
        promotionEvidenceReady: state.replayPass,
        promotionEvidenceErrors: state.replayPass ? [] : ["promotion evidence unavailable"],
        artifact: "/tmp/regression.json",
        versionId: "v-truth",
        evidenceFingerprint: "sandbox-evidence:v2:truth",
        suiteFingerprint: "regression-suite:v1:truth",
        sandboxCleanupReceiptHash: `sandbox-cleanup:v1:${"e".repeat(64)}`,
        sandboxExternalLiveCalls: state.replayExternalLiveCalls,
        sandboxReplayEvidenceComplete: state.replayEvidenceComplete,
        sandboxExecutionReceipt: { schema: "test-signed-execution-receipt" },
        sandboxModelUsage: state.replayModelUsage,
        authoritativeOntology: ontologyEvidence,
        sandboxReplayReceipts: [],
        effectiveEntryEvents: state.replayEntryEvents,
        results: [{
          slug: "truth-action", caseId: "truth-action:tc1", pass: state.replayPass, ran: true,
          emitNames: state.replayPass ? ["DONE"] : [], reasons: state.replayPass ? [] : ["expected DONE"],
          tier: "codeact-worker", execution: state.replayExecution,
          codeHash: state.replayCodeHash ?? String(state.signedSelection[0]?.runtimeCodeHash ?? ""),
        }],
        errors: state.replayPass ? [] : ["suite fingerprint mismatch"],
      };
    }
  },
}));

vi.mock("../src/services/agent-factory/draft-review", () => ({
  verifyHumanReviewReceipt: vi.fn(async () => ({
    receipt: {
      receiptId: "review-truth",
      actor: { userId: "usr-human" },
      createdAt: new Date(0).toISOString(),
      previewHash: "promotion-preview:v1:truth",
      selectionHash: "promotion-selection:v1:truth",
      selection: state.signedSelection,
      signature: "a".repeat(64),
    },
  })),
}));

vi.mock("../src/services/agent-factory/domain-binding", () => ({
  getFactoryDomainBinding: () => ({ ontologyDomainId: "truth-domain" }),
}));

vi.mock("../src/services/agent-factory/active-work", () => ({
  beginFactoryActiveWork: () => () => undefined,
}));

vi.mock("../src/services/agent-factory/execution-resource-snapshot", () => ({
  currentFactoryExecutionTools: vi.fn(async () => state.currentTools),
}));

vi.mock("../src/services/agent-factory/promotion-regression-ledger", () => ({
  factoryPromotionDeploymentNote: (promotionId: string) =>
    `agent-factory-promotion:${promotionId}`,
  stageFactoryPromotionRegression: vi.fn(async (input: unknown) => {
    state.promotionRegressionStaged = input;
    return {
      record: { promotionId: "fpr-truth" },
      async finalize(deploymentId: string) {
        state.promotionRegressionFinalized = true;
        return { promotionId: "fpr-truth", deploymentId };
      },
      async abort() { state.promotionRegressionAborted = true; },
    };
  }),
}));

vi.mock("../src/services/agent-factory/remote-sandbox-deployer", () => ({
  loadRemoteSandboxConnectionConfig: () => ({
    receiptSigningKey: "test-receipt-key",
    runnerId: "test-runner",
    allowedBuildIds: new Set(["test-build"]),
    allowedImageDigests: new Set(["sha256:test"]),
  }),
}));

vi.mock("../src/services/agent-factory/sandbox-remote-protocol", () => ({
  verifySandboxExecutionPlaneReceipt: vi.fn(() => undefined),
}));

// The promotion policy suite isolates CodeAct/manifest gates. Authoritative
// Ontology drift is exercised through the real review API suite, so this mock
// keeps the existing cases focused while retaining exact evidence equality.
vi.mock("../src/services/agent-factory/authoritative-ontology-evidence", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/agent-factory/authoritative-ontology-evidence")>();
  return {
    ...actual,
    assertAuthoritativeOntologyCurrent: vi.fn(async ({ expected }: { expected: unknown }) => {
      if (state.ontologyRevision !== 1) {
        throw new Error("权威 Ontology 已在沙箱通过后发生变化；请重新预检、沙箱测试和人工审查");
      }
      return expected;
    }),
  };
});

import { promoteDrafts } from "../src/services/agent-factory/promote";

function executableSpec(): GeneratedAgentSpec {
  return {
    key: "TruthAction",
    actionName: "TruthAction",
    slug: "truth-action",
    short: "truthActionAgent",
    domainId: "truth-domain",
    nameZh: "真实性测试",
    kind: "llm",
    trigger: ["START"],
    emit: ["DONE"],
    tools: [],
    unresolvedTools: [],
    objects: [],
    systemPrompt: "Execute the ontology-grounded action and return a structured result.",
    userPrompt: "",
    steps: [],
    ruleRefs: [],
    retries: 1,
    hitl: false,
    confidence: 1,
    codeSource: "ai",
    codeExecuted: true,
    generatedCode: `
      import { defineAgent } from "@agentic/runtime";
      export const truthActionAgent = defineAgent({
        name: "truth-action",
        async handler(input, ctx) {
          ctx.emit("DONE", { source: "sandbox-code" });
          return { ok: true, input };
        },
      });
    `,
  } as GeneratedAgentSpec;
}

function installDraft(spec: GeneratedAgentSpec): void {
  state.moduleCode = renderTsFunctionModule(spec);
  state.signedSelection = [{
    slug: spec.slug,
    specHash: regressionSpecHash(spec),
    sandboxEvidenceFingerprint: "sandbox-evidence:v2:truth",
    regressionSuiteFingerprint: "regression-suite:v1:truth",
    sandboxCleanupReceiptHash: `sandbox-cleanup:v1:${"e".repeat(64)}`,
    runtimeCodeHash: regressionModuleHash(spec.generatedCode!),
    moduleHash: regressionModuleHash(state.moduleCode),
    authoritativeOntology: ontologyEvidence,
  }];
  state.drafts = [{
    domain: "truth-domain",
    slug: spec.slug,
    spec,
    createdAt: new Date(0).toISOString(),
    versionId: "v-truth",
    regression: {
      artifact: "versions/v-truth/regression.json",
      evidenceFingerprint: "sandbox-evidence:v2:truth",
      suiteFingerprint: "regression-suite:v1:truth",
      cleanupReceiptHash: `sandbox-cleanup:v1:${"e".repeat(64)}`,
      authoritativeOntology: ontologyEvidence,
    },
  }];
}

function appendDeclarativeDraft(): GeneratedAgentSpec {
  const spec = {
    ...executableSpec(),
    key: "TruthFollowup",
    actionName: "TruthFollowup",
    slug: "truth-followup",
    short: "truthFollowupAgent",
    nameZh: "真实性后续测试",
    emit: ["FOLLOWUP_DONE"],
    codeExecuted: false,
    generatedCode: undefined,
  } as GeneratedAgentSpec;
  const regression = (state.drafts[0] as { regression: Record<string, unknown> }).regression;
  state.drafts.push({
    domain: "truth-domain",
    slug: spec.slug,
    spec,
    createdAt: new Date(0).toISOString(),
    versionId: "v-truth",
    regression: { ...regression },
  });
  state.signedSelection.push({
    slug: spec.slug,
    specHash: regressionSpecHash(spec),
    sandboxEvidenceFingerprint: "sandbox-evidence:v2:truth",
    regressionSuiteFingerprint: "regression-suite:v1:truth",
    sandboxCleanupReceiptHash: `sandbox-cleanup:v1:${"e".repeat(64)}`,
    moduleHash: regressionModuleHash(state.moduleCode),
    authoritativeOntology: ontologyEvidence,
  });
  return spec;
}

function installCurrentPingTool(): void {
  state.currentTools = [{
    name: "meta.ping",
    summary: "Pure health probe",
    sideEffect: "read",
    operation: "read",
    effectScope: "none",
    sandboxPolicy: "pure",
    configKeys: [],
    credentialEnv: [],
    capabilities: [],
    integrationProfiles: [],
    catalogDefinition: {
      name: "meta.ping",
      sideEffect: "read",
      operation: "read",
      effectScope: "none",
      sandboxPolicy: "pure",
      configSchema: {},
    },
  }];
}

function reviewPingTool(spec: GeneratedAgentSpec): void {
  spec.tools = ["meta.ping"];
  spec.toolSideEffects = { "meta.ping": "read" };
  spec.toolPolicies = {
    "meta.ping": {
      operation: "read",
      effectScope: "none",
      sandboxPolicy: "pure",
    },
  };
  installCurrentPingTool();
}

describe("Agent Factory promotion generated-code policy", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const root of promotionRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  beforeEach(() => {
    state.validatedWorkflow = null;
    state.committedWorkflow = null;
    state.replayPass = true;
    state.replayCodeHash = null;
    state.replayExecution = "codeact-runtime";
    state.replayEntryEvents = ["START"];
    state.replayExternalLiveCalls = 0;
    state.replayEvidenceComplete = true;
    state.replayModelUsage = makePromotableSandboxModelUsage({
      sandboxAttemptId: "11111111-1111-4111-8111-111111111111",
      targetTenantId: "ten-truth",
      targetTenantSlug: "truth-production",
      agentRefs: ["truth-action"],
    });
    state.live = [];
    state.importAuthorization = null;
    state.validateAuthorization = null;
    state.commitAuthorization = null;
    state.commitNote = null;
    state.promotionRegressionStaged = null;
    state.promotionRegressionFinalized = false;
    state.promotionRegressionAborted = false;
    state.commitShouldFail = false;
    state.ontologyRevision = 1;
    state.currentTools = [];
    installDraft(executableSpec());
  });

  it("blocks production promotion before reading drafts when the host image proof is unavailable", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("FACTORY_PRODUCTION_IMAGE_ATTESTATION_FILE", "");
    vi.stubEnv("FACTORY_PRODUCTION_IMAGE_ATTESTATION_PUBLIC_KEY_FILE", "");

    await expect(promoteDrafts(
      "truth-domain",
      { versionId: "v-truth", receiptId: "review-truth" },
      { tenantId: "ten-truth", tenantSlug: "truth-production", ontology: promotionOntologySource },
    )).rejects.toThrow(/生产镜像的主机签名证明缺失/);
    expect(state.validatedWorkflow).toBeNull();
    expect(state.committedWorkflow).toBeNull();
  });

  it("does not let NODE_ENV=test alone create a production deployment", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("FACTORY_ALLOW_TEST_PROMOTION", "");

    await expect(promoteDrafts(
      "truth-domain",
      { versionId: "v-truth", receiptId: "review-truth" },
      { tenantId: "ten-truth", tenantSlug: "truth-production", ontology: promotionOntologySource },
    )).rejects.toThrow(/不是启用生产镜像信任验证的 production 进程/);
    expect(state.validatedWorkflow).toBeNull();
    expect(state.committedWorkflow).toBeNull();
  });

  it("does not honor the unit-test promotion switch outside a Vitest process", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("VITEST", "");
    vi.stubEnv("FACTORY_ALLOW_TEST_PROMOTION", "1");

    await expect(promoteDrafts(
      "truth-domain",
      { versionId: "v-truth", receiptId: "review-truth" },
      { tenantId: "ten-truth", tenantSlug: "truth-production", ontology: promotionOntologySource },
    )).rejects.toThrow(/不是启用生产镜像信任验证的 production 进程/);
    expect(state.committedWorkflow).toBeNull();
  });

  it("blocks promotion with a valid same-host proof because only external_sandbox is promotable", async () => {
    const image = (digit: string) => `sha256:${digit.repeat(64)}`;
    const values = {
      NODE_ENV: "production",
      FACTORY_PRODUCTION_IMAGE_ATTESTATION_TOPOLOGY: "single_host_compose",
      AGENTIC_BUILD_ID: "promotion-local-build",
      AGENTIC_API_IMAGE: image("1"),
      AGENTIC_WEB_IMAGE: image("2"),
      FACTORY_SANDBOX_CONTROL_IMAGE: image("3"),
      FACTORY_SANDBOX_WORKLOAD_IMAGE: image("4"),
      FACTORY_SANDBOX_GATEWAY_IMAGE: image("5"),
      PRODUCTION_CODEACT_EXECUTOR_IMAGE: image("6"),
      FACTORY_SB_RUNTIME_IMAGE_DIGEST: image("4"),
      FACTORY_SB_ALLOWED_BUILD_IDS: JSON.stringify(["promotion-local-build"]),
      FACTORY_SB_ALLOWED_IMAGE_DIGESTS: JSON.stringify([image("4")]),
      FACTORY_CODEACT_ALLOWED_IMAGE_DIGESTS: "",
      PRODUCTION_CODEACT_ALLOWED_CANDIDATE_REFS: JSON.stringify([image("7")]),
      PRODUCTION_CODEACT_ALLOWED_CANDIDATE_IMAGE_IDS: JSON.stringify([image("7")]),
      FACTORY_PRODUCTION_IMAGE_ATTESTATION_TTL_MS: "60000",
    };
    const keys = generateKeyPairSync("ed25519");
    const expected = expectedProductionImages(values);
    const now = new Date();
    const body = verifyProductionImageObservation({
      expected,
      keyId: productionImageAttestationKeyId(keys.publicKey),
      containers: expected.services.map((row, index) => ({
        service: row.service,
        containerId: `promotion-container-${index}`,
        configImage: row.imageId,
        imageId: row.imageId,
        status: "running",
        health: "healthy",
        buildId: expected.buildId,
        role: row.role,
      })),
      candidate: {
        imageId: expected.candidateImageId,
        buildId: expected.buildId,
        role: "codeact-candidate",
      },
      now,
      ttlMs: 60_000,
    });
    const root = mkdtempSync(path.join(tmpdir(), "factory-promotion-topology-"));
    promotionRoots.push(root);
    const attestationFile = path.join(root, "attestation.json");
    const publicKeyFile = path.join(root, "public.pem");
    writeFileSync(
      attestationFile,
      JSON.stringify(signFactoryProductionImageAttestation(body, keys.privateKey)),
    );
    writeFileSync(
      publicKeyFile,
      keys.publicKey.export({ type: "spki", format: "pem" }),
    );
    for (const [name, value] of Object.entries({
      ...values,
      FACTORY_PRODUCTION_IMAGE_ATTESTATION_FILE: attestationFile,
      FACTORY_PRODUCTION_IMAGE_ATTESTATION_PUBLIC_KEY_FILE: publicKeyFile,
    })) vi.stubEnv(name, value);

    await expect(promoteDrafts(
      "truth-domain",
      { versionId: "v-truth", receiptId: "review-truth" },
      { tenantId: "ten-truth", tenantSlug: "truth-production", ontology: promotionOntologySource },
    )).rejects.toThrow(/requires external_sandbox.*diagnostic-only/);
    expect(state.validatedWorkflow).toBeNull();
    expect(state.committedWorkflow).toBeNull();
  });

  it("promotes the exact reviewed handler as attested production CodeAct", async () => {
    const result = await promoteDrafts("truth-domain", { versionId: "v-truth", receiptId: "review-truth", slugs: ["truth-action"] }, {
      tenantId: "ten-truth",
      tenantSlug: "truth-production",
      ontology: promotionOntologySource,
    });

    expect(result.promoted).toEqual(["truth-action"]);
    expect(result.review).toMatchObject({ receiptId: "review-truth", reviewedBy: "usr-human", previewHash: "promotion-preview:v1:truth" });
    const validated = state.validatedWorkflow as Array<Record<string, unknown>>;
    const committed = state.committedWorkflow as Array<Record<string, unknown>>;
    expect(validated).toHaveLength(1);
    expect(validated[0]).toEqual(expect.objectContaining({
      generated: true,
      codeExecuted: true,
      typescript_code: executableSpec().generatedCode,
      code_attestation: {
        allow_production: true,
        expected_sha256: regressionModuleHash(executableSpec().generatedCode!),
      },
    }));
    expect(validated[0]!.actions).toEqual([
      expect.objectContaining({ type: "logic", name: "TruthAction" }),
    ]);
    expect(committed).toEqual(validated);
    expect(state.importAuthorization).toEqual(expect.objectContaining({
      receiptId: "review-truth",
      receiptSignature: "a".repeat(64),
      regressionSuiteFingerprint: "regression-suite:v1:truth",
    }));
    expect(state.validateAuthorization).toEqual({ opaqueFactoryAuthorization: true });
    expect(state.commitAuthorization).toEqual({ opaqueFactoryAuthorization: true });
    expect(state.commitNote).toBe("agent-factory-promotion:fpr-truth");
    expect(result.deploymentId).toBe("dpl-truth");
    expect(state.promotionRegressionStaged).toEqual(expect.objectContaining({
      tenantId: "ten-truth",
      domain: "truth-domain",
      versionId: "v-truth",
      slugs: ["truth-action"],
      artifactPath: "/tmp/regression.json",
      suiteFingerprint: "regression-suite:v1:truth",
    }));
    expect(state.promotionRegressionFinalized).toBe(true);
    expect(result.regression?.promotionRecordId).toBe("fpr-truth");
  });

  it("rejects selecting only a subset of the immutable draft version", async () => {
    appendDeclarativeDraft();

    await expect(promoteDrafts("truth-domain", {
      versionId: "v-truth",
      receiptId: "review-truth",
      slugs: ["truth-action"],
    }, {
      tenantId: "ten-truth",
      tenantSlug: "truth-production",
    })).rejects.toThrow(/拒绝部分晋升.*完整 Agent 集合：truth-action、truth-followup.*本次选择：truth-action/s);
    expect(state.validatedWorkflow).toBeNull();
    expect(state.committedWorkflow).toBeNull();
  });

  it("allows an explicit complete immutable slug set", async () => {
    appendDeclarativeDraft();

    const result = await promoteDrafts("truth-domain", {
      versionId: "v-truth",
      receiptId: "review-truth",
      // Request order is irrelevant; identity is the complete immutable set.
      slugs: ["truth-followup", "truth-action"],
    }, {
      tenantId: "ten-truth",
      tenantSlug: "truth-production",
      ontology: promotionOntologySource,
    });

    expect(result.promoted).toEqual(["truth-action", "truth-followup"]);
    expect(result.total).toBe(2);
    expect(state.committedWorkflow).toEqual(state.validatedWorkflow);
  });

  it("blocks a CodeAct handler that only declares a reviewed tool without calling it", async () => {
    const spec = executableSpec();
    reviewPingTool(spec);
    installDraft(spec);

    await expect(promoteDrafts("truth-domain", {
      versionId: "v-truth",
      receiptId: "review-truth",
      slugs: ["truth-action"],
    }, {
      tenantId: "ten-truth",
      tenantSlug: "truth-production",
    })).rejects.toThrow(/执行所有权不安全|没有真实覆盖全部已审查工具|meta\.ping/);
    expect(state.committedWorkflow).toBeNull();
  });

  it("aborts the pending regression ledger record when the production commit fails", async () => {
    state.commitShouldFail = true;
    await expect(promoteDrafts("truth-domain", {
      versionId: "v-truth",
      receiptId: "review-truth",
      slugs: ["truth-action"],
    }, {
      tenantId: "ten-truth",
      tenantSlug: "truth-production",
    })).rejects.toThrow(/manifest commit failed/);
    expect(state.promotionRegressionStaged).not.toBeNull();
    expect(state.promotionRegressionAborted).toBe(true);
    expect(state.promotionRegressionFinalized).toBe(false);
  });

  it("re-reads authoritative Ontology immediately before commit and aborts the staged promotion on drift", async () => {
    state.ontologyRevision = 2;
    await expect(promoteDrafts("truth-domain", {
      versionId: "v-truth",
      receiptId: "review-truth",
      slugs: ["truth-action"],
    }, {
      tenantId: "ten-truth",
      tenantSlug: "truth-production",
      ontology: promotionOntologySource,
    })).rejects.toThrow(/权威 Ontology 已在沙箱通过后发生变化/);
    expect(state.promotionRegressionStaged).not.toBeNull();
    expect(state.promotionRegressionAborted).toBe(true);
    expect(state.committedWorkflow).toBeNull();
  });

  it("blocks a literal ctx.tool call that is absent from the reviewed spec.tools", async () => {
    const spec = executableSpec();
    spec.generatedCode = spec.generatedCode!.replace(
      'ctx.emit("DONE", { source: "sandbox-code" });',
      'await ctx.tool("meta.ping", input); ctx.emit("DONE", { source: "sandbox-code" });',
    );
    installDraft(spec);

    await expect(promoteDrafts("truth-domain", {
      versionId: "v-truth",
      receiptId: "review-truth",
      slugs: ["truth-action"],
    }, {
      tenantId: "ten-truth",
      tenantSlug: "truth-production",
    })).rejects.toThrow(/执行所有权不安全|工具调用.*spec\.tools.*meta\.ping/s);
    expect(state.validatedWorkflow).toBeNull();
    expect(state.committedWorkflow).toBeNull();
  });

  it("blocks dynamic ctx.tool names even when the possible tool is reviewed", async () => {
    const spec = executableSpec();
    reviewPingTool(spec);
    spec.generatedCode = spec.generatedCode!.replace(
      'ctx.emit("DONE", { source: "sandbox-code" });',
      'const toolName = "meta.ping"; await ctx.tool(toolName, input); ctx.emit("DONE", { source: "sandbox-code" });',
    );
    installDraft(spec);

    await expect(promoteDrafts("truth-domain", {
      versionId: "v-truth",
      receiptId: "review-truth",
      slugs: ["truth-action"],
    }, {
      tenantId: "ten-truth",
      tenantSlug: "truth-production",
    })).rejects.toThrow(/执行所有权不安全|动态工具名不允许上线|动态工具名/s);
    expect(state.validatedWorkflow).toBeNull();
    expect(state.committedWorkflow).toBeNull();
  });

  it("blocks promotion when the current registry policy drifted after review", async () => {
    const spec = executableSpec();
    reviewPingTool(spec);
    installDraft(spec);
    state.currentTools[0] = {
      ...state.currentTools[0],
      operation: "write",
      effectScope: "external",
      sandboxPolicy: "requires_attempt_grant",
    };

    await expect(promoteDrafts("truth-domain", {
      versionId: "v-truth",
      receiptId: "review-truth",
      slugs: ["truth-action"],
    }, {
      tenantId: "ten-truth",
      tenantSlug: "truth-production",
    })).rejects.toThrow(/执行所有权不安全|工具库的执行策略.*不一致/s);
    expect(state.validatedWorkflow).toBeNull();
    expect(state.committedWorkflow).toBeNull();
  });

  it("blocks promotion before manifest validation when the current regression suite fails", async () => {
    state.replayPass = false;
    await expect(promoteDrafts("truth-domain", { versionId: "v-truth", receiptId: "review-truth", slugs: ["truth-action"] }, {
      tenantId: "ten-truth",
      tenantSlug: "truth-production",
    })).rejects.toThrow(/回归套件未通过/);
    expect(state.validatedWorkflow).toBeNull();
    expect(state.committedWorkflow).toBeNull();
  });

  it("blocks promotion when an external trigger has no fingerprint-bound approved case", async () => {
    state.replayEntryEvents = [];
    await expect(
      promoteDrafts(
        "truth-domain",
        {
          versionId: "v-truth",
          receiptId: "review-truth",
          slugs: ["truth-action"],
        },
        {
          tenantId: "ten-truth",
          tenantSlug: "truth-production",
        },
      ),
    ).rejects.toThrow(/外部平台输入 START.*没有明确批准的测试用例\/真实载荷/);
    expect(state.validatedWorkflow).toBeNull();
    expect(state.committedWorkflow).toBeNull();
  });

  it("blocks a green replay receipt that ran different bytes than the production handler", async () => {
    state.replayCodeHash = "b".repeat(64);
    await expect(promoteDrafts("truth-domain", { versionId: "v-truth", receiptId: "review-truth", slugs: ["truth-action"] }, {
      tenantId: "ten-truth",
      tenantSlug: "truth-production",
    })).rejects.toThrow(/同 SHA-256.*exact CodeAct regression replay/);
    expect(state.validatedWorkflow).toBeNull();
    expect(state.committedWorkflow).toBeNull();
  });

  it("blocks promotion when the sandbox dispatch ledger is unknown or contains an external live call", async () => {
    state.replayExternalLiveCalls = 1;
    await expect(promoteDrafts("truth-domain", { versionId: "v-truth", receiptId: "review-truth" }, {
      tenantId: "ten-truth",
      tenantSlug: "truth-production",
    })).rejects.toThrow(/externalLiveCalls=0/);
    expect(state.validatedWorkflow).toBeNull();

    state.replayExternalLiveCalls = null;
    state.replayEvidenceComplete = false;
    await expect(promoteDrafts("truth-domain", { versionId: "v-truth", receiptId: "review-truth" }, {
      tenantId: "ten-truth",
      tenantSlug: "truth-production",
    })).rejects.toThrow(/externalLiveCalls=0/);
    expect(state.committedWorkflow).toBeNull();
  });

  it("does not accept a legacy/rendered-module regression receipt for codeExecuted promotion", async () => {
    state.replayExecution = "rendered-module";
    await expect(promoteDrafts("truth-domain", { versionId: "v-truth", receiptId: "review-truth" }, {
      tenantId: "ten-truth",
      tenantSlug: "truth-production",
    })).rejects.toThrow(/exact CodeAct regression replay/);
    expect(state.validatedWorkflow).toBeNull();
  });

  it("blocks regression-suite substitution after the human receipt was signed", async () => {
    state.signedSelection[0]!.regressionSuiteFingerprint = `regression-suite:v1:${"c".repeat(64)}`;
    await expect(promoteDrafts("truth-domain", { versionId: "v-truth", receiptId: "review-truth" }, {
      tenantId: "ten-truth",
      tenantSlug: "truth-production",
    })).rejects.toThrow(/suite fingerprint.*HMAC receipt/);
    expect(state.validatedWorkflow).toBeNull();
  });

  it("blocks sandbox code/spec evidence substitution after human approval", async () => {
    state.signedSelection[0]!.sandboxEvidenceFingerprint = `sandbox-evidence:v5:${"d".repeat(64)}`;
    await expect(promoteDrafts("truth-domain", { versionId: "v-truth", receiptId: "review-truth" }, {
      tenantId: "ten-truth",
      tenantSlug: "truth-production",
    })).rejects.toThrow(/code\/spec evidence fingerprint.*HMAC receipt/);
    expect(state.validatedWorkflow).toBeNull();
  });

  it("blocks sandbox cleanup-receipt substitution after human approval", async () => {
    state.signedSelection[0]!.sandboxCleanupReceiptHash = `sandbox-cleanup:v1:${"f".repeat(64)}`;
    await expect(promoteDrafts("truth-domain", { versionId: "v-truth", receiptId: "review-truth" }, {
      tenantId: "ten-truth",
      tenantSlug: "truth-production",
    })).rejects.toThrow(/App 删除回执.*HMAC receipt/);
    expect(state.validatedWorkflow).toBeNull();
  });

  it("fails instead of downgrading when production CodeAct lacks handler bytes", async () => {
    const broken = executableSpec();
    broken.generatedCode = undefined;
    state.drafts[0]!.spec = broken;
    await expect(promoteDrafts("truth-domain", { versionId: "v-truth", receiptId: "review-truth" }, {
      tenantId: "ten-truth",
      tenantSlug: "truth-production",
    })).rejects.toThrow(/without generated handler bytes/);
    expect(state.validatedWorkflow).toBeNull();
  });

  it("rejects a signed selection whose exact immutable module hash no longer matches", async () => {
    state.moduleCode += "\n// tampered after sign-off\n";
    await expect(promoteDrafts("truth-domain", { versionId: "v-truth", receiptId: "review-truth" }, {
      tenantId: "ten-truth",
      tenantSlug: "truth-production",
    })).rejects.toThrow(/spec\/module hash/);
    expect(state.validatedWorkflow).toBeNull();
  });

  it("blocks an unbounded existing↔new event cycle in the merged live fleet", async () => {
    const spec = executableSpec();
    spec.inputSchema = [{ field: "candidate_id", type: "string" }];
    spec.outputSchema = [{ field: "candidate_id", type: "string" }];
    installDraft(spec);
    state.live = [{
      id: "existing-loop",
      name: "existingLoop",
      actor: ["Agent"],
      trigger: ["DONE"],
      triggered_event: ["START"],
      actions: [{ order: "1", name: "existingLoop", description: "", type: "logic" }],
      tool_use: [],
      factory_input_schema: [{ field: "candidate_id", type: "string" }],
      factory_output_schema: [{ field: "candidate_id", type: "string" }],
    }];

    await expect(promoteDrafts("truth-domain", { versionId: "v-truth", receiptId: "review-truth" }, {
      tenantId: "ten-truth",
      tenantSlug: "truth-production",
    })).rejects.toThrow(/live\+candidate.*无界事件环.*existing-loop.*truth-action/s);
    expect(state.validatedWorkflow).toBeNull();
    expect(state.committedWorkflow).toBeNull();
  });

  it("blocks payload contract type drift across a new→existing event edge", async () => {
    const spec = executableSpec();
    spec.inputSchema = [];
    spec.outputSchema = [{ field: "candidate_id", type: "number" }];
    installDraft(spec);
    state.live = [{
      id: "existing-consumer",
      name: "existingConsumer",
      actor: ["Agent"],
      trigger: ["DONE"],
      triggered_event: ["FINISHED"],
      actions: [{ order: "1", name: "existingConsumer", description: "", type: "logic" }],
      tool_use: [],
      factory_input_schema: [{ field: "candidate_id", type: "string" }],
      factory_output_schema: [],
    }];

    await expect(promoteDrafts("truth-domain", { versionId: "v-truth", receiptId: "review-truth" }, {
      tenantId: "ten-truth",
      tenantSlug: "truth-production",
    })).rejects.toThrow(/payload 字段「candidate_id」类型不兼容.*number.*string/s);
    expect(state.validatedWorkflow).toBeNull();
    expect(state.committedWorkflow).toBeNull();
  });
});
