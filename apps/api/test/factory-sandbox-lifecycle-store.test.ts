import { createHash } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { GeneratedAgentSpec, SandboxCleanupReceipt } from "@agentic/agent-factory";
import {
  SANDBOX_CLEANUP_RECEIPT_SCHEMA,
  SANDBOX_RUN_DRAIN_RECEIPT_SCHEMA,
  canonicalEvidenceJson,
  sandboxCleanupReceiptHash,
  sandboxRunDrainReceiptHash,
} from "@agentic/agent-factory";
import {
  eq,
  factorySandboxAttempts,
  factorySandboxToolSnapshots,
  factoryTools,
  getDb,
  getRawSqlite,
  tenants,
} from "@agentic/db";
import { assertSandboxAttemptDispatchAllowed } from "@agentic/runtime";

import {
  cloneSandboxDeclarativeTools,
  claimSandboxAttemptForCleanup,
  createSandboxAttemptWithTenant,
  deleteSandboxToolClones,
  heartbeatSandboxAttempt,
  listOutstandingSandboxAttempts,
  markSandboxActive,
  markSandboxCleanupFailed,
  markSandboxCleanupPending,
  markSandboxCleanupVerified,
  markSandboxRunDrainVerified,
  markSandboxRegistering,
  sandboxLeaseFence,
  verifySandboxToolSnapshot,
} from "../src/services/agent-factory/sandbox-lifecycle-store";

const suffix = `${process.pid}-${Date.now().toString(36)}`;
const ownerTenantId = `ten-sbx-owner-${suffix}`;
const ownerTenantSlug = `sbx-owner-${suffix}`;
const sandboxTenantId = `ten-sbx-clone-${suffix}`;
const sandboxTenantSlug = "af-sbx-11111111-22222222-333333333333-sb";
const attemptId = `sba-${suffix}`;
const appId = `factory-test-${sandboxTenantSlug}`;
const domainId = `Agents-generation-${suffix}`;
const toolName = `private.lookup.${suffix}`;
const privateToolId = `tol-private-${suffix}`;
const sharedToolId = `tol-shared-${suffix}`;
const sandboxConfigMarker = `sandbox-config-${suffix}`;

function candidate(): GeneratedAgentSpec {
  return {
    key: "Generate",
    actionName: "Generate",
    slug: `generate-${suffix}`,
    short: "generateAgent",
    domainId,
    nameZh: "生成",
    kind: "llm",
    trigger: ["GENERATION_REQUESTED"],
    emit: ["GENERATION_COMPLETED"],
    tools: [toolName],
    toolSideEffects: { [toolName]: "read" },
    toolPolicies: {
      [toolName]: {
        operation: "read",
        effectScope: "external",
        sandboxPolicy: "live_external",
      },
    },
    toolConfigs: { [toolName]: { endpoint: "https://production.invalid" } },
    sandboxToolConfigs: {
      [toolName]: {
        endpoint: "https://sandbox.invalid",
        namespace: sandboxConfigMarker,
      },
    },
    sandboxToolProfileRefs: { [toolName]: `profile-${suffix}` },
    unresolvedTools: [],
    objects: [],
    systemPrompt: "Generate the function",
    userPrompt: "",
    steps: [],
    plan: [{
      stepId: "items",
      kind: "foreach",
      itemsFrom: "input.items",
      itemAs: "item",
      itemKeyFrom: "id",
      body: [{ stepId: "lookup", kind: "tool", tool: toolName }],
    }],
    ruleRefs: [],
    retries: 1,
    hitl: false,
    confidence: 1,
  } as GeneratedAgentSpec;
}

