import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  FACTORY_TEST_FIXTURE_ASSET_SCHEMA,
  type GeneratedAgentSpec,
} from "@agentic/agent-factory";

const state = vi.hoisted(() => ({
  createdSlugs: [] as string[],
  cleanupCommits: 0,
  removedSlugs: [] as string[],
  unregisteredApps: [] as string[],
  disposedSlugs: [] as string[],
  deletedApps: [] as string[],
  deletedCloneAttempts: [] as string[],
  deletedReplayAttempts: [] as string[],
  lifecycleEvents: [] as string[],
  attempts: new Map<string, any>(),
  cleanupCapability: true,
  isolationReady: true,
  validationBlocks: true,
  brokerDisposition: "absent" as "absent" | "zero-functions" | "network-error",
  emptySyncFailure: false,
  runDrainFailure: false,
}));

vi.mock("@agentic/db", () => {
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({ all: () => [] }),
      }),
    }),
    insert: () => ({
      values: (row: { slug?: string }) => ({
        run: () => {
          if (row.slug) state.createdSlugs.push(row.slug);
          return { changes: 1 };
        },
      }),
    }),
    update: () => ({
      set: () => ({ where: () => ({ run: () => ({ changes: 1 }) }) }),
    }),
  };
  const table = {};
  return {
    getDb: () => db,
    tenants: table,
    runs: table,
    agents: table,
    steps: table,
    events: table,
    eq: () => ({}),
    and: () => ({}),
    desc: () => ({}),
    asc: () => ({}),
  };
});

