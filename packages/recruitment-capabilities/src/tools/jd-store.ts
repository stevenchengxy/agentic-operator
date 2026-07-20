/**
 * jd-store — shared recruitment tenant JD store, on the tenant-scoped
 * `agent_memory_long` KV table (no schema migration; same pattern as
 * candidate-dedup.ts). createJD's final `persistJd` step writes the generated JD
 * keyed by `job_requisition_id`; processResume's `routeResumeProcessed` reads it
 * back via `loadJd` so matchResume receives the JD text WITHOUT the LLM having to
 * re-quote it. This is the new-arch-native replacement for the old AO's
 * job_posting instance store (Neo4j/RAAS-PG) for the JD-lookup use case.
 *
 * The store is fail-closed: it persists only a non-empty JD produced by the
 * real generation chain. Missing tenant/requisition/content or any database
 * error fails the step; no event-derived placeholder is manufactured.
 */

import { z } from "zod";
import { defineTool, type ToolContext } from "@agentic/agent-kit";
import { getDb, agentMemoryLong, tenants, eq, and } from "@agentic/db";
import { type RaasPgSession, withRaasPgConnection } from "./raas-pg";
import { profileEnvironmentValue } from "./profile-config";

const AGENT_KEY = "recruitmentJdStore";
const SUBJECT = "registry";
const jrKey = (jr: string): string => `jd:${jr}`;

function tenantIdOf(slug: string): string {
  const row = getDb()
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.slug, slug))
    .all()[0];
  if (!row) {
    throw new Error(`[recruitmentJdStore] unknown tenant slug=${slug}`);
  }
  return row.id;
}

const s = (v: unknown): string => (typeof v === "string" ? v : "");

interface JdRecord {
  jd_content: string;
  job_posting_id: string;
  title: string;
  job_requisition_id: string;
}

function writeJdRecord(tenantId: string, rec: JdRecord): void {
  const now = new Date();
  getDb()
    .insert(agentMemoryLong)
    .values({
      tenantId,
      agentName: AGENT_KEY,
      subject: SUBJECT,
      key: jrKey(rec.job_requisition_id),
      valueJson: JSON.stringify(rec),
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        agentMemoryLong.tenantId,
        agentMemoryLong.agentName,
        agentMemoryLong.subject,
        agentMemoryLong.key,
      ],
      set: { valueJson: JSON.stringify(rec), updatedAt: now },
    })
    .run();
}

/** Assemble a JD record from fields actually produced by the createJD chain. */
function deriveJd(ctx: ToolContext): JdRecord {
  const last = (
    ctx.lastResult && typeof ctx.lastResult === "object" ? ctx.lastResult : {}
  ) as Record<string, unknown>;
  const data = (ctx.event?.data ?? {}) as Record<string, unknown>;
  const jr = (
    s(data.job_requisition_id) ||
    s(last.job_requisition_id) ||
    s(data.entity_id) ||
    s(ctx.subject)
  ).trim();
  const jd = (
    s(last.jd_content) ||
    s(last.jd) ||
    s(data.jd_content) ||
    s(data.jd)
  ).trim();
  if (!jr) {
    throw new Error("[recruitmentJdStore] job_requisition_id is required");
  }
  if (!jd) {
    throw new Error(
      "[recruitmentJdStore] generated jd_content is required; refusing to persist synthesized content",
    );
  }
  return {
    jd_content: jd,
    // A posting id is emitted only when an upstream system supplied one. The
    // JD store must never invent a business id merely to satisfy a UI field.
    job_posting_id: s(data.job_posting_id) || s(last.job_posting_id),
    title: s(data.title) || s(data.job_title) || s(last.title),
    job_requisition_id: jr,
  };
}

const persistedJdSchema = z.object({
  jd_content: z.string().min(1),
  job_posting_id: z.string(),
  job_requisition_id: z.string().min(1),
  title: z.string(),
  jd_persisted: z.literal(true),
});

export const persistJdTool = defineTool({
  name: "persistJd",
  description:
    "Persist the generated JD (keyed by job_requisition_id) to the tenant JD " +
    "store so matchResume can retrieve it later. Requires real generated " +
    "jd_content and fails closed on missing input or persistence errors. Echoes " +
    "jd_content so JD_GENERATED still carries it.",
  factory: {
    category: "tenant-storage",
    sideEffect: "write",
    operation: "write",
    effectScope: "sandbox_local",
    sandboxPolicy: "sandbox_local",
    configSchema: {
      tenant_slug: { type: "string", required: true },
    },
    capabilities: [
      {
        systems: ["AO_Internal"],
        kinds: ["internal_store", "database"],
        roles: ["write", "persist"],
        operations: ["job_posting.persist", "write"],
        objectTypes: ["Job_Posting", "Job_Requisition"],
        probeRequired: true,
      },
    ],
    profileScope: {
      exact: [{ configKey: "tenant_slug", source: "tenantSlug" }],
    },
    // Cleanup/readback does not exist yet; absence keeps write probes closed.
    source: {
      modulePath: "packages/recruitment-capabilities/src/tools/jd-store.ts",
      exportName: "persistJdTool",
    },
  },
  output: persistedJdSchema,
  // eslint-disable-next-line @typescript-eslint/require-await
  async handler(ctx) {
    const rec = deriveJd(ctx);
    const tenantId = tenantIdOf(ctx.tenantSlug);
    writeJdRecord(tenantId, rec);
    return {
      data: {
        jd_content: rec.jd_content,
        job_posting_id: rec.job_posting_id,
        job_requisition_id: rec.job_requisition_id,
        title: rec.title,
        jd_persisted: true as const,
      },
    };
  },
});

