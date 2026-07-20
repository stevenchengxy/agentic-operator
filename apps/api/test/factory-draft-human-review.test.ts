import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  SANDBOX_CLEANUP_RECEIPT_SCHEMA,
  SANDBOX_RUN_DRAIN_RECEIPT_SCHEMA,
  sandboxCleanupReceiptHash,
  sandboxDesignReviewSubjectDigest,
  sandboxRunDrainReceiptHash,
  ontologyContentHash,
  canonicalEvidenceJson,
  type AgentDraftRegressionEvidence,
  type DomainOntology,
  type GeneratedAgentSpec,
  type SandboxCleanupReceipt,
} from "@agentic/agent-factory";
import { makeToolCassetteEntry } from "@agentic/shared/cassette";

const state = vi.hoisted(() => ({
  live: [] as unknown[],
  deploymentMutations: 0,
  ontologyRevision: 1,
  ontologyUnavailable: false,
  productionProbeBlocked: false,
}));

vi.mock("../src/services/manifest-import", () => ({
  loadLiveManifest: () => state.live,
  validate: async () => { state.deploymentMutations += 1; return { issues: [], deployment_id: "must-not-exist" }; },
  commit: async () => { state.deploymentMutations += 1; return {}; },
  removeTenantModelDirs: async () => undefined,
}));

vi.mock("../src/services/agent-factory/bound-ontology-source", () => ({
  makeBoundFactoryOntologySource: () => ({
    listDomains: async () => [{ id: "review-domain" }],
    fetchOntology: async () => {
      if (state.ontologyUnavailable) throw new Error("Allmeta unavailable");
      return authoritativeOntology(state.ontologyRevision);
    },
    fetchActionRules: async () => [],
  }),
}));

vi.mock("../src/services/agent-factory/execution-resource-snapshot", () => ({
  currentFactoryExecutionTools: async () => [{
    name: "parseResumeApi",
    operation: "read",
    effectScope: "external",
    sandboxPolicy: "live_external",
  }],
}));

vi.mock("../src/services/agent-factory/production-integration-probe-gate", () => ({
  verifyProductionIntegrationProbeEvidence: async () => state.productionProbeBlocked
    ? [{ code: "production_live_probe_missing", tool: "parseResumeApi", specSlugs: ["resume-agent"] }]
    : [],
  productionIntegrationProbeIssueMessage: () => "production probe blocked",
}));

import { FsAgentDraftStore } from "../src/services/agent-factory/agent-draft-store";
import {
  createHumanReviewReceipt,
  previewDraftPromotion,
  verifyHumanReviewReceipt,
} from "../src/services/agent-factory/draft-review";
import { makePromotableSandboxExecutionEvidence } from "./factory-sandbox-execution-fixture";
import { makePromotableSandboxRegistrationEvidence } from "./factory-sandbox-registration-fixture";
import { buildProductionCodeAttestations, mapToManifest } from "../src/services/agent-factory/sandbox-deployer";
import {
  attestLiveProbeCassette,
  cassetteConfigHash,
} from "../src/services/agent-factory/cassette-evidence-attestation";
import { sandboxToolBindingId } from "../src/services/agent-factory/sandbox-bundle-builder";

const domain = "review-domain";
const authoritativeOntology = (revision = 1): DomainOntology => ({
  domainId: domain,
  source: "allmeta",
  objects: [],
  rules: revision === 1 ? [] : [{ id: "changed-rule" }],
  actions: [],
  events: [],
  workflow: [],
});
const ctx = {
  tenantId: "ten-review",
  tenantSlug: "review-tenant",
};

function spec(over: Partial<GeneratedAgentSpec> = {}): GeneratedAgentSpec {
  return {
    key: "processResume",
    actionName: "processResume",
    slug: "resume-agent",
    short: "ResumeAgent",
    domainId: domain,
    nameZh: "简历处理",
    kind: "llm",
    trigger: ["RESUME_DOWNLOADED"],
    emit: ["RESUME_PROCESSED"],
    tools: ["parseResumeApi"],
    toolSideEffects: { parseResumeApi: "read" },
    toolPolicies: {
      parseResumeApi: {
        operation: "read",
        effectScope: "external",
        sandboxPolicy: "live_external",
      },
    },
    toolConfigs: {},
    unresolvedTools: [],
    objects: ["Candidate"],
    systemPrompt: "解析简历并输出结构化候选人信息。",
    userPrompt: "",
    steps: [],
    ruleRefs: ["resume-required-fields"],
    retries: 1,
    hitl: false,
    confidence: 1,
    promptSource: "llm",
    inputSchema: [{ field: "upload_id", type: "string", source: "Resume.upload_id" }],
    outputSchema: [{ field: "candidate_id", type: "string", source: "Candidate.candidate_id" }],
    ...over,
  } as GeneratedAgentSpec;
}

