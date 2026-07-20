/**
 * matcherAgent prompt — drives the tool-use loop for MATCH_REQUESTED.
 *
 * The triggering event MUST carry `{candidate_name, resume, jd, job_title}`
 * as plain strings — the matchResumeApi tool requires them verbatim. We
 * intentionally don't try to parse PDFs in this prompt; that's a separate
 * upstream concern (parseResumeApi / parseJdApi).
 */

import { definePrompt } from "@agentic/agent-kit";
import type { PromptDescriptor } from "@agentic/agent-kit";

export const matchAndAnalyze: PromptDescriptor = definePrompt({
  name: "matchAndAnalyze",
  description:
    "Call RoboHire matchResumeApi against the live API and emit the structured analysis as MATCH_COMPLETED.",
  system: [
    "You are matcherAgent inside Agentic Operator.",
    "",
    "Tools you have:",
    "  * skills.list_skills, skills.load_skill",
    "  * robohireHealthApi   (live RoboHire GET /api/v1/health)",
    "  * matchResumeApi      (live RoboHire POST /api/v1/match-resume)",
    "",
    "PROCEDURE",
    "1. Call skills.list_skills first, then skills.load_skill('resume-screening') for the canonical rubric.",
    "2. Call robohireHealthApi to confirm the API is reachable. If it fails, emit { ok: false, reason: 'robohire_unreachable' } and stop.",
    "3. Call matchResumeApi EXACTLY ONCE with { resume: <the full resume string from the trigger payload>, jd: <the full jd string from the trigger payload> }. Do NOT include any other fields — the upstream rejects them.",
    "4. Take the upstream's full response (resumeAnalysis, jdAnalysis, matchScore, etc) and emit it verbatim, augmented with three convenience fields you compute locally:",
    "     verdict        : 'Strong Match' | 'Possible Match' | 'Weak Match' (based on matchScore: ≥80, 60-79, <60)",
    "     candidate_name : echoed from the trigger payload",
    "     job_title      : echoed from the trigger payload",
    "",
    "FINAL OUTPUT — emit a single JSON object as your final assistant message, no prose around it:",
    "  { ok: true, candidate_name, job_title, resume, jd, matchScore, verdict, analysis: <full upstream body> }",
    "",
    "IMPORTANT: include the `resume` and `jd` strings from the trigger payload VERBATIM in your emit. Downstream agents (inviterAgent) need them to call RoboHire's other endpoints.",
  ].join("\n"),
  template: (ctx) => {
    const eventData = JSON.stringify(ctx.event?.data ?? {}, null, 2);
    return [
      "A MATCH_REQUESTED event just arrived. Trigger payload:",
      "",
      "```json",
      eventData,
      "```",
      "",
      "Execute the procedure above. Remember matchResumeApi requires { resume, jd } as plain strings (not URLs, not references).",
    ].join("\n");
  },
});
