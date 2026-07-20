/**
 * RAAS rule-context loader for ruleCheckForMatchResume.
 *
 * The 11 live rules need facts that are not present in a parsed resume alone:
 * target client/department/job type, prior applications, BP credential state,
 * blacklist rows and interview outcomes.  This tool reads only tables/columns
 * present in the RAAS Prisma contract and returns explicit missing slots.  A
 * connectivity/missing-entity error throws; incomplete business evidence is
 * returned with rule_context_complete=false so the evaluator marks the
 * affected mandatory rules insufficient_info (never pass-by-absence).
 */

import { z } from "zod";
import { defineTool, type ToolContext } from "@agentic/agent-kit";
import { withRaasPgConnection, type RaasPgSession } from "./raas-pg";
import { profileEnvironmentValue } from "./profile-config";

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const text = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

function parseObject(value: unknown): Record<string, unknown> | null {
  const direct = asRecord(value);
  if (direct) return direct;
  if (typeof value !== "string" || !value.trim().startsWith("{")) return null;
  try {
    return asRecord(JSON.parse(value) as unknown);
  } catch {
    return null;
  }
}

function pick(snapshot: Record<string, unknown>, keys: string[]): string {
  const roots = [
    snapshot,
    asRecord(snapshot.data),
    asRecord(snapshot.payload),
  ].filter((root): root is Record<string, unknown> => root !== null);
  for (const root of roots) {
    for (const key of keys) {
      const value = text(root[key]);
      if (value) return value;
    }
  }
  return "";
}

export interface RaasRuleContext extends Record<string, unknown> {
  candidate_id: string;
  job_requisition_id: string;
  candidate: Record<string, unknown>;
  resume: Record<string, unknown>;
  job_requisition: Record<string, unknown>;
  client_name: string | null;
  client_department: Record<string, unknown> | null;
  department: Record<string, unknown> | null;
  studio: string | null;
  job_type: string | null;
  application_history: Array<Record<string, unknown>>;
  blacklist_hits: Array<Record<string, unknown>>;
  interview_history: Array<Record<string, unknown>>;
  /** #CREDENTIAL-VERDICT-FIX — raw evidence, never a verdict. Whether a present credential is
   * VALID (vs "rejected"/"expired"/"pending") is an ontology rule decision, not this loader's.
   * The old derived `compliance_credential_verified: boolean` treated ANY non-empty string as
   * verified and silently passed the mandatory compliance gate. */
  compliance_credentials: string[];
  compliance_credential_present: boolean;
  client_bp_decision: string | null;
  rule_context_complete: boolean;
  rule_context_missing: string[];
  rule_context_source: "raas-postgres";
}