vi.mock("../src/services/agent-factory/sandbox-lifecycle-store", () => ({
  createSandboxAttemptWithTenant: (args: any) => {
    const row = {
      id: args.attemptId,
      ownerTenantId: args.ownerTenantId,
      ownerTenantSlug: args.ownerTenantSlug,
      targetDomainId: args.targetDomainId,
      candidateFingerprint: args.candidateFingerprint,
      sandboxTenantId: args.sandboxTenantId,
      sandboxTenantSlug: args.sandboxTenantSlug,
      appId: args.appId,
      status: "prepared",
      remoteMayExist: false,
      leaseOwner: "mock-owner",
      leaseToken: `mock-token:${args.attemptId}`,
      fenceGeneration: 1,
      leaseExpiresAt: new Date(Date.now() + 60_000),
      cleanupReceipt: null,
      cleanupError: null,
      runDrainStatus: "not_started",
      runDrainReceipt: null,
      runDrainError: null,
    };
    state.attempts.set(row.id, row);
    state.createdSlugs.push(row.sandboxTenantSlug);
    state.lifecycleEvents.push(`ledger:${row.id}`);
    return row;
  },
  cloneSandboxDeclarativeTools: (args: any) => {
    state.lifecycleEvents.push(`clone:${args.attemptId}`);
    return { snapshotHash: `snapshot:${args.attemptId}`, count: 0, toolNames: [] };
  },
  claimSandboxAttemptForCleanup: (attemptId: string, now = new Date()) => {
    const row = state.attempts.get(attemptId);
    if (!row || row.status === "cleanup_verified") return null;
    if (row.status !== "cleanup_failed" && row.leaseExpiresAt.getTime() > now.getTime()) return null;
    Object.assign(row, {
      status: "cleanup_pending",
      cleanupError: null,
      leaseOwner: "mock-reaper",
      leaseToken: `mock-reaper-token:${attemptId}:${row.fenceGeneration + 1}`,
      fenceGeneration: row.fenceGeneration + 1,
      leaseExpiresAt: new Date(now.getTime() + 60_000),
    });
    return {
      attemptId,
      leaseOwner: row.leaseOwner,
      leaseToken: row.leaseToken,
      fenceGeneration: row.fenceGeneration,
    };
  },
  verifySandboxToolSnapshot: (attemptId: string) => {
    state.lifecycleEvents.push(`verify:${attemptId}`);
    return { snapshotHash: `snapshot:${attemptId}`, count: 0 };
  },
  sandboxLeaseFence: (row: any) => ({
    attemptId: row.id,
    leaseOwner: row.leaseOwner,
    leaseToken: row.leaseToken,
    fenceGeneration: row.fenceGeneration,
  }),
  assertSandboxAttemptFence: (lease: any, expectedStatuses: string[]) => {
    const row = state.attempts.get(lease.attemptId);
    if (
      !row ||
      row.leaseOwner !== lease.leaseOwner ||
      row.leaseToken !== lease.leaseToken ||
      row.fenceGeneration !== lease.fenceGeneration ||
      !expectedStatuses.includes(row.status) ||
      row.leaseExpiresAt.getTime() <= Date.now()
    ) throw new Error(`sandbox attempt lease was expired, superseded, or in an illegal state: ${lease.attemptId}@${lease.fenceGeneration}`);
    return row;
  },
  heartbeatSandboxAttempt: vi.fn((lease: any) => {
    const row = state.attempts.get(lease.attemptId);
    if (row) row.leaseExpiresAt = new Date(Date.now() + 60_000);
  }),
  sandboxAttemptHeartbeatMs: () => {
    const lease = Number(process.env.FACTORY_SANDBOX_ATTEMPT_LEASE_MS ?? 180_000);
    const heartbeat = Number(process.env.FACTORY_SANDBOX_ATTEMPT_HEARTBEAT_MS ?? 30_000);
    if (!Number.isSafeInteger(lease) || lease <= 0 || !Number.isSafeInteger(heartbeat) || heartbeat <= 0 || heartbeat >= lease) {
      throw new Error("heartbeat must be lower than lease");
    }
    return heartbeat;
  },
  markSandboxRegistering: (lease: any) => {
    const attemptId = lease.attemptId;
    Object.assign(state.attempts.get(attemptId), { status: "registering", remoteMayExist: true });
    state.lifecycleEvents.push(`registering:${attemptId}`);
  },
  markSandboxActive: (lease: any) => {
    const attemptId = lease.attemptId;
    Object.assign(state.attempts.get(attemptId), { status: "active", remoteMayExist: true });
    state.lifecycleEvents.push(`active:${attemptId}`);
  },
  markSandboxCleanupPending: (lease: any) => {
    const attemptId = lease.attemptId;
    Object.assign(state.attempts.get(attemptId), { status: "cleanup_pending" });
    state.lifecycleEvents.push(`cleanup_pending:${attemptId}`);
  },
  markSandboxRunDrainStarted: (lease: any) => {
    const attemptId = lease.attemptId;
    Object.assign(state.attempts.get(attemptId), {
      runDrainStatus: "cancelling",
      runDrainReceipt: null,
      runDrainError: null,
    });
    state.lifecycleEvents.push(`run_drain_started:${attemptId}`);
  },
  markSandboxRunDrainVerified: (lease: any, receipt: unknown) => {
    const attemptId = lease.attemptId;
    Object.assign(state.attempts.get(attemptId), {
      runDrainStatus: "verified",
      runDrainReceipt: receipt,
      runDrainError: null,
    });
    state.lifecycleEvents.push(`run_drain_verified:${attemptId}`);
  },
  markSandboxRunDrainFailed: (lease: any, error: unknown) => {
    const attemptId = lease.attemptId;
    Object.assign(state.attempts.get(attemptId), {
      runDrainStatus: "failed",
      runDrainError: String((error as Error)?.message ?? error),
    });
    state.lifecycleEvents.push(`run_drain_failed:${attemptId}`);
  },
  markSandboxCleanupFailed: (lease: any, error: unknown) => {
    const attemptId = lease.attemptId;
    Object.assign(state.attempts.get(attemptId), {
      status: "cleanup_failed",
      remoteMayExist: true,
      cleanupError: String((error as Error)?.message ?? error),
      leaseExpiresAt: new Date(0),
    });
    state.lifecycleEvents.push(`cleanup_failed:${attemptId}`);
  },
  deleteSandboxToolClones: (lease: any) => {
    const attemptId = lease.attemptId;
    state.deletedCloneAttempts.push(attemptId);
    state.lifecycleEvents.push(`clones_deleted:${attemptId}`);
  },
  markSandboxCleanupVerified: (lease: any, receipt: unknown) => {
    const attemptId = lease.attemptId;
    if (state.attempts.get(attemptId)?.runDrainStatus !== "verified") {
      throw new Error("durable run-drain proof missing");
    }
    Object.assign(state.attempts.get(attemptId), {
      status: "cleanup_verified",
      remoteMayExist: false,
      cleanupReceipt: receipt,
    });
    state.lifecycleEvents.push(`cleanup_verified:${attemptId}`);
  },
  listOutstandingSandboxAttempts: (args: any = {}) => [...state.attempts.values()].filter((row) =>
    row.status !== "cleanup_verified" &&
    (!args.ownerTenantId || row.ownerTenantId === args.ownerTenantId) &&
    (!args.targetDomainId || row.targetDomainId === args.targetDomainId) &&
    !args.excludeAttemptIds?.has(row.id),
  ),
  listReapableSandboxAttempts: (args: any = {}) => [...state.attempts.values()].filter((row) =>
    row.status !== "cleanup_verified" &&
    (row.status === "cleanup_failed" || row.leaseExpiresAt.getTime() <= (args.now ?? new Date()).getTime()) &&
    (!args.ownerTenantId || row.ownerTenantId === args.ownerTenantId) &&
    (!args.targetDomainId || row.targetDomainId === args.targetDomainId) &&
    !args.excludeAttemptIds?.has(row.id),
  ),
  sandboxAttemptContext: (row: any, lease?: any) => ({
    tenantId: row.sandboxTenantId,
    tenantSlug: row.sandboxTenantSlug,
    appId: row.appId,
    attemptId: row.id,
    candidateFingerprint: row.candidateFingerprint,
    targetDomainId: row.targetDomainId,
    lease: lease ?? {
      attemptId: row.id,
      leaseOwner: row.leaseOwner,
      leaseToken: row.leaseToken,
      fenceGeneration: row.fenceGeneration,
    },
  }),
  sandboxAttemptError: (error: unknown) => String((error as Error)?.message ?? error).slice(0, 500),
}));

