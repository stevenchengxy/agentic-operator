/**
 * routeResumeProcessed — 招聘-v1 (zhaopin) deterministic FINAL step of
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
import { loadJd } from "./jd-store";

const s = (v: unknown): string => (typeof v === "string" ? v : "");

export const routeResumeProcessed = defineTool({
  name: "routeResumeProcessed",
  description:
    "Deterministic final step of processResume: assemble the RESUME_PROCESSED " +
    "payload (candidate_id / resume / resume_id / job_requisition_id / jd) so " +
    "downstream agents receive it via carry-forward, and route _emit by " +
    "lock_conflict (RESUME_LOCKED_CONFLICT vs RESUME_PROCESSED). No LLM.",
  output: z.record(z.string(), z.unknown()),
  // eslint-disable-next-line @typescript-eslint/require-await
  async handler(ctx) {
    const d = (ctx.lastResult && typeof ctx.lastResult === "object" ? ctx.lastResult : {}) as Record<string, unknown>;
    const data = (ctx.event?.data ?? {}) as Record<string, unknown>;
    const jr = s(d.job_requisition_id) || s(data.job_requisition_id);
    const jd = s(data.jd) || loadJd(ctx, jr);
    const lockConflict = d.lock_conflict === true;
    const candidateId = s(d.candidate_id) || s(data.candidate_id);
    return {
      data: {
        _emit: lockConflict ? "RESUME_LOCKED_CONFLICT" : "RESUME_PROCESSED",
        candidate_id: candidateId,
        resume: s(d.resume) || s(data.resume) || s(data.resume_text),
        resume_id: s(d.resume_id) || s(data.resume_id) || (candidateId ? `res-${candidateId}` : ""),
        job_requisition_id: jr,
        jd,
        lock_conflict: lockConflict,
        needs_review: d.needs_review === true,
      },
    };
  },
});
