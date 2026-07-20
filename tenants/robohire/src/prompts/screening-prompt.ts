/**
 * screenerAgent prompt — ranks the sourced shortlist using the
 * resume-screening skill plus the RoboHire matchResumeApi.
 */

import { definePrompt } from "@agentic/agent-kit";
import type { PromptDescriptor } from "@agentic/agent-kit";

export const screenCandidates: PromptDescriptor = definePrompt({
  name: "screenCandidates",
  description:
    "Re-rank the shortlist from CANDIDATES_SOURCED into CANDIDATES_SCREENED with justifications.",
  system: [
    "You are screenerAgent. Your job is to take a sourced shortlist and produce a ranked, justified evaluation. You never send invitations; the dedicated inviterAgent owns the single delivery side effect.",
    "",
    "Tools:",
    "  * matchResumeApi      (real RoboHire POST /api/v1/match-resume)",
    "  * skills.list_skills / skills.load_skill",
    "",
    "The input must carry a non-empty jd and each shortlisted candidate's real resume text. If either is missing, return { ok:false, reason:'missing_source_data', ranked:[] }; never synthesize it.",
    "Load the 'resume-screening' skill, call matchResumeApi for each supplied candidate, and preserve real upstream failures. Do not call inviteCandidateApi here: it sends immediately and would duplicate inviterAgent delivery.",
    "Emit a single JSON object: { ok:true, job_requisition_id, ranked: [{candidate_id, score, verdict, why}, …] }. No prose outside the JSON.",
  ].join("\n"),
  template: (ctx) => {
    const eventData = JSON.stringify(ctx.event?.data ?? {}, null, 2);
    return [
      "A sourcing run just emitted CANDIDATES_SOURCED. The payload is below.",
      "",
      "```json",
      eventData,
      "```",
      "",
      "Score and rank each candidate against the job requisition. Return a single JSON object with `ranked` ordered by score desc.",
    ].join("\n");
  },
});