vi.mock("../src/services/agent-factory/sandbox-run-drain", () => ({
  drainSandboxRuns: vi.fn(async (ctx: {
    tenantSlug: string;
    appId: string;
    attemptId: string;
  }) => {
    const row = state.attempts.get(ctx.attemptId);
    Object.assign(row, { runDrainStatus: "cancelling", runDrainReceipt: null });
    state.lifecycleEvents.push(`run_drain_started:${ctx.attemptId}`);
    if (state.runDrainFailure) {
      Object.assign(row, { runDrainStatus: "failed", runDrainError: "terminal status timeout" });
      state.lifecycleEvents.push(`run_drain_failed:${ctx.attemptId}`);
      throw new Error("sandbox runs did not reach terminal status before timeout");
    }
    const receipt = {
      schema: "agent-factory-sandbox-run-drain/v1",
      sandboxAttemptId: ctx.attemptId,
      appId: ctx.appId,
      sandboxTenantSlug: ctx.tenantSlug,
      startedAt: new Date(0).toISOString(),
      completedAt: new Date(0).toISOString(),
      observedRuns: [],
      evidenceHash: `sandbox-run-drain:v1:${"a".repeat(64)}`,
    };
    Object.assign(row, { runDrainStatus: "verified", runDrainReceipt: receipt });
    state.lifecycleEvents.push(`run_drain_verified:${ctx.attemptId}`);
    return receipt;
  }),
}));