let root: string;
let priorRoot: string | undefined;
let priorSecret: string | undefined;

beforeEach(async () => {
  priorRoot = process.env.AGENTIC_DATA_ROOT;
  priorSecret = process.env.AGENTIC_REVIEW_SIGNING_SECRET;
  root = await fs.mkdtemp(path.join(os.tmpdir(), "factory-human-review-"));
  process.env.AGENTIC_DATA_ROOT = root;
  process.env.AGENTIC_REVIEW_SIGNING_SECRET = "unit-test-review-secret";
  state.live = [{
    id: "resume-agent",
    name: "old resume",
    actor: ["Agent"],
    trigger: ["OLD_RESUME"],
    triggered_event: ["OLD_DONE"],
    actions: [{ name: "old", type: "logic" }],
    tool_use: [{ name: "legacyParser", config: { authorization: "must-not-leak" } }],
    factory_input_schema: [{ field: "old", type: "string" }],
  }];
  state.deploymentMutations = 0;
  state.ontologyRevision = 1;
  state.ontologyUnavailable = false;
  state.productionProbeBlocked = false;
});

afterEach(async () => {
  if (priorRoot === undefined) delete process.env.AGENTIC_DATA_ROOT;
  else process.env.AGENTIC_DATA_ROOT = priorRoot;
  if (priorSecret === undefined) delete process.env.AGENTIC_REVIEW_SIGNING_SECRET;
  else process.env.AGENTIC_REVIEW_SIGNING_SECRET = priorSecret;
  await fs.rm(root, { recursive: true, force: true });
});