export async function readRaasRuleContext(
  session: RaasPgSession,
  args: { candidateId: string; jobRequisitionId: string },
): Promise<RaasRuleContext> {
  const candidateResult = await session.query<{
    candidate_json: Record<string, unknown>;
  }>(
    "SELECT row_to_json(c.*) AS candidate_json FROM candidate c WHERE c.candidate_id = $1 LIMIT 1",
    [args.candidateId],
  );
  const candidate = asRecord(candidateResult.rows[0]?.candidate_json);
  if (!candidate) {
    throw new Error(
      `loadRaasRuleContext: RAAS Candidate '${args.candidateId}' does not exist`,
    );
  }

  const jobResult = await session.query<{
    requirement_json: Record<string, unknown>;
    specification_json: Record<string, unknown> | null;
    client_json: Record<string, unknown> | null;
    department_json: Record<string, unknown> | null;
  }>(
    `SELECT
        row_to_json(r.*) AS requirement_json,
        row_to_json(s.*) AS specification_json,
        row_to_json(cl.*) AS client_json,
        row_to_json(cd.*) AS department_json
      FROM job_requisition r
      LEFT JOIN job_requisition_specification s
        ON s.job_requisition_specification_id = r.job_requisition_specification_id
      LEFT JOIN client cl ON cl.client_id = COALESCE(r.client_id, s.client_id)
      LEFT JOIN client_department cd
        ON cd.client_department_id = r.client_department_id
      WHERE r.job_requisition_id = $1
      LIMIT 1`,
    [args.jobRequisitionId],
  );
  const jobRow = jobResult.rows[0];
  const requirement = asRecord(jobRow?.requirement_json);
  if (!requirement) {
    throw new Error(
      `loadRaasRuleContext: RAAS JobRequisition '${args.jobRequisitionId}' does not exist`,
    );
  }
  const specification = asRecord(jobRow?.specification_json);
  const client = asRecord(jobRow?.client_json);
  const department = asRecord(jobRow?.department_json);

  const resumeResult = await session.query<{
    resume_json: Record<string, unknown>;
  }>(
    `SELECT row_to_json(r.*) AS resume_json
      FROM resume r
      WHERE r.candidate_id = $1
      ORDER BY r.updated_at DESC
      LIMIT 1`,
    [args.candidateId],
  );
  const resumeRow = asRecord(resumeResult.rows[0]?.resume_json);
  if (!resumeRow) {
    throw new Error(
      `loadRaasRuleContext: RAAS Resume for candidate '${args.candidateId}' does not exist`,
    );
  }
  const rawParse = parseObject(resumeRow.raw_parse_result) ?? {};
  const rawData = asRecord(rawParse.data) ?? rawParse;
  const workHistory =
    (Array.isArray(rawData.experience) ? rawData.experience : undefined) ??
    (Array.isArray(rawData.work_history) ? rawData.work_history : undefined) ??
    (Array.isArray(resumeRow.work_history)
      ? resumeRow.work_history
      : undefined) ??
    [];
  const resume = {
    ...resumeRow,
    ...rawData,
    experience: workHistory,
    work_history: workHistory,
  };

  const applicationResult = await session.query<Record<string, unknown>>(
    `SELECT
        application_id, client_id, job_requisition_id, candidate_id, resume_id,
        status, stage, matching_score, push_timestamp,
        rejection_reason, abandon_reason, compliance_credential,
        COALESCE(push_timestamp, updated_at, created_at) AS occurred_at
      FROM application
      WHERE candidate_id = $1
      ORDER BY COALESCE(push_timestamp, updated_at, created_at) DESC`,
    [args.candidateId],
  );
  const applicationHistory = applicationResult.rows.map((row) => ({ ...row }));

  const blacklistResult = await session.query<Record<string, unknown>>(
    `SELECT
        blacklist_id, candidate_id, client_id, client_department_id,
        job_requisition_id, lock_reason, lock_duration_months,
        expires_at, source, active, created_at
      FROM blacklist
      WHERE candidate_id = $1 AND active = TRUE
      ORDER BY created_at DESC`,
    [args.candidateId],
  );

  const interviewResult = await session.query<Record<string, unknown>>(
    `SELECT
        ir.interview_record_id, ir.application_id, ir.interview_type,
        ir.interview_round, ir.start_time, ir.end_time,
        ir.interview_result, ir.raw_interview_notes,
        a.job_requisition_id, a.status AS application_status
      FROM interview_record ir
      JOIN application a ON a.application_id = ir.application_id
      WHERE a.candidate_id = $1
      ORDER BY COALESCE(ir.end_time, ir.start_time, ir.updated_at) DESC`,
    [args.candidateId],
  );

  const clientName = text(client?.client_name) || null;
  const studio =
    text(requirement.client_business_group) ||
    text(specification?.sd_org_name) ||
    text(department?.dept_name) ||
    null;
  const jobType =
    text(requirement.client_job_type) ||
    text(requirement.job_type) ||
    text(requirement.recruitment_type) ||
    null;
  const targetApplications = applicationHistory.filter(
    (row) => text(row.job_requisition_id) === args.jobRequisitionId,
  );
  // #CREDENTIAL-VERDICT-FIX — this used to conclude `credentialVerified =
  // targetApplications.some(r => text(r.compliance_credential).length > 0)`, i.e. ANY non-empty
  // string counted as "verified". A credential reading "rejected"/"pending"/"expired" therefore
  // returned true, kept `compliance_credential_verified` OUT of `missing[]`, and let the mandatory
  // compliance rule PASS silently. Deciding what counts as a verified credential is an
  // ontology-owned ruling, and this file already refuses exactly that for client_bp_decision
  // ("Do not infer approval from a stage/status"). So: surface the RAW credential values and let
  // the ontology's rules adjudicate; report presence (not validity) for slot completeness.
  const complianceCredentials = targetApplications
    .map((row) => text(row.compliance_credential))
    .filter((value) => value.length > 0);
  const credentialPresent = complianceCredentials.length > 0;

  // The current RAAS schema has compliance_credential but no authoritative
  // `client_bp_decision` column.  Do not infer approval from a stage/status;
  // exposing null makes mandatory BP-dependent rules insufficient_info.
  const clientBpDecision: string | null = null;
  const missing: string[] = [];
  if (!clientName) missing.push("client_name");
  if (!department && !studio) missing.push("client_department_or_studio");
  if (!jobType) missing.push("job_type");
  if (workHistory.length === 0) missing.push("resume.work_history");
  // Absent credential = no evidence → the mandatory rule must go insufficient_info. A PRESENT
  // credential is evidence, not a verdict: its validity is judged by the ontology's rules.
  if (!credentialPresent) missing.push("compliance_credential");
  missing.push("client_bp_decision");

  return {
    candidate_id: args.candidateId,
    job_requisition_id: args.jobRequisitionId,
    candidate,
    resume,
    job_requisition: {
      ...requirement,
      specification,
      client,
      client_department: department,
    },
    client_name: clientName,
    client_department: department,
    department,
    studio,
    job_type: jobType,
    application_history: applicationHistory,
    blacklist_hits: blacklistResult.rows.map((row) => ({ ...row })),
    interview_history: interviewResult.rows.map((row) => ({ ...row })),
    // Raw evidence for the ontology to adjudicate — NOT a verdict. `*_present` reports only that
    // a credential exists; whether it is VALID (vs "rejected"/"expired") is a rule decision.
    compliance_credentials: complianceCredentials,
    compliance_credential_present: credentialPresent,
    client_bp_decision: clientBpDecision,
    rule_context_complete: missing.length === 0,
    rule_context_missing: missing,
    rule_context_source: "raas-postgres",
  };
}

