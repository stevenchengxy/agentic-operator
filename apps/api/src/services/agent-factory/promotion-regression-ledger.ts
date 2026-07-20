import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { canonicalEvidenceJson } from "@agentic/agent-factory";

import {
  REGRESSION_ARTIFACT_SCHEMA,
  regressionSuiteFingerprint,
  type PersistedRegressionArtifact,
} from "./regression-artifact";
import {
  FACTORY_PROMOTION_FIXTURE_CAPSULE_REF_SCHEMA,
  removeFactoryPromotionFixtureCapsule,
  stageFactoryPromotionFixtureCapsule,
  verifyFactoryPromotionFixtureCapsule,
  type FactoryPromotionFixtureCapsuleRef,
} from "./promotion-regression-fixture-capsule";

export const FACTORY_PROMOTION_REGRESSION_SCHEMA =
  "agent-factory-promotion-regression/v2" as const;
export const FACTORY_PROMOTION_HIGH_WATERMARK_SCHEMA =
  "agent-factory-promotion-high-watermark/v1" as const;

export interface FactoryPromotionRegressionRecord {
  schema: typeof FACTORY_PROMOTION_REGRESSION_SCHEMA;
  promotionId: string;
  tenantId: string;
  tenantSlug: string;
  domain: string;
  versionId: string;
  slugs: string[];
  /** Portable path below the configured AGENTIC_DATA_ROOT. */
  artifact: string;
  evidenceFingerprint: string;
  suiteFingerprint: string;
  sandboxCleanupReceiptHash: string;
  reviewReceiptId: string;
  /** Immutable binary evidence frozen at stage time. Old records without
   * binary descriptors legitimately omit this field. */
  fixtureCapsule?: FactoryPromotionFixtureCapsuleRef;
  /** Production deployment created by this exact promotion. Missing on the
   * pre-commit pending record and mandatory after finalize. */
  deploymentId?: string;
  stagedAt: string;
  committedAt?: string;
  recordHash: string;
}

export interface FactoryPromotionRegressionStageInput {
  tenantId: string;
  tenantSlug: string;
  domain: string;
  versionId: string;
  slugs: string[];
  artifactPath: string;
  evidenceFingerprint: string;
  suiteFingerprint: string;
  sandboxCleanupReceiptHash: string;
  reviewReceiptId: string;
}

export interface StagedFactoryPromotionRegression {
  record: FactoryPromotionRegressionRecord;
  finalize(deploymentId: string): Promise<FactoryPromotionRegressionRecord>;
  abort(): Promise<void>;
}

export interface FactoryPromotionRegressionHighWatermark {
  schema: typeof FACTORY_PROMOTION_HIGH_WATERMARK_SCHEMA;
  committedCount: number;
  ledgerDigest: string;
  /** Hash of the checkpoint that was current immediately before the last
   * committed record was appended. `null` is valid only for the first record. */
  previousStateHash: string | null;
  /** Exact append that advanced this checkpoint. These fields make a retry
   * idempotent without allowing the checkpoint to be recomputed from an
   * arbitrary (possibly truncated) directory. */
  appendedPromotionId: string;
  appendedRecordHash: string;
  updatedAt: string;
  stateHash: string;
}

function configuredDataRoot(): string {
  const configured = process.env.AGENTIC_DATA_ROOT?.trim() || "./data";
  return path.resolve(configured);
}

function ledgerRoot(dataRoot = configuredDataRoot()): string {
  return path.join(dataRoot, "factory-regression-promotions");
}

function exactText(value: unknown, field: string, max = 256): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`invalid promotion regression ${field}`);
  }
  return value;
}

function exactSlugs(slugs: unknown): string[] {
  if (!Array.isArray(slugs) || !slugs.length)
    throw new Error("promotion regression slugs are empty");
  const values = slugs.map((slug) => exactText(slug, "slug", 128));
  const unique = [...new Set(values)].sort();
  if (unique.length !== values.length)
    throw new Error("promotion regression slugs contain duplicates");
  return unique;
}

function recordHash(
  record: Omit<FactoryPromotionRegressionRecord, "recordHash">,
): string {
  return `factory-promotion-regression:v2:${createHash("sha256")
    .update(canonicalEvidenceJson(record), "utf8")
    .digest("hex")}`;
}

function withHash(
  record: Omit<FactoryPromotionRegressionRecord, "recordHash">,
): FactoryPromotionRegressionRecord {
  return { ...record, recordHash: recordHash(record) };
}

/** Stable pre-deployment record hash. The committed record adds deploymentId
 * and committedAt (and therefore has a different recordHash), while DB
 * CodeAct authorization is inserted in the manifest transaction before those
 * distributed-commit fields exist. */
export function factoryPromotionStagedRecordHash(
  record: FactoryPromotionRegressionRecord,
): string {
  const {
    recordHash: _recordHash,
    deploymentId: _deploymentId,
    committedAt: _committedAt,
    ...staged
  } = record;
  return recordHash(staged);
}

