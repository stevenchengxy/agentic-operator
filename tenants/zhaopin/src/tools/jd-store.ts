/**
 * jd-store — 招聘-v1 (zhaopin) tenant JD store, on the existing tenant-scoped
 * `agent_memory_long` KV table (no schema migration; same pattern as
 * candidate-dedup.ts). createJD's final `persistJd` step writes the generated JD
 * keyed by `job_requisition_id`; processResume's `routeResumeProcessed` reads it
 * back via `loadJd` so matchResume receives the JD text WITHOUT the LLM having to
 * re-quote it. This is the new-arch-native replacement for the old AO's
 * job_posting instance store (Neo4j/RAAS-PG) for the JD-lookup use case.
 *
 * Under the mock gateway createJD.generateJDContent produces no real jd_content,
 * so persistJd falls back to an event-derived JD (title + requirements) — the
 * store stays useful without a real LLM.
 */

import { z } from "zod";
import { defineTool, type ToolContext } from "@agentic/agent-kit";
import { getDb, agentMemoryLong, tenants, eq, and } from "@agentic/db";

const AGENT_KEY = "zhaopinJdStore";
const SUBJECT = "registry";
const jrKey = (jr: string): string => `jd:${jr}`;

function tenantIdOf(slug: string): string | null {
  const row = getDb().select({ id: tenants.id }).from(tenants).where(eq(tenants.slug, slug)).all()[0];
  return row?.id ?? null;
}

const s = (v: unknown): string => (typeof v === "string" ? v : "");

interface JdRecord {
  jd_content: string;
  job_posting_id: string;
  title: string;
  job_requisition_id: string;
}

/** Assemble a JD record from the createJD chain output or, failing that, the
 *  trigger payload (title + requirements) so the store is useful under mock. */
function deriveJd(ctx: ToolContext): JdRecord {
  const last = (ctx.lastResult && typeof ctx.lastResult === "object" ? ctx.lastResult : {}) as Record<string, unknown>;
  const data = (ctx.event?.data ?? {}) as Record<string, unknown>;
  const jr = s(data.job_requisition_id) || s(last.job_requisition_id);
  let jd = s(last.jd_content) || s(last.jd) || s(data.jd_content) || s(data.jd);
  if (!jd) {
    const title = s(data.title) || s(data.job_title) || s(last.title);
    const req = s(data.requirements) || s(data.jd_requirements) || s(data.description);
    jd = [title && `职位：${title}`, req && `要求：${req}`].filter(Boolean).join("\n");
  }
  return {
    jd_content: jd,
    job_posting_id: s(data.job_posting_id) || s(last.job_posting_id) || (jr ? `jp-${jr}` : ""),
    title: s(data.title) || s(data.job_title) || s(last.title),
    job_requisition_id: jr,
  };
}

export const persistJdTool = defineTool({
  name: "persistJd",
  description:
    "Persist the generated JD (keyed by job_requisition_id) to the tenant JD " +
    "store so matchResume can retrieve it later; falls back to an event-derived " +
    "JD when no LLM content is present. Echoes jd_content so JD_GENERATED still " +
    "carries it. Deterministic, soft-fail.",
  output: z.record(z.string(), z.unknown()),
  // eslint-disable-next-line @typescript-eslint/require-await
  async handler(ctx) {
    const rec = deriveJd(ctx);
    try {
      const tenantId = tenantIdOf(ctx.tenantSlug);
      if (tenantId && rec.job_requisition_id && rec.jd_content) {
        const db = getDb();
        const where = and(
          eq(agentMemoryLong.tenantId, tenantId),
          eq(agentMemoryLong.agentName, AGENT_KEY),
          eq(agentMemoryLong.subject, SUBJECT),
          eq(agentMemoryLong.key, jrKey(rec.job_requisition_id)),
        );
        db.delete(agentMemoryLong).where(where).run();
        db.insert(agentMemoryLong)
          .values({
            tenantId,
            agentName: AGENT_KEY,
            subject: SUBJECT,
            key: jrKey(rec.job_requisition_id),
            valueJson: JSON.stringify(rec),
          })
          .run();
      }
    } catch {
      /* JD store is best-effort — never block createJD. */
    }
    return {
      data: {
        jd_content: rec.jd_content,
        job_posting_id: rec.job_posting_id,
        job_requisition_id: rec.job_requisition_id,
        title: rec.title,
        jd_persisted: !!rec.jd_content,
      },
    };
  },
});

/** Read the stored JD text for a job_requisition_id ("" when absent). */
export function loadJd(ctx: ToolContext, jobRequisitionId: string): string {
  if (!jobRequisitionId) return "";
  try {
    const tenantId = tenantIdOf(ctx.tenantSlug);
    if (!tenantId) return "";
    const row = getDb()
      .select({ v: agentMemoryLong.valueJson })
      .from(agentMemoryLong)
      .where(
        and(
          eq(agentMemoryLong.tenantId, tenantId),
          eq(agentMemoryLong.agentName, AGENT_KEY),
          eq(agentMemoryLong.subject, SUBJECT),
          eq(agentMemoryLong.key, jrKey(jobRequisitionId)),
        ),
      )
      .all()[0];
    if (!row) return "";
    const parsed = JSON.parse(row.v) as { jd_content?: string };
    return typeof parsed.jd_content === "string" ? parsed.jd_content : "";
  } catch {
    return "";
  }
}
