import {
  sandboxInfrastructureCleanupEvidenceHash,
  type SandboxDeployResult,
} from "@agentic/agent-factory";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  buildSandboxRunnerWorkload,
  loadSandboxWorkloadConfig,
  waitForSandboxDeleteControlReady,
} from "../src/sandbox-runner";
import type { SandboxCandidateBundle } from "../src/services/agent-factory/sandbox-bundle-builder";
import type {
  SandboxCodeActCandidateReaperLike,
  SandboxCodeActReaperTelemetry,
} from "../src/services/agent-factory/sandbox-codeact-reaper";

const token = "workload-control-token-that-is-at-least-32-bytes";
const cancelFenceKey = "workload-cancel-fence-integrity-key-at-least-32-bytes";
const roots: string[] = [];

function fenceDir(): string {
  const value = mkdtempSync(path.join(tmpdir(), "factory-workload-fences-"));
  roots.push(value);
  return value;
}

function workloadConfig(cancelFenceDir = fenceDir()) {
  return {
    host: "127.0.0.1",
    port: 3561,
    token,
    brokerOrigin: "http://sandbox-inngest:8288",
    appPrefix: "agentic-factory-sandbox",
    cancelFenceDir,
    cancelFenceIntegrityKey: cancelFenceKey,
    cancelFenceMaxEntries: 128,
  };
}

function readyCandidateReaper(
  overrides: Partial<SandboxCodeActReaperTelemetry> = {},
): SandboxCodeActCandidateReaperLike {
  const state: SandboxCodeActReaperTelemetry = {
    lastCandidateReaperAt: "2026-07-16T00:00:00.000Z",
    candidateReaperFailure: null,
    orphanCandidates: 0,
    oldestCandidateOrphanAgeMs: null,
    candidateCleanupReady: true,
    removedCandidates: 0,
    ...overrides,
  };
  return {
    async reconcile() { return { ...state }; },
    telemetry() { return { ...state }; },
    start() {},
    stop() {},
  };
}

function bundle(): SandboxCandidateBundle {
  return {
    schema: "agent-factory-sandbox-candidate/v1",
    attemptId: "attempt-workload-1",
    bundleHash: "bundle-workload-1",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    controlPlaneBuildId: "control-build",
    candidateFingerprint: "candidate-workload-1",
    targetDomainId: "agents-generation",
    targetTenant: { id: "tenant-1", slug: "agents-generation" },
    sandboxTenantSlug: "agents-generation-sb-workload",
    specsFingerprint: "specs",
    manifestHash: "manifest",
    specs: [],
    manifest: [],
    testCases: [],
    boundaryEvents: { entryEvents: [], terminalEvents: [], externalInputEvents: [] },
    toolDefinitions: [],
    toolEvidence: [],
    policy: {
      requiredIsolation: "remote_container",
      networkPolicy: "deny_public_egress",
      externalLiveCalls: 0,
      functionModuleFallbackAllowed: false,
      maxRunMs: 1_000,
    },
  } as unknown as SandboxCandidateBundle;
}

