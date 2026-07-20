import { createHash, randomUUID } from "node:crypto";

import type { GeneratedAgentSpec, SandboxCleanupReceipt, SandboxRunDrainReceipt } from "@agentic/agent-factory";
import {
  canonicalEvidenceJson,
  isGeneratedToolExecutionPolicy,
  sandboxRunDrainReceiptIssues,
} from "@agentic/agent-factory";
import { and, gt, inArray, lte, ne, or, sql } from "drizzle-orm";
import {
  eq,
  factorySandboxAttempts,
  factorySandboxToolSnapshots,
  factoryTools,
  getDb,
  tenants,
} from "@agentic/db";

export type SandboxAttemptStatus =
  | "prepared"
  | "registering"
  | "active"
  | "cleanup_pending"
  | "cleanup_failed"
  | "cleanup_verified";

export type SandboxAttemptRecord = typeof factorySandboxAttempts.$inferSelect;

export interface SandboxLeaseFence {
  attemptId: string;
  leaseOwner: string;
  leaseToken: string;
  fenceGeneration: number;
}

const PROCESS_LEASE_OWNER = `factory-sandbox:${process.pid}:${randomUUID()}`;
const TERMINAL = new Set<SandboxAttemptStatus>(["cleanup_verified"]);

function positiveDuration(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

export function sandboxAttemptLeaseMs(): number {
  return positiveDuration("FACTORY_SANDBOX_ATTEMPT_LEASE_MS", 180_000);
}

export function sandboxAttemptHeartbeatMs(): number {
  const heartbeat = positiveDuration("FACTORY_SANDBOX_ATTEMPT_HEARTBEAT_MS", 30_000);
  if (heartbeat >= sandboxAttemptLeaseMs()) {
    throw new Error(
      "FACTORY_SANDBOX_ATTEMPT_HEARTBEAT_MS must be lower than FACTORY_SANDBOX_ATTEMPT_LEASE_MS",
    );
  }
  return heartbeat;
}

function leaseDeadline(now = new Date()): Date {
  return new Date(now.getTime() + sandboxAttemptLeaseMs());
}

export function sandboxLeaseFence(row: SandboxAttemptRecord): SandboxLeaseFence {
  return {
    attemptId: row.id,
    leaseOwner: row.leaseOwner,
    leaseToken: row.leaseToken,
    fenceGeneration: row.fenceGeneration,
  };
}

function sha(value: unknown): string {
  return createHash("sha256").update(canonicalEvidenceJson(value), "utf8").digest("hex");
}

function safeError(error: unknown): string {
  return String((error as Error)?.message ?? error)
    .replace(/\bBearer\s+[^\s,"'}]+/gi, "Bearer [REDACTED]")
    .replace(/((?:api[_-]?key|token|secret|password|credential)\s*[:=]\s*)[^\s,"'}]+/gi, "$1[REDACTED]")
    .slice(0, 500);
}

export function createSandboxAttemptWithTenant(args: {
  attemptId: string;
  ownerTenantId: string;
  ownerTenantSlug: string;
  targetDomainId: string;
  candidateFingerprint: string;
  sandboxTenantId: string;
  sandboxTenantSlug: string;
  appId: string;
}): SandboxAttemptRecord {
  const db = getDb();
  const now = new Date();
  db.transaction((tx) => {
    const existingTenant = tx
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.slug, args.sandboxTenantSlug))
      .all()[0];
    const existingAttempt = tx
      .select({ id: factorySandboxAttempts.id })
      .from(factorySandboxAttempts)
      .where(eq(factorySandboxAttempts.appId, args.appId))
      .all()[0];
    if (existingTenant || existingAttempt) {
      throw new Error("fresh sandbox identity collided with durable state");
    }
    tx.insert(tenants).values({
      id: args.sandboxTenantId,
      slug: args.sandboxTenantSlug,
      name: `${args.ownerTenantSlug} · ${args.targetDomainId} 临时沙箱`,
      subtitle: `Agent Factory ephemeral ${args.attemptId}`,
      createdAt: now,
      updatedAt: now,
    }).run();
    tx.insert(factorySandboxAttempts).values({
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
      toolSnapshotCount: 0,
      leaseOwner: PROCESS_LEASE_OWNER,
      leaseToken: randomUUID(),
      fenceGeneration: 1,
      leaseExpiresAt: leaseDeadline(now),
      createdAt: now,
      updatedAt: now,
    }).run();
  });
  const row = db
    .select()
    .from(factorySandboxAttempts)
    .where(eq(factorySandboxAttempts.id, args.attemptId))
    .all()[0];
  if (!row) throw new Error("sandbox attempt ledger insert was not durable");
  return row;
}

function declaredToolNames(specs: GeneratedAgentSpec[]): string[] {
  const names = new Set<string>();
  const visit = (steps: GeneratedAgentSpec["plan"]): void => {
    for (const step of steps ?? []) {
      if (step.kind === "tool" && step.tool?.trim()) names.add(step.tool.trim());
      if (step.body?.length) visit(step.body);
    }
  };
  for (const spec of specs) {
    for (const name of spec.tools ?? []) if (name.trim()) names.add(name.trim());
    visit(spec.plan);
  }
  return [...names].sort();
}

function sourceRank(
  row: typeof factoryTools.$inferSelect,
  ownerTenantId: string,
  targetDomainId: string,
): number {
  const owner = row.scopeKey === ownerTenantId ? 20 : row.scopeKey === "shared" ? 10 : 0;
  const domain = row.domainKey === targetDomainId ? 2 : row.domainKey === "" ? 1 : 0;
  return owner + domain;
}

function sourceDefinitionHash(row: typeof factoryTools.$inferSelect): string {
  return `factory-tool-source:v1:${sha({
    name: row.name,
    description: row.description,
    method: row.method,
    urlTemplate: row.urlTemplate,
    headers: row.headers,
    bodyTemplate: row.bodyTemplate,
    requestSpec: row.requestSpec,
    responseSpec: row.responseSpec,
    examples: row.examples,
    sideEffect: row.sideEffect,
    operation: row.operation,
    effectScope: row.effectScope,
    sandboxPolicy: row.sandboxPolicy,
    paramsSchema: row.paramsSchema,
    returnsSchema: row.returnsSchema,
    capabilities: row.capabilities,
    probeStatus: row.probeStatus,
    definitionHash: row.definitionHash,
    probeEvidence: row.probeEvidence,
    verifiedAt: row.verifiedAt,
  })}`;
}

function planUsesTool(plan: GeneratedAgentSpec["plan"], name: string): boolean {
  return (plan ?? []).some(
    (step) =>
      (step.kind === "tool" && step.tool === name) ||
      (step.body?.length ? planUsesTool(step.body, name) : false),
  );
}

function configsForTool(specs: GeneratedAgentSpec[], name: string): unknown[] {
  return specs
    .filter((spec) =>
      (spec.tools ?? []).includes(name) ||
      planUsesTool(spec.plan, name),
    )
    .map((spec) => ({
      slug: spec.slug,
      // This is the exact config mapToManifest emits for the sandbox target.
      // Production toolConfigs must never be silently substituted here.
      config: spec.sandboxToolConfigs?.[name] ?? {},
      profileRef: spec.sandboxToolProfileRefs?.[name] ?? null,
      sideEffect: spec.toolSideEffects?.[name] ?? null,
      executionPolicy: spec.toolPolicies?.[name] ?? null,
    }))
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

/** Clone every persisted declarative definition selected by the candidate into
 * the fresh sandbox tenant. No raw per-agent config is persisted in the
 * provenance table: only its canonical hash. */
export function cloneSandboxDeclarativeTools(args: {
  attemptId: string;
  lease: SandboxLeaseFence;
  ownerTenantId: string;
  targetDomainId: string;
  candidateFingerprint: string;
  sandboxTenantId: string;
  specs: GeneratedAgentSpec[];
}): { snapshotHash: string; count: number; toolNames: string[] } {
  const db = getDb();
  const names = declaredToolNames(args.specs);
  const allRows = db.select().from(factoryTools).all();
  const chosen = names.flatMap((name) => {
    const candidates = allRows
      .filter((row) => row.name === name)
      .filter((row) => row.scopeKey === args.ownerTenantId || row.scopeKey === "shared")
      .filter((row) => row.domainKey === "" || row.domainKey === args.targetDomainId)
      .sort((a, b) => sourceRank(b, args.ownerTenantId, args.targetDomainId) - sourceRank(a, args.ownerTenantId, args.targetDomainId));
    return candidates[0] ? [candidates[0]] : [];
  });
  const snapshots = chosen.map((source) => {
    if (!isGeneratedToolExecutionPolicy({
      operation: source.operation,
      effectScope: source.effectScope,
      sandboxPolicy: source.sandboxPolicy,
    })) {
      throw new Error(
        `sandbox declarative tool ${source.name} requires explicit execution-policy migration`,
      );
    }
    const definitionHash = sourceDefinitionHash(source);
    const configHash = `factory-tool-config:v1:${sha(configsForTool(args.specs, source.name))}`;
    const domainHash = `factory-tool-domain:v1:${sha({
      targetDomainId: args.targetDomainId,
      sourceDomainKey: source.domainKey,
      sourceDomain: source.domain,
    })}`;
    const snapshotHash = `factory-tool-snapshot:v1:${sha({
      candidateFingerprint: args.candidateFingerprint,
      sourceToolId: source.id,
      sourceScopeKey: source.scopeKey,
      definitionHash,
      configHash,
      domainHash,
    })}`;
    return {
      source,
      definitionHash,
      configHash,
      domainHash,
      snapshotHash,
      cloneId: `tol-sbx-${sha({ attemptId: args.attemptId, snapshotHash }).slice(0, 32)}`,
    };
  });
  const aggregate = `factory-tool-snapshot-set:v1:${sha({
    attemptId: args.attemptId,
    candidateFingerprint: args.candidateFingerprint,
    targetDomainId: args.targetDomainId,
    snapshots: snapshots.map((entry) => entry.snapshotHash).sort(),
  })}`;
  const now = new Date();
  db.transaction((tx) => {
    for (const entry of snapshots) {
      const source = entry.source;
      tx.insert(factoryTools).values({
        id: entry.cloneId,
        scopeKey: args.sandboxTenantId,
        domainKey: source.domainKey,
        name: source.name,
        tenantId: args.sandboxTenantId,
        description: source.description,
        method: source.method,
        urlTemplate: source.urlTemplate,
        headers: source.headers,
        bodyTemplate: source.bodyTemplate,
        requestSpec: source.requestSpec,
        responseSpec: source.responseSpec,
        examples: source.examples,
        sideEffect: source.sideEffect,
        operation: source.operation,
        effectScope: source.effectScope,
        sandboxPolicy: source.sandboxPolicy,
        domain: source.domain,
        paramsSchema: source.paramsSchema,
        returnsSchema: source.returnsSchema,
        capabilities: source.capabilities,
        probeStatus: source.probeStatus,
        definitionHash: source.definitionHash,
        probeEvidence: source.probeEvidence,
        verifiedAt: source.verifiedAt,
        createdAt: now,
        updatedAt: now,
      }).run();
      tx.insert(factorySandboxToolSnapshots).values({
        id: `sbt-${sha({ attemptId: args.attemptId, tool: source.name }).slice(0, 32)}`,
        attemptId: args.attemptId,
        sandboxTenantId: args.sandboxTenantId,
        sandboxToolId: entry.cloneId,
        toolName: source.name,
        sourceToolId: source.id,
        sourceScopeKey: source.scopeKey,
        sourceDefinitionHash: entry.definitionHash,
        configHash: entry.configHash,
        domainHash: entry.domainHash,
        snapshotHash: entry.snapshotHash,
        createdAt: now,
      }).run();
    }
    const updated = tx
      .update(factorySandboxAttempts)
      .set({
        toolSnapshotHash: aggregate,
        toolSnapshotCount: snapshots.length,
        updatedAt: now,
        leaseOwner: PROCESS_LEASE_OWNER,
        leaseExpiresAt: leaseDeadline(now),
      })
      .where(and(
        eq(factorySandboxAttempts.id, args.attemptId),
        eq(factorySandboxAttempts.leaseOwner, args.lease.leaseOwner),
        eq(factorySandboxAttempts.leaseToken, args.lease.leaseToken),
        eq(factorySandboxAttempts.fenceGeneration, args.lease.fenceGeneration),
        eq(factorySandboxAttempts.status, "prepared"),
        gt(factorySandboxAttempts.leaseExpiresAt, now),
      ))
      .run() as { changes?: number };
    if ((updated.changes ?? 0) !== 1) throw new Error("sandbox attempt disappeared while cloning tools");
  });
  return { snapshotHash: aggregate, count: snapshots.length, toolNames: snapshots.map((entry) => entry.source.name) };
}

export function verifySandboxToolSnapshot(attemptId: string): { snapshotHash: string; count: number } {
  const db = getDb();
  const attempt = db.select().from(factorySandboxAttempts).where(eq(factorySandboxAttempts.id, attemptId)).all()[0];
  if (!attempt?.toolSnapshotHash) throw new Error("sandbox tool snapshot was not durably recorded");
  const snapshots = db
    .select()
    .from(factorySandboxToolSnapshots)
    .where(eq(factorySandboxToolSnapshots.attemptId, attemptId))
    .all();
  if (snapshots.length !== attempt.toolSnapshotCount) throw new Error("sandbox tool snapshot count drift");
  const cloned = db
    .select()
    .from(factoryTools)
    .where(eq(factoryTools.scopeKey, attempt.sandboxTenantId))
    .all();
  if (cloned.length !== snapshots.length) throw new Error("sandbox declarative clone set drift");
  const clonesById = new Map(cloned.map((row) => [row.id, row]));
  for (const snapshot of snapshots) {
    const clone = clonesById.get(snapshot.sandboxToolId);
    if (
      snapshot.sandboxTenantId !== attempt.sandboxTenantId ||
      !clone ||
      clone.scopeKey !== attempt.sandboxTenantId ||
      clone.tenantId !== attempt.sandboxTenantId ||
      clone.name !== snapshot.toolName
    ) {
      throw new Error("sandbox declarative clone provenance mismatch");
    }
    if (sourceDefinitionHash(clone) !== snapshot.sourceDefinitionHash) {
      throw new Error(`sandbox declarative clone content drift: ${snapshot.toolName}`);
    }
    const expectedDomainHash = `factory-tool-domain:v1:${sha({
      targetDomainId: attempt.targetDomainId,
      sourceDomainKey: clone.domainKey,
      sourceDomain: clone.domain,
    })}`;
    if (expectedDomainHash !== snapshot.domainHash) {
      throw new Error(`sandbox declarative clone domain drift: ${snapshot.toolName}`);
    }
    const expectedSnapshot = `factory-tool-snapshot:v1:${sha({
      candidateFingerprint: attempt.candidateFingerprint,
      sourceToolId: snapshot.sourceToolId,
      sourceScopeKey: snapshot.sourceScopeKey,
      definitionHash: snapshot.sourceDefinitionHash,
      configHash: snapshot.configHash,
      domainHash: snapshot.domainHash,
    })}`;
    if (expectedSnapshot !== snapshot.snapshotHash) {
      throw new Error(`sandbox declarative snapshot provenance drift: ${snapshot.toolName}`);
    }
  }
  const expected = `factory-tool-snapshot-set:v1:${sha({
    attemptId: attempt.id,
    candidateFingerprint: attempt.candidateFingerprint,
    targetDomainId: attempt.targetDomainId,
    snapshots: snapshots.map((entry) => entry.snapshotHash).sort(),
  })}`;
  if (expected !== attempt.toolSnapshotHash) throw new Error("sandbox tool snapshot hash mismatch");
  return { snapshotHash: expected, count: snapshots.length };
}

function fencedAttemptWhere(
  lease: SandboxLeaseFence,
  expectedStatuses: SandboxAttemptStatus[],
  now: Date,
) {
  if (
    !lease.attemptId
    || !lease.leaseOwner
    || !lease.leaseToken
    || !Number.isSafeInteger(lease.fenceGeneration)
    || lease.fenceGeneration < 1
  ) throw new Error("sandbox attempt lease fence is invalid");
  return and(
    eq(factorySandboxAttempts.id, lease.attemptId),
    eq(factorySandboxAttempts.leaseOwner, lease.leaseOwner),
    eq(factorySandboxAttempts.leaseToken, lease.leaseToken),
    eq(factorySandboxAttempts.fenceGeneration, lease.fenceGeneration),
    inArray(factorySandboxAttempts.status, expectedStatuses),
    gt(factorySandboxAttempts.leaseExpiresAt, now),
  );
}

function updateAttempt(
  lease: SandboxLeaseFence,
  expectedStatuses: SandboxAttemptStatus[],
  values: Partial<typeof factorySandboxAttempts.$inferInsert>,
  now = new Date(),
): void {
  const result = getDb()
    .update(factorySandboxAttempts)
    .set({ ...values, updatedAt: now })
    .where(fencedAttemptWhere(lease, expectedStatuses, now))
    .run() as { changes?: number };
  if ((result.changes ?? 0) !== 1) {
    throw new Error(
      `sandbox attempt lease was expired, superseded, or in an illegal state: ${lease.attemptId}@${lease.fenceGeneration}`,
    );
  }
}

export function assertSandboxAttemptFence(
  lease: SandboxLeaseFence,
  expectedStatuses: SandboxAttemptStatus[],
  now = new Date(),
): SandboxAttemptRecord {
  const row = getDb()
    .select()
    .from(factorySandboxAttempts)
    .where(fencedAttemptWhere(lease, expectedStatuses, now))
    .all()[0];
  if (!row) {
    throw new Error(
      `sandbox attempt lease was expired, superseded, or in an illegal state: ${lease.attemptId}@${lease.fenceGeneration}`,
    );
  }
  return row;
}

export function heartbeatSandboxAttempt(lease: SandboxLeaseFence): void {
  const now = new Date();
  updateAttempt(
    lease,
    ["prepared", "registering", "active", "cleanup_pending"],
    { leaseExpiresAt: leaseDeadline(now) },
    now,
  );
}

export function markSandboxRegistering(lease: SandboxLeaseFence): void {
  updateAttempt(lease, ["prepared"], {
    status: "registering",
    remoteMayExist: true,
    leaseExpiresAt: leaseDeadline(),
    cleanupError: null,
  });
}

export function markSandboxActive(lease: SandboxLeaseFence): void {
  updateAttempt(lease, ["registering"], {
    status: "active",
    remoteMayExist: true,
    leaseExpiresAt: leaseDeadline(),
  });
}

export function markSandboxCleanupPending(lease: SandboxLeaseFence): void {
  const now = new Date();
  updateAttempt(lease, ["prepared", "registering", "active", "cleanup_pending"], {
    status: "cleanup_pending",
    cleanupStartedAt: now,
    cleanupError: null,
    leaseExpiresAt: leaseDeadline(now),
  }, now);
}

export function markSandboxRunDrainStarted(
  lease: SandboxLeaseFence,
  startedAt = new Date(),
): void {
  updateAttempt(lease, ["cleanup_pending"], {
    runDrainStatus: "cancelling",
    runDrainReceipt: null,
    runDrainError: null,
    runDrainStartedAt: startedAt,
    runDrainCompletedAt: null,
    leaseExpiresAt: leaseDeadline(startedAt),
  }, startedAt);
}

export function markSandboxRunDrainVerified(
  lease: SandboxLeaseFence,
  receipt: SandboxRunDrainReceipt,
): void {
  const attempt = getDb()
    .select()
    .from(factorySandboxAttempts)
    .where(fencedAttemptWhere(lease, ["cleanup_pending"], new Date()))
    .all()[0];
  if (!attempt) throw new Error(`sandbox attempt lease is no longer current: ${lease.attemptId}`);
  const issues = sandboxRunDrainReceiptIssues(receipt, {
    sandboxAttemptId: attempt.id,
    appId: attempt.appId,
    sandboxTenantSlug: attempt.sandboxTenantSlug,
  });
  if (issues.length) throw new Error(`invalid sandbox run-drain receipt: ${issues.join("; ")}`);
  updateAttempt(lease, ["cleanup_pending"], {
    runDrainStatus: "verified",
    runDrainReceipt: receipt,
    runDrainError: null,
    runDrainCompletedAt: new Date(receipt.completedAt),
    leaseExpiresAt: leaseDeadline(),
  });
}

export function markSandboxRunDrainFailed(lease: SandboxLeaseFence, error: unknown): void {
  updateAttempt(lease, ["cleanup_pending"], {
    runDrainStatus: "failed",
    runDrainError: safeError(error),
    runDrainCompletedAt: null,
    leaseExpiresAt: leaseDeadline(),
  });
}

/** Atomically lease an expired/failed row to one reaper process. */
export function claimSandboxAttemptForCleanup(
  attemptId: string,
  now = new Date(),
): SandboxLeaseFence | null {
  const leaseToken = randomUUID();
  const result = getDb()
    .update(factorySandboxAttempts)
    .set({
      status: "cleanup_pending",
      cleanupStartedAt: now,
      cleanupError: null,
      leaseOwner: PROCESS_LEASE_OWNER,
      leaseToken,
      fenceGeneration: sql`${factorySandboxAttempts.fenceGeneration} + 1`,
      leaseExpiresAt: leaseDeadline(now),
      updatedAt: now,
    })
    .where(and(
      eq(factorySandboxAttempts.id, attemptId),
      ne(factorySandboxAttempts.status, "cleanup_verified"),
      or(
        eq(factorySandboxAttempts.status, "cleanup_failed"),
        lte(factorySandboxAttempts.leaseExpiresAt, now),
      ),
    ))
    .returning({
      attemptId: factorySandboxAttempts.id,
      leaseOwner: factorySandboxAttempts.leaseOwner,
      leaseToken: factorySandboxAttempts.leaseToken,
      fenceGeneration: factorySandboxAttempts.fenceGeneration,
    })
    .all()[0];
  return result ?? null;
}

export function markSandboxCleanupFailed(lease: SandboxLeaseFence, error: unknown): void {
  updateAttempt(lease, ["cleanup_pending"], {
    status: "cleanup_failed",
    remoteMayExist: true,
    cleanupError: safeError(error),
    leaseExpiresAt: new Date(0),
  });
}

export function deleteSandboxToolClones(
  lease: SandboxLeaseFence,
  sandboxTenantId: string,
): void {
  const db = getDb();
  db.transaction((tx) => {
    const owned = tx.select({ id: factorySandboxAttempts.id })
      .from(factorySandboxAttempts)
      .where(fencedAttemptWhere(lease, ["cleanup_pending"], new Date()))
      .all()[0];
    if (!owned) throw new Error("sandbox tool-clone deletion lost its lease fence");
    tx.delete(factoryTools).where(eq(factoryTools.scopeKey, sandboxTenantId)).run();
    tx.delete(factorySandboxToolSnapshots).where(eq(factorySandboxToolSnapshots.attemptId, lease.attemptId)).run();
    const remainingTools = tx.select({ id: factoryTools.id }).from(factoryTools).where(eq(factoryTools.scopeKey, sandboxTenantId)).all();
    const remainingSnapshots = tx.select({ id: factorySandboxToolSnapshots.id }).from(factorySandboxToolSnapshots).where(eq(factorySandboxToolSnapshots.attemptId, lease.attemptId)).all();
    if (remainingTools.length || remainingSnapshots.length) throw new Error("sandbox declarative clones were not physically deleted");
  });
}

export function markSandboxCleanupVerified(
  lease: SandboxLeaseFence,
  receipt: SandboxCleanupReceipt,
): void {
  const attempt = getDb()
    .select()
    .from(factorySandboxAttempts)
    .where(fencedAttemptWhere(lease, ["cleanup_pending"], new Date()))
    .all()[0];
  if (
    !attempt ||
    attempt.runDrainStatus !== "verified" ||
    !attempt.runDrainReceipt ||
    canonicalEvidenceJson(attempt.runDrainReceipt) !== canonicalEvidenceJson(receipt.runDrain)
  ) {
    throw new Error("sandbox cleanup receipt refused: durable run-drain proof is missing or mismatched");
  }
  const now = new Date();
  updateAttempt(lease, ["cleanup_pending"], {
    status: "cleanup_verified",
    remoteMayExist: false,
    cleanupReceipt: receipt,
    cleanupError: null,
    cleanedAt: now,
    leaseExpiresAt: now,
  }, now);
}

export function listSandboxAttempts(): SandboxAttemptRecord[] {
  return getDb().select().from(factorySandboxAttempts).all();
}

export function listOutstandingSandboxAttempts(args: {
  ownerTenantId?: string;
  targetDomainId?: string;
  excludeAttemptIds?: ReadonlySet<string>;
} = {}): SandboxAttemptRecord[] {
  return listSandboxAttempts().filter((row) => {
    if (TERMINAL.has(row.status as SandboxAttemptStatus)) return false;
    if (args.ownerTenantId && row.ownerTenantId !== args.ownerTenantId) return false;
    if (args.targetDomainId && row.targetDomainId !== args.targetDomainId) return false;
    if (args.excludeAttemptIds?.has(row.id)) return false;
    return true;
  });
}

export function listReapableSandboxAttempts(args: {
  now?: Date;
  ownerTenantId?: string;
  targetDomainId?: string;
  excludeAttemptIds?: ReadonlySet<string>;
} = {}): SandboxAttemptRecord[] {
  const now = args.now ?? new Date();
  return listSandboxAttempts().filter((row) => {
    if (TERMINAL.has(row.status as SandboxAttemptStatus)) return false;
    if (args.ownerTenantId && row.ownerTenantId !== args.ownerTenantId) return false;
    if (args.targetDomainId && row.targetDomainId !== args.targetDomainId) return false;
    if (args.excludeAttemptIds?.has(row.id)) return false;
    return row.status === "cleanup_failed" || row.leaseExpiresAt.getTime() <= now.getTime();
  });
}

export function sandboxAttemptContext(
  row: SandboxAttemptRecord,
  lease: SandboxLeaseFence = sandboxLeaseFence(row),
): {
  tenantId: string;
  tenantSlug: string;
  appId: string;
  attemptId: string;
  candidateFingerprint: string;
  targetDomainId: string;
  lease: SandboxLeaseFence;
} {
  return {
    tenantId: row.sandboxTenantId,
    tenantSlug: row.sandboxTenantSlug,
    appId: row.appId,
    attemptId: row.id,
    candidateFingerprint: row.candidateFingerprint,
    targetDomainId: row.targetDomainId,
    lease,
  };
}

export function sandboxAttemptError(error: unknown): string {
  return safeError(error);
}