function validateRecord(
  value: unknown,
  committed: boolean,
): FactoryPromotionRegressionRecord {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("promotion regression record is not an object");
  const record = value as FactoryPromotionRegressionRecord;
  if (record.schema !== FACTORY_PROMOTION_REGRESSION_SCHEMA)
    throw new Error(
      `unsupported promotion regression schema: ${String(record.schema)}`,
    );
  exactText(record.promotionId, "promotionId", 96);
  exactText(record.tenantId, "tenantId", 128);
  exactText(record.tenantSlug, "tenantSlug", 128);
  exactText(record.domain, "domain");
  exactText(record.versionId, "versionId", 128);
  exactText(record.artifact, "artifact", 1024);
  exactText(record.evidenceFingerprint, "evidenceFingerprint", 256);
  exactText(record.suiteFingerprint, "suiteFingerprint", 256);
  exactText(record.sandboxCleanupReceiptHash, "sandboxCleanupReceiptHash", 256);
  exactText(record.reviewReceiptId, "reviewReceiptId", 128);
  exactText(record.stagedAt, "stagedAt", 64);
  exactSlugs(record.slugs);
  if (record.fixtureCapsule !== undefined) {
    if (
      !record.fixtureCapsule ||
      typeof record.fixtureCapsule !== "object" ||
      record.fixtureCapsule.schema !==
        FACTORY_PROMOTION_FIXTURE_CAPSULE_REF_SCHEMA
    ) {
      throw new Error("promotion regression fixture capsule reference is invalid");
    }
    exactText(record.fixtureCapsule.manifest, "fixtureCapsule.manifest", 1024);
    exactText(
      record.fixtureCapsule.manifestHash,
      "fixtureCapsule.manifestHash",
      256,
    );
    if (
      path.isAbsolute(record.fixtureCapsule.manifest) ||
      record.fixtureCapsule.manifest.includes("\\") ||
      record.fixtureCapsule.manifest.split("/").includes("..") ||
      !Number.isSafeInteger(record.fixtureCapsule.bindingCount) ||
      record.fixtureCapsule.bindingCount < 1
    ) {
      throw new Error("promotion regression fixture capsule pointer is invalid");
    }
  }
  if (committed) {
    exactText(record.committedAt, "committedAt", 64);
    exactText(record.deploymentId, "deploymentId", 128);
  } else if (record.deploymentId !== undefined) {
    throw new Error(
      "pending promotion regression record already has a deployment id",
    );
  }
  if (
    path.isAbsolute(record.artifact) ||
    record.artifact.split("/").includes("..")
  ) {
    throw new Error(
      "promotion regression artifact must be a contained relative path",
    );
  }
  const { recordHash: suppliedHash, ...withoutHash } = record;
  if (suppliedHash !== recordHash(withoutHash))
    throw new Error("promotion regression record hash mismatch");
  return record;
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeExclusive(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.link(temporary, file);
    await fs.unlink(temporary);
    await syncDirectory(path.dirname(file));
  } catch (error) {
    await fs.unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function writeAtomic(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(temporary, file);
    await syncDirectory(path.dirname(file));
  } catch (error) {
    await fs.unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export function factoryPromotionLedgerDigest(
  records: readonly FactoryPromotionRegressionRecord[],
): string {
  const identities = records
    .map((record) => `${record.promotionId}:${record.recordHash}`)
    .sort();
  return `factory-promotion-ledger:v1:${createHash("sha256")
    .update(canonicalEvidenceJson(identities), "utf8")
    .digest("hex")}`;
}

function highWatermarkHash(
  value: Omit<FactoryPromotionRegressionHighWatermark, "stateHash">,
): string {
  return `factory-promotion-high-watermark:v1:${createHash("sha256")
    .update(canonicalEvidenceJson(value), "utf8")
    .digest("hex")}`;
}

function validateHighWatermark(
  value: unknown,
): FactoryPromotionRegressionHighWatermark {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("promotion high-watermark is not an object");
  }
  const watermark = value as FactoryPromotionRegressionHighWatermark;
  if (watermark.schema !== FACTORY_PROMOTION_HIGH_WATERMARK_SCHEMA) {
    throw new Error(
      `unsupported promotion high-watermark schema: ${String(watermark.schema)}`,
    );
  }
  if (
    !Number.isSafeInteger(watermark.committedCount) ||
    watermark.committedCount < 1
  ) {
    throw new Error("promotion high-watermark committedCount is invalid");
  }
  exactText(watermark.ledgerDigest, "ledgerDigest", 256);
  if (!/^factory-promotion-ledger:v1:[a-f0-9]{64}$/.test(watermark.ledgerDigest)) {
    throw new Error("promotion high-watermark ledgerDigest is invalid");
  }
  if (watermark.previousStateHash !== null) {
    exactText(watermark.previousStateHash, "previousStateHash", 256);
    if (
      !/^factory-promotion-high-watermark:v1:[a-f0-9]{64}$/.test(
        watermark.previousStateHash,
      )
    ) {
      throw new Error("promotion high-watermark predecessor hash is invalid");
    }
  }
  if (
    (watermark.committedCount === 1) !==
    (watermark.previousStateHash === null)
  ) {
    throw new Error("promotion high-watermark predecessor chain is invalid");
  }
  exactText(watermark.appendedPromotionId, "appendedPromotionId", 96);
  exactText(watermark.appendedRecordHash, "appendedRecordHash", 256);
  if (
    !/^fpr-[a-f0-9-]{8,80}$/.test(watermark.appendedPromotionId) ||
    !/^factory-promotion-regression:v2:[a-f0-9]{64}$/.test(
      watermark.appendedRecordHash,
    )
  ) {
    throw new Error("promotion high-watermark appended identity is invalid");
  }
  exactText(watermark.updatedAt, "updatedAt", 64);
  const { stateHash, ...body } = watermark;
  if (stateHash !== highWatermarkHash(body))
    throw new Error("promotion high-watermark hash mismatch");
  return watermark;
}

const FACTORY_PROMOTION_LEDGER_LOCK_SCHEMA =
  "agent-factory-promotion-ledger-lock/v1" as const;
const DEFAULT_LEDGER_LOCK_LEASE_TTL_MS = 120_000;
const DEFAULT_LEDGER_LOCK_HEARTBEAT_MS = 10_000;
const DEFAULT_LEDGER_LOCK_ACQUIRE_TIMEOUT_MS = 10_000;
const DEFAULT_LEDGER_LOCK_RETRY_MS = 50;
const DEFAULT_LEDGER_LOCK_RECLAIM_OBSERVATION_MS = 100;
const DEFAULT_LEDGER_LOCK_MUTATION_GUARD_TTL_MS = 30_000;

interface FactoryPromotionLedgerLockOwner {
  schema: typeof FACTORY_PROMOTION_LEDGER_LOCK_SCHEMA;
  token: string;
  pid: number;
  acquiredAt: string;
  leaseTtlMs: number;
}

/** Timing overrides exist for deterministic lock tests. Production callers
 * intentionally use the conservative defaults above. */
export interface FactoryPromotionRegressionLedgerLockOptions {
  leaseTtlMs?: number;
  heartbeatMs?: number;
  acquireTimeoutMs?: number;
  retryMs?: number;
  reclaimObservationMs?: number;
  mutationGuardTtlMs?: number;
}

interface ResolvedFactoryPromotionLedgerLockOptions {
  leaseTtlMs: number;
  heartbeatMs: number;
  acquireTimeoutMs: number;
  retryMs: number;
  reclaimObservationMs: number;
  mutationGuardTtlMs: number;
}

function positiveLockDuration(
  value: number | undefined,
  fallback: number,
  field: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new Error(`promotion regression ledger ${field} is invalid`);
  }
  return resolved;
}

function resolveLedgerLockOptions(
  options: FactoryPromotionRegressionLedgerLockOptions,
): ResolvedFactoryPromotionLedgerLockOptions {
  const resolved = {
    leaseTtlMs: positiveLockDuration(
      options.leaseTtlMs,
      DEFAULT_LEDGER_LOCK_LEASE_TTL_MS,
      "lock lease TTL",
    ),
    heartbeatMs: positiveLockDuration(
      options.heartbeatMs,
      DEFAULT_LEDGER_LOCK_HEARTBEAT_MS,
      "lock heartbeat interval",
    ),
    acquireTimeoutMs: positiveLockDuration(
      options.acquireTimeoutMs,
      DEFAULT_LEDGER_LOCK_ACQUIRE_TIMEOUT_MS,
      "lock acquisition timeout",
    ),
    retryMs: positiveLockDuration(
      options.retryMs,
      DEFAULT_LEDGER_LOCK_RETRY_MS,
      "lock retry interval",
    ),
    reclaimObservationMs: positiveLockDuration(
      options.reclaimObservationMs,
      DEFAULT_LEDGER_LOCK_RECLAIM_OBSERVATION_MS,
      "lock reclaim observation interval",
    ),
    mutationGuardTtlMs: positiveLockDuration(
      options.mutationGuardTtlMs,
      DEFAULT_LEDGER_LOCK_MUTATION_GUARD_TTL_MS,
      "lock mutation guard TTL",
    ),
  };
  if (resolved.heartbeatMs * 2 >= resolved.leaseTtlMs) {
    throw new Error(
      "promotion regression ledger heartbeat must be less than half its lease TTL",
    );
  }
  return resolved;
}

function lockSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function writeLeaseFile(
  file: string,
  owner: FactoryPromotionLedgerLockOwner,
): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(file, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  try {
    await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    handle = undefined;
    await fs.unlink(file).catch(() => undefined);
    throw error;
  } finally {
    await handle?.close();
  }
  await syncDirectory(path.dirname(file));
  return true;
}

async function readLeaseOwner(
  file: string,
): Promise<FactoryPromotionLedgerLockOwner | null> {
  try {
    const value = JSON.parse(await fs.readFile(file, "utf8")) as Partial<FactoryPromotionLedgerLockOwner>;
    if (
      value.schema !== FACTORY_PROMOTION_LEDGER_LOCK_SCHEMA ||
      typeof value.token !== "string" ||
      !value.token ||
      !Number.isSafeInteger(value.pid) ||
      typeof value.acquiredAt !== "string" ||
      !Number.isSafeInteger(value.leaseTtlMs) ||
      value.leaseTtlMs! < 1
    ) {
      return null;
    }
    return value as FactoryPromotionLedgerLockOwner;
  } catch (error) {
    if (isMissingFile(error) || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await fs.lstat(file);
    return true;
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
}

async function reclaimExpiredMutationGuard(
  guardPath: string,
  ttlMs: number,
): Promise<boolean> {
  let observed;
  try {
    observed = await fs.lstat(guardPath);
  } catch (error) {
    if (isMissingFile(error)) return true;
    throw error;
  }
  if (Date.now() - observed.mtimeMs <= ttlMs) return false;

  const quarantine = `${guardPath}.stale.${process.pid}.${randomUUID()}`;
  try {
    await fs.rename(guardPath, quarantine);
  } catch (error) {
    if (isMissingFile(error)) return true;
    throw error;
  }
  const moved = await fs.lstat(quarantine);
  if (Date.now() - moved.mtimeMs <= ttlMs) {
    try {
      await fs.link(quarantine, guardPath);
      await fs.unlink(quarantine);
      await syncDirectory(path.dirname(guardPath));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    return false;
  }
  await fs.unlink(quarantine);
  await syncDirectory(path.dirname(guardPath));
  return true;
}

async function acquireMutationGuard(
  lockPath: string,
  options: ResolvedFactoryPromotionLedgerLockOptions,
): Promise<{ path: string; token: string }> {
  const guardPath = `${lockPath}.mutation`;
  const deadline = Date.now() + options.acquireTimeoutMs;
  while (true) {
    const token = `${process.pid}:${randomUUID()}`;
    const acquired = await writeLeaseFile(guardPath, {
      schema: FACTORY_PROMOTION_LEDGER_LOCK_SCHEMA,
      token,
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
      leaseTtlMs: options.mutationGuardTtlMs,
    });
    if (acquired) return { path: guardPath, token };
    if (
      await reclaimExpiredMutationGuard(
        guardPath,
        options.mutationGuardTtlMs,
      )
    ) {
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        "promotion regression ledger lock mutation guard is busy",
      );
    }
    await lockSleep(options.retryMs);
  }
}

async function releaseMutationGuard(
  guard: { path: string; token: string },
): Promise<void> {
  const current = await readLeaseOwner(guard.path);
  if (current?.token !== guard.token) {
    throw new Error(
      "promotion regression ledger lock mutation guard ownership was lost",
    );
  }
  await fs.unlink(guard.path);
  await syncDirectory(path.dirname(guard.path));
}

function sameInode(
  left: Awaited<ReturnType<typeof fs.lstat>>,
  right: Awaited<ReturnType<typeof fs.lstat>>,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function reclaimExpiredLedgerLock(
  lockPath: string,
  options: ResolvedFactoryPromotionLedgerLockOptions,
): Promise<boolean> {
  const guard = await acquireMutationGuard(lockPath, options);
  try {
    let first;
    try {
      first = await fs.lstat(lockPath);
    } catch (error) {
      if (isMissingFile(error)) return true;
      throw error;
    }
    if (Date.now() - first.mtimeMs <= options.leaseTtlMs) return false;

    // Observe the same inode twice while the mutation guard prevents another
    // reclaimer or token-checked release. A live owner's heartbeat refreshes
    // mtime and makes this candidate ineligible before the atomic rename.
    await lockSleep(options.reclaimObservationMs);
    let second;
    try {
      second = await fs.lstat(lockPath);
    } catch (error) {
      if (isMissingFile(error)) return true;
      throw error;
    }
    if (
      !sameInode(first, second) ||
      Date.now() - second.mtimeMs <= options.leaseTtlMs
    ) {
      return false;
    }

    const quarantine = `${lockPath}.stale.${process.pid}.${randomUUID()}`;
    await fs.rename(lockPath, quarantine);
    try {
      // An owner can already have the old inode open when it is renamed. Give
      // that final in-flight heartbeat a chance to refresh the quarantined
      // inode; if it does, restore rather than steal the lease.
      await lockSleep(options.reclaimObservationMs);
      const moved = await fs.lstat(quarantine);
      if (
        !sameInode(second, moved) ||
        Date.now() - moved.mtimeMs <= options.leaseTtlMs
      ) {
        await fs.rename(quarantine, lockPath);
        await syncDirectory(path.dirname(lockPath));
        return false;
      }
      await fs.unlink(quarantine);
      await syncDirectory(path.dirname(lockPath));
      return true;
    } catch (error) {
      if (await fileExists(quarantine)) {
        if (!(await fileExists(lockPath))) {
          await fs.rename(quarantine, lockPath).catch(() => undefined);
        }
      }
      throw error;
    }
  } finally {
    await releaseMutationGuard(guard);
  }
}

async function renewOwnedLedgerLock(
  lockPath: string,
  token: string,
): Promise<void> {
  const handle = await fs.open(lockPath, "r+");
  try {
    const owner = JSON.parse(await handle.readFile("utf8")) as Partial<FactoryPromotionLedgerLockOwner>;
    if (
      owner.schema !== FACTORY_PROMOTION_LEDGER_LOCK_SCHEMA ||
      owner.token !== token
    ) {
      throw new Error(
        "promotion regression ledger lock heartbeat lost ownership",
      );
    }
    const now = new Date();
    // FileHandle.utimes updates the inode already opened above. If a stale
    // reclaimer renamed that inode concurrently, it cannot accidentally renew
    // a newer owner's path.
    await handle.utimes(now, now);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function releaseOwnedLedgerLock(
  lockPath: string,
  token: string,
  options: ResolvedFactoryPromotionLedgerLockOptions,
): Promise<boolean> {
  const guard = await acquireMutationGuard(lockPath, options);
  try {
    const current = await readLeaseOwner(lockPath);
    if (current?.token !== token) return false;
    await fs.unlink(lockPath);
    await syncDirectory(path.dirname(lockPath));
    return true;
  } finally {
    await releaseMutationGuard(guard);
  }
}

async function acquireLedgerLock(
  root: string,
  options: ResolvedFactoryPromotionLedgerLockOptions,
): Promise<{ path: string; token: string }> {
  const lockPath = path.join(root, ".finalize.lock");
  const mutationGuardPath = `${lockPath}.mutation`;
  const deadline = Date.now() + options.acquireTimeoutMs;
  while (true) {
    if (!(await fileExists(mutationGuardPath))) {
      const token = `${process.pid}:${randomUUID()}`;
      const acquired = await writeLeaseFile(lockPath, {
        schema: FACTORY_PROMOTION_LEDGER_LOCK_SCHEMA,
        token,
        pid: process.pid,
        acquiredAt: new Date().toISOString(),
        leaseTtlMs: options.leaseTtlMs,
      });
      if (acquired) {
        // A stale reclaimer may have created its mutation guard between our
        // absence check and O_EXCL create. It will observe this fresh lease;
        // wait for it, release our exact token, and retry cleanly.
        if (await fileExists(mutationGuardPath)) {
          if (!(await releaseOwnedLedgerLock(lockPath, token, options))) {
            throw new Error(
              "promotion regression ledger lock ownership was lost during acquisition",
            );
          }
        } else {
          return { path: lockPath, token };
        }
      }
    } else {
      await reclaimExpiredMutationGuard(
        mutationGuardPath,
        options.mutationGuardTtlMs,
      );
    }

    if (await fileExists(lockPath)) {
      await reclaimExpiredLedgerLock(lockPath, options);
    }
    if (Date.now() >= deadline) {
      throw new Error(
        "promotion regression ledger finalize lock is busy or not yet stale",
      );
    }
    await lockSleep(options.retryMs);
  }
}

/** Serialize promotion-ledger commits with a renewable, crash-recoverable
 * filesystem lease. Reclaim is deliberately based on a conservative mtime
 * TTL, not PID liveness, so it also works across containers and host restarts. */
export async function withFactoryPromotionRegressionLedgerLock<T>(
  root: string,
  work: () => Promise<T>,
  optionOverrides: FactoryPromotionRegressionLedgerLockOptions = {},
): Promise<T> {
  const options = resolveLedgerLockOptions(optionOverrides);
  const lease = await acquireLedgerLock(root, options);
  let heartbeatError: unknown;
  let heartbeatTail = Promise.resolve();
  const heartbeat = setInterval(() => {
    heartbeatTail = heartbeatTail.then(async () => {
      if (heartbeatError) return;
      try {
        await renewOwnedLedgerLock(lease.path, lease.token);
      } catch (error) {
        heartbeatError = error;
      }
    });
  }, options.heartbeatMs);
  heartbeat.unref();

  let result: T | undefined;
  let workError: unknown;
  try {
    result = await work();
  } catch (error) {
    workError = error;
  }

  clearInterval(heartbeat);
  await heartbeatTail;
  let lockError = heartbeatError;
  try {
    if (!(await releaseOwnedLedgerLock(lease.path, lease.token, options))) {
      lockError ??= new Error(
        "promotion regression ledger lock release refused a different owner token",
      );
    }
  } catch (error) {
    lockError ??= error;
  }

  if (workError) throw workError;
  if (lockError) throw lockError;
  return result as T;
}

function promotionRecordPaths(root: string, promotionId: string): {
  pendingPath: string;
  committedPath: string;
} {
  const exactPromotionId = exactText(promotionId, "promotionId", 96);
  if (!/^fpr-[a-f0-9-]{8,80}$/.test(exactPromotionId)) {
    throw new Error("invalid promotion regression promotionId");
  }
  return {
    pendingPath: path.join(root, "pending", `${exactPromotionId}.json`),
    committedPath: path.join(root, "committed", `${exactPromotionId}.json`),
  };
}

/** Stable deployment note written into the workflow deployment itself. Besides
 * making operator history self-describing, the one-to-one marker prevents
 * generic rolled-back-history compaction from grouping promotion anchors into
 * an anonymous/null-note bucket. */
export function factoryPromotionDeploymentNote(promotionId: string): string {
  const exactPromotionId = exactText(promotionId, "promotionId", 96);
  if (!/^fpr-[a-f0-9-]{8,80}$/.test(exactPromotionId)) {
    throw new Error("invalid promotion regression promotionId");
  }
  return `agent-factory-promotion:${exactPromotionId}`;
}

async function readValidatedRecordFile(
  file: string,
  committed: boolean,
): Promise<FactoryPromotionRegressionRecord> {
  return validateRecord(JSON.parse(await fs.readFile(file, "utf8")), committed);
}

async function readPromotionHighWatermark(
  root: string,
): Promise<FactoryPromotionRegressionHighWatermark | null> {
  try {
    return validateHighWatermark(
      JSON.parse(await fs.readFile(path.join(root, "high-watermark.json"), "utf8")),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function advancePromotionHighWatermark(
  root: string,
  appended: FactoryPromotionRegressionRecord,
): Promise<void> {
  const entries = await readLedgerDirectory(path.join(root, "committed"), true);
  const invalid = entries.filter((entry) => !entry.record || entry.error);
  if (invalid.length) {
    throw new Error(
      "cannot advance promotion high-watermark over invalid committed records",
    );
  }
  const records = entries.map((entry) => entry.record!);
  if (!records.length) {
    throw new Error("cannot advance an empty promotion high-watermark");
  }
  const appendedMatches = records.filter(
    (record) =>
      record.promotionId === appended.promotionId &&
      record.recordHash === appended.recordHash,
  );
  if (appendedMatches.length !== 1) {
    throw new Error(
      "cannot advance promotion high-watermark without the exact appended record",
    );
  }
  const current = await readPromotionHighWatermark(root);
  const nextDigest = factoryPromotionLedgerDigest(records);
  // Crash recovery may retry an older finalize after a later append already
  // covered it. Accept only an exact checkpoint for the complete directory.
  if (
    current &&
    current.committedCount === records.length &&
    current.ledgerDigest === nextDigest
  ) {
    if (
      !records.some(
        (record) =>
          record.promotionId === current.appendedPromotionId &&
          record.recordHash === current.appendedRecordHash,
      )
    ) {
      throw new Error(
        "promotion high-watermark appended identity is absent from its ledger",
      );
    }
    return;
  }

  const previousRecords = records.filter(
    (record) => record.promotionId !== appended.promotionId,
  );
  if (previousRecords.length !== records.length - 1) {
    throw new Error("promotion high-watermark append identity is duplicated");
  }
  if (current) {
    if (
      current.committedCount + 1 !== records.length ||
      current.committedCount !== previousRecords.length ||
      current.ledgerDigest !== factoryPromotionLedgerDigest(previousRecords) ||
      !previousRecords.some(
        (record) =>
          record.promotionId === current.appendedPromotionId &&
          record.recordHash === current.appendedRecordHash,
      )
    ) {
      throw new Error(
        "promotion high-watermark is not the exact predecessor of the appended record",
      );
    }
  } else if (previousRecords.length !== 0) {
    throw new Error(
      "promotion high-watermark is missing for an existing committed ledger",
    );
  }
  const watermarkBody = {
    schema: FACTORY_PROMOTION_HIGH_WATERMARK_SCHEMA,
    committedCount: records.length,
    ledgerDigest: nextDigest,
    previousStateHash: current?.stateHash ?? null,
    appendedPromotionId: appended.promotionId,
    appendedRecordHash: appended.recordHash,
    updatedAt: new Date().toISOString(),
  } satisfies Omit<FactoryPromotionRegressionHighWatermark, "stateHash">;
  await writeAtomic(path.join(root, "high-watermark.json"), {
    ...watermarkBody,
    stateHash: highWatermarkHash(watermarkBody),
  });
}

/**
 * Complete a previously staged promotion by durable identity.  This is also
 * the crash-recovery primitive: a process may die after the production
 * manifest became live (or after the committed record was linked) but before
 * the high-watermark and pending-file cleanup completed.  Re-running this
 * function is idempotent only when the exact same deployment is supplied.
 */
export async function finalizePendingFactoryPromotionRegression(
  promotionId: string,
  deploymentId: string,
  dataRoot = configuredDataRoot(),
): Promise<FactoryPromotionRegressionRecord> {
  const root = ledgerRoot(path.resolve(dataRoot));
  await fs.mkdir(path.join(root, "pending"), { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(root, "committed"), { recursive: true, mode: 0o700 });
  const exactDeploymentId = exactText(deploymentId, "deploymentId", 128);
  const paths = promotionRecordPaths(root, promotionId);
  return withFactoryPromotionRegressionLedgerLock(root, async () => {
    const pending = await readValidatedRecordFile(paths.pendingPath, false);
    if (pending.promotionId !== promotionId) {
      throw new Error("pending promotion regression identity mismatch");
    }
    const artifactPath = path.resolve(dataRoot, ...pending.artifact.split("/"));
    const artifact = JSON.parse(
      await fs.readFile(artifactPath, "utf8"),
    ) as PersistedRegressionArtifact;
    await verifyFactoryPromotionFixtureCapsule({
      dataRoot,
      record: pending,
      artifact,
    });
    const { recordHash: _pendingHash, ...pendingBody } = pending;
    let committed: FactoryPromotionRegressionRecord;
    try {
      const existing = await readValidatedRecordFile(paths.committedPath, true);
      const {
        recordHash: _existingHash,
        deploymentId: existingDeploymentId,
        committedAt: _existingCommittedAt,
        ...existingBase
      } = existing;
      if (
        existing.promotionId !== pending.promotionId ||
        existingDeploymentId !== exactDeploymentId ||
        canonicalEvidenceJson(existingBase) !== canonicalEvidenceJson(pendingBody)
      ) {
        throw new Error(
          "existing committed promotion does not match the pending record and deployment",
        );
      }
      committed = existing;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      committed = withHash({
        ...pendingBody,
        deploymentId: exactDeploymentId,
        committedAt: new Date().toISOString(),
      });
      await writeExclusive(paths.committedPath, committed);
    }

    // Write the catalog checkpoint before deleting the pending marker. A
    // crash at either boundary remains recoverable and never produces a green
    // CI inventory that omitted a production deployment.
    await advancePromotionHighWatermark(root, committed);
    await fs.unlink(paths.pendingPath);
    await syncDirectory(path.dirname(paths.pendingPath));
    return committed;
  });
}

/** Remove a stage that provably never reached a production deployment. */
export async function abortPendingFactoryPromotionRegression(
  promotionId: string,
  dataRoot = configuredDataRoot(),
): Promise<void> {
  const root = ledgerRoot(path.resolve(dataRoot));
  const paths = promotionRecordPaths(root, promotionId);
  await fs.mkdir(path.dirname(paths.pendingPath), {
    recursive: true,
    mode: 0o700,
  });
  await withFactoryPromotionRegressionLedgerLock(root, async () => {
    const pending = await readValidatedRecordFile(paths.pendingPath, false);
    if (pending.promotionId !== promotionId) {
      throw new Error("pending promotion regression identity mismatch");
    }
    try {
      await fs.access(paths.committedPath);
      throw new Error(
        "cannot abort a pending marker that already has a committed promotion record",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await fs.unlink(paths.pendingPath);
    await syncDirectory(path.dirname(paths.pendingPath));
    await removeFactoryPromotionFixtureCapsule({
      dataRoot,
      record: pending,
    });
  });
}

function containedRelative(dataRoot: string, artifactPath: string): string {
  const base = path.resolve(dataRoot);
  const target = path.resolve(artifactPath);
  if (target === base || !target.startsWith(`${base}${path.sep}`)) {
    throw new Error(
      "promotion regression artifact is outside AGENTIC_DATA_ROOT",
    );
  }
  return path.relative(base, target).split(path.sep).join("/");
}

async function readArtifact(
  input: FactoryPromotionRegressionStageInput,
): Promise<PersistedRegressionArtifact> {
  const artifact = JSON.parse(
    await fs.readFile(path.resolve(input.artifactPath), "utf8"),
  ) as PersistedRegressionArtifact;
  if (artifact.schema !== REGRESSION_ARTIFACT_SCHEMA)
    throw new Error("promotion regression artifact schema mismatch");
  if (
    artifact.domain !== input.domain ||
    artifact.versionId !== input.versionId
  ) {
    throw new Error("promotion regression artifact identity mismatch");
  }
  if (
    artifact.evidenceFingerprint !== input.evidenceFingerprint ||
    artifact.suiteFingerprint !== input.suiteFingerprint ||
    artifact.sandboxCleanupReceipt?.absenceProbeHash !==
      input.sandboxCleanupReceiptHash
  ) {
    throw new Error("promotion regression artifact evidence pointer mismatch");
  }
  if (regressionSuiteFingerprint(artifact) !== artifact.suiteFingerprint) {
    throw new Error("promotion regression suite fingerprint mismatch");
  }
  const artifactSlugs = new Set(artifact.agents.map((agent) => agent.slug));
  for (const slug of exactSlugs(input.slugs)) {
    if (!artifactSlugs.has(slug))
      throw new Error(`promotion regression artifact does not cover ${slug}`);
  }
  // New promotions must be portable. Legacy absolute cassette paths can still
  // be replayed locally, but cannot be advertised as CI-complete evidence.
  if (artifact.cassetteRefs.some((ref) => path.isAbsolute(ref.path))) {
    throw new Error(
      "promotion regression artifact contains a non-portable absolute cassette path; finish a new draft version",
    );
  }
  return artifact;
}

/**
 * Stage a durable replay record before the production commit. A process crash
 * leaves the pending record behind; bulk CI replay treats any pending record as
 * an error instead of silently omitting a possibly-live promotion.
 */
export async function stageFactoryPromotionRegression(
  input: FactoryPromotionRegressionStageInput,
): Promise<StagedFactoryPromotionRegression> {
  const artifact = await readArtifact(input);
  const dataRoot = configuredDataRoot();
  const root = ledgerRoot(dataRoot);
  const pendingDir = path.join(root, "pending");
  const committedDir = path.join(root, "committed");
  await fs.mkdir(pendingDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(committedDir, { recursive: true, mode: 0o700 });
  const promotionId = `fpr-${randomUUID()}`;
  const fixtureCapsule = await stageFactoryPromotionFixtureCapsule({
    dataRoot,
    promotionId,
    tenantId: input.tenantId,
    domain: input.domain,
    artifact,
  });
  const base = {
    schema: FACTORY_PROMOTION_REGRESSION_SCHEMA,
    promotionId,
    tenantId: exactText(input.tenantId, "tenantId", 128),
    tenantSlug: exactText(input.tenantSlug, "tenantSlug", 128),
    domain: exactText(input.domain, "domain"),
    versionId: exactText(input.versionId, "versionId", 128),
    slugs: exactSlugs(input.slugs),
    artifact: containedRelative(dataRoot, input.artifactPath),
    evidenceFingerprint: exactText(
      input.evidenceFingerprint,
      "evidenceFingerprint",
      256,
    ),
    suiteFingerprint: exactText(
      input.suiteFingerprint,
      "suiteFingerprint",
      256,
    ),
    sandboxCleanupReceiptHash: exactText(
      input.sandboxCleanupReceiptHash,
      "sandboxCleanupReceiptHash",
      256,
    ),
    reviewReceiptId: exactText(input.reviewReceiptId, "reviewReceiptId", 128),
    ...(fixtureCapsule ? { fixtureCapsule } : {}),
    stagedAt: new Date().toISOString(),
  } satisfies Omit<FactoryPromotionRegressionRecord, "recordHash">;
  const record = withHash(base);
  const pendingPath = path.join(pendingDir, `${promotionId}.json`);
  try {
    await writeExclusive(pendingPath, record);
  } catch (error) {
    await removeFactoryPromotionFixtureCapsule({ dataRoot, record }).catch(
      () => undefined,
    );
    throw error;
  }

  let settled = false;
  return {
    record,
    async finalize(deploymentId) {
      if (settled)
        throw new Error("promotion regression stage is already settled");
      const committed = await finalizePendingFactoryPromotionRegression(
        promotionId,
        deploymentId,
        dataRoot,
      );
      settled = true;
      return committed;
    },
    async abort() {
      if (settled) return;
      await abortPendingFactoryPromotionRegression(promotionId, dataRoot);
      settled = true;
    },
  };
}

export interface FactoryPromotionRegressionLedgerSnapshot {
  dataRoot: string;
  highWatermark?: FactoryPromotionRegressionHighWatermark;
  highWatermarkError?: string;
  pending: Array<{
    file: string;
    record?: FactoryPromotionRegressionRecord;
    error?: string;
  }>;
  committed: Array<{
    file: string;
    record?: FactoryPromotionRegressionRecord;
    error?: string;
  }>;
}

async function readLedgerDirectory(
  directory: string,
  committed: boolean,
): Promise<
  Array<{
    file: string;
    record?: FactoryPromotionRegressionRecord;
    error?: string;
  }>
> {
  let names: string[];
  try {
    names = (await fs.readdir(directory))
      .filter((name) => name.endsWith(".json"))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return Promise.all(
    names.map(async (name) => {
      const file = path.join(directory, name);
      try {
        return {
          file,
          record: validateRecord(
            JSON.parse(await fs.readFile(file, "utf8")),
            committed,
          ),
        };
      } catch (error) {
        return { file, error: String((error as Error)?.message ?? error) };
      }
    }),
  );
}

/** Read-only inventory used by CI. The caller decides whether empty is valid. */
export async function readFactoryPromotionRegressionLedger(
  dataRoot = configuredDataRoot(),
): Promise<FactoryPromotionRegressionLedgerSnapshot> {
  const root = ledgerRoot(path.resolve(dataRoot));
  const [pending, committed, highWatermarkResult] = await Promise.all([
    readLedgerDirectory(path.join(root, "pending"), false),
    readLedgerDirectory(path.join(root, "committed"), true),
    fs
      .readFile(path.join(root, "high-watermark.json"), "utf8")
      .then((raw) => ({
        highWatermark: validateHighWatermark(JSON.parse(raw)),
      }))
      .catch((error) => ({
        highWatermarkError: String((error as Error)?.message ?? error),
      })),
  ]);
  return {
    dataRoot: path.resolve(dataRoot),
    pending,
    committed,
    ...highWatermarkResult,
  };
}
