/**
 * Durable, tenant-scoped idempotency primitives.
 *
 * The original helper was only a response cache: two first requests could
 * both miss, both perform their side effect, and race to overwrite the cache.
 * This module now also provides an atomic pending claim with a recoverable
 * operation recipe.  A route claims before its first side effect, uses stable
 * operation ids from the recipe, and conditionally completes with the claim's
 * owner token.  Concurrent callers therefore observe pending/replay instead
 * of executing the operation a second time.
 */

import { createHash, randomUUID } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { and, eq, lt } from "drizzle-orm";
import { getDb, idempotencyKeys } from "@agentic/db";

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LEASE_MS = 5 * 60 * 1000;
export const MAX_IDEMPOTENCY_KEY_LENGTH = 255;
const STORED_VERSION = 2 as const;

export interface CachedResponse {
  status: number;
  body: unknown;
}

interface StoredPending<T = unknown> {
  __agentic_idempotency: typeof STORED_VERSION;
  state: "pending";
  fingerprint: string;
  ownerToken: string;
  leaseUntil: number;
  attempt: number;
  operation: T;
}

interface StoredComplete {
  __agentic_idempotency: typeof STORED_VERSION;
  state: "complete";
  fingerprint: string;
  response: CachedResponse;
}

type StoredEnvelope<T = unknown> = StoredPending<T> | StoredComplete;

export class InvalidIdempotencyKeyError extends Error {
  readonly code = "invalid_idempotency_key";
  readonly statusCode = 400;

  constructor(message: string) {
    super(message);
    this.name = "InvalidIdempotencyKeyError";
  }
}

export class IdempotencyConflictError extends Error {
  readonly code = "idempotency_key_reused";
  readonly statusCode = 409;

  constructor(message = "Idempotency-Key was already used for a different request") {
    super(message);
    this.name = "IdempotencyConflictError";
  }
}

export class IdempotencyStoreError extends Error {
  readonly code = "idempotency_store_failed";
  readonly statusCode = 503;

  constructor(message: string) {
    super(message);
    this.name = "IdempotencyStoreError";
  }
}

function configuredDuration(name: string, fallback: number, minimum: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new IdempotencyStoreError(`${name} must be an integer >= ${minimum}; received ${JSON.stringify(raw)}`);
  }
  return value;
}

function ttlMs(): number {
  return configuredDuration("AGENTIC_IDEMPOTENCY_TTL_MS", DEFAULT_TTL_MS, 60_000);
}

function leaseMs(): number {
  return configuredDuration("AGENTIC_IDEMPOTENCY_LEASE_MS", DEFAULT_LEASE_MS, 5_000);
}

function canonicalJson(value: unknown): string {
  const visit = (input: unknown): unknown => {
    if (input === null || typeof input === "string" || typeof input === "boolean") return input;
    if (typeof input === "number") return Number.isFinite(input) ? input : String(input);
    if (Array.isArray(input)) return input.map(visit);
    if (typeof input === "object") {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .filter(([, child]) => child !== undefined)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, child]) => [key, visit(child)]),
      );
    }
    return String(input);
  };
  return JSON.stringify(visit(value));
}

/** Stable request fingerprint; routes include every input/query bit that can
 * change the side effect. */
export function idempotencyFingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/** Scope keys per mutation endpoint without changing the public header.  The
 * legacy table primary key is only (tenant,key), so hashing scope into the
 * stored key prevents `/events` from replaying an `/agents/:name/invoke`
 * response that happened to use the same client key. */
function storageKey(key: string, scope?: string): string {
  if (!scope) return key;
  const digest = createHash("sha256").update(key).digest("hex");
  return `v2:${scope}:${digest}`;
}

