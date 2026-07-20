import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";

import {
  SANDBOX_CLEANUP_RECEIPT_SCHEMA,
  SANDBOX_RUN_DRAIN_RECEIPT_SCHEMA,
  sandboxCleanupReceiptHash,
  sandboxDesignReviewSubjectDigest,
  sandboxRunDrainReceiptHash,
  ontologyContentHash,
  type GeneratedAgentSpec,
  type SandboxCleanupReceipt,
} from "@agentic/agent-factory";
import { auditLog, getDb, tenants, users } from "@agentic/db";
import { and, eq } from "drizzle-orm";

const state = vi.hoisted(() => ({
  domain: "route-review-domain",
  live: [] as unknown[],
  via: "cookie" as "cookie" | "token",
  ontologyRevision: 1,
  ontologyUnavailable: false,
}));

const routeOntology = () => ({
  domainId: state.domain,
  source: "allmeta" as const,
  objects: [],
  rules: [{ id: `rule-v${state.ontologyRevision}` }],
  actions: [],
  events: [],
  workflow: [],
});

vi.mock("../src/services/manifest-import", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/manifest-import")>();
  return { ...actual, loadLiveManifest: () => state.live };
});

vi.mock("../src/services/agent-factory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/agent-factory")>();
  return {
    ...actual,
    makeFactoryPorts: () => ({ ontology: {
      listDomains: async () => [{ id: state.domain, name: "Route Review", description: "", actionCount: 1 }],
      fetchOntology: async () => {
        if (state.ontologyUnavailable) throw new Error("Allmeta unavailable");
        return routeOntology();
      },
      fetchActionRules: async () => [],
    } }),
  };
});

vi.mock("../src/services/agent-factory/bound-ontology-source", () => ({
  makeBoundFactoryOntologySource: () => ({
    listDomains: async () => [{ id: state.domain }],
    fetchOntology: async () => {
      if (state.ontologyUnavailable) throw new Error("Allmeta unavailable");
      return routeOntology();
    },
    fetchActionRules: async () => [],
  }),
}));

vi.mock("../src/services/agent-factory/domain-binding", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/agent-factory/domain-binding")>();
  return {
    ...actual,
    getFactoryDomainBinding: () => ({ ontologyDomainId: state.domain, ontologyDomainName: "Route Review", source: "explicit" }),
    bindingMatchesDomain: (_binding: unknown, requested: string) => requested === state.domain,
  };
});

import { registerEnvelope } from "../src/plugins/error";
import { agentFactoryRoutes } from "../src/routes/v1/agent-factory";
import { FsAgentDraftStore } from "../src/services/agent-factory/agent-draft-store";
import { makePromotableSandboxExecutionEvidence } from "./factory-sandbox-execution-fixture";
import { makePromotableSandboxRegistrationEvidence } from "./factory-sandbox-registration-fixture";

const tenantId = `ten-review-route-${Date.now().toString(36)}`;
const tenantSlug = `review-route-${Date.now().toString(36)}`;
const userId = `usr-review-route-${Date.now().toString(36)}`;
let root: string;
let oldRoot: string | undefined;
let oldSecret: string | undefined;
let app: ReturnType<typeof Fastify>;
let versionId: string;

function spec(): GeneratedAgentSpec {
  return {
    key: "routeReview",
    actionName: "routeReview",
    slug: "route-review-agent",
    short: "RouteReviewAgent",
    domainId: state.domain,
    nameZh: "路由签核",
    kind: "llm",
    trigger: ["ROUTE_START"],
    emit: ["ROUTE_DONE"],
    tools: [],
    unresolvedTools: [],
    objects: [],
    systemPrompt: "执行经人工审阅的路由测试设计。",
    userPrompt: "",
    steps: [],
    ruleRefs: [],
    retries: 1,
    hitl: false,
    confidence: 1,
    promptSource: "llm",
  } as GeneratedAgentSpec;
}

function cleanupReceipt(): SandboxCleanupReceipt {
  const attemptId = "44444444-4444-4444-8444-444444444444";
  const appId = "factory-test-af-sbx-route-review";
  const sandboxTenantSlug = "af-sbx-44444444-55555555-666666666666-sb";
  const drainBody = {
    schema: SANDBOX_RUN_DRAIN_RECEIPT_SCHEMA,
    sandboxAttemptId: attemptId,
    appId,
    sandboxTenantSlug,
    startedAt: new Date(0).toISOString(),
    completedAt: new Date(0).toISOString(),
    observedRuns: [],
  };
  const body: Omit<SandboxCleanupReceipt, "absenceProbeHash"> = {
    schema: SANDBOX_CLEANUP_RECEIPT_SCHEMA,
    appId,
    sandboxTenantSlug,
    sandboxAttemptId: attemptId,
    candidateFingerprint: "sandbox-evidence:v2:route-review",
    targetDomainId: state.domain,
    runDrain: { ...drainBody, evidenceHash: sandboxRunDrainReceiptHash(drainBody) },
    deletedAt: new Date(0).toISOString(),
    absence: { connected: false, functionCount: null, registryState: "not_registered" },
  };
  return { ...body, absenceProbeHash: sandboxCleanupReceiptHash(body) };
}