vi.mock("@agentic/runtime", () => ({
  appIdForTenant: (slug: string) => `factory-test-${slug}`,
  getTenantInngest: () => ({ send: vi.fn() }),
  tenantEventName: (slug: string, event: string) => `${slug}/${event}`,
  isFactorySandboxTenant: (slug: string) =>
    /^af-sbx-[a-f0-9]{8}-[a-f0-9]{8}-[a-f0-9]{12}-sb$/.test(slug),
  tenantInngestConfigStatus: (slug: string) => ({
    slug,
    readiness: "ready",
    source: "sandbox_env_refs",
    mode: "self_hosted",
    eventKeyConfigured: true,
    signingKeyConfigured: true,
    serveOrigin: "https://sandbox.invalid",
    baseUrl: "https://sandbox.invalid",
    missing: [],
    ...(state.cleanupCapability
      ? { cleanupMode: "custom_delete_control", deleteControlConfigured: true }
      : {}),
  }),
  sandboxInngestIsolationStatus: () => state.isolationReady
    ? { isolated: true, missing: [] }
    : { isolated: false, missing: ["sandbox broker differs from target tenant broker"] },
  disposeTenantInngestClient: (slug: string) => {
    state.disposedSlugs.push(slug);
    return true;
  },
  deleteFactorySandboxApp: vi.fn(async (_slug: string, appId: string) => {
    state.deletedApps.push(appId);
    return { alreadyAbsent: false };
  }),
  initializeFactorySandboxReplayAttempt: vi.fn(async (scope: { attempt_id: string }) => {
    state.lifecycleEvents.push(`replay_initialized:${scope.attempt_id}`);
  }),
  stageFactorySandboxReplayCassette: vi.fn(async () => undefined),
  readFactorySandboxDispatchEvidence: vi.fn(async () => ({
    complete: true,
    externalLiveCalls: 0,
    replayReceipts: [],
    dispatches: [],
  })),
  removeFactorySandboxReplayAttempt: vi.fn(async (scope: { attempt_id: string }) => {
    state.deletedReplayAttempts.push(scope.attempt_id);
    state.lifecycleEvents.push(`replay_deleted:${scope.attempt_id}`);
  }),
}));

vi.mock("../src/services/manifest-import", () => ({
  validate: vi.fn(async () => ({
    issues: state.validationBlocks ? [{ severity: "error", message: "fixture validation stop" }] : [],
    deployment_id: "dpl-fixture",
  })),
  commit: vi.fn(async (input: { workflow?: unknown[] }) => {
    state.lifecycleEvents.push("manifest_commit");
    if (Array.isArray(input.workflow) && input.workflow.length === 0) {
      state.cleanupCommits += 1;
      if (state.emptySyncFailure) throw new Error("empty sync unavailable");
    }
    return { inngest_fns_registered: 0, deployment_id: "dpl-clean" };
  }),
  removeTenantModelDirs: vi.fn(async (slug: string) => {
    state.removedSlugs.push(slug);
    return [];
  }),
}));

vi.mock("../src/services/inngest-sync", () => ({
  beginInngestAppDeletion: vi.fn((slug: string, appId: string) => {
    state.lifecycleEvents.push(`delete_begin:${slug}:${appId}`);
  }),
  finishInngestAppDeletion: vi.fn((slug: string, appId: string) => {
    state.lifecycleEvents.push(`delete_finish:${slug}:${appId}`);
  }),
  syncTenantApp: vi.fn(async () => ({ ok: true })),
  probeApp: vi.fn(async () => state.brokerDisposition === "absent"
    ? {
        connected: false,
        functionCount: null,
        error: "App not registered in Inngest",
        healthy: false,
      }
    : state.brokerDisposition === "zero-functions" ? {
        connected: true,
        functionCount: 0,
        error: null,
        healthy: true,
      } : {
        connected: null,
        functionCount: null,
        error: "network unavailable",
        healthy: false,
      }),
  forgetInngestSyncEvidence: vi.fn(() => true),
}));

vi.mock("../src/services/inngest-registry", () => ({
  unregisterApp: vi.fn((appId: string) => {
    state.unregisteredApps.push(appId);
    return true;
  }),
}));

vi.mock("../src/services/llm", () => ({
  getLLMGateway: () => ({ defaultProvider: "mock" }),
}));

