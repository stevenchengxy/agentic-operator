import { randomUUID } from "node:crypto";
import { and, eq, gt, lte } from "drizzle-orm";
import { getDb, operationLeases } from "@agentic/db";

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const MIN_TTL_MS = 5_000;

export class DurableLeaseBusyError extends Error {
  readonly code = "resource_busy";
  readonly statusCode = 409;

  constructor(readonly resourceKey: string) {
    super(`operation lease is already held for ${resourceKey}`);
    this.name = "DurableLeaseBusyError";
  }
}

export class DurableLeaseLostError extends Error {
  readonly code = "operation_lease_lost";
  readonly statusCode = 503;

  constructor(readonly resourceKey: string) {
    super(`operation lease ownership was lost for ${resourceKey}`);
    this.name = "DurableLeaseLostError";
  }
}

export interface DurableLeaseHandle {
  resourceKey: string;
  ownerToken: string;
  assertOwned(): void;
  release(): void;
}

function validTtl(ttlMs: number | undefined): number {
  const value = ttlMs ?? DEFAULT_TTL_MS;
  if (!Number.isSafeInteger(value) || value < MIN_TTL_MS) {
    throw new Error(`lease ttlMs must be an integer >= ${MIN_TTL_MS}`);
  }
  return value;
}

/** Acquire a primary-keyed SQLite lease without waiting. */
export function acquireDurableLease(args: {
  resourceKey: string;
  tenantId: string;
  kind: string;
  workId?: string | null;
  ttlMs?: number;
}): DurableLeaseHandle {
  const ttlMs = validTtl(args.ttlMs);
  const ownerToken = randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs);
  const db = getDb();

  const acquired = db.transaction((tx) => {
    // A crashed owner's row is reclaimable, but only after its exact expiry.
    tx.delete(operationLeases)
      .where(
        and(
          eq(operationLeases.resourceKey, args.resourceKey),
          lte(operationLeases.expiresAt, now),
        ),
      )
      .run();
    return tx
      .insert(operationLeases)
      .values({
        resourceKey: args.resourceKey,
        tenantId: args.tenantId,
        ownerToken,
        kind: args.kind,
        workId: args.workId ?? null,
        createdAt: now,
        expiresAt,
      })
      .onConflictDoNothing({ target: operationLeases.resourceKey })
      .run() as { changes?: number };
  });
  if ((acquired.changes ?? 0) !== 1) {
    throw new DurableLeaseBusyError(args.resourceKey);
  }

  let released = false;
  let lost = false;
  const renewEveryMs = Math.max(1_000, Math.floor(ttlMs / 3));
  const timer = setInterval(() => {
    if (released || lost) return;
    try {
      const refreshed = getDb()
        .update(operationLeases)
        .set({ expiresAt: new Date(Date.now() + ttlMs) })
        .where(
          and(
            eq(operationLeases.resourceKey, args.resourceKey),
            eq(operationLeases.ownerToken, ownerToken),
          ),
        )
        .run() as { changes?: number };
      if ((refreshed.changes ?? 0) !== 1) lost = true;
    } catch {
      // Do not manufacture continued ownership when durable renewal failed.
      // The caller's next ownership assertion fails closed.
      lost = true;
    }
  }, renewEveryMs);
  timer.unref();

  return {
    resourceKey: args.resourceKey,
    ownerToken,
    assertOwned() {
      if (released || lost) throw new DurableLeaseLostError(args.resourceKey);
      const row = getDb()
        .select({ resourceKey: operationLeases.resourceKey })
        .from(operationLeases)
        .where(
          and(
            eq(operationLeases.resourceKey, args.resourceKey),
            eq(operationLeases.ownerToken, ownerToken),
            gt(operationLeases.expiresAt, new Date()),
          ),
        )
        .all()[0];
      if (!row) {
        lost = true;
        throw new DurableLeaseLostError(args.resourceKey);
      }
    },
    release() {
      if (released) return;
      released = true;
      clearInterval(timer);
      try {
        getDb()
          .delete(operationLeases)
          .where(
            and(
              eq(operationLeases.resourceKey, args.resourceKey),
              eq(operationLeases.ownerToken, ownerToken),
            ),
          )
          .run();
      } catch (error) {
        // Retaining a lease until TTL is safer than deleting another owner's
        // row. Surface the cleanup failure operationally without turning a
        // completed detached job into an unhandled rejection.
        console.error(
          `[durable-lease] failed to release ${args.resourceKey}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Acquire, run, verify ownership, and release. Optional bounded waiting keeps
 * existing single-process mutex callers serialized while adding real
 * cross-process arbitration. */
export async function withDurableLease<T>(args: {
  resourceKey: string;
  tenantId: string;
  kind: string;
  workId?: string | null;
  ttlMs?: number;
  waitMs?: number;
  fn: (lease: DurableLeaseHandle) => Promise<T>;
}): Promise<T> {
  const waitMs = Math.max(0, Math.trunc(args.waitMs ?? 0));
  const deadline = Date.now() + waitMs;
  let lease: DurableLeaseHandle;
  for (;;) {
    try {
      lease = acquireDurableLease(args);
      break;
    } catch (error) {
      if (
        !(error instanceof DurableLeaseBusyError) ||
        Date.now() >= deadline
      ) {
        throw error;
      }
      await delay(Math.min(50, Math.max(1, deadline - Date.now())));
    }
  }
  try {
    const value = await args.fn(lease);
    lease.assertOwned();
    return value;
  } finally {
    lease.release();
  }
}