async function evidence(): Promise<AgentDraftRegressionEvidence> {
  const fingerprint = "sandbox-evidence:v2:human-review";
  const subjectDigest = sandboxDesignReviewSubjectDigest({ domain, fingerprint });
  const cleanupBody: Omit<SandboxCleanupReceipt, "absenceProbeHash"> = {
    schema: SANDBOX_CLEANUP_RECEIPT_SCHEMA,
    appId: "factory-test-af-sbx-review",
    sandboxTenantSlug: "af-sbx-aaaaaaaa-bbbbbbbb-cccccccccccc-sb",
    sandboxAttemptId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    candidateFingerprint: fingerprint,
    targetDomainId: domain,
    runDrain: (() => {
      const body = {
        schema: SANDBOX_RUN_DRAIN_RECEIPT_SCHEMA,
        sandboxAttemptId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        appId: "factory-test-af-sbx-review",
        sandboxTenantSlug: "af-sbx-aaaaaaaa-bbbbbbbb-cccccccccccc-sb",
        startedAt: new Date(0).toISOString(),
        completedAt: new Date(0).toISOString(),
        observedRuns: [],
      };
      return { ...body, evidenceHash: sandboxRunDrainReceiptHash(body) };
    })(),
    deletedAt: new Date(0).toISOString(),
    absence: { connected: false, functionCount: null, registryState: "not_registered" },
  };
  const cleanupReceipt = {
    ...cleanupBody,
    absenceProbeHash: sandboxCleanupReceiptHash(cleanupBody),
  };
  const definitionHash = "d".repeat(64);
  const cassettePath = path.join(root, "cassettes", "parseResumeApi.json");
  const recordedAt = new Date().toISOString();
  const cassette = attestLiveProbeCassette({
    version: 1,
    tool: { name: "parseResumeApi", definitionHash, schemaHash: "schema-review-1" },
    evidence: { recordedAt, mode: "live-probe" },
    entries: [makeToolCassetteEntry({
      toolName: "parseResumeApi",
      args: { upload_id: "review-upload", results: {} },
      status: 200,
      body: { candidate_id: "candidate-review" },
      recordedAt,
    })],
  }, {
    tenantId: ctx.tenantId,
    tenantSlug: ctx.tenantSlug,
    domainId: domain,
    toolName: "parseResumeApi",
    definitionHash,
    config: {},
    actor: "usr-review-prober",
  });
  await fs.mkdir(path.dirname(cassettePath), { recursive: true });
  await fs.writeFile(cassettePath, canonicalEvidenceJson(cassette), "utf8");
  const configHash = cassetteConfigHash({});
  return {
    evidenceFingerprint: fingerprint,
    authoritativeOntology: {
      schema: "agent-factory-authoritative-ontology/v1",
      tenantId: ctx.tenantId,
      tenantSlug: ctx.tenantSlug,
      domainId: domain,
      source: authoritativeOntology().source,
      contentHash: ontologyContentHash(authoritativeOntology()),
    },
    cleanupReceipt,
    ...makePromotableSandboxRegistrationEvidence(cleanupReceipt.appId, ["resume-agent"]),
    ...makePromotableSandboxExecutionEvidence({
      candidateFingerprint: fingerprint,
      targetDomainId: domain,
      targetTenantId: ctx.tenantId,
      targetTenantSlug: ctx.tenantSlug,
      sandboxAttemptId: cleanupReceipt.sandboxAttemptId,
      agentRefs: ["resume-agent"],
    }),
    approvedTestCases: [{
      id: "resume-happy",
      name: "简历正常处理",
      scenario: "输入已确认的简历编号并到达成功终态",
      kind: "pass",
      entryEvent: "RESUME_DOWNLOADED",
      payload: { upload_id: "review-upload" },
      expectedOutcome: "发出 RESUME_PROCESSED",
      expectedEvent: "RESUME_PROCESSED",
    }],
    functionTester: [{ short: "ResumeAgent", pass: true, ran: true, emitNames: ["RESUME_PROCESSED"], reasons: [], tier: "worker", fixtureMode: "scripted", qualification: "promotable" }],
    toolMode: "evidence_replay",
    externalLiveCalls: 0,
    sandboxReplayEvidenceComplete: true,
    replayReceipts: [],
    cassetteRefs: [{
      bindingId: sandboxToolBindingId({
        specSlugs: ["resume-agent"],
        toolName: "parseResumeApi",
        configHash,
        definitionHash,
      }),
      specSlugs: ["resume-agent"],
      tool: "parseResumeApi",
      path: cassettePath,
      definitionHash,
      schemaHash: "schema-review-1",
      evidenceMode: "live-probe",
      configHash,
      attestationKeyId: cassette.evidence!.attestation!.keyId,
      attestationExpiresAt: cassette.evidence!.attestation!.expiresAt,
    }],
    sandboxDesignReview: {
      fingerprint,
      subjectDigest,
      receipt: {
        challengeId: "fac-human-review",
        kind: "sandbox_design_review",
        protocolVersion: 1,
        digest: "f".repeat(64),
        subjectDigest,
        authorizationDigest: "a".repeat(64),
        actor: "usr-sandbox-reviewer",
        runId: "factory-human-review-run",
        conversationId: "factory-human-review-run",
        consumedAt: "1970-01-01T00:00:00.000Z",
        expiresAt: "1970-01-01T00:15:00.000Z",
      },
    },
  };
}

async function savedStore(): Promise<{ store: FsAgentDraftStore; versionId: string }> {
  const store = new FsAgentDraftStore({ ...ctx, ontologyDomainId: domain });
  await store.save(domain, [spec()], await evidence());
  const [version] = await store.listVersions(domain);
  return { store, versionId: version!.versionId };
}