// Lifecycle ordering is the subject of this suite. Function-evidence replay has
// its own tests; keep it deterministically green here so registration/cleanup
// state transitions are exercised without depending on worker internals.
vi.mock("../src/services/agent-factory/function-tester-run", () => ({
  loadApprovedFunctionTestCassette: () => ({ blockedReason: "unused in tool-free lifecycle fixture" }),
  testGeneratedFunction: vi.fn(async (_spec: GeneratedAgentSpec, opts: { expectEmits?: string[] }) => ({
    code: "",
    tier: "worker",
    fixtureMode: "scripted",
    verdict: {
      pass: true,
      ran: true,
      emitNames: opts.expectEmits ?? [],
      reasons: [],
    },
  })),
}));

import {
  ManifestSandboxDeployer,
  reapFactorySandboxOrphans,
} from "../src/services/agent-factory/sandbox-deployer";

function candidate(): GeneratedAgentSpec {
  return {
    key: "Generate",
    actionName: "Generate",
    slug: "generate",
    short: "generateAgent",
    domainId: "Agents-generation",
    nameZh: "生成",
    kind: "llm",
    trigger: ["GENERATION_REQUESTED"],
    emit: ["GENERATION_COMPLETED"],
    tools: [],
    unresolvedTools: [],
    objects: [],
    systemPrompt: "Generate the function",
    userPrompt: "",
    steps: [],
    ruleRefs: [],
    retries: 1,
    hitl: false,
    confidence: 1,
  } as GeneratedAgentSpec;
}

