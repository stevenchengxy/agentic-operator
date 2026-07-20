/**
 * Factory sandbox live-runthrough — integration coverage for T1 (per-case polling + per-kind
 * verdict) + T2 (auto-synthesized mock external-platform agents), exercised against the REAL
 * ManifestSandboxDeployer → manifest-import commit → in-process Inngest function registration.
 *
 * What this proves HERE (no separate Inngest dev server in the vitest env):
 *   - a generated agent chain with an EXTERNAL handoff auto-grows a mock external-platform agent
 *     so the chain is closeable (T2),
 *   - the chain + mock are really COMMITTED to an isolated `<domain>-sb` tenant and Inngest
 *     functions are registered (functionsRegistered > 0),
 *   - the per-case / per-kind verdict pipeline runs end-to-end without throwing (T1).
 * The actual event EXECUTION (runs settling) needs a live `inngest-cli dev` (driven by `pnpm dev`);
 * with no executor here the run count is honestly 0 and fullChainRan is false — that's expected.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { buildTestEnv } from "./harness";
import { ManifestSandboxDeployer } from "../src/services/agent-factory/sandbox-deployer";
import { saveGlobalToolProbeReceipt } from "../src/services/agent-factory/tool-probe-store";
import { reconcileImports } from "../src/services/reconcile-imports";
import { listRegisteredApps } from "../src/services/inngest-registry";
import { allTenantClients } from "@agentic/runtime";
import { catalogToolDefinitionHash, type GeneratedAgentSpec } from "@agentic/agent-factory";
import { makeToolCassetteEntry } from "@agentic/shared/cassette";
import { listGlobalTools } from "@agentic/tools";
import { eq, getDb, tenants } from "@agentic/db";
import { attestLiveProbeCassette } from "../src/services/agent-factory/cassette-evidence-attestation";

function spec(p: Partial<GeneratedAgentSpec> & { actionName: string; trigger: string[]; emit: string[] }): GeneratedAgentSpec {
  return {
    key: p.actionName,
    actionName: p.actionName,
    slug: `sbrt-${p.actionName.toLowerCase()}`,
    short: p.actionName,
    domainId: "sbruntest",
    nameZh: p.actionName,
    kind: "llm",
    trigger: p.trigger,
    emit: p.emit,
    tools: p.tools ?? ["meta.ping"],
    toolSideEffects: { "meta.ping": "read" },
    toolPolicies: {
      "meta.ping": {
        operation: "read",
        effectScope: "none",
        sandboxPolicy: "pure",
      },
    },
    ...(p.sandboxToolConfigs ? { sandboxToolConfigs: p.sandboxToolConfigs } : {}),
    unresolvedTools: [],
    objects: [],
    systemPrompt: `You are ${p.actionName}. Handle the trigger event and emit the outcome event.`,
    userPrompt: "",
    steps: [],
    ruleRefs: [],
    retries: 1,
    hitl: false,
    confidence: 1,
    promptSource: "llm",
  } as GeneratedAgentSpec;
}

function ensureRunthroughOwnerTenant(): string {
  const existing = getDb().select().from(tenants).where(eq(tenants.slug, "sandbox-runthrough-target")).all()[0];
  if (existing) return existing.id;
  const id = "ten-sandbox-runthrough-target";
  getDb().insert(tenants).values({
    id,
    slug: "sandbox-runthrough-target",
    name: "Sandbox Runthrough Target",
  }).run();
  return id;
}

describe("factory sandbox live-runthrough (T1 + T2 integration)", () => {
  let originalTenantConfigRefs: string | undefined;

  beforeAll(async () => {
    originalTenantConfigRefs = process.env.INNGEST_TENANT_CONFIG_REFS;
    await buildTestEnv();
    const existingTenantRefs = (() => {
      try {
        return JSON.parse(process.env.INNGEST_TENANT_CONFIG_REFS ?? "{}") as Record<string, unknown>;
      } catch {
        return {};
      }
    })();
    process.env.INNGEST_TENANT_CONFIG_REFS = JSON.stringify({
      ...existingTenantRefs,
      "sandbox-runthrough-target": {
        eventKeyEnv: "FACTORY_TEST_TARGET_EVENT_KEY",
        signingKeyEnv: "FACTORY_TEST_TARGET_SIGNING_KEY",
        serveOriginEnv: "FACTORY_TEST_TARGET_SERVE_ORIGIN",
        baseUrlEnv: "FACTORY_TEST_TARGET_BASE_URL",
      },
    });
    process.env.FACTORY_SANDBOX_READY_MS = "800"; // no dev server in test → don't wait the full 8s
    process.env.INNGEST_SANDBOX_CONFIG_REFS = JSON.stringify({
      eventKeyEnv: "FACTORY_TEST_SB_EVENT_KEY",
      signingKeyEnv: "FACTORY_TEST_SB_SIGNING_KEY",
      serveOriginEnv: "FACTORY_TEST_SB_SERVE_ORIGIN",
      baseUrlEnv: "FACTORY_TEST_SB_BASE_URL",
      appPrefixEnv: "FACTORY_TEST_SB_APP_PREFIX",
      controlBearerEnv: "FACTORY_TEST_SB_CONTROL_BEARER",
      cleanupMode: "custom_delete_control",
      deleteControlUrlEnv: "FACTORY_TEST_SB_DELETE_URL",
      deleteControlTokenEnv: "FACTORY_TEST_SB_DELETE_TOKEN",
    });
    process.env.FACTORY_TEST_SB_EVENT_KEY = "factory-sandbox-event-isolated";
    process.env.FACTORY_TEST_SB_SIGNING_KEY = "factory-sandbox-signing-isolated";
    process.env.FACTORY_TEST_SB_SERVE_ORIGIN = "http://localhost:3540";
    process.env.FACTORY_TEST_SB_BASE_URL = "http://localhost:8488";
    process.env.FACTORY_TEST_SB_APP_PREFIX = "factory-test-sandbox";
    process.env.FACTORY_TEST_SB_DELETE_URL = "http://sandbox-control.invalid/apps/{appId}";
    process.env.FACTORY_TEST_SB_DELETE_TOKEN = "isolated-delete-token";
    process.env.FACTORY_TEST_SB_CONTROL_BEARER =
      "isolated-sandbox-control-bearer-at-least-32-bytes";
    process.env.FACTORY_TEST_TARGET_EVENT_KEY = "factory-target-event-isolated";
    process.env.FACTORY_TEST_TARGET_SIGNING_KEY = "factory-target-signing-isolated";
    process.env.FACTORY_TEST_TARGET_SERVE_ORIGIN = "http://localhost:4540";
    process.env.FACTORY_TEST_TARGET_BASE_URL = "http://localhost:8589";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ data: { apps: [] } }),
      { status: 200, headers: { "content-type": "application/json" } },
    )));
  });

  afterAll(() => {
    vi.unstubAllGlobals();
    if (originalTenantConfigRefs === undefined) delete process.env.INNGEST_TENANT_CONFIG_REFS;
    else process.env.INNGEST_TENANT_CONFIG_REFS = originalTenantConfigRefs;
    for (const name of [
      "INNGEST_SANDBOX_CONFIG_REFS",
      "FACTORY_TEST_SB_EVENT_KEY",
      "FACTORY_TEST_SB_SIGNING_KEY",
      "FACTORY_TEST_SB_SERVE_ORIGIN",
      "FACTORY_TEST_SB_BASE_URL",
      "FACTORY_TEST_SB_APP_PREFIX",
      "FACTORY_TEST_SB_DELETE_URL",
      "FACTORY_TEST_SB_DELETE_TOKEN",
      "FACTORY_TEST_SB_CONTROL_BEARER",
      "FACTORY_TEST_TARGET_EVENT_KEY",
      "FACTORY_TEST_TARGET_SIGNING_KEY",
      "FACTORY_TEST_TARGET_SERVE_ORIGIN",
      "FACTORY_TEST_TARGET_BASE_URL",
    ]) delete process.env[name];
  });

  it("registers the isolated chain but fails closed before dispatch when no Inngest executor is ready", async () => {
    const domain = "sbruntest";
    const ownerTenantId = ensureRunthroughOwnerTenant();
    // The pre-registration function test no longer fabricates `{ok:true}` for tools. Seed a
    // definition-bound signed fixture with both argument shapes this test really executes.
    const catalog = listGlobalTools().find((tool) => tool.name === "meta.ping")!;
    const definitionHash = catalogToolDefinitionHash(catalog, {});
    const cassettePath = path.join(process.env.AGENTIC_DATA_ROOT!, "meta-ping-runthrough.json");
    await fs.mkdir(path.dirname(cassettePath), { recursive: true });
    const recordedAt = new Date().toISOString();
    const cassette = attestLiveProbeCassette({
      version: 1,
      tool: { name: "meta.ping", definitionHash, schemaHash: "schema-meta-ping" },
      evidence: { recordedAt, mode: "live-probe" },
      entries: [
        makeToolCassetteEntry({ toolName: "meta.ping", args: { subject: "rt-pass", results: {} }, status: 200, body: { ok: true }, recordedAt }),
        makeToolCassetteEntry({ toolName: "meta.ping", args: { subject: "rt-reject", _force_reject: true, results: {} }, status: 200, body: { ok: true }, recordedAt }),
        makeToolCassetteEntry({ toolName: "meta.ping", args: { results: {} }, status: 200, body: { ok: true }, recordedAt }),
      ],
    }, {
      tenantId: ownerTenantId,
      tenantSlug: "sandbox-runthrough-target",
      domainId: domain,
      toolName: "meta.ping",
      definitionHash,
      config: {},
      actor: "usr-runthrough-prober",
    });
    await fs.writeFile(cassettePath, JSON.stringify(cassette), "utf8");
    saveGlobalToolProbeReceipt(ownerTenantId, domain, {
      toolName: "meta.ping",
      status: "verified",
      definitionHash,
      schemaHash: "schema-meta-ping",
      evidence: {
        cassettePath,
        evidenceMode: cassette.evidence!.mode,
        attestationKeyId: cassette.evidence!.attestation!.keyId,
        attestationExpiresAt: cassette.evidence!.attestation!.expiresAt,
      },
      verifiedAt: recordedAt,
    });
    // A 2-agent chain with an EXTERNAL handoff: ProcessResume waits on RESUME_DOWNLOADED, which no
    // internal agent produces and we don't fire → the deployer must synthesize a mock to produce it.
    const specs = [
      spec({ actionName: "CreateJd", trigger: ["RUNTHRU_START"], emit: ["JD_GENERATED"] }),
      spec({ actionName: "ProcessResume", trigger: ["RESUME_DOWNLOADED"], emit: ["RESUME_PROCESSED"] }),
    ];
    const deployer = new ManifestSandboxDeployer({
      tenantId: ownerTenantId,
      tenantSlug: "sandbox-runthrough-target",
    });
    let res;
    try {
      res = await deployer.deployAndObserve(domain, specs, {
        candidateFingerprint: "sandbox-evidence:v5:runthrough-candidate",
        testCases: [
          { entryEvent: "RUNTHRU_START", payload: { subject: "rt-pass" }, kind: "pass" },
          { entryEvent: "RUNTHRU_START", payload: { subject: "rt-reject", _force_reject: true }, kind: "reject" },
        ],
      });
    } finally {
      await deployer.teardown(domain).catch(() => {});
    }

    // T2 — a mock external-platform agent was auto-synthesized for the orphan trigger.
    expect(res.mockExternalAgents, JSON.stringify(res)).toBeDefined();
    expect(res.mockExternalAgents!.length).toBe(1);
    expect(res.mockExternalAgents![0]).toContain("-mock-");

    // Real registration: the chain (2) + the mock (1) committed to the isolated sandbox app.
    expect(res.functionsRegistered).toBe(3);
    expect(res.simulated).toBe(false);
    expect(res.committedManifestFunctionIds).toHaveLength(3);

    // This test process has no Inngest executor. Registration readiness is therefore a hard stop:
    // no test event is dispatched and no per-case/run success evidence can be fabricated.
    expect(res.appReady).toBe(false);
    expect(res.fires).toEqual([]);
    expect(res.ran).toBe(0);
    expect(res.reachedSuccessTerminal).toBe(false);
    expect(res.fullChainRan).toBe(false);
    expect(res.caseVerdicts).toBeUndefined();
    expect(res.brokerRegistration).toMatchObject({
      expectedFunctionCount: 3,
      observedFunctionCount: 3,
      verified: true,
      evidence: "test_only_bypass",
    });
    expect(res.syncError).toContain("not an independent");
    expect(res.toolMode).toBe("evidence_replay");
    expect(res.externalLiveCalls).toBe(0);
    expect(res.sandboxReplayEvidenceComplete).toBe(true);
    expect(res.replayReceipts).toEqual([]);
    expect(res.cleanupVerified).toBe(true);
    expect(res.cleanupReceipt).toMatchObject({
      appId: res.appId,
      candidateFingerprint: "sandbox-evidence:v5:runthrough-candidate",
      targetDomainId: domain,
      absenceProbeHash: expect.stringMatching(/^sandbox-cleanup:v1:[a-f0-9]{64}$/),
    });
    expect(res.sandboxTenantSlug).toMatch(/^af-sbx-/);
    expect(listRegisteredApps().some((app) => app.appId === res.appId)).toBe(false);
    expect(allTenantClients().some((client) => client.slug === res.sandboxTenantSlug)).toBe(false);

    // A later API boot must not interpret intentional sandbox deletion as a
    // crashed manifest import and recreate/re-register the archived tenant.
    const reregistered: string[] = [];
    const recovery = await reconcileImports(getDb(), {
      reregister: async (slug) => { reregistered.push(slug); },
    });
    expect(recovery.failures).toBe(0);
    expect(reregistered).not.toContain(res.sandboxTenantSlug);
    const modelEntries = await fs.readdir(process.env.AGENTIC_MODELS_DIR!);
    expect(modelEntries.some((entry) => entry.startsWith(`${res.sandboxTenantSlug}-v`))).toBe(false);
  }, 30_000);

  it("blocks before Inngest registration when the current sandbox profile has no matching cassette", async () => {
    const domain = "sbruntest";
    const ownerTenantId = ensureRunthroughOwnerTenant();
    const drifted = spec({
      actionName: "EvidenceDrift",
      trigger: ["EVIDENCE_TEST_REQUESTED"],
      emit: ["EVIDENCE_TEST_COMPLETED"],
      sandboxToolConfigs: { "meta.ping": { profile_marker: "not-the-probed-profile" } },
    });
    const deployer = new ManifestSandboxDeployer({
      tenantId: ownerTenantId,
      tenantSlug: "sandbox-runthrough-target",
    });
    let res;
    try {
      res = await deployer.deployAndObserve(domain, [drifted], {
        candidateFingerprint: "sandbox-evidence:v5:missing-cassette",
        testCases: [{ entryEvent: "EVIDENCE_TEST_REQUESTED", payload: { subject: "evidence-drift" }, kind: "pass" }],
      });
    } finally {
      await deployer.teardown(domain).catch(() => {});
    }

    expect(res.functionsRegistered).toBe(0);
    expect(res.committedManifestFunctionIds).toBeUndefined();
    expect(res.brokerRegistration).toBeUndefined();
    expect(res.functionTester).toEqual([
      expect.objectContaining({ short: "EvidenceDrift", pass: false, ran: false }),
    ]);
    expect(res.functionTester?.[0]?.reasons.join(" ")).toContain("没有与这次 sandbox profile/定义一致的已验证 cassette");
    expect(res.functionTester?.[0]?.reasons.join(" ")).toContain("不会调用真实外部系统");
    expect(res.toolMode).toBe("evidence_replay");
    expect(res.externalLiveCalls).toBe(0);
    expect(res.sandboxReplayEvidenceComplete).toBe(true);
    expect(res.cleanupVerified).toBe(true);
    expect(listRegisteredApps().some((app) => app.appId === res.appId)).toBe(false);
  }, 30_000);
});