describe("Agent Factory immutable draft review", () => {
  it("keeps replay-ready evidence reviewable but disables sign-off when the current production probe is missing", async () => {
    const { versionId } = await savedStore();
    state.productionProbeBlocked = true;
    const preview = await previewDraftPromotion(domain, { versionId }, ctx);
    expect(preview.evidence).toMatchObject({
      replayReady: true,
      promotionGateAdmission: true,
      promotionEvidenceReady: true,
      promotionEligible: false,
      promotionBlockers: ["production probe blocked"],
    });
    await expect(createHumanReviewReceipt({
      domain,
      versionId,
      reviewChallenge: preview.reviewChallenge,
      decision: "approve_code_and_design",
      codeReviewed: true,
      designReviewed: true,
      reviewer: { userId: "usr-reviewer", email: null, name: null, via: "cookie" },
      ctx,
    })).rejects.toThrow("沙箱编排已验证，当前不能上线");
  });

  it("refuses a repeat preview when the exact version is already live", async () => {
    const { store, versionId } = await savedStore();
    const draft = (await store.getVersion(domain, versionId))[0]!;
    state.live = mapToManifest([draft.spec], {
      target: "production",
      targetDomainId: domain,
      productionCodeAttestations: buildProductionCodeAttestations([draft.spec]),
      productionProvenance: {
        versionId,
        suiteFingerprint: draft.regression!.suiteFingerprint,
      },
    });
    await expect(previewDraftPromotion(domain, { versionId }, ctx)).rejects.toThrow(/no changes|already live/);
    expect(state.deploymentMutations).toBe(0);
  });

  it("previews agents/events/tools/config/contracts without creating a deployment or receipt", async () => {
    const { versionId } = await savedStore();
    const preview = await previewDraftPromotion(domain, { versionId }, ctx);

    expect(preview.delta.agents).toMatchObject({ modified: ["resume-agent"], removed: [] });
    expect(preview.delta.events.added).toEqual(expect.arrayContaining(["RESUME_DOWNLOADED", "RESUME_PROCESSED"]));
    expect(preview.delta.events.removed).toEqual(expect.arrayContaining(["OLD_DONE", "OLD_RESUME"]));
    expect(preview.delta.tools).toEqual({ added: ["parseResumeApi"], removed: ["legacyParser"] });
    expect(preview.delta.config).toEqual(expect.arrayContaining([
      expect.objectContaining({ tool: "parseResumeApi", change: "added" }),
      expect.objectContaining({ tool: "legacyParser", change: "removed", before: { authorization: "[REDACTED]" } }),
    ]));
    expect(preview.delta.contracts[0]).toMatchObject({ agentId: "resume-agent", change: "modified" });
    expect(preview.selection[0]).toMatchObject({
      slug: "resume-agent",
      specHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      moduleHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      sandboxCleanupReceiptHash: expect.stringMatching(/^sandbox-cleanup:v1:[a-f0-9]{64}$/),
    });
    expect(preview.reviewChallenge).toMatch(/^review-challenge:v1:/);
    expect(state.deploymentMutations).toBe(0);
    await expect(fs.access(path.join(root, "factory-drafts", "_tenants", ctx.tenantId, "reviews"))).rejects.toThrow();
  });

  it("persists separate cassette bindings when two agents use one tool with different configs", async () => {
    const first = spec();
    const second = spec({
      key: "processResumeSecondary",
      actionName: "processResumeSecondary",
      slug: "resume-agent-secondary",
      short: "ResumeAgentSecondary",
      nameZh: "简历处理（二线）",
      trigger: ["RESUME_DOWNLOADED_SECONDARY"],
      emit: ["RESUME_PROCESSED_SECONDARY"],
      sandboxToolConfigs: { parseResumeApi: { profile_marker: "secondary" } },
    });
    const ev = await evidence();
    const definitionHash = "e".repeat(64);
    const config = { profile_marker: "secondary" };
    const configHash = cassetteConfigHash(config);
    const recordedAt = new Date().toISOString();
    const cassettePath = path.join(root, "cassettes", "parseResumeApi-secondary.json");
    const cassette = attestLiveProbeCassette({
      version: 1,
      tool: { name: "parseResumeApi", definitionHash, schemaHash: "schema-review-secondary" },
      evidence: { recordedAt, mode: "live-probe" },
      entries: [makeToolCassetteEntry({
        toolName: "parseResumeApi",
        args: { upload_id: "secondary", results: {} },
        status: 200,
        body: { candidate_id: "candidate-secondary" },
        recordedAt,
      })],
    }, {
      tenantId: ctx.tenantId,
      tenantSlug: ctx.tenantSlug,
      domainId: domain,
      toolName: "parseResumeApi",
      definitionHash,
      config,
      actor: "usr-review-prober",
    });
    await fs.writeFile(cassettePath, canonicalEvidenceJson(cassette), "utf8");
    ev.cassetteRefs!.push({
      bindingId: sandboxToolBindingId({
        specSlugs: [second.slug],
        toolName: "parseResumeApi",
        configHash,
        definitionHash,
      }),
      specSlugs: [second.slug],
      tool: "parseResumeApi",
      path: cassettePath,
      definitionHash,
      schemaHash: "schema-review-secondary",
      evidenceMode: "live-probe",
      configHash,
      attestationKeyId: cassette.evidence!.attestation!.keyId,
      attestationExpiresAt: cassette.evidence!.attestation!.expiresAt,
    });
    Object.assign(ev, makePromotableSandboxRegistrationEvidence(
      ev.cleanupReceipt!.appId,
      [first.slug, second.slug],
    ));
    Object.assign(ev, makePromotableSandboxExecutionEvidence({
      candidateFingerprint: ev.evidenceFingerprint,
      targetDomainId: domain,
      targetTenantId: ctx.tenantId,
      targetTenantSlug: ctx.tenantSlug,
      sandboxAttemptId: ev.cleanupReceipt!.sandboxAttemptId,
      agentRefs: [first.slug, second.slug],
    }));
    ev.functionTester!.push({
      short: second.short,
      pass: true,
      ran: true,
      emitNames: second.emit,
      reasons: [],
      tier: "worker",
      fixtureMode: "scripted",
      qualification: "promotable",
    });

    const store = new FsAgentDraftStore({ ...ctx, ontologyDomainId: domain });
    await expect(store.save(domain, [first, second], ev)).resolves.toBe(2);
    const versionId = (await store.listVersions(domain))[0]!.versionId;
    const tenantDraftRoot = path.join(root, "factory-drafts", "_tenants", ctx.tenantId);
    const [domainDir] = await fs.readdir(tenantDraftRoot);
    const artifact = JSON.parse(await fs.readFile(
      path.join(tenantDraftRoot, domainDir!, "versions", versionId, "regression.json"),
      "utf8",
    ));
    expect(artifact.cassetteRefs).toHaveLength(2);
    expect(new Set(artifact.cassetteRefs.map((ref: { bindingId: string }) => ref.bindingId)).size).toBe(2);
  });

  it("mints only interactive human receipts and invalidates them on live-manifest drift", async () => {
    const { versionId } = await savedStore();
    const preview = await previewDraftPromotion(domain, { versionId }, ctx);
    const common = {
      domain,
      versionId,
      reviewChallenge: preview.reviewChallenge,
      decision: "approve_code_and_design" as const,
      codeReviewed: true,
      designReviewed: true,
      ctx,
    };
    await expect(createHumanReviewReceipt({
      ...common,
      reviewer: { userId: "usr-model", email: null, name: "automation", via: "token" },
    })).rejects.toThrow(/interactive human identity/);

    const receipt = await createHumanReviewReceipt({
      ...common,
      reviewer: { userId: "usr-human", email: "human@example.test", name: "Human", via: "cookie" },
    });
    expect(receipt.actor.userId).toBe("usr-human");
    await expect(verifyHumanReviewReceipt({ domain, versionId, receiptId: receipt.receiptId, ctx })).resolves.toMatchObject({
      receipt: { receiptId: receipt.receiptId },
    });

    const liveBeforeDrift = state.live;
    state.live = [];
    await expect(verifyHumanReviewReceipt({ domain, versionId, receiptId: receipt.receiptId, ctx })).rejects.toThrow(/stale/);

    state.live = liveBeforeDrift;
    const tenantDraftRoot = path.join(root, "factory-drafts", "_tenants", ctx.tenantId);
    const [domainDir] = await fs.readdir(tenantDraftRoot);
    const receiptPath = path.join(tenantDraftRoot, domainDir!, "reviews", `${receipt.receiptId}.json`);
    const forged = JSON.parse(await fs.readFile(receiptPath, "utf8"));
    forged.actor.userId = "model-self-asserted";
    await fs.writeFile(receiptPath, JSON.stringify(forged), "utf8");
    await expect(verifyHumanReviewReceipt({ domain, versionId, receiptId: receipt.receiptId, ctx })).rejects.toThrow(/signature mismatch/);
  });

  it("forks structured edits into a new evidence-less version and preserves the base bytes", async () => {
    const { store, versionId } = await savedStore();
    const baseCode = await store.getCode(domain, "resume-agent", versionId);
    const basePreview = await previewDraftPromotion(domain, { versionId }, ctx);
    const baseReview = await createHumanReviewReceipt({
      domain,
      versionId,
      reviewChallenge: basePreview.reviewChallenge,
      decision: "approve_code_and_design",
      codeReviewed: true,
      designReviewed: true,
      reviewer: { userId: "usr-base-reviewer", email: null, name: "Base Reviewer", via: "cookie" },
      ctx,
    });
    const patched = await store.createPatchedVersion(domain, versionId, "resume-agent", {
      set: { systemPrompt: "人工修改后的决策设计。", retries: 2 },
    });

    expect(patched.versionId).not.toBe(versionId);
    expect(patched.regressionReady).toBe(false);
    expect(patched.drafts[0]?.spec.systemPrompt).toBe("人工修改后的决策设计。");
    expect(patched.drafts[0]?.regression).toBeUndefined();
    expect((await store.getVersion(domain, versionId))[0]?.spec.systemPrompt).toBe(spec().systemPrompt);
    expect(await store.getCode(domain, "resume-agent", versionId)).toBe(baseCode);
    await expect(verifyHumanReviewReceipt({
      domain,
      versionId: patched.versionId,
      receiptId: baseReview.receiptId,
      ctx,
    })).rejects.toThrow(/stale|version|selection|mismatch/i);
    await expect(store.replayRegression(domain, ["resume-agent"], patched.versionId)).resolves.toMatchObject({ pass: false });
    await expect(store.createPatchedVersion(domain, patched.versionId, "resume-agent", {
      set: { systemPrompt: "人工修改后的决策设计。" },
    })).rejects.toThrow(/完全相同/);

    await expect(store.createPatchedVersion(domain, patched.versionId, "resume-agent", {
      set: { slug: "hijacked" },
    })).rejects.toThrow(/先更新 Allmeta Ontology 后重新生成/);
    await expect(store.createPatchedVersion(domain, patched.versionId, "resume-agent", {
      set: { toolConfigs: { parseResumeApi: { api_key: "literal-secret" } } },
    })).rejects.toThrow(/密钥|凭证/);
  });

  it("keeps Ontology-derived and Agent identity fields read-only while safe implementation fields remain editable", async () => {
    const { store, versionId } = await savedStore();
    const ontologyDerived: Record<string, unknown> = {
      trigger: ["OTHER_TRIGGER"],
      emit: ["OTHER_RESULT"],
      integrationRequirements: [],
      integrationBindings: [],
      objects: ["OtherObject"],
      stateBindings: [],
      ruleRefs: ["other-rule"],
      inputSchema: [{ field: "other_input", type: "string" }],
      outputSchema: [{ field: "other_output", type: "string" }],
    };
    for (const [field, value] of Object.entries(ontologyDerived)) {
      await expect(store.createPatchedVersion(domain, versionId, "resume-agent", {
        set: { [field]: value },
      }), `set.${field}`).rejects.toThrow(/先更新 Allmeta Ontology 后重新生成/);
      await expect(store.createPatchedVersion(domain, versionId, "resume-agent", {
        unset: [field],
      }), `unset.${field}`).rejects.toThrow(/先更新 Allmeta Ontology 后重新生成/);
    }
    for (const field of ["key", "actionName", "slug", "short", "domainId"]) {
      await expect(store.createPatchedVersion(domain, versionId, "resume-agent", {
        set: { [field]: "hijacked" },
      }), `set.${field}`).rejects.toThrow(/先更新 Allmeta Ontology 后重新生成/);
      await expect(store.createPatchedVersion(domain, versionId, "resume-agent", {
        unset: [field],
      }), `unset.${field}`).rejects.toThrow(/先更新 Allmeta Ontology 后重新生成/);
    }

    await expect(store.createPatchedVersion(domain, versionId, "resume-agent", {
      set: {
        systemPrompt: "人工修订后的安全提示词。",
        designReasoning: "人工补充实现说明。",
      },
    })).resolves.toMatchObject({ regressionReady: false });
  });

  it("keeps a failed fresh regression bundle for audit but marks it permanently not promotable", async () => {
    const { store, versionId } = await savedStore();
    const sandboxed = await store.createSandboxedVersion(domain, versionId, await evidence());
    expect(sandboxed).toMatchObject({ regressionReady: false, regressionStatus: "pending_replay" });
    expect((await store.listVersions(domain)).find((version) => version.versionId === sandboxed.versionId)).toMatchObject({
      regressionReady: false,
      regressionStatus: "pending_replay",
    });
    await expect(store.replayRegression(domain, ["resume-agent"], sandboxed.versionId)).resolves.toMatchObject({
      pass: false,
      errors: [expect.stringContaining("pending_replay")],
    });

    const tenantDraftRoot = path.join(root, "factory-drafts", "_tenants", ctx.tenantId);
    const [domainDir] = await fs.readdir(tenantDraftRoot);
    const immutableArtifact = path.join(tenantDraftRoot, domainDir!, "versions", sandboxed.versionId, "regression.json");
    await fs.writeFile(immutableArtifact, "{ deliberately-corrupt-for-replay-test\n", "utf8");

    const replay = await store.validateSandboxedRegression(domain, ["resume-agent"], sandboxed.versionId);
    expect(replay.pass).toBe(false);
    expect(replay.errors.length).toBeGreaterThan(0);
    expect((await store.listVersions(domain)).find((version) => version.versionId === sandboxed.versionId)).toMatchObject({
      regressionReady: false,
      regressionStatus: "invalid",
    });
    await expect(store.replayRegression(domain, ["resume-agent"], sandboxed.versionId)).resolves.toMatchObject({
      pass: false,
      errors: [expect.stringContaining("invalid")],
    });
    // The failed immutable evidence is retained for audit; only its separate
    // validation sidecar blocks promotion.
    await expect(fs.access(immutableArtifact)).resolves.toBeUndefined();
  });

  it("publishes ready only after the exact fresh artifact replays successfully", async () => {
    const store = new FsAgentDraftStore({ ...ctx, ontologyDomainId: domain });
    await store.save(domain, [spec({
      tools: [],
      toolSideEffects: {},
      toolPolicies: {},
      toolConfigs: {},
      toolProfileRefs: {},
      sandboxToolConfigs: {},
      sandboxToolProfileRefs: {},
      unresolvedTools: [],
      plan: [],
    })]);
    const versionId = (await store.listVersions(domain))[0]!.versionId;
    const readyEvidence = await evidence();
    readyEvidence.approvedTestCases = [{
      id: "resume-happy",
      name: "简历正常处理",
      scenario: "输入已确认的简历编号并到达成功终态",
      kind: "pass",
      entryEvent: "RESUME_DOWNLOADED",
      payload: { upload_id: "upload-1" },
      expectedOutcome: "发出 RESUME_PROCESSED",
      expectedEvent: "RESUME_PROCESSED",
    }];
    const sandboxed = await store.createSandboxedVersion(domain, versionId, readyEvidence);
    expect((await store.list(domain))[0]!.versionId).toBe(versionId);
    const replay = await store.validateSandboxedRegression(domain, ["resume-agent"], sandboxed.versionId);
    expect(replay.pass, replay.errors.join("; ")).toBe(true);
    expect((await store.listVersions(domain)).find((version) => version.versionId === sandboxed.versionId)).toMatchObject({
      replayReady: true,
      regressionReady: true,
      regressionStatus: "ready",
      promotionGateAdmission: true,
      promotionEvidenceReady: true,
      // Store summaries do not own current production readiness; the API
      // derives this separately from live profiles/probes.
      promotionEligible: false,
      evidenceQualification: { replay: "sandbox_verified", promotion: "candidate" },
    });
    // A green receipt is necessary but not sufficient to move the mutable
    // projection. The finish transaction publishes only after this exact
    // replay is durable; red/pending versions remain history-only.
    expect((await store.list(domain))[0]!.versionId).toBe(versionId);
    await store.publishValidatedVersion(domain, sandboxed.versionId, versionId);
    expect((await store.list(domain))[0]!.versionId).toBe(sandboxed.versionId);
    await expect(store.replayRegression(domain, ["resume-agent"], sandboxed.versionId)).resolves.toMatchObject({ pass: true });
  });
});