describe("Agent Factory ephemeral Inngest lifecycle (mocked control plane)", () => {
  beforeEach(() => {
    state.createdSlugs.length = 0;
    state.cleanupCommits = 0;
    state.removedSlugs.length = 0;
    state.unregisteredApps.length = 0;
    state.disposedSlugs.length = 0;
    state.deletedApps.length = 0;
    state.deletedCloneAttempts.length = 0;
    state.deletedReplayAttempts.length = 0;
    state.lifecycleEvents.length = 0;
    state.attempts.clear();
    state.cleanupCapability = true;
    state.isolationReady = true;
    state.validationBlocks = true;
    state.brokerDisposition = "absent";
    state.emptySyncFailure = false;
    state.runDrainFailure = false;
    delete process.env.FACTORY_SANDBOX_ATTEMPT_LEASE_MS;
    delete process.env.FACTORY_SANDBOX_ATTEMPT_HEARTBEAT_MS;
    process.env.NODE_ENV = "test";
    process.env.INNGEST_SYNC_DISABLED = "1";
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("no external network is allowed in this test");
    }));
  });

  afterEach(() => vi.unstubAllGlobals());

  it("creates a new app per attempt and cleans validation failures before returning", async () => {
    const deployer = new ManifestSandboxDeployer({
      tenantId: "ten-agents-generation",
      tenantSlug: "agents-generation",
    });
    const first = await deployer.deployAndObserve(
      "Agents-generation",
      [candidate()],
      { candidateFingerprint: "sandbox-evidence:v5:first" },
    );
    const second = await deployer.deployAndObserve(
      "Agents-generation",
      [candidate()],
      { candidateFingerprint: "sandbox-evidence:v5:first" },
    );

    expect(first.sandboxTenantSlug).not.toBe(second.sandboxTenantSlug);
    expect(first.cleanupVerified).toBe(true);
    expect(second.cleanupVerified).toBe(true);
    expect(first.cleanupReceipt).toMatchObject({
      appId: first.appId,
      sandboxTenantSlug: first.sandboxTenantSlug,
      sandboxAttemptId: first.sandboxAttemptId,
      candidateFingerprint: "sandbox-evidence:v5:first",
      targetDomainId: "Agents-generation",
      absence: { connected: false, functionCount: null, registryState: "not_registered" },
      absenceProbeHash: expect.stringMatching(/^sandbox-cleanup:v1:[a-f0-9]{64}$/),
    });
    expect(first.cleanupReceipt?.absenceProbeHash).not.toBe(second.cleanupReceipt?.absenceProbeHash);
    expect(state.cleanupCommits).toBe(0);
    expect(state.removedSlugs).toEqual(state.createdSlugs);
    expect(state.disposedSlugs).toEqual(state.createdSlugs);
    expect(state.unregisteredApps).toEqual(
      state.createdSlugs.map((slug) => `factory-test-${slug}`),
    );
    expect(state.deletedApps).toEqual(state.unregisteredApps);
    expect(state.deletedCloneAttempts).toEqual([
      first.sandboxAttemptId,
      second.sandboxAttemptId,
    ]);
    expect(state.deletedReplayAttempts).toEqual([
      first.sandboxAttemptId,
      second.sandboxAttemptId,
    ]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("asks a human before creating an app when deletion capability is not declared", async () => {
    state.cleanupCapability = false;
    const deployer = new ManifestSandboxDeployer({
      tenantId: "ten-agents-generation",
      tenantSlug: "agents-generation",
    });

    await expect(deployer.deployAndObserve(
      "Agents-generation",
      [candidate()],
      { candidateFingerprint: "sandbox-evidence:v5:no-delete-capability" },
    )).rejects.toMatchObject({
      block: {
        code: "sandbox_unregister_unavailable",
        next: "ask_user",
      },
    });
    expect(state.createdSlugs).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("asks a human before creating an app when target/sandbox isolation is not provable", async () => {
    state.isolationReady = false;
    const deployer = new ManifestSandboxDeployer({
      tenantId: "ten-agents-generation",
      tenantSlug: "agents-generation",
    });

    await expect(deployer.deployAndObserve(
      "Agents-generation",
      [candidate()],
      { candidateFingerprint: "sandbox-evidence:v5:not-isolated" },
    )).rejects.toMatchObject({
      block: {
        code: "sandbox_isolation_invalid",
        next: "ask_user",
        missing: ["sandbox broker differs from target tenant broker"],
      },
    });
    expect(state.createdSlugs).toEqual([]);
    expect(state.deletedApps).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("asks a human before persistence when heartbeat is not lower than lease", async () => {
    process.env.FACTORY_SANDBOX_ATTEMPT_LEASE_MS = "1000";
    process.env.FACTORY_SANDBOX_ATTEMPT_HEARTBEAT_MS = "1000";
    const deployer = new ManifestSandboxDeployer({
      tenantId: "ten-agents-generation",
      tenantSlug: "agents-generation",
    });

    await expect(deployer.deployAndObserve(
      "Agents-generation",
      [candidate()],
      { candidateFingerprint: "sandbox-evidence:v5:invalid-lease" },
    )).rejects.toMatchObject({
      block: { code: "sandbox_isolation_invalid", next: "ask_user" },
    });
    expect(state.createdSlugs).toEqual([]);
    expect(state.attempts.size).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("resolves approved binary fixtures before creating any sandbox tenant or Inngest App", async () => {
    const read = vi.fn(async () => null);
    const deployer = new ManifestSandboxDeployer({
      tenantId: "ten-agents-generation",
      tenantSlug: "agents-generation",
    }, { read } as never);

    await expect(deployer.deployAndObserve(
      "Agents-generation",
      [candidate()],
      {
        candidateFingerprint: "sandbox-evidence:v5:missing-binary-fixture",
        fixtureConversationId: "run-fixture",
        testCases: [{
          id: "case-fixture",
          entryEvent: "GENERATION_REQUESTED",
          kind: "pass",
          expectedEvent: "GENERATION_COMPLETED",
          payload: {
            resume: {
              schema: FACTORY_TEST_FIXTURE_ASSET_SCHEMA,
              assetId: "ffa-missing",
              conversationId: "run-fixture",
              sha256: "a".repeat(64),
              bytes: 12,
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
              as: "base64_string",
            },
          },
        }],
      },
    )).rejects.toMatchObject({
      block: { code: "sandbox_fixture_invalid", next: "ask_user" },
    });

    expect(read).toHaveBeenCalledOnce();
    expect(state.createdSlugs).toEqual([]);
    expect(state.attempts.size).toBe(0);
    expect(state.deletedApps).toEqual([]);
    expect(state.lifecycleEvents).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not call a surviving zero-function app deleted", async () => {
    state.brokerDisposition = "zero-functions";
    const deployer = new ManifestSandboxDeployer({
      tenantId: "ten-agents-generation",
      tenantSlug: "agents-generation",
    });

    await expect(deployer.deployAndObserve(
      "Agents-generation",
      [candidate()],
      { candidateFingerprint: "sandbox-evidence:v5:zero-is-not-delete" },
    )).rejects.toMatchObject({
      block: {
        code: "sandbox_cleanup_failed",
        next: "ask_user",
      },
    });
    expect(state.cleanupCommits).toBe(0);
    expect(state.unregisteredApps).toEqual([]);
    expect(state.deletedApps).toHaveLength(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("still deletes the App but refuses cleanup evidence when run termination is unproven", async () => {
    state.runDrainFailure = true;
    const deployer = new ManifestSandboxDeployer({
      tenantId: "ten-agents-generation",
      tenantSlug: "agents-generation",
    });

    await expect(deployer.deployAndObserve(
      "Agents-generation",
      [candidate()],
      { candidateFingerprint: "sandbox-evidence:v5:run-drain-timeout" },
    )).rejects.toMatchObject({
      block: { code: "sandbox_cleanup_failed", next: "ask_user" },
    });

    expect(state.deletedApps).toHaveLength(1);
    expect(state.unregisteredApps).toEqual(state.deletedApps);
    expect([...state.attempts.values()][0]).toMatchObject({
      status: "cleanup_failed",
      remoteMayExist: true,
      cleanupReceipt: null,
      runDrainStatus: "failed",
    });
    expect(state.lifecycleEvents.some((event) => event.startsWith("cleanup_verified:"))).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("deletes the remote app without pretending an empty manifest is app deletion", async () => {
    state.emptySyncFailure = true;
    const deployer = new ManifestSandboxDeployer({
      tenantId: "ten-agents-generation",
      tenantSlug: "agents-generation",
    });

    const result = await deployer.deployAndObserve(
      "Agents-generation",
      [candidate()],
      { candidateFingerprint: "sandbox-evidence:v5:empty-sync-failed" },
    );

    expect(result.cleanupVerified).toBe(true);
    expect(state.cleanupCommits).toBe(0);
    expect(state.deletedApps).toHaveLength(1);
    expect(state.unregisteredApps).toEqual(state.deletedApps);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("never treats a network failure as absence and retains the attempt for cleanup retry", async () => {
    state.brokerDisposition = "network-error";
    const deployer = new ManifestSandboxDeployer({
      tenantId: "ten-agents-generation",
      tenantSlug: "agents-generation",
    });

    await expect(deployer.deployAndObserve(
      "Agents-generation",
      [candidate()],
      { candidateFingerprint: "sandbox-evidence:v5:network-unknown" },
    )).rejects.toMatchObject({
      block: { code: "sandbox_cleanup_failed", next: "ask_user" },
    });
    expect(state.unregisteredApps).toEqual([]);

    state.brokerDisposition = "absent";
    await expect(deployer.teardown("Agents-generation")).resolves.toBeUndefined();
    expect(state.deletedApps).toHaveLength(2);
    expect(state.unregisteredApps).toHaveLength(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("still cleans an attempt cancelled before validation starts", async () => {
    const deployer = new ManifestSandboxDeployer({
      tenantId: "ten-agents-generation",
      tenantSlug: "agents-generation",
    });
    const controller = new AbortController();
    controller.abort("operator cancelled");

    await expect(deployer.deployAndObserve(
      "Agents-generation",
      [candidate()],
      {
        candidateFingerprint: "sandbox-evidence:v5:cancelled",
        signal: controller.signal,
      },
    )).rejects.toBeDefined();

    expect(state.cleanupCommits).toBe(0);
    expect(state.removedSlugs).toEqual(state.createdSlugs);
    expect(state.unregisteredApps).toHaveLength(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("durably records remote-may-exist before manifest registration", async () => {
    state.validationBlocks = false;
    const deployer = new ManifestSandboxDeployer({
      tenantId: "ten-agents-generation",
      tenantSlug: "agents-generation",
    });

    const result = await deployer.deployAndObserve(
      "Agents-generation",
      [candidate()],
      { candidateFingerprint: "sandbox-evidence:v5:ledger-before-register" },
    );

    const attemptId = result.sandboxAttemptId!;
    const ledger = state.lifecycleEvents.indexOf(`ledger:${attemptId}`);
    const registering = state.lifecycleEvents.indexOf(`registering:${attemptId}`);
    const commit = state.lifecycleEvents.indexOf("manifest_commit");
    const active = state.lifecycleEvents.indexOf(`active:${attemptId}`);
    const verified = state.lifecycleEvents.indexOf(`cleanup_verified:${attemptId}`);
    expect(ledger).toBeGreaterThanOrEqual(0);
    expect(registering).toBeGreaterThan(ledger);
    expect(commit).toBeGreaterThan(registering);
    expect(active).toBeGreaterThan(commit);
    expect(verified).toBeGreaterThan(active);
    expect(state.attempts.get(attemptId)).toMatchObject({
      status: "cleanup_verified",
      remoteMayExist: false,
      cleanupReceipt: result.cleanupReceipt,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fails closed before creating a new app while an older lease is unresolved", async () => {
    state.attempts.set("old-live-attempt", {
      id: "old-live-attempt",
      ownerTenantId: "ten-agents-generation",
      ownerTenantSlug: "agents-generation",
      targetDomainId: "Agents-generation",
      candidateFingerprint: "old",
      sandboxTenantId: "ten-old-sandbox",
      sandboxTenantSlug: "af-sbx-00000000-00000000-000000000000-sb",
      appId: "factory-test-old",
      status: "active",
      remoteMayExist: true,
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    const deployer = new ManifestSandboxDeployer({
      tenantId: "ten-agents-generation",
      tenantSlug: "agents-generation",
    });

    await expect(deployer.deployAndObserve(
      "Agents-generation",
      [candidate()],
      { candidateFingerprint: "sandbox-evidence:v5:blocked-by-old" },
    )).rejects.toMatchObject({
      block: { code: "sandbox_cleanup_failed", next: "ask_user" },
    });
    expect(state.createdSlugs).toEqual([]);
    expect(state.deletedApps).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reaps an expired durable attempt through strict delete, absence readback, and receipt persistence", async () => {
    const row = {
      id: "expired-attempt",
      ownerTenantId: "ten-agents-generation",
      ownerTenantSlug: "agents-generation",
      targetDomainId: "Agents-generation",
      candidateFingerprint: "expired-candidate",
      sandboxTenantId: "ten-expired-sandbox",
      sandboxTenantSlug: "af-sbx-aaaaaaaa-bbbbbbbb-cccccccccccc-sb",
      appId: "factory-test-expired",
      status: "cleanup_failed",
      remoteMayExist: true,
      leaseOwner: "dead-owner",
      leaseToken: "dead-token",
      fenceGeneration: 1,
      leaseExpiresAt: new Date(0),
      cleanupError: "prior process crashed",
    };
    state.attempts.set(row.id, row);

    const report = await reapFactorySandboxOrphans({
      ownerTenantId: row.ownerTenantId,
      targetDomainId: row.targetDomainId,
    });

    expect(report).toMatchObject({ scanned: 1, cleaned: 1, failed: 0, failures: [] });
    expect(state.deletedApps).toEqual([row.appId]);
    expect(state.deletedCloneAttempts).toEqual([row.id]);
    expect(state.attempts.get(row.id)).toMatchObject({
      status: "cleanup_verified",
      remoteMayExist: false,
      cleanupReceipt: {
        appId: row.appId,
        sandboxAttemptId: row.id,
        candidateFingerprint: row.candidateFingerprint,
        targetDomainId: row.targetDomainId,
      },
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
