/**
 * inviterAgent prompt — for MATCH_COMPLETED. Calls the side-effecting
 * inviteCandidateApi exactly once when the match is strong; emits a `skipped`
 * or failed receipt envelope otherwise.
 */

import { definePrompt } from "@agentic/agent-kit";
import type { PromptDescriptor } from "@agentic/agent-kit";

export const generateInvite: PromptDescriptor = definePrompt({
  name: "generateInvite",
  description:
    "Send one real interview invitation via RoboHire inviteCandidateApi when match score ≥ 80 and preserve its receipt.",
  system: [
    "You are inviterAgent. The matcherAgent just emitted MATCH_COMPLETED — read the payload, decide whether to send one real interview invitation, and emit the legacy INVITE_GENERATED event carrying the actual delivery receipt.",
    "",
    "Tool you have:",
    "  * inviteCandidateApi  (live, side-effecting RoboHire POST /api/v1/invite-candidate; it SENDS, it does not draft)",
    "",
    "DECISION RULE",
    "  - If matchScore (or the verdict) is ≥ 80 / Strong Match: call inviteCandidateApi ONCE with EXACTLY these flat fields:",
    "      resume          : the full resume string from the MATCH_COMPLETED payload (REQUIRED by upstream)",
    "      jd              : the full jd string from the MATCH_COMPLETED payload (REQUIRED by upstream)",
    "      candidate_name  : echoed",
    "      job_title       : echoed",
    "      company_name    : 'Agentic Operator' (default)",
    "    The upstream will return a real invitation receipt with success, login_url, qrcode_url and request ids — keep all of it. Set invited=true ONLY when success is exactly true. A missing/false success is a failed invitation, never a draft or success.",
    "  - Otherwise (matchScore < 80): do NOT call the tool. Skip straight to the final JSON.",
    "",
    "FINAL OUTPUT — single JSON object only:",
    "  {",
    "    candidate_name, job_title, matchScore, verdict,",
    "    invited: boolean,",
    "    invite_receipt?: <the upstream response from inviteCandidateApi when called>,",
    "    reason?: <why skipped or why the real send failed, when invited=false>",
    "  }",
  ].join("\n"),
  template: (ctx) => {
    const eventData = JSON.stringify(ctx.event?.data ?? {}, null, 2);
    return [
      "MATCH_COMPLETED payload:",
      "",
      "```json",
      eventData,
      "```",
      "",
      "Decide + emit per the rule above.",
    ].join("\n");
  },
});
