import { factoryDomainBindings, factoryRuns, getDb, eq, and, inArray } from "@agentic/db";
import { isNull } from "drizzle-orm";
import { hasFactoryActiveWork } from "./active-work";

export interface FactoryDomainBinding {
  tenantId: string;
  ontologyDomainId: string;
  ontologyDomainName: string | null;
  source: "explicit" | "auto" | "upload";
  createdAt: string;
  updatedAt: string;
}

export interface OntologyDomainListItem {
  id: string;
  name?: string;
  counts?: Record<string, number>;
}

const iso = (v: unknown): string =>
  v instanceof Date ? v.toISOString() : new Date(v as string | number).toISOString();

/** Used only for one-time auto-binding, never as an ongoing identity relation. */
export function migrationDomainKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .normalize("NFKC")
    .replace(/-v\d+(?:\.\d+)*$/i, "")
    .replace(/[\s_-]+/g, "");
}

function rowToBinding(row: typeof factoryDomainBindings.$inferSelect): FactoryDomainBinding {
  return {
    tenantId: row.tenantId,
    ontologyDomainId: row.ontologyDomainId,
    ontologyDomainName: row.ontologyDomainName ?? null,
    source: row.source as FactoryDomainBinding["source"],
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

export function getFactoryDomainBinding(tenantId: string): FactoryDomainBinding | null {
  const row = getDb()
    .select()
    .from(factoryDomainBindings)
    .where(eq(factoryDomainBindings.tenantId, tenantId))
    .all()[0];
  return row ? rowToBinding(row) : null;
}

export function setFactoryDomainBinding(
  tenantId: string,
  domain: { id: string; name?: string },
  source: FactoryDomainBinding["source"] = "explicit",
): FactoryDomainBinding {
  const now = new Date();
  const db = getDb();
  db.transaction((tx) => {
    const current = tx.select().from(factoryDomainBindings).where(eq(factoryDomainBindings.tenantId, tenantId)).all()[0];
    const changesIdentity = !current || current.ontologyDomainId !== domain.id || current.source !== source;
    const unfinished = tx
      .select({ id: factoryRuns.id })
      .from(factoryRuns)
      .where(and(
        eq(factoryRuns.tenantId, tenantId),
        inArray(factoryRuns.status, ["running", "waiting_human"]),
        isNull(factoryRuns.deletedAt),
      ))
      .limit(1)
      .all()[0];
    if (changesIdentity && (unfinished || hasFactoryActiveWork(tenantId))) {
      throw new Error("factory_running: 当前业务领域仍有 Agent 工厂任务运行中或等待人工回复，不能更换本体连接");
    }
    tx.insert(factoryDomainBindings)
      .values({
        tenantId,
        ontologyDomainId: domain.id,
        ontologyDomainName: domain.name ?? domain.id,
        source,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: factoryDomainBindings.tenantId,
        set: {
          ontologyDomainId: domain.id,
          ontologyDomainName: domain.name ?? domain.id,
          source,
          updatedAt: now,
        },
      })
      .run();
  });
  return getFactoryDomainBinding(tenantId)!;
}

export function clearFactoryDomainBinding(tenantId: string): boolean {
  const db = getDb();
  return db.transaction((tx) => {
    const unfinished = tx
      .select({ id: factoryRuns.id })
      .from(factoryRuns)
      .where(and(
        eq(factoryRuns.tenantId, tenantId),
        inArray(factoryRuns.status, ["running", "waiting_human"]),
        isNull(factoryRuns.deletedAt),
      ))
      .limit(1)
      .all()[0];
    if (unfinished || hasFactoryActiveWork(tenantId)) {
      throw new Error("factory_running: 当前业务领域仍有 Agent 工厂任务运行中或等待人工回复，不能断开本体连接");
    }
    const result = tx
      .delete(factoryDomainBindings)
      .where(eq(factoryDomainBindings.tenantId, tenantId))
      .run() as { changes?: number };
    return (result.changes ?? 0) > 0;
  });
}

export function catalogDomain(
  domains: OntologyDomainListItem[],
  requestedId: string,
): OntologyDomainListItem | null {
  const folded = requestedId.trim().toLowerCase().normalize("NFKC");
  const exact = domains.find((d) => d.id === requestedId);
  if (exact) return exact;
  const foldedMatches = domains.filter((d) => d.id.trim().toLowerCase().normalize("NFKC") === folded);
  // Case-folding is convenience, not identity. If the catalog contains two
  // distinct ids that fold to the same value, choosing the first would bind a
  // tenant nondeterministically; require an exact id instead.
  return foldedMatches.length === 1 ? foldedMatches[0]! : null;
}

export function bindingMatchesDomain(binding: FactoryDomainBinding | null, domainId: string): boolean {
  return !!binding && binding.ontologyDomainId === domainId;
}