/** Read a real stored JD. Missing/corrupt state fails the resume pipeline. */
export function loadJd(ctx: ToolContext, jobRequisitionId: string): string {
  if (!jobRequisitionId.trim()) {
    throw new Error(
      "[recruitmentJdStore] job_requisition_id is required to load a JD",
    );
  }
  const tenantId = tenantIdOf(ctx.tenantSlug);
  const lookup = (agentName: string) =>
    getDb()
      .select({ v: agentMemoryLong.valueJson })
      .from(agentMemoryLong)
      .where(
        and(
          eq(agentMemoryLong.tenantId, tenantId),
          eq(agentMemoryLong.agentName, agentName),
          eq(agentMemoryLong.subject, SUBJECT),
          eq(agentMemoryLong.key, jrKey(jobRequisitionId)),
        ),
      )
      .all()[0];
  const row = lookup(AGENT_KEY);
  if (!row) {
    throw new Error(
      `[recruitmentJdStore] no persisted JD for job_requisition_id=${jobRequisitionId}`,
    );
  }
  let parsed: { jd_content?: unknown };
  try {
    parsed = JSON.parse(row.v) as { jd_content?: unknown };
  } catch (err) {
    throw new Error(
      `[recruitmentJdStore] corrupt JD record for job_requisition_id=${jobRequisitionId}`,
      { cause: err },
    );
  }
  if (typeof parsed.jd_content !== "string" || !parsed.jd_content.trim()) {
    throw new Error(
      `[recruitmentJdStore] persisted JD is empty for job_requisition_id=${jobRequisitionId}`,
    );
  }
  return parsed.jd_content;
}

const text = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function first(source: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = text(source[key]);
    if (value) return value;
  }
  return "";
}

/** Read the legacy/partner source of truth without naming optional columns. */
export async function loadRaasJdSnapshot(
  client: RaasPgSession,
  jobRequisitionId: string,
): Promise<JdRecord> {
  const result = await client.query<{
    posting_json: Record<string, unknown> | null;
    requirement_json: Record<string, unknown>;
  }>(
    `SELECT row_to_json(p.*) AS posting_json,
            row_to_json(r.*) AS requirement_json
       FROM job_requisition r
       LEFT JOIN LATERAL (
         SELECT posting.*
           FROM job_posting posting
          WHERE posting.job_requisition_id = r.job_requisition_id
          ORDER BY posting.published_at DESC NULLS LAST,
                   posting.updated_at DESC,
                   posting.created_at DESC
          LIMIT 1
       ) p ON TRUE
      WHERE r.job_requisition_id = $1
      LIMIT 1`,
    [jobRequisitionId],
  );
  const row = result.rows[0];
  const posting = object(row?.posting_json);
  const requirement = object(row?.requirement_json);
  if (!row || Object.keys(posting).length === 0) {
    throw new Error(
      `[recruitmentJdStore] RAAS has no JobPosting for job_requisition_id=${jobRequisitionId}`,
    );
  }

  const title =
    first(posting, ["posting_title", "title"]) ||
    first(requirement, ["client_job_title", "title"]);
  const direct = first(posting, ["jd_content"]);
  const sections: string[] = [];
  if (title) sections.push(`# ${title}`);
  const append = (heading: string, values: unknown[]) => {
    const value = values.map(text).find(Boolean);
    if (value) sections.push(`## ${heading}\n${value}`);
  };
  append("职位描述", [
    posting.posting_description,
    requirement.job_description,
  ]);
  append("岗位职责", [posting.responsibility, requirement.job_responsibility]);
  append("任职要求", [
    posting.requirement,
    requirement.job_requirement,
    requirement.qualifications,
  ]);
  append("硬性要求", [requirement.hard_requirements]);
  append("加分项", [requirement.nice_to_have]);
  append("薪资福利", [requirement.benefits, posting.salary_range]);
  const jdContent = direct || sections.join("\n\n");
  if (!jdContent.trim()) {
    throw new Error(
      `[recruitmentJdStore] RAAS JobPosting is empty for job_requisition_id=${jobRequisitionId}`,
    );
  }
  return {
    jd_content: jdContent,
    job_posting_id: first(posting, ["job_posting_id"]),
    title,
    job_requisition_id: jobRequisitionId,
  };
}

/** Local cache first, then authoritative RAAS PG with write-through caching. */
export async function loadJdWithRaasFallback(
  ctx: ToolContext,
  jobRequisitionId: string,
): Promise<string> {
  try {
    return loadJd(ctx, jobRequisitionId);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !error.message.includes("no persisted JD")
    ) {
      throw error;
    }
  }
  const connectionString = profileEnvironmentValue(ctx, "postgres_url_env", {
    label: `recruitmentJdStore fallback for ${jobRequisitionId}`,
  });
  const record = await withRaasPgConnection(connectionString, (client) =>
    loadRaasJdSnapshot(client, jobRequisitionId),
  );
  writeJdRecord(tenantIdOf(ctx.tenantSlug), record);
  return record.jd_content;
}
