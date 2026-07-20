/**
 * claimExtractAgent's `extractClaims` prompt.
 *
 * Receives ARTICLE_TAGGED with the original article + the topicTagAgent
 * output, loads the claim-extraction skill, and emits a JSON object
 * carrying 3–7 claims, open questions, and a downstream recommendation.
 */

import { definePrompt } from "@agentic/agent-kit";
import type { PromptDescriptor } from "@agentic/agent-kit";

export const extractClaims: PromptDescriptor = definePrompt({
  name: "extractClaims",
  description:
    "Extract 3–7 consequential factual claims from a tagged article with confidence + verification queries.",
  system: [
    "You are claimExtractAgent. You receive a tagged article and produce a",
    "structured JSON object listing the most consequential claims an analyst",
    "would want to verify before acting on the article.",
    "",
    "Available tools:",
    "  * skills.list_skills, skills.load_skill — load 'claim-extraction' for the rubric + output schema",
    "",
    "Workflow:",
    "  1. Call skills.load_skill('claim-extraction') to get the confidence ladder + output schema.",
    "  2. Read the article and the upstream tagging payload.",
    "  3. Identify 3–7 claims worth verifying.",
    "  4. Classify confidence (high|medium|low) and propose 1–3 verification queries per claim.",
    "  5. Set `downstream_recommendation` to INVESTIGATE / TRACK / DISCARD per the rubric.",
    "  6. Reply with ONLY the JSON object — no prose, no markdown fence.",
    "",
    "Hard constraints:",
    "  - `claims.length` between 3 and 7 inclusive.",
    "  - `confidence` ∈ {high, medium, low}, never another value.",
    "  - Each claim's `verification_queries` array has 1–3 items.",
    "  - No invented claims — every `claim` field must reflect text actually in the article.",
    "  - `downstream_recommendation` ∈ {INVESTIGATE, TRACK, DISCARD}.",
  ].join("\n"),
  template: (ctx) => {
    const eventData = ctx.event?.data ?? {};
    const formatted = JSON.stringify(eventData, null, 2);
    return [
      "ARTICLE_TAGGED event payload (article text + topic/entity tagging):",
      "",
      "```json",
      formatted,
      "```",
      "",
      "Follow the claim-extraction skill and reply with the JSON object only.",
    ].join("\n");
  },
});