describe("Agent Factory durable sandbox ledger and tool clones", () => {
  beforeAll(() => {
    const now = new Date();
    const db = getDb();
    db.insert(tenants).values({
      id: ownerTenantId,
      slug: ownerTenantSlug,
      name: "Sandbox lifecycle owner",
      createdAt: now,
      updatedAt: now,
    }).run();
    db.insert(factoryTools).values([
      {
        id: sharedToolId,
        scopeKey: "shared",
        domainKey: domainId,
        name: toolName,
        tenantId: null,
        description: "shared definition must lose to target-private",
        method: "GET",
        urlTemplate: "https://shared.invalid/lookup",
        sideEffect: "read",
        operation: "read",
        effectScope: "external",
        sandboxPolicy: "live_external",
        domain: domainId,
        probeStatus: "verified",
        definitionHash: `shared-${suffix}`,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: privateToolId,
        scopeKey: ownerTenantId,
        domainKey: domainId,
        name: toolName,
        tenantId: ownerTenantId,
        description: "target-private immutable snapshot",
        method: "GET",
        urlTemplate: "https://private.invalid/lookup/{id}",
        headers: { Authorization: "Bearer ${PRIVATE_LOOKUP_KEY}" },
        requestSpec: { encoding: "json", fields: ["id"] },
        responseSpec: { select: "data.result" },
        examples: [{ input: { id: "safe-fixture" }, output: { ok: true } }],
        sideEffect: "read",
        operation: "read",
        effectScope: "external",
        sandboxPolicy: "live_external",
        domain: domainId,
        paramsSchema: { type: "object", required: ["id"] },
        returnsSchema: { type: "object" },
        capabilities: { systems: ["Allmeta-test-double"] },
        probeStatus: "verified",
        definitionHash: `private-${suffix}`,
        probeEvidence: { fixture: true },
        verifiedAt: now,
        createdAt: now,
        updatedAt: now,
      },
    ]).run();
  });

  afterAll(() => {
    const db = getDb();
    db.delete(factorySandboxToolSnapshots)
      .where(eq(factorySandboxToolSnapshots.attemptId, attemptId))
      .run();
    db.delete(factoryTools).where(eq(factoryTools.scopeKey, sandboxTenantId)).run();
    db.delete(factorySandboxAttempts).where(eq(factorySandboxAttempts.id, attemptId)).run();
    db.delete(factoryTools).where(eq(factoryTools.id, privateToolId)).run();
    db.delete(factoryTools).where(eq(factoryTools.id, sharedToolId)).run();
    db.delete(tenants).where(eq(tenants.id, sandboxTenantId)).run();
    db.delete(tenants).where(eq(tenants.id, ownerTenantId)).run();
    vi.unstubAllGlobals();
  });

  it("has the durable lifecycle migration on the isolated test database", () => {
    const sqlite = getRawSqlite();
    const attemptColumns = sqlite
      .prepare("PRAGMA table_info(factory_sandbox_attempts)")
      .all() as Array<{ name: string }>;
    const snapshotColumns = sqlite
      .prepare("PRAGMA table_info(factory_sandbox_tool_snapshots)")
      .all() as Array<{ name: string }>;
    expect(attemptColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
      "status",
      "remote_may_exist",
      "lease_expires_at",
      "cleanup_receipt",
      "cleanup_error",
      "run_drain_status",
      "run_drain_receipt",
      "run_drain_error",
      "lease_token",
      "fence_generation",
    ]));
    expect(snapshotColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
      "source_tool_id",
      "source_definition_hash",
      "config_hash",
      "domain_hash",
      "snapshot_hash",
    ]));
  });

  it("clones only the selected private definition, detects drift, and physically deletes it", () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("external network is forbidden in this test");
    }));

    const prepared = createSandboxAttemptWithTenant({
      attemptId,
      ownerTenantId,
      ownerTenantSlug,
      targetDomainId: domainId,
      candidateFingerprint: `candidate:${suffix}`,
      sandboxTenantId,
      sandboxTenantSlug,
      appId,
    });
    expect(prepared).toMatchObject({
      status: "prepared",
      remoteMayExist: false,
      toolSnapshotCount: 0,
      fenceGeneration: 1,
    });
    expect(prepared.leaseToken).toMatch(/\S/);
    const initialLease = sandboxLeaseFence(prepared);

    const result = cloneSandboxDeclarativeTools({
      attemptId,
      lease: initialLease,
      ownerTenantId,
      targetDomainId: domainId,
      candidateFingerprint: `candidate:${suffix}`,
      sandboxTenantId,
      specs: [candidate()],
    });
    expect(result).toMatchObject({ count: 1, toolNames: [toolName] });
    expect(result.snapshotHash).toMatch(/^factory-tool-snapshot-set:v1:[a-f0-9]{64}$/);

    const clone = getDb()
      .select()
      .from(factoryTools)
      .where(eq(factoryTools.scopeKey, sandboxTenantId))
      .get()!;
    const provenance = getDb()
      .select()
      .from(factorySandboxToolSnapshots)
      .where(eq(factorySandboxToolSnapshots.attemptId, attemptId))
      .get()!;
    expect(clone).toMatchObject({
      tenantId: sandboxTenantId,
      scopeKey: sandboxTenantId,
      name: toolName,
      description: "target-private immutable snapshot",
      urlTemplate: "https://private.invalid/lookup/{id}",
    });
    expect(provenance).toMatchObject({
      sourceToolId: privateToolId,
      sourceScopeKey: ownerTenantId,
      sandboxToolId: clone.id,
    });
    expect(JSON.stringify(provenance)).not.toContain(sandboxConfigMarker);

    const expectedConfigHash = createHash("sha256")
      .update(canonicalEvidenceJson([{
        slug: `generate-${suffix}`,
        config: {
          endpoint: "https://sandbox.invalid",
          namespace: sandboxConfigMarker,
        },
        profileRef: `profile-${suffix}`,
        sideEffect: "read",
        executionPolicy: {
          operation: "read",
          effectScope: "external",
          sandboxPolicy: "live_external",
        },
      }]), "utf8")
      .digest("hex");
    expect(provenance.configHash).toBe(`factory-tool-config:v1:${expectedConfigHash}`);
    expect(verifySandboxToolSnapshot(attemptId)).toEqual({
      snapshotHash: result.snapshotHash,
      count: 1,
    });

    // The source can evolve after cloning without changing this attempt.
    getDb().update(factoryTools)
      .set({ description: "source changed after snapshot" })
      .where(eq(factoryTools.id, privateToolId))
      .run();
    expect(verifySandboxToolSnapshot(attemptId).count).toBe(1);
    expect(getDb().select().from(factoryTools).where(eq(factoryTools.id, clone.id)).get()?.description)
      .toBe("target-private immutable snapshot");

    // The clone itself is content-addressed and cannot drift before registration.
    getDb().update(factoryTools).set({ method: "POST" }).where(eq(factoryTools.id, clone.id)).run();
    expect(() => verifySandboxToolSnapshot(attemptId)).toThrow(/clone content drift/);
    getDb().update(factoryTools).set({ method: "GET" }).where(eq(factoryTools.id, clone.id)).run();
    expect(verifySandboxToolSnapshot(attemptId).count).toBe(1);

    markSandboxRegistering(initialLease);
    expect(getDb().select().from(factorySandboxAttempts).where(eq(factorySandboxAttempts.id, attemptId)).get())
      .toMatchObject({ status: "registering", remoteMayExist: true });
    markSandboxActive(initialLease);
    expect(() => assertSandboxAttemptDispatchAllowed({
      tenantId: sandboxTenantId,
      tenantSlug: sandboxTenantSlug,
      appId,
      executionScope: {
        kind: "sandbox",
        target_domain_id: domainId,
        candidate_fingerprint: `candidate:${suffix}`,
        attempt_id: attemptId,
      },
    })).not.toThrow();
    markSandboxCleanupPending(initialLease);
    markSandboxCleanupFailed(initialLease, new Error("Bearer do-not-store token=do-not-store"));
    const failed = getDb().select().from(factorySandboxAttempts).where(eq(factorySandboxAttempts.id, attemptId)).get()!;
    expect(failed).toMatchObject({ status: "cleanup_failed", remoteMayExist: true });
    expect(failed.cleanupError).toContain("[REDACTED]");
    expect(failed.cleanupError).not.toContain("do-not-store");
    expect(listOutstandingSandboxAttempts().map((row) => row.id)).toContain(attemptId);

    const cleanupLease = claimSandboxAttemptForCleanup(attemptId)!;
    expect(cleanupLease).toEqual(expect.objectContaining({
      attemptId,
      fenceGeneration: initialLease.fenceGeneration + 1,
    }));
    expect(cleanupLease.leaseToken).not.toBe(initialLease.leaseToken);
    expect(claimSandboxAttemptForCleanup(attemptId)).toBeNull();

    // A writer holding the old owner/token/generation cannot renew or mutate
    // after the reaper atomically claims cleanup, even though the row is in a
    // status where a heartbeat would otherwise be legal.
    expect(() => heartbeatSandboxAttempt(initialLease)).toThrow(/superseded/);
    const afterStaleWrite = getDb().select().from(factorySandboxAttempts)
      .where(eq(factorySandboxAttempts.id, attemptId)).get()!;
    expect(sandboxLeaseFence(afterStaleWrite)).toEqual(cleanupLease);
    expect(() => heartbeatSandboxAttempt(cleanupLease)).not.toThrow();
    markSandboxCleanupPending(cleanupLease);
    expect(() => assertSandboxAttemptDispatchAllowed({
      tenantId: sandboxTenantId,
      tenantSlug: sandboxTenantSlug,
      appId,
      executionScope: {
        kind: "sandbox",
        target_domain_id: domainId,
        candidate_fingerprint: `candidate:${suffix}`,
        attempt_id: attemptId,
      },
    })).toThrow(/cleanup_pending/);
    deleteSandboxToolClones(cleanupLease, sandboxTenantId);
    expect(getDb().select().from(factoryTools).where(eq(factoryTools.scopeKey, sandboxTenantId)).all())
      .toEqual([]);
    expect(getDb().select().from(factorySandboxToolSnapshots).where(eq(factorySandboxToolSnapshots.attemptId, attemptId)).all())
      .toEqual([]);
    expect(getDb().select().from(factoryTools).where(eq(factoryTools.id, privateToolId)).get())
      .toBeDefined();

    const receiptBody: Omit<SandboxCleanupReceipt, "absenceProbeHash"> = {
      schema: SANDBOX_CLEANUP_RECEIPT_SCHEMA,
      appId,
      sandboxTenantSlug,
      sandboxAttemptId: attemptId,
      candidateFingerprint: `candidate:${suffix}`,
      targetDomainId: domainId,
      runDrain: (() => {
        const drainBody = {
          schema: SANDBOX_RUN_DRAIN_RECEIPT_SCHEMA,
          sandboxAttemptId: attemptId,
          appId,
          sandboxTenantSlug,
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          observedRuns: [],
        };
        return { ...drainBody, evidenceHash: sandboxRunDrainReceiptHash(drainBody) };
      })(),
      deletedAt: new Date().toISOString(),
      absence: {
        connected: false,
        functionCount: null,
        registryState: "not_registered",
      },
    };
    const receipt: SandboxCleanupReceipt = {
      ...receiptBody,
      absenceProbeHash: sandboxCleanupReceiptHash(receiptBody),
    };
    markSandboxRunDrainVerified(cleanupLease, receipt.runDrain);
    markSandboxCleanupVerified(cleanupLease, receipt);
    const terminal = getDb().select().from(factorySandboxAttempts).where(eq(factorySandboxAttempts.id, attemptId)).get()!;
    expect(terminal).toMatchObject({
      status: "cleanup_verified",
      remoteMayExist: false,
      cleanupError: null,
      cleanupReceipt: receipt,
    });
    expect(listOutstandingSandboxAttempts().map((row) => row.id)).not.toContain(attemptId);
    expect(fetch).not.toHaveBeenCalled();
  });
});