beforeAll(async () => {
  oldRoot = process.env.AGENTIC_DATA_ROOT;
  oldSecret = process.env.AGENTIC_REVIEW_SIGNING_SECRET;
  root = await fs.mkdtemp(path.join(os.tmpdir(), "factory-review-routes-"));
  process.env.AGENTIC_DATA_ROOT = root;
  process.env.AGENTIC_REVIEW_SIGNING_SECRET = "route-test-signing-secret";
  const now = new Date();
  getDb().insert(users).values({ id: userId, email: `${userId}@example.test`, name: "Route Human", platformRole: "superadmin", status: "active", createdAt: now, updatedAt: now }).run();
  getDb().insert(tenants).values({ id: tenantId, slug: tenantSlug, name: "Review Route", createdAt: now, updatedAt: now }).run();
  const store = new FsAgentDraftStore({ tenantId, tenantSlug, ontologyDomainId: state.domain });
  const fingerprint = "sandbox-evidence:v2:route-review";
  const cleanup = cleanupReceipt();
  const subjectDigest = sandboxDesignReviewSubjectDigest({ domain: state.domain, fingerprint });
  await store.save(state.domain, [spec()], {
    evidenceFingerprint: fingerprint,
    authoritativeOntology: {
      schema: "agent-factory-authoritative-ontology/v1",
      tenantId,
      tenantSlug,
      domainId: state.domain,
      source: "allmeta",
      contentHash: ontologyContentHash(routeOntology()),
    },
    cleanupReceipt: cleanup,
    ...makePromotableSandboxRegistrationEvidence(cleanup.appId, ["route-review-agent"]),
    ...makePromotableSandboxExecutionEvidence({
      candidateFingerprint: fingerprint,
      targetDomainId: state.domain,
      targetTenantId: tenantId,
      targetTenantSlug: tenantSlug,
      sandboxAttemptId: cleanup.sandboxAttemptId,
      agentRefs: ["route-review-agent"],
    }),
    approvedTestCases: [{
      id: "route-happy",
      name: "路由正常完成",
      scenario: "收到批准输入并发出完成事件",
      kind: "pass",
      entryEvent: "ROUTE_START",
      payload: {},
      expectedOutcome: "发出 ROUTE_DONE",
      expectedEvent: "ROUTE_DONE",
    }],
    functionTester: [{ short: "RouteReviewAgent", pass: true, ran: true, emitNames: ["ROUTE_DONE"], reasons: [], tier: "worker", fixtureMode: "scripted", qualification: "promotable" }],
    toolMode: "evidence_replay",
    externalLiveCalls: 0,
    sandboxReplayEvidenceComplete: true,
    replayReceipts: [],
    sandboxDesignReview: {
      fingerprint,
      subjectDigest,
      receipt: {
        challengeId: "fac-route-review",
        kind: "sandbox_design_review",
        protocolVersion: 1,
        digest: "f".repeat(64),
        subjectDigest,
        authorizationDigest: "a".repeat(64),
        actor: userId,
        runId: "factory-route-review-run",
        conversationId: "factory-route-review-run",
        consumedAt: "1970-01-01T00:00:00.000Z",
        expiresAt: "1970-01-01T00:15:00.000Z",
      },
    },
  });
  versionId = (await store.listVersions(state.domain))[0]!.versionId;

  app = Fastify({ logger: false });
  await registerEnvelope(app);
  app.addHook("onRequest", async (req) => {
    req.auth = {
      userId,
      email: "route-human@example.test",
      name: "Route Human",
      platformRole: "superadmin",
      tenantId,
      tenantSlug,
      role: "admin",
      via: state.via,
    };
  });
  await app.register(agentFactoryRoutes, { prefix: "/v1" });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  getDb().delete(auditLog).where(eq(auditLog.tenantId, tenantId)).run();
  getDb().delete(tenants).where(eq(tenants.id, tenantId)).run();
  getDb().delete(users).where(eq(users.id, userId)).run();
  if (oldRoot === undefined) delete process.env.AGENTIC_DATA_ROOT;
  else process.env.AGENTIC_DATA_ROOT = oldRoot;
  if (oldSecret === undefined) delete process.env.AGENTIC_REVIEW_SIGNING_SECRET;
  else process.env.AGENTIC_REVIEW_SIGNING_SECRET = oldSecret;
  await fs.rm(root, { recursive: true, force: true });
});