function parseStored(raw: string): StoredEnvelope | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new IdempotencyStoreError(`stored idempotency response is invalid JSON: ${String((error as Error).message)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const candidate = parsed as Partial<StoredEnvelope>;
  if (candidate.__agentic_idempotency !== STORED_VERSION) return null;
  if (candidate.state === "complete" && candidate.response && typeof candidate.fingerprint === "string") {
    return candidate as StoredComplete;
  }
  if (
    candidate.state === "pending" &&
    typeof candidate.fingerprint === "string" &&
    typeof (candidate as Partial<StoredPending>).ownerToken === "string" &&
    typeof (candidate as Partial<StoredPending>).leaseUntil === "number"
  ) {
    return candidate as StoredPending;
  }
  throw new IdempotencyStoreError("stored idempotency envelope is malformed");
}

function assertFingerprint(actual: string, expected?: string): void {
  if (expected && actual !== expected) throw new IdempotencyConflictError();
}

/** Read and validate the opaque Idempotency-Key header. An explicitly invalid
 * key is a 400 error; it never silently disables duplicate protection. */
export function readIdempotencyKey(req: FastifyRequest): string | null {
  const raw = req.headers["idempotency-key"];
  if (raw === undefined) return null;
  if (Array.isArray(raw)) {
    if (raw.length !== 1) throw new InvalidIdempotencyKeyError("Idempotency-Key must be supplied exactly once");
    return validateKey(raw[0]!);
  }
  if (typeof raw !== "string") throw new InvalidIdempotencyKeyError("Idempotency-Key must be a string");
  return validateKey(raw);
}

function validateKey(value: string): string {
  if (!value || !value.trim()) throw new InvalidIdempotencyKeyError("Idempotency-Key must not be empty");
  if (value !== value.trim()) throw new InvalidIdempotencyKeyError("Idempotency-Key must not contain leading or trailing whitespace");
  if (value.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new InvalidIdempotencyKeyError(`Idempotency-Key must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`);
  }
  return value;
}

export function lookupIdempotency(
  tenantId: string,
  key: string,
  opts?: { scope?: string; fingerprint?: string },
): CachedResponse | null {
  const storedKey = storageKey(key, opts?.scope);
  const row = getDb()
    .select({
      responseJson: idempotencyKeys.responseJson,
      statusCode: idempotencyKeys.statusCode,
      expiresAt: idempotencyKeys.expiresAt,
    })
    .from(idempotencyKeys)
    .where(and(eq(idempotencyKeys.tenantId, tenantId), eq(idempotencyKeys.key, storedKey)))
    .all()[0];
  if (!row) return null;
  const expiresAtMs = row.expiresAt instanceof Date ? row.expiresAt.getTime() : Number(row.expiresAt);
  if (Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now()) return null;
  const envelope = parseStored(row.responseJson);
  if (envelope) {
    assertFingerprint(envelope.fingerprint, opts?.fingerprint);
    return envelope.state === "complete" ? envelope.response : null;
  }
  // Backward-compatible replay for rows written before the v2 envelope.
  return { status: row.statusCode ?? 200, body: JSON.parse(row.responseJson) as unknown };
}

export type IdempotencyClaim<T> =
  | { state: "owner"; ownerToken: string; operation: T; recovered: boolean }
  | { state: "pending"; operation: T; retryAfterMs: number }
  | { state: "replay"; response: CachedResponse };

/** Atomically claim the first execution.  When a crashed owner's lease has
 * expired, the next caller inherits the *original* operation recipe and its
 * stable ids rather than generating a second side effect. */
export function claimIdempotency<T>(args: {
  tenantId: string;
  key: string;
  scope: string;
  fingerprint: string;
  operation: T;
}): IdempotencyClaim<T> {
  const storedKey = storageKey(args.key, args.scope);
  const now = Date.now();
  const expiresAt = new Date(now + ttlMs());
  return getDb().transaction((tx) => {
    let row = tx
      .select({ responseJson: idempotencyKeys.responseJson, statusCode: idempotencyKeys.statusCode, expiresAt: idempotencyKeys.expiresAt })
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.tenantId, args.tenantId), eq(idempotencyKeys.key, storedKey)))
      .all()[0];
    if (row && row.expiresAt.getTime() <= now) {
      tx.delete(idempotencyKeys)
        .where(and(eq(idempotencyKeys.tenantId, args.tenantId), eq(idempotencyKeys.key, storedKey)))
        .run();
      row = undefined;
    }

    if (!row) {
      const ownerToken = randomUUID();
      const pending: StoredPending<T> = {
        __agentic_idempotency: STORED_VERSION,
        state: "pending",
        fingerprint: args.fingerprint,
        ownerToken,
        leaseUntil: now + leaseMs(),
        attempt: 1,
        operation: args.operation,
      };
      const inserted = tx.insert(idempotencyKeys).values({
        tenantId: args.tenantId,
        key: storedKey,
        responseJson: JSON.stringify(pending),
        statusCode: 409,
        expiresAt,
      }).onConflictDoNothing({ target: [idempotencyKeys.tenantId, idempotencyKeys.key] }).run() as { changes?: number };
      if ((inserted.changes ?? 0) === 1) {
        return { state: "owner", ownerToken, operation: args.operation, recovered: false };
      }
      row = tx
        .select({ responseJson: idempotencyKeys.responseJson, statusCode: idempotencyKeys.statusCode, expiresAt: idempotencyKeys.expiresAt })
        .from(idempotencyKeys)
        .where(and(eq(idempotencyKeys.tenantId, args.tenantId), eq(idempotencyKeys.key, storedKey)))
        .all()[0];
      if (!row) throw new IdempotencyStoreError("idempotency claim lost after primary-key conflict");
    }

    const envelope = parseStored(row.responseJson);
    if (!envelope) {
      // A legacy completed cache row is replayable, never reclaimable.
      return { state: "replay", response: { status: row.statusCode ?? 200, body: JSON.parse(row.responseJson) as unknown } };
    }
    assertFingerprint(envelope.fingerprint, args.fingerprint);
    if (envelope.state === "complete") return { state: "replay", response: envelope.response };
    const prior = envelope as StoredPending<T>;
    if (prior.leaseUntil > now) {
      return { state: "pending", operation: prior.operation, retryAfterMs: prior.leaseUntil - now };
    }

    const ownerToken = randomUUID();
    const reclaimed: StoredPending<T> = {
      ...prior,
      ownerToken,
      leaseUntil: now + leaseMs(),
      attempt: prior.attempt + 1,
    };
    const updated = tx.update(idempotencyKeys)
      .set({ responseJson: JSON.stringify(reclaimed), statusCode: 409, expiresAt })
      .where(and(
        eq(idempotencyKeys.tenantId, args.tenantId),
        eq(idempotencyKeys.key, storedKey),
        eq(idempotencyKeys.responseJson, row.responseJson),
      ))
      .run() as { changes?: number };
    if ((updated.changes ?? 0) !== 1) throw new IdempotencyStoreError("idempotency claim was concurrently reclaimed");
    return { state: "owner", ownerToken, operation: prior.operation, recovered: true };
  });
}

/** Complete only the claim still owned by `ownerToken`. A stale worker may
 * have performed work, but it cannot overwrite a recovered owner's result. */
export function completeIdempotency(args: {
  tenantId: string;
  key: string;
  scope: string;
  fingerprint: string;
  ownerToken: string;
  response: CachedResponse;
}): void {
  const storedKey = storageKey(args.key, args.scope);
  const db = getDb();
  db.transaction((tx) => {
    const row = tx.select({ responseJson: idempotencyKeys.responseJson })
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.tenantId, args.tenantId), eq(idempotencyKeys.key, storedKey)))
      .all()[0];
    if (!row) throw new IdempotencyStoreError("idempotency claim disappeared before completion");
    const envelope = parseStored(row.responseJson);
    if (!envelope || envelope.state !== "pending") throw new IdempotencyStoreError("idempotency claim is no longer pending");
    assertFingerprint(envelope.fingerprint, args.fingerprint);
    if (envelope.ownerToken !== args.ownerToken) throw new IdempotencyStoreError("idempotency claim ownership was lost before completion");
    const complete: StoredComplete = {
      __agentic_idempotency: STORED_VERSION,
      state: "complete",
      fingerprint: args.fingerprint,
      response: args.response,
    };
    const updated = tx.update(idempotencyKeys)
      .set({
        responseJson: JSON.stringify(complete),
        statusCode: args.response.status,
        expiresAt: new Date(Date.now() + ttlMs()),
      })
      .where(and(
        eq(idempotencyKeys.tenantId, args.tenantId),
        eq(idempotencyKeys.key, storedKey),
        eq(idempotencyKeys.responseJson, row.responseJson),
      ))
      .run() as { changes?: number };
    if ((updated.changes ?? 0) !== 1) throw new IdempotencyStoreError("idempotency completion lost a concurrent ownership race");
  });
}

/** Relinquish a pending claim after its side effect definitively failed to enqueue. The owner and
 * fingerprint checks prevent a stale worker from deleting a newer recovery claim. Callers must use
 * a stable downstream operation id before abandoning so an ambiguous network failure is safe to
 * retry without duplicating the external side effect. */
export function abandonIdempotency(args: {
  tenantId: string;
  key: string;
  scope: string;
  fingerprint: string;
  ownerToken: string;
}): void {
  const storedKey = storageKey(args.key, args.scope);
  getDb().transaction((tx) => {
    const row = tx
      .select({ responseJson: idempotencyKeys.responseJson })
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.tenantId, args.tenantId), eq(idempotencyKeys.key, storedKey)))
      .all()[0];
    if (!row) return;
    const envelope = parseStored(row.responseJson);
    if (!envelope || envelope.state !== "pending") {
      throw new IdempotencyStoreError("idempotency claim is no longer pending");
    }
    assertFingerprint(envelope.fingerprint, args.fingerprint);
    if (envelope.ownerToken !== args.ownerToken) {
      throw new IdempotencyStoreError("idempotency claim ownership was lost before abandon");
    }
    const deleted = tx
      .delete(idempotencyKeys)
      .where(and(
        eq(idempotencyKeys.tenantId, args.tenantId),
        eq(idempotencyKeys.key, storedKey),
        eq(idempotencyKeys.responseJson, row.responseJson),
      ))
      .run() as { changes?: number };
    if ((deleted.changes ?? 0) !== 1) {
      throw new IdempotencyStoreError("idempotency abandon lost a concurrent ownership race");
    }
  });
}

/** Relinquish ownership while retaining the original operation recipe. This
 * is the safe retry path when a multi-system operation failed or its outcome
 * is ambiguous: the next request can reclaim immediately, but it must reuse
 * the same stable ids/secrets instead of generating a second side effect. */
export function releaseIdempotency(args: {
  tenantId: string;
  key: string;
  scope: string;
  fingerprint: string;
  ownerToken: string;
}): void {
  const storedKey = storageKey(args.key, args.scope);
  getDb().transaction((tx) => {
    const row = tx
      .select({ responseJson: idempotencyKeys.responseJson })
      .from(idempotencyKeys)
      .where(
        and(
          eq(idempotencyKeys.tenantId, args.tenantId),
          eq(idempotencyKeys.key, storedKey),
        ),
      )
      .all()[0];
    if (!row) {
      throw new IdempotencyStoreError(
        "idempotency claim disappeared before release",
      );
    }
    const envelope = parseStored(row.responseJson);
    if (!envelope || envelope.state !== "pending") {
      throw new IdempotencyStoreError("idempotency claim is no longer pending");
    }
    assertFingerprint(envelope.fingerprint, args.fingerprint);
    if (envelope.ownerToken !== args.ownerToken) {
      throw new IdempotencyStoreError(
        "idempotency claim ownership was lost before release",
      );
    }
    const released: StoredPending = {
      ...envelope,
      leaseUntil: Date.now() - 1,
    };
    const updated = tx
      .update(idempotencyKeys)
      .set({ responseJson: JSON.stringify(released), statusCode: 409 })
      .where(
        and(
          eq(idempotencyKeys.tenantId, args.tenantId),
          eq(idempotencyKeys.key, storedKey),
          eq(idempotencyKeys.responseJson, row.responseJson),
        ),
      )
      .run() as { changes?: number };
    if ((updated.changes ?? 0) !== 1) {
      throw new IdempotencyStoreError(
        "idempotency release lost a concurrent ownership race",
      );
    }
  });
}

/** Legacy cache writer retained for routes not yet migrated to pending claims.
 * New side-effecting routes should use claimIdempotency/completeIdempotency. */
export function storeIdempotency(tenantId: string, key: string, res: CachedResponse): void {
  const responseJson = JSON.stringify(res.body);
  const expiresAt = new Date(Date.now() + ttlMs());
  getDb().insert(idempotencyKeys).values({
    tenantId,
    key,
    responseJson,
    statusCode: res.status,
    expiresAt,
  }).onConflictDoUpdate({
    target: [idempotencyKeys.tenantId, idempotencyKeys.key],
    set: { responseJson, statusCode: res.status, expiresAt },
  }).run();
}

export function sweepExpiredIdempotency(now = Date.now()): number {
  const result = getDb().delete(idempotencyKeys).where(lt(idempotencyKeys.expiresAt, new Date(now))).run();
  return (result as unknown as { changes: number }).changes ?? 0;
}
