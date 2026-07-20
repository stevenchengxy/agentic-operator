/**
 * routeResumeProcessed — shared recruitment deterministic FINAL step of
 * processResume (9-1). The carry-forward envelope builds the outgoing event.data
 * as { ...inbound top-level fields, ...THIS step's returned object }
 * (message-envelope.ts assembleEmitPayload), so this step assembles the fields
 * the downstream agents need — candidate_id, resume (parsed, echoed by
 * candidateDedupLookup), resume_id, job_requisition_id, and the JD text
 * (loadJd) — as TOP-LEVEL fields on RESUME_PROCESSED. They then auto-carry
 * through the rule-check gate to MATCH_RULE_CHECK_PASSED, where matchResumeApi
 * (which reads ctx.event.data) picks up { resume, jd } with zero LLM re-quoting.
 *
 * Also owns the routing the old validateCandidacy logic step did: a recruiter
 * lock conflict → RESUME_LOCKED_CONFLICT (terminates), else RESUME_PROCESSED.
 */

import { z } from "zod";
import { defineTool } from "@agentic/agent-kit";
import { extractCandidateExpectation } from "@agentic/tools/robohire";
import { loadJdWithRaasFallback } from "./jd-store";

const s = (v: unknown): string => (typeof v === "string" ? v : "");

function stringIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const item of value) {
    const id = s(item).trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

export const routeResumeProcessed = defineTool({
  name: "routeResumeProcessed",
  description:
    "Deterministic final step of processResume: assemble the RESUME_PROCESSED " +
    "payload (candidate_id / resume / resume_id / job_requisition_id / jd) so " +
    "downstream agents receive it via carry-forward, and route _emit by " +
    "lock_conflict (RESUME_LOCKED_CONFLICT vs RESUME_PROCESSED). No LLM.",
  factory: {
    category: "workflow-routing",
    sideEffect: "read",
    operation: "read",
    effectScope: "external",
    sandboxPolicy: "live_external",
    configSchema: {
      tenant_slug: { type: "string", required: true },
    },
    capabilities: [
      {
        systems: ["AO_Internal", "RAAS_System"],
        kinds: ["internal_store", "database"],
        roles: ["read", "route"],
        operations: ["job_posting.load", "resume.outcome.route", "read"],
        objectTypes: ["Job_Posting", "Job_Requisition", "Resume", "Candidate"],
        probeRequired: true,
      },
    ],
    profileScope: {
      exact: [{ configKey: "tenant_slug", source: "tenantSlug" }],
    },
    source: {
      modulePath:
        "packages/recruitment-capabilities/src/tools/route-resume-processed.ts",
      exportName: "routeResumeProcessed",
    },
  },
  output: z.record(z.string(), z.unknown()),
  // eslint-disable-next-line @typescript-eslint/require-await
  async handler(ctx) {
    const d = (
      ctx.lastResult && typeof ctx.lastResult === "object" ? ctx.lastResult : {}
    ) as Record<string, unknown>;
    const data = (ctx.event?.data ?? {}) as Record<string, unknown>;
    const lockConflict = d.lock_conflict === true;
    const candidateId = s(d.candidate_id) || s(data.candidate_id);
    const lockedByEmployeeId =
      s(d.locked_by_employee_id) || s(data.locked_by_employee_id);
    const requestingRecruiterId =
      s(d.requesting_recruiter_id) ||
      s(data.requesting_recruiter_id) ||
      s(data.employee_id) ||
      s(data.recruiter_id);
    const resume = s(d.resume) || s(data.resume) || s(data.resume_text);
    const resumeId = s(d.resume_id) || s(data.resume_id);
    const singleJr = (
      s(d.job_requisition_id) || s(data.job_requisition_id)
    ).trim();
    // Match the legacy rule-check precedence: an explicit singular JR wins;
    // otherwise fan out the pre-filtered list supplied by RAAS/Nextcloud.
    const jobRequisitionIds = singleJr
      ? [singleJr]
      : stringIds(d.job_requisition_ids).length > 0
        ? stringIds(d.job_requisition_ids)
        : stringIds(data.job_requisition_ids);

    // Candidate's OWN expectations (ontology Candidate_Expectation): prefer a
    // structured value already supplied upstream, else extract once from the
    // parsed resume / raw text. This is the single population site — the wire
    // envelope carries it on RESUME_PROCESSED → MATCH_RULE_CHECK_PASSED so the
    // matcher (and the four expectation-gated matchResume rules) finally get
    // data to judge. {} when nothing is found (zero behaviour change).
    const upstreamExpectation = [
      d.candidate_expectation,
      data.candidate_expectation,
    ].find(
      (v) =>
        v &&
        typeof v === "object" &&
        !Array.isArray(v) &&
        Object.keys(v as object).length > 0,
    ) as Record<string, unknown> | undefined;
    const candidateExpectation =
      upstreamExpectation ??
      extractCandidateExpectation({
        parsed: d,
        rawText: s(d.rawText) || s(data.rawText) || null,
      });

    // A recruiter lock conflict is terminal and does not enter matching. It
    // must remain emit-able even when there is no requisition/JD (the legacy
    // resume parser detects the conflict before job fan-out).
    if (lockConflict) {
      return {
        data: {
          _emit: "RESUME_LOCKED_CONFLICT",
          candidate_id: candidateId,
          locked_by_employee_id: lockedByEmployeeId,
          requesting_recruiter_id: requestingRecruiterId,
          resume,
          resume_id: resumeId,
          job_requisition_id: singleJr,
          job_requisition_ids: jobRequisitionIds,
          jd: s(data.jd),
          candidate_expectation: candidateExpectation,
          lock_conflict: true,
          needs_review: d.needs_review === true,
        },
      };
    }

    if (jobRequisitionIds.length === 0) {
      throw new Error(
        "routeResumeProcessed: job_requisition_id or job_requisition_ids is required",
      );
    }

    const payloads = await Promise.all(
      jobRequisitionIds.map(async (jobRequisitionId) => ({
        candidate_id: candidateId,
        locked_by_employee_id: lockedByEmployeeId,
        requesting_recruiter_id: requestingRecruiterId,
        resume,
        // A candidate can own multiple resumes. Never synthesize `res-${candidate}`
        // (which collapses them into one fake identity); only a source id crosses
        // this boundary and persistence derives one from the real file otherwise.
        resume_id: resumeId,
        job_requisition_id: jobRequisitionId,
        job_requisition_ids: jobRequisitionIds,
        jd:
          jobRequisitionIds.length === 1 && s(data.jd)
            ? s(data.jd)
            : await loadJdWithRaasFallback(ctx, jobRequisitionId),
        candidate_expectation: candidateExpectation,
        lock_conflict: false,
        needs_review: d.needs_review === true,
      })),
    );
    const firstPayload = payloads[0]!;
    return {
      data: {
        _emit: "RESUME_PROCESSED",
        ...firstPayload,
        // The runtime validates every embedded intent against triggered_event
        // and deliberately retains repeated names, yielding one downstream run
        // per requisition without duplicating Candidate/Resume persistence.
        _emits: payloads.map((payload) => ({
          event: "RESUME_PROCESSED",
          payload,
        })),
      },
    };
  },
});
