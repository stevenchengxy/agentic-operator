/**
 * records.upsert — durable business-record persistence. The new-arch-native
 * replacement for the old AO's Neo4j / RAAS-Postgres instance write-back:
 * candidate / resume / job_posting / candidate_match_result / communication_log
 * rows in the `business_records` table (which OUTLIVE the runs that produce
 * them, unlike run-scoped artifacts).
 *
 * Bound as a `type:"tool"` step mid-pipeline. It is PASS-THROUGH: it echoes the
 * upstream step's result so inserting it never starves the next step of its
 * `ctx.lastResult` and never hijacks `_emit` routing (it is always placed
 * non-terminally). Soft-fail: a persistence hiccup never blocks the run.
 *
 * Config (manifest tool_use[].config → ctx.config):
 *   { record_type: "candidate"|"resume"|"job_posting"|"candidate_match_result"
 *                  |"communication_log"  (required),
 *     key_field?: string,        // override the business-identity field
 *     candidate_field?: string,  // default "candidate_id"
 *     append?: boolean }         // communication_log: always insert a fresh row
 */

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { defineTool, type ToolContext } from "@agentic/agent-kit";
import { getDb, businessRecords, tenants, eq, and } from "@agentic/db";

const recId = (): string => "rec-" + randomUUID().replace(/-/g, "").slice(0, 12);
const s = (v: unknown): string => (typeof v === "string" ? v : "");

/** Non-crypto stable hash for deriving a record key from a snapshot. */
function shortHash(text: string): string {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

function sources(ctx: ToolContext): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const push = (v: unknown) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      out.push(v as Record<string, unknown>);
      const d = (v as Record<string, unknown>).data;
      if (d && typeof d === "object" && !Array.isArray(d)) out.push(d as Record<string, unknown>);
    }
  };
  push(ctx.lastResult);
  push(ctx.event?.data);
  return out;
}

function pick(srcs: Record<string, unknown>[], keys: string[]): string {
  for (const src of srcs) {
    for (const k of keys) {
      const v = src[k];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
  }
  return "";
}

function deriveRecordKey(
  recordType: string,
  snapshot: Record<string, unknown>,
  candidateId: string,
  cfg: Record<string, unknown>,
): string {
  const keyField = s(cfg.key_field);
  if (keyField && s(snapshot[keyField])) return s(snapshot[keyField]);
  const jr = s(snapshot.job_requisition_id) || s(snapshot.requisition_id);
  const email = s(snapshot.email);
  const phone = s(snapshot.phone);
  const hash = () => shortHash(JSON.stringify(snapshot));
  switch (recordType) {
    case "candidate":
      return candidateId || email || phone || `cand:${hash()}`;
    case "resume":
      return s(snapshot.resume_id) || (candidateId ? `res:${candidateId}` : email ? `res:${email}` : `res:${hash()}`);
    case "job_posting":
      return jr || s(snapshot.job_posting_id) || `jp:${hash()}`;
    case "candidate_match_result":
      return `${candidateId || email || "?"}:${jr || "?"}`;
    case "communication_log":
      return recId();
    default:
      return candidateId || recId();
  }
}

export const recordsUpsert = defineTool({
  name: "records.upsert",
  description:
    "Persist a durable business record (candidate / resume / job_posting / " +
    "candidate_match_result / communication_log) from the current step's data, " +
    "tagged to the run / correlation / candidate. Pass-through (echoes the " +
    "upstream result) so it can sit mid-pipeline without breaking routing. " +
    "Config: { record_type (required), key_field?, candidate_field?, append? }. " +
    "Soft-fail.",
  output: z.record(z.string(), z.unknown()),
  // eslint-disable-next-line @typescript-eslint/require-await
  async handler(ctx) {
    const cfg = (ctx.config ?? {}) as Record<string, unknown>;
    const recordType = s(cfg.record_type) || "record";
    const srcs = sources(ctx);

    // Business snapshot: earlier sources (lastResult) win over later (event.data).
    const snapshot: Record<string, unknown> = {};
    for (let i = srcs.length - 1; i >= 0; i--) Object.assign(snapshot, srcs[i]);
    delete snapshot._emit;
    delete snapshot._record;

    const candidateField = s(cfg.candidate_field) || "candidate_id";
    const candidateId = pick(srcs, [candidateField, "candidate_id", "candidateId"]);
    const recordKey = deriveRecordKey(recordType, snapshot, candidateId, cfg);
    const append = cfg.append === true;

    let recordId = recId();
    let upserted = false;
    try {
      const db = getDb();
      const tRow = db.select({ id: tenants.id }).from(tenants).where(eq(tenants.slug, ctx.tenantSlug)).all()[0];
      if (tRow) {
        const tenantId = tRow.id;
        // business_records.data_json is a drizzle `mode:"json"` column — pass the
        // OBJECT (drizzle serializes it once). Passing JSON.stringify(snapshot)
        // here would double-encode it (a JSON string of a JSON string).
        const dataJson = snapshot;
        const base = {
          tenantId,
          recordType,
          recordKey,
          subject: ctx.subject ?? null,
          candidateId: candidateId || null,
          correlationId: ctx.correlationId ?? null,
          runId: ctx.runId ?? null,
          sourceAgent: ctx.agentName ?? null,
          dataJson,
        };
        const existing = append
          ? undefined
          : db
              .select({ id: businessRecords.id })
              .from(businessRecords)
              .where(
                and(
                  eq(businessRecords.tenantId, tenantId),
                  eq(businessRecords.recordType, recordType),
                  eq(businessRecords.recordKey, recordKey),
                ),
              )
              .all()[0];
        if (existing) {
          recordId = existing.id;
          db.update(businessRecords)
            .set({ ...base, updatedAt: new Date() })
            .where(eq(businessRecords.id, existing.id))
            .run();
        } else {
          db.insert(businessRecords).values({ id: recordId, ...base }).run();
        }
        upserted = true;
      }
    } catch {
      /* soft-fail — never block the pipeline on a persistence hiccup */
    }

    // PASS-THROUGH: echo the incoming result so the next step's lastResult is
    // unchanged (dedup/route/decide read it) and selectEmittedEvent is not
    // hijacked (this step is always non-terminal).
    const passthrough =
      ctx.lastResult && typeof ctx.lastResult === "object" && !Array.isArray(ctx.lastResult)
        ? { ...(ctx.lastResult as Record<string, unknown>) }
        : {};
    return {
      data: {
        ...passthrough,
        _record: { record_id: recordId, record_type: recordType, record_key: recordKey, upserted },
      },
    };
  },
});
