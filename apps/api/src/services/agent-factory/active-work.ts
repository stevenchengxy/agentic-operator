/** Durable registry for detached factory work not represented by factory_runs. */

import { randomUUID } from "node:crypto";
import { and, eq, gt, inArray, lte } from "drizzle-orm";
import { getDb, operationLeases } from "@agentic/db";
import { acquireDurableLease } from "../durable-lease";

export type FactoryActiveWorkKind = "report" | "promotion" | "sandbox";

interface ActiveWork {
  id: string;
  kind: FactoryActiveWorkKind;
}

const ACTIVE_KINDS = [
  "factory_report",
  "factory_promotion",
  "factory_sandbox",
] as const;

function durableKind(kind: FactoryActiveWorkKind): (typeof ACTIVE_KINDS)[number] {
  return `factory_${kind}` as (typeof ACTIVE_KINDS)[number];
}

function sweepExpired(): void {
  getDb()
    .delete(operationLeases)
    .where(
      and(
        inArray(operationLeases.kind, [...ACTIVE_KINDS]),
        lte(operationLeases.expiresAt, new Date()),
      ),
    )
    .run();
}

// In-flight lease TTL: how long a crashed process's registration stays visible before the durable
// lease expires and the work can be reclaimed. Default 1h.
const ACTIVE_WORK_TTL_MS = Number(process.env.FACTORY_ACTIVE_WORK_TTL_MS) || 60 * 60 * 1000;

export function beginFactoryActiveWork(
  tenantId: string,
  id: string,
  kind: FactoryActiveWorkKind,
): () => void {
  const registrationId = randomUUID();
  const lease = acquireDurableLease({
    resourceKey: `factory-work:${tenantId}:${registrationId}`,
    tenantId,
    kind: durableKind(kind),
    workId: id,
    ttlMs: ACTIVE_WORK_TTL_MS,
  });
  return lease.release;
}

export function listFactoryActiveWork(tenantId: string): ActiveWork[] {
  sweepExpired();
  return getDb()
    .select({ id: operationLeases.workId, kind: operationLeases.kind })
    .from(operationLeases)
    .where(
      and(
        eq(operationLeases.tenantId, tenantId),
        inArray(operationLeases.kind, [...ACTIVE_KINDS]),
        gt(operationLeases.expiresAt, new Date()),
      ),
    )
    .all()
    .map((row) => ({
      id: row.id ?? "unknown",
      kind: row.kind.replace(/^factory_/, "") as FactoryActiveWorkKind,
    }));
}

export function hasFactoryActiveWork(tenantId: string): boolean {
  sweepExpired();
  return Boolean(
    getDb()
      .select({ resourceKey: operationLeases.resourceKey })
      .from(operationLeases)
      .where(
        and(
          eq(operationLeases.tenantId, tenantId),
          inArray(operationLeases.kind, [...ACTIVE_KINDS]),
          gt(operationLeases.expiresAt, new Date()),
        ),
      )
      .limit(1)
      .all()[0],
  );
}

/** Shared execution resources can affect every tenant, so their mutation gate
 * must look across all active Factory work instead of checking only the actor's
 * tenant. Expired leases are swept first just like the tenant-scoped query. */
export function hasAnyFactoryActiveWork(): boolean {
  sweepExpired();
  return Boolean(
    getDb()
      .select({ resourceKey: operationLeases.resourceKey })
      .from(operationLeases)
      .where(
        and(
          inArray(operationLeases.kind, [...ACTIVE_KINDS]),
          gt(operationLeases.expiresAt, new Date()),
        ),
      )
      .limit(1)
      .all()[0],
  );
}