describe("Agent Factory draft review API", () => {
  it("serves an exact editor contract with Ontology fields visible but read-only", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/v1/agent-factory/drafts/route-review-agent/editor?domain=${encodeURIComponent(state.domain)}&versionId=${encodeURIComponent(versionId)}`,
    });
    expect(response.statusCode, response.body).toBe(200);
    const editor = response.json().data;
    expect(editor).toMatchObject({
      schema: "agent-factory-draft-editor/v1",
      scope: {
        tenantId,
        tenantSlug,
        domain: state.domain,
        slug: "route-review-agent",
        versionId,
      },
      evidenceEffect: {
        carriedForward: false,
        invalidatedForNewVersion: expect.arrayContaining(["human_review", "sandbox", "regression", "promotion_preview"]),
        requiredNext: expect.arrayContaining(["human_review", "sandbox_replay", "promotion_preview"]),
      },
    });
    expect(editor.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "systemPrompt", valueType: "multiline", editable: true, valueStatus: "available", value: spec().systemPrompt }),
      expect.objectContaining({ key: "decisionTables", valueType: "json", editable: true, unsettable: true }),
    ]));
    for (const key of [
      "trigger", "emit", "integrationRequirements", "integrationBindings", "objects",
      "stateBindings", "ruleRefs", "inputSchema", "outputSchema",
    ]) {
      expect(editor.fields).toEqual(expect.arrayContaining([
        expect.objectContaining({
          key,
          editable: false,
          unsettable: false,
          readonlyReason: expect.stringContaining("先更新 Allmeta Ontology 后重新生成"),
        }),
      ]));
    }
    expect(editor.fields.map((field: { key: string }) => field.key)).not.toEqual(expect.arrayContaining([
      "key", "actionName", "slug", "short", "domainId", "tools", "toolPolicies", "sandboxToolConfigs",
    ]));

    const stale = await app.inject({
      method: "GET",
      url: `/v1/agent-factory/drafts/route-review-agent/editor?domain=${encodeURIComponent(state.domain)}&versionId=v-does-not-exist`,
    });
    expect(stale.statusCode).toBe(404);
    expect(stale.json().error.message).toContain("刷新");
  });

  it("PATCH rejects set/unset of Ontology and identity fields with human guidance", async () => {
    const currentVersionId = (await new FsAgentDraftStore({ tenantId, tenantSlug, ontologyDomainId: state.domain }).listVersions(state.domain))[0]!.versionId;
    for (const patch of [
      { set: { trigger: ["OTHER_TRIGGER"] } },
      { unset: ["outputSchema"] },
      { set: { actionName: "otherAction" } },
    ]) {
      const response = await app.inject({
        method: "PATCH",
        url: "/v1/agent-factory/drafts/route-review-agent",
        payload: { domain: state.domain, baseVersionId: currentVersionId, patch },
      });
      expect(response.statusCode, response.body).toBe(400);
      expect(response.json().error.message).toContain("先更新 Allmeta Ontology 后重新生成");
    }
  });

  it("withholds historic fixture references and keeps list responses summary-only", async () => {
    const store = new FsAgentDraftStore({ tenantId, tenantSlug, ontologyDomainId: state.domain });
    await store.save(state.domain, [{
      ...spec(),
      decisionLogic: "historic fixture ffa-0123456789abcdef0123456789abcdef",
      toolConfigs: { external: { api_key_env: "SAFE_ENV_REFERENCE" } },
    }]);
    const sensitiveVersion = (await store.listVersions(state.domain))[0]!.versionId;
    const response = await app.inject({
      method: "GET",
      url: `/v1/agent-factory/drafts/route-review-agent/editor?domain=${encodeURIComponent(state.domain)}&versionId=${encodeURIComponent(sensitiveVersion)}`,
    });
    expect(response.statusCode, response.body).toBe(200);
    const serialized = JSON.stringify(response.json().data);
    expect(serialized).not.toContain("ffa-0123456789abcdef0123456789abcdef");
    expect(response.json().data.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "decisionLogic", valueStatus: "withheld_sensitive", present: true }),
      expect.objectContaining({ key: "toolConfigs", valueStatus: "available", value: { external: { api_key_env: "SAFE_ENV_REFERENCE" } } }),
    ]));

    const list = await app.inject({
      method: "GET",
      url: `/v1/agent-factory/drafts?domain=${encodeURIComponent(state.domain)}`,
    });
    expect(list.statusCode, list.body).toBe(200);
    expect(JSON.stringify(list.json().data)).not.toContain("SAFE_ENV_REFERENCE");
    expect(JSON.stringify(list.json().data)).not.toContain("decisionLogic");
    expect(list.json().data.drafts[0]).toMatchObject({
      replayReady: false,
      regressionReady: false,
      regressionStatus: "missing",
      promotionGateAdmission: false,
      promotionEvidenceReady: false,
      promotionEligible: false,
      evidenceQualification: { replay: "blocked", promotion: "blocked" },
    });
    const versions = await app.inject({
      method: "GET",
      url: `/v1/agent-factory/drafts/versions?domain=${encodeURIComponent(state.domain)}`,
    });
    expect(versions.statusCode, versions.body).toBe(200);
    expect(versions.json().data.versions.find((entry: { versionId: string }) => entry.versionId === sensitiveVersion)).toMatchObject({
      replayReady: false,
      promotionGateAdmission: false,
      promotionEvidenceReady: false,
      promotionEligible: false,
      promotionBlockers: expect.any(Array),
    });
  });

  it("exposes preview, requires an interactive reviewer, and issues a server receipt", async () => {
    const previewResponse = await app.inject({
      method: "POST",
      url: "/v1/agent-factory/drafts/promotion-preview",
      payload: { domain: state.domain, versionId },
    });
    expect(previewResponse.statusCode).toBe(200);
    const preview = previewResponse.json().data;
    expect(preview.reviewChallenge).toMatch(/^review-challenge:v1:/);

    state.via = "token";
    const tokenReview = await app.inject({
      method: "POST",
      url: "/v1/agent-factory/drafts/reviews",
      payload: { domain: state.domain, versionId, reviewChallenge: preview.reviewChallenge, decision: "approve_code_and_design", codeReviewed: true, designReviewed: true },
    });
    expect(tokenReview.statusCode).toBe(403);

    state.via = "cookie";
    const humanReview = await app.inject({
      method: "POST",
      url: "/v1/agent-factory/drafts/reviews",
      payload: { domain: state.domain, versionId, reviewChallenge: preview.reviewChallenge, decision: "approve_code_and_design", codeReviewed: true, designReviewed: true },
    });
    expect(humanReview.statusCode, humanReview.body).toBe(201);
    expect(humanReview.json().data.receipt).toMatchObject({
      tenantId,
      domain: state.domain,
      versionId,
      actor: { userId, via: "cookie" },
      attestations: { codeReviewed: true, designReviewed: true },
    });
    const audits = getDb().select().from(auditLog).where(and(
      eq(auditLog.tenantId, tenantId),
      eq(auditLog.action, "agent_factory.draft.human_signoff"),
      eq(auditLog.targetId, versionId),
    )).all();
    expect(audits.map((row) => row.metaJson)).toEqual(expect.arrayContaining([
      expect.objectContaining({ decision: "deny", outcome: "failed", errorCode: "interactive_human_required" }),
      expect.objectContaining({ decision: "allow", outcome: "succeeded", codeReviewed: true, designReviewed: true }),
    ]));
  });

  it("fails preview closed when authoritative Ontology drifts or cannot be read", async () => {
    state.ontologyRevision = 2;
    const drifted = await app.inject({
      method: "POST",
      url: "/v1/agent-factory/drafts/promotion-preview",
      payload: { domain: state.domain, versionId },
    });
    expect(drifted.statusCode, drifted.body).toBe(400);
    expect(drifted.json().error.message).toContain("权威 Ontology 已在沙箱通过后发生变化");
    expect(drifted.json().error.message).toContain("预检 → 新建沙箱测试 → 人工审查");

    state.ontologyRevision = 1;
    state.ontologyUnavailable = true;
    const unavailable = await app.inject({
      method: "POST",
      url: "/v1/agent-factory/drafts/promotion-preview",
      payload: { domain: state.domain, versionId },
    });
    expect(unavailable.statusCode, unavailable.body).toBe(503);
    expect(unavailable.json().error.message).toContain("无法读取");

    state.ontologyUnavailable = false;
  });

  it("PATCH forks a new version and promotion rejects requests without exact-version sign-off", async () => {
    const currentVersionId = (await new FsAgentDraftStore({ tenantId, tenantSlug, ontologyDomainId: state.domain }).listVersions(state.domain))[0]!.versionId;
    const patched = await app.inject({
      method: "PATCH",
      url: "/v1/agent-factory/drafts/route-review-agent",
      payload: { domain: state.domain, baseVersionId: currentVersionId, patch: { set: { systemPrompt: "人工修订后的路由设计。" } } },
    });
    expect(patched.statusCode, patched.body).toBe(201);
    expect(patched.json().data).toMatchObject({
      domain: state.domain,
      baseVersionId: currentVersionId,
      changedSlug: "route-review-agent",
      regressionReady: false,
      scope: { tenantId, tenantSlug, domain: state.domain, slug: "route-review-agent", baseVersionId: currentVersionId },
      evidenceEffect: {
        carriedForward: false,
        invalidatedForNewVersion: expect.arrayContaining(["human_review", "sandbox", "regression", "promotion_preview"]),
      },
    });
    expect(patched.json().data).not.toHaveProperty("drafts");
    expect(patched.json().data.versionId).not.toBe(currentVersionId);
    const patchAudit = getDb().select().from(auditLog).where(and(
      eq(auditLog.tenantId, tenantId),
      eq(auditLog.action, "agent_factory.draft.patch"),
      eq(auditLog.targetId, patched.json().data.versionId),
    )).all()[0];
    expect(patchAudit?.metaJson).toMatchObject({ decision: "allow", outcome: "succeeded", baseVersionId: currentVersionId, regressionInvalidated: true });

    const stale = await app.inject({
      method: "PATCH",
      url: "/v1/agent-factory/drafts/route-review-agent",
      payload: { domain: state.domain, baseVersionId: currentVersionId, patch: { set: { systemPrompt: "旧页面覆盖。" } } },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe("draft_version_conflict");
    expect(stale.json().error.message).toContain("刷新");

    const noReceipt = await app.inject({
      method: "POST",
      url: "/v1/agent-factory/drafts/promote",
      payload: { domain: state.domain, versionId },
    });
    expect(noReceipt.statusCode).toBe(400);
    expect(noReceipt.json().error.message).toContain("receiptId");
  });

  it("rejects fixture ids and credentials without echoing their values", async () => {
    let currentVersionId = (await new FsAgentDraftStore({ tenantId, tenantSlug, ontologyDomainId: state.domain }).listVersions(state.domain))[0]!.versionId;
    const fixtureId = "ffa-fedcba9876543210fedcba9876543210";
    const rejected = await app.inject({
      method: "PATCH",
      url: "/v1/agent-factory/drafts/route-review-agent",
      payload: { domain: state.domain, baseVersionId: currentVersionId, patch: { set: { decisionLogic: `use ${fixtureId}` } } },
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().error.message).toContain("fixture");
    expect(rejected.body).not.toContain(fixtureId);

    const literalAuth = "this-is-a-real-secret-value";
    const rejectedAuth = await app.inject({
      method: "PATCH",
      url: "/v1/agent-factory/drafts/route-review-agent",
      payload: { domain: state.domain, baseVersionId: currentVersionId, patch: { set: { toolConfigs: { external: { auth: literalAuth } } } } },
    });
    expect(rejectedAuth.statusCode).toBe(400);
    expect(rejectedAuth.json().error.message).toMatch(/密钥|凭证/);
    expect(rejectedAuth.body).not.toContain(literalAuth);

    const envReference = await app.inject({
      method: "PATCH",
      url: "/v1/agent-factory/drafts/route-review-agent",
      payload: {
        domain: state.domain,
        baseVersionId: currentVersionId,
        patch: {
          set: {
            toolConfigs: {
              external: {
                auth_env: "EXTERNAL_AUTH_ENV",
                authHeaderEnv: "EXTERNAL_AUTH_HEADER_ENV",
                key_env: "EXTERNAL_SIGNING_KEY_ENV",
              },
            },
          },
        },
      },
    });
    expect(envReference.statusCode, envReference.body).toBe(201);

    currentVersionId = envReference.json().data.versionId;

    const invalidType = await app.inject({
      method: "PATCH",
      url: "/v1/agent-factory/drafts/route-review-agent",
      payload: { domain: state.domain, baseVersionId: currentVersionId, patch: { set: { retries: "many" } } },
    });
    expect(invalidType.statusCode).toBe(400);
    expect(invalidType.json().error.message).toContain("不符合 Agent 运行契约");
    expect(invalidType.json().error.message).not.toContain("must be");
  });
});
