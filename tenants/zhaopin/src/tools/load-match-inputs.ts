import { z } from "zod";
import { defineTool, type ToolContext } from "@agentic/agent-kit";
import {
  extractCandidateExpectation,
  formatCandidatePreferences,
  type CandidateExpectationNested,
} from "@agentic/tools/robohire";
import { withRaasPgConnection } from "./raas-pg";
import { loadJdWithRaasFallback } from "./jd-store";

const text = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function firstText(
  sources: Array<Record<string, unknown>>,
  keys: string[],
): string {
  for (const source of sources) {
    for (const key of keys) {
      const value = text(source[key]);
      if (value) return value;
    }
  }
  return "";
}

interface ResumeRow {
  resume_id: string;
  parsed_content: string | null;
  raw_parse_result: unknown;
}

function resumeTextFromRow(row: ResumeRow): string {
  const parsed = text(row.parsed_content);
  if (parsed) return parsed;
  const raw = record(row.raw_parse_result);
  return text(raw.rawText) || text(raw.raw_text) || text(raw.text);
}

/**
 * loadMatchInputs — deterministic re-materialization of the two plain-text
 * bodies RoboHire /match-resume requires.
 *
 * The legacy RAAS wire contract (tenants/zhaopin/src/legacy-raas-envelope.ts)
 * intentionally does NOT carry the full resume text or the JD across the
 * MATCH_RULE_CHECK_PASSED hop — like the old AO, the matcher pulls both from
 * the systems of record using the ids that DO travel on the wire:
 *   resume — RAAS mirror PG `resume.parsed_content` (written by processResume's
 *            persistRaasEntities before RESUME_PROCESSED was emitted), falling
 *            back to `raw_parse_result.rawText`, by resume_id else latest for
 *            the candidate;
 *   jd     — tenant JD store (written by createJD's persistJd), falling back to
 *            the authoritative RAAS job_posting via loadJdWithRaasFallback.
 * Fail-closed: a missing body must stop the run here with a precise reason —
 * matchResumeApi would otherwise 400 with a less actionable message.
 */
export const loadMatchInputs = defineTool({
  name: "loadMatchInputs",
  description:
    "Load the plain-text resume (RAAS mirror PG) and JD (JD store → RAAS job_posting) for the ids carried on MATCH_RULE_CHECK_PASSED, so matchResumeApi gets full bodies without them riding the legacy wire envelope.",
  factory: {
    category: "workflow-routing",
    sideEffect: "read",
    operation: "read",
    effectScope: "external",
    sandboxPolicy: "live_external",
    credentialEnv: ["RAAS_POSTGRES_URL"],
    capabilities: [{
      systems: ["AO_Internal", "RAAS_System"],
      kinds: ["internal_store", "database"],
      roles: ["read"],
      operations: ["resume.load", "job_posting.load", "read"],
      objectTypes: ["Resume", "Job_Posting", "Job_Requisition"],
      probeRequired: true,
    }],
    source: {
      modulePath: "tenants/zhaopin/src/tools/load-match-inputs.ts",
      exportName: "loadMatchInputs",
    },
  },
  output: z.record(z.string(), z.unknown()),
  async handler(ctx: ToolContext) {
    const data = record(ctx.event?.data);
    const last = record(ctx.lastResult);
    const jobRequisitionId = firstText(
      [last, data],
      ["job_requisition_id", "jobRequisitionId"],
    );
    const resumeId = firstText([last, data], ["resume_id", "resumeId"]);
    const candidateId = firstText(
      [last, data],
      ["candidate_id", "candidateId"],
    );
    if (!jobRequisitionId) {
      throw new Error(
        "loadMatchInputs: job_requisition_id is required to load the JD",
      );
    }
    if (!resumeId && !candidateId) {
      throw new Error(
        "loadMatchInputs: resume_id or candidate_id is required to load the resume text",
      );
    }

    const connectionString = process.env.RAAS_POSTGRES_URL?.trim() ?? "";
    if (!connectionString) {
      throw new Error(
        "loadMatchInputs: RAAS_POSTGRES_URL is required; the resume body lives in the RAAS mirror",
      );
    }

    const row = await withRaasPgConnection(connectionString, async (client) => {
      if (resumeId) {
        const byId = await client.query<ResumeRow>(
          `SELECT resume_id, parsed_content, raw_parse_result
             FROM resume WHERE resume_id = $1 LIMIT 1`,
          [resumeId],
        );
        if (byId.rows[0]) return byId.rows[0];
      }
      if (candidateId) {
        const byCandidate = await client.query<ResumeRow>(
          `SELECT resume_id, parsed_content, raw_parse_result
             FROM resume WHERE candidate_id = $1
            ORDER BY updated_at DESC NULLS LAST LIMIT 1`,
          [candidateId],
        );
        if (byCandidate.rows[0]) return byCandidate.rows[0];
      }
      return null;
    });
    if (!row) {
      throw new Error(
        `loadMatchInputs: no RAAS mirror resume row for resume_id=${resumeId || "(none)"} candidate_id=${candidateId || "(none)"}`,
      );
    }
    const resume = resumeTextFromRow(row);
    if (!resume) {
      throw new Error(
        `loadMatchInputs: mirror resume ${row.resume_id} has no parsed_content/rawText`,
      );
    }

    const jd = await loadJdWithRaasFallback(ctx, jobRequisitionId);
    if (!text(jd)) {
      throw new Error(
        `loadMatchInputs: empty JD for job_requisition_id=${jobRequisitionId}`,
      );
    }

    // Candidate's OWN expectations: prefer the structured Candidate_Expectation
    // threaded on the wire (RESUME_PROCESSED → MATCH_RULE_CHECK_PASSED carry),
    // else re-extract from the mirror resume text. Rendered to the free-form
    // string RoboHire's /match-resume accepts; empty → omitted so the matcher
    // scores on resume-vs-JD facts only (the pre-fix behaviour).
    const threadedExpectation = [
      last.candidate_expectation,
      data.candidate_expectation,
    ].find(
      (v) =>
        v &&
        typeof v === "object" &&
        !Array.isArray(v) &&
        Object.keys(v as object).length > 0,
    ) as CandidateExpectationNested | undefined;
    const candidatePreferences = formatCandidatePreferences(
      threadedExpectation ?? extractCandidateExpectation(resume),
    );

    return {
      data: {
        resume,
        jd,
        resume_id: row.resume_id,
        candidate_id: candidateId,
        job_requisition_id: jobRequisitionId,
        ...(candidatePreferences
          ? { candidate_preferences: candidatePreferences }
          : {}),
      },
    };
  },
});
