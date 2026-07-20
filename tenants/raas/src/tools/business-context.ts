/**
 * Real tenant-scoped business context readers for RAAS.
 *
 * These actions used to be declared as tools without a handler. They now read
 * the durable business_records store written by records.upsert, and fail when
 * neither the triggering payload nor persisted records provide real material.
 */

import { z } from "zod";
import { defineTool, type ToolContext } from "@agentic/agent-kit";
import { businessRecords, desc, eq, getDb, tenants } from "@agentic/db";

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

function sourceRecords(ctx: ToolContext): Record<string, unknown>[] {
  const sources: Record<string, unknown>[] = [];
  const add = (value: unknown): void => {
    const record = asRecord(value);
    if (!record) return;
    sources.push(record);
    const nested = asRecord(record.data);
    if (nested) sources.push(nested);
  };
  add(ctx.lastResult);
  add(ctx.event?.data);
  for (const value of Object.values(ctx.results ?? {})) add(value);
  return sources;
}

function pick(sources: Record<string, unknown>[], keys: readonly string[]): string {
  for (const source of sources) {
    for (const key of keys) {
      const value = source[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  return "";
}

function decodeData(value: unknown): Record<string, unknown> {
  const direct = asRecord(value);
  if (direct) return direct;
  if (typeof value === "string") {
    try {
      return asRecord(JSON.parse(value)) ?? { raw: value };
    } catch {
      return { raw: value };
    }
  }
  return {};
}

function loadRelevantRecords(ctx: ToolContext): Array<{
  id: string;
  record_type: string;
  record_key: string;
  subject: string | null;
  candidate_id: string | null;
  updated_at: string;
  data: Record<string, unknown>;
}> {
  const db = getDb();
  const tenant = db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.slug, ctx.tenantSlug))
    .all()[0];
  if (!tenant) throw new Error(`[RAAS context] unknown tenant '${ctx.tenantSlug}'`);

  const sources = sourceRecords(ctx);
  const candidateId = pick(sources, ["candidate_id", "candidateId"]);
  const requisitionId = pick(sources, [
    "job_requisition_id",
    "jobRequisitionId",
    "requisition_id",
    "job_posting_id",
  ]);
  const subject = (ctx.subject ?? "").trim();
  const correlationId = (ctx.correlationId ?? "").trim();
  const hasIdentity = Boolean(candidateId || requisitionId || subject || correlationId);
  if (!hasIdentity) return [];

  // Bound the tenant-local scan. business_records has tenant/update indexes;
  // filtering the last 200 rows in process avoids constructing a permissive
  // dynamic SQL predicate while keeping identities explicit and tenant-safe.
  return db
    .select()
    .from(businessRecords)
    .where(eq(businessRecords.tenantId, tenant.id))
    .orderBy(desc(businessRecords.updatedAt))
    .limit(200)
    .all()
    .filter((row) =>
      (candidateId && row.candidateId === candidateId) ||
      (requisitionId && row.recordKey === requisitionId) ||
      (subject && (row.subject === subject || row.recordKey === subject)) ||
      (correlationId && row.correlationId === correlationId),
    )
    .map((row) => ({
      id: row.id,
      record_type: row.recordType,
      record_key: row.recordKey,
      subject: row.subject,
      candidate_id: row.candidateId,
      updated_at: row.updatedAt.toISOString(),
      data: decodeData(row.dataJson),
    }));
}

export const loadContextData = defineTool({
  name: "loadContextData",
  description:
    "Load real tenant-scoped requisition/candidate context from durable business_records and the live trigger payload. Fails when both sources are empty; never synthesizes market/history data.",
  output: z.record(z.string(), z.unknown()),
  // eslint-disable-next-line @typescript-eslint/require-await
  async handler(ctx) {
    const trigger = asRecord(ctx.event?.data) ?? {};
    const records = loadRelevantRecords(ctx);
    if (Object.keys(trigger).length === 0 && records.length === 0) {
      throw new Error(
        `[loadContextData] ${ctx.tenantSlug}/${ctx.subject ?? "unknown"}: no trigger payload or persisted business context`,
      );
    }
    return {
      data: {
        context_data: {
          trigger_event: ctx.event?.name ?? null,
          trigger_payload: trigger,
          persisted_records: records,
        },
        context_record_count: records.length,
        context_sources: [
          ...(Object.keys(trigger).length > 0 ? ["trigger"] : []),
          ...(records.length > 0 ? ["business_records"] : []),
        ],
      },
      meta: { persistedRecords: records.length, tenant: ctx.tenantSlug },
    };
  },
});

export const assemblePackageMaterials = defineTool({
  name: "assemblePackageMaterials",
  description:
    "Assemble the actual trigger payload and tenant-scoped durable candidate records into a recommendation-material inventory. Fails when no real material exists.",
  output: z.record(z.string(), z.unknown()),
  // eslint-disable-next-line @typescript-eslint/require-await
  async handler(ctx) {
    const trigger = asRecord(ctx.event?.data) ?? {};
    const records = loadRelevantRecords(ctx);
    const triggerHasMaterial = Object.keys(trigger).length > 0;
    if (!triggerHasMaterial && records.length === 0) {
      throw new Error(
        `[assemblePackageMaterials] ${ctx.tenantSlug}/${ctx.subject ?? "unknown"}: no persisted or inbound recommendation material`,
      );
    }
    const materials = [
      ...records.map((record) => ({
        material_id: record.id,
        kind: record.record_type,
        record_key: record.record_key,
        updated_at: record.updated_at,
        data: record.data,
      })),
      ...(triggerHasMaterial
        ? [{
            material_id: `trigger:${ctx.correlationId}`,
            kind: "trigger_payload",
            record_key: ctx.subject ?? ctx.correlationId,
            updated_at: new Date().toISOString(),
            data: trigger,
          }]
        : []),
    ];
    return {
      data: {
        assembled_materials: materials,
        material_count: materials.length,
        source_record_ids: records.map((record) => record.id),
      },
      meta: { persistedRecords: records.length, tenant: ctx.tenantSlug },
    };
  },
});