function snapshotFromContext(ctx: ToolContext): Record<string, unknown> {
  return {
    ...(ctx.event?.data ?? {}),
    ...(asRecord(ctx.lastResult) ?? {}),
  };
}

export const loadRaasRuleContext = defineTool({
  name: "loadRaasRuleContext",
  description:
    "Load fail-closed RAAS recruitment rule facts by candidate_id + " +
    "job_requisition_id: client/department/job type, structured employment " +
    "history, prior applications/interviews, blacklist and BP credential state.",
  factory: {
    category: "raas-data",
    sideEffect: "read",
    operation: "read",
    effectScope: "external",
    sandboxPolicy: "live_external",
    configSchema: {
      tenant_slug: { type: "string", required: true },
      postgres_url_env: {
        type: "string",
        required: true,
        description:
          "Server env name for RAAS PostgreSQL; no literal credential is accepted.",
      },
    },
    capabilities: [
      {
        systems: ["RAAS_System"],
        kinds: ["database"],
        roles: ["read", "reads"],
        operations: [
          "rule_context.load",
          "candidate_match_context.load",
          "read",
        ],
        objectTypes: [
          "Candidate",
          "Resume",
          "Job_Requisition",
          "Application",
          "Interview_Record",
          "Client",
        ],
        probeRequired: true,
      },
    ],
    profileScope: {
      exact: [{ configKey: "tenant_slug", source: "tenantSlug" }],
    },
    source: {
      modulePath:
        "packages/recruitment-capabilities/src/tools/raas-rule-context.ts",
      exportName: "loadRaasRuleContext",
    },
  },
  output: z.record(z.string(), z.unknown()),
  async handler(ctx) {
    const connectionString = profileEnvironmentValue(ctx, "postgres_url_env", {
      label: "loadRaasRuleContext",
    });
    const snapshot = snapshotFromContext(ctx);
    const candidateId = pick(snapshot, ["candidate_id", "candidateId"]);
    const jobRequisitionId = pick(snapshot, [
      "job_requisition_id",
      "jobRequisitionId",
    ]);
    if (!candidateId || !jobRequisitionId) {
      throw new Error(
        "loadRaasRuleContext: candidate_id and job_requisition_id are required",
      );
    }
    const context = await withRaasPgConnection(connectionString, (session) =>
      readRaasRuleContext(session, { candidateId, jobRequisitionId }),
    );
    return { data: { ...context } };
  },
});