describe("split sandbox workload service", () => {
  afterEach(() => {
    for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
  });

  it("requires isolated paths and explicit workload credentials", () => {
    expect(loadSandboxWorkloadConfig({
      NODE_ENV: "test",
      SANDBOX_WORKLOAD_TOKEN: token,
      SANDBOX_INNGEST_BASE_URL: "http://sandbox-inngest:8288",
      SANDBOX_INNGEST_APP_PREFIX: "agentic-factory-sandbox",
      SANDBOX_CANCEL_FENCE_HMAC: cancelFenceKey,
    })).toMatchObject({ port: 3561, token, appPrefix: "agentic-factory-sandbox" });
  });

  it("proves authenticated cross-network delete readiness before orphan recovery", async () => {
    const fetchFn = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      expect(init?.headers).toEqual({ authorization: `Bearer ${token}` });
      return new Response(JSON.stringify({
        schema: "agent-factory-sandbox-delete-control-readiness/v1",
        ready: true,
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    await expect(waitForSandboxDeleteControlReady({
      origin: "http://sandbox-runner:3560",
      token,
      fetchFn,
      timeoutMs: 100,
      pollIntervalMs: 1,
    })).resolves.toBeUndefined();
    expect(fetchFn).toHaveBeenCalledWith(
      "http://sandbox-runner:3560/internal/health/delete-control",
      expect.objectContaining({ redirect: "error" }),
    );
  });

  it("fails closed before orphan recovery when delete-control auth is rejected", async () => {
    await expect(waitForSandboxDeleteControlReady({
      origin: "http://sandbox-runner:3560",
      token,
      fetchFn: vi.fn(async () => new Response("unauthorized", { status: 401 })) as unknown as typeof fetch,
      timeoutMs: 100,
      pollIntervalMs: 1,
    })).rejects.toMatchObject({
      block: {
        code: "sandbox_cleanup_failed",
        next: "ask_user",
        missing: ["sandbox delete-control authentication was rejected"],
      },
    });
  });

  it("authenticates execution and returns only a terminal evidence envelope", async () => {
    const candidate = bundle();
    const cleanupBody = {
      schema: "agent-factory-sandbox-infrastructure-cleanup/v1" as const,
      candidateExecutionAbsent: true as const,
      workspaceAbsent: true as const,
      candidateSecretsIssued: false as const,
      isolation: "isolated_container" as const,
      executionOwners: { declarativeFunctions: 0, codeactFunctions: 1 },
      candidateExecutions: [{
        schema: "agentic-codeact-container-execution/v1" as const,
        attemptId: candidate.attemptId,
        containerIdHash: `sha256:${"1".repeat(64)}`,
        codeSha256: "2".repeat(64),
        candidateImageDigest: `test/codeact-candidate@sha256:${"3".repeat(64)}`,
        imageId: `sha256:${"4".repeat(64)}`,
        policyHash: `sha256:${"5".repeat(64)}`,
        isolation: "isolated_container" as const,
        startedAt: new Date(1_000).toISOString(),
        completedAt: new Date(2_000).toISOString(),
        removedAt: new Date(2_000).toISOString(),
        exitCode: 0,
        oomKilled: false,
        rpcCount: 1,
        removed: true as const,
        absenceVerified: true as const,
      }],
      verifiedAt: new Date(2_000).toISOString(),
    };
    const result = {
      appId: "agentic-factory-sandbox-test",
      functionsRegistered: 1,
      ran: 1,
      deployed: 1,
      reachedSuccessTerminal: true,
      fullChainRan: true,
      degradedAgents: [],
      runs: [],
      fingerprint: "deployment-1",
    } as SandboxDeployResult;
    const execute = vi.fn(async () => ({
      schema: "agent-factory-sandbox-workload-result/v1" as const,
      bundleHash: candidate.bundleHash,
      startedAt: new Date(1_000).toISOString(),
      completedAt: new Date(2_000).toISOString(),
      result,
      infrastructureCleanup: {
        ...cleanupBody,
        evidenceHash: sandboxInfrastructureCleanupEvidenceHash(cleanupBody),
      },
    }));
    const app = await buildSandboxRunnerWorkload({
      config: workloadConfig(),
      execute,
      candidateReaper: readyCandidateReaper(),
    });
    try {
      const denied = await app.inject({ method: "POST", url: "/internal/v1/execute", payload: {} });
      expect(denied.statusCode).toBe(401);

      const accepted = await app.inject({
        method: "POST",
        url: "/internal/v1/execute",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          schema: "agent-factory-sandbox-workload-command/v1",
          bundleHash: candidate.bundleHash,
          bundle: candidate,
        },
      });
      expect(accepted.statusCode).toBe(200);
      expect(accepted.json()).toMatchObject({
        schema: "agent-factory-sandbox-workload-terminal/v1",
        attemptId: candidate.attemptId,
        bundleHash: candidate.bundleHash,
        status: "completed",
        infrastructureCleanup: {
          candidateExecutionAbsent: true,
          candidateSecretsIssued: false,
        },
      });
      expect(execute).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });

  it("reports durable reaper and orphan evidence in authenticated deep health", async () => {
    const app = await buildSandboxRunnerWorkload({
      config: workloadConfig(),
      execute: vi.fn() as never,
      fetchFn: vi.fn(async () => new Response(JSON.stringify({
        data: { apps: [] },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch,
      durableHealth: () => ({
        outstandingAttempts: 0,
        cleanupFailures: 0,
        oldestOrphanAgeMs: null,
        lastReaperAt: "2026-07-16T00:00:00.000Z",
        reaperFailure: null,
      }),
      candidateReaper: readyCandidateReaper(),
    });
    try {
      const denied = await app.inject({ method: "GET", url: "/health" });
      expect(denied.statusCode).toBe(401);

      const ready = await app.inject({
        method: "GET",
        url: "/health",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(ready.statusCode).toBe(200);
      expect(ready.json()).toMatchObject({
        schema: "agent-factory-sandbox-workload-health/v1",
        ok: true,
        cleanupReady: true,
        activeExecutions: 0,
        outstandingAttempts: 0,
        cleanupFailures: 0,
        lastReaperAt: "2026-07-16T00:00:00.000Z",
        reaperFailure: null,
      });
    } finally {
      await app.close();
    }
  });

  it("prunes expired gateway tombstones only inside the globally-clean health gate", async () => {
    const appId = "agentic-factory-sandbox-af-sbx-1234abcd-5678efab-123456789abc-sb";
    const fetchFn = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      const value = String(url);
      if (value.endsWith("/internal/factory-sandbox/tombstones")) {
        return new Response(JSON.stringify({
          schema: "agent-factory-sandbox-gateway-tombstones/v1",
          tombstones: [{ appId }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (value.includes("/internal/factory-sandbox/tombstones/") && init?.method === "DELETE") {
        return new Response(JSON.stringify({ released: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: { apps: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const app = await buildSandboxRunnerWorkload({
      config: { ...workloadConfig(), brokerAuthToken: "gateway-control-token" },
      execute: vi.fn() as never,
      fetchFn,
      durableHealth: () => ({
        outstandingAttempts: 0,
        cleanupFailures: 0,
        oldestOrphanAgeMs: null,
        lastReaperAt: "2026-07-16T00:00:00.000Z",
        reaperFailure: null,
      }),
      candidateReaper: readyCandidateReaper(),
    });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/health",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(200);
      const releaseCall = fetchFn.mock.calls.find((call) =>
        String(call[0]).includes(encodeURIComponent(appId))
        && call[1]?.method === "DELETE");
      expect(releaseCall).toBeDefined();
      expect(JSON.parse(String(releaseCall?.[1]?.body))).toMatchObject({
        appId,
        workloadClean: true,
        candidateClean: true,
      });
    } finally {
      await app.close();
    }
  });

  it("stays live but marks cleanup unready while an execution is active", async () => {
    const candidate = bundle();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const execute = vi.fn(async () => {
      await gate;
      throw new Error("test execution released");
    });
    const app = await buildSandboxRunnerWorkload({
      config: workloadConfig(),
      execute: execute as never,
      fetchFn: vi.fn(async () => new Response(JSON.stringify({ data: { apps: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch,
      durableHealth: () => ({
        outstandingAttempts: 0,
        cleanupFailures: 0,
        oldestOrphanAgeMs: null,
        lastReaperAt: "2026-07-16T00:00:00.000Z",
        reaperFailure: null,
      }),
      candidateReaper: readyCandidateReaper(),
    });
    try {
      const running = app.inject({
        method: "POST",
        url: "/internal/v1/execute",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          schema: "agent-factory-sandbox-workload-command/v1",
          bundleHash: candidate.bundleHash,
          bundle: candidate,
        },
      });
      await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
      const health = await app.inject({
        method: "GET",
        url: "/health",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(health.statusCode).toBe(200);
      expect(health.json()).toMatchObject({
        ok: true,
        cleanupReady: false,
        activeExecutions: 1,
        outstandingAttempts: 0,
      });
      release();
      await running;
    } finally {
      release();
      await app.close();
    }
  });

  it("durably fences cancellation before execute and never enters candidate execution", async () => {
    const candidate = bundle();
    const execute = vi.fn(async ({ signal }: { signal?: AbortSignal }) => {
      expect(signal?.aborted).toBe(true);
      throw new Error("cancelled before start");
    });
    const app = await buildSandboxRunnerWorkload({
      config: workloadConfig(),
      execute: execute as never,
      reconcileCancellation: vi.fn(async () => undefined),
      candidateReaper: readyCandidateReaper(),
    });
    try {
      const cancelled = await app.inject({
        method: "POST",
        url: `/internal/v1/executions/${candidate.attemptId}/cancel`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          schema: "agent-factory-sandbox-workload-cancel/v1",
          attemptId: candidate.attemptId,
          bundleHash: candidate.bundleHash,
          sandboxTenantSlug: candidate.sandboxTenantSlug,
          appId: `agentic-factory-sandbox-${candidate.sandboxTenantSlug}`,
          expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
        },
      });
      expect(cancelled.statusCode).toBe(202);
      expect(cancelled.json()).toMatchObject({
        schema: "agent-factory-sandbox-cancel-fence-ack/v1",
        bundleHash: candidate.bundleHash,
        status: "cancel_fenced",
      });

      const attempted = await app.inject({
        method: "POST",
        url: "/internal/v1/execute",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          schema: "agent-factory-sandbox-workload-command/v1",
          bundleHash: candidate.bundleHash,
          bundle: candidate,
        },
      });
      expect(attempted.statusCode).toBe(200);
      expect(attempted.json()).toMatchObject({
        schema: "agent-factory-sandbox-cancel-fence-ack/v1",
        status: "cancel_fenced",
      });
      expect(execute).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("keeps the exact cancel fence across a workload restart", async () => {
    const candidate = bundle();
    const directory = fenceDir();
    const first = await buildSandboxRunnerWorkload({
      config: workloadConfig(directory),
      execute: vi.fn() as never,
      reconcileCancellation: vi.fn(async () => undefined),
      candidateReaper: readyCandidateReaper(),
    });
    const cancelPayload = {
      schema: "agent-factory-sandbox-workload-cancel/v1",
      attemptId: candidate.attemptId,
      bundleHash: candidate.bundleHash,
      sandboxTenantSlug: candidate.sandboxTenantSlug,
      appId: `agentic-factory-sandbox-${candidate.sandboxTenantSlug}`,
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    };
    await first.inject({
      method: "POST",
      url: `/internal/v1/executions/${candidate.attemptId}/cancel`,
      headers: { authorization: `Bearer ${token}` },
      payload: cancelPayload,
    });
    await first.close();

    const lateExecute = vi.fn();
    const reconcileCancellation = vi.fn(async () => undefined);
    const restarted = await buildSandboxRunnerWorkload({
      config: workloadConfig(directory),
      execute: lateExecute as never,
      reconcileCancellation,
      candidateReaper: readyCandidateReaper(),
    });
    try {
      const response = await restarted.inject({
        method: "POST",
        url: "/internal/v1/execute",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          schema: "agent-factory-sandbox-workload-command/v1",
          bundleHash: candidate.bundleHash,
          bundle: candidate,
        },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        schema: "agent-factory-sandbox-cancel-fence-ack/v1",
        attemptId: candidate.attemptId,
        bundleHash: candidate.bundleHash,
        status: "cancel_fenced",
      });
      expect(lateExecute).not.toHaveBeenCalled();
      expect(reconcileCancellation).toHaveBeenCalledOnce();
    } finally {
      await restarted.close();
    }
  });
});
