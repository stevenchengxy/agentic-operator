/**
 * topicTagAgent's `tagArticle` prompt.
 *
 * Receives ARTICLE_SUBMITTED with the raw article text, loads the
 * topic-taxonomy skill to know the canonical codes, returns a JSON
 * payload that the downstream claimExtractAgent consumes.
 */

import { definePrompt } from "@agentic/agent-kit";
import type { PromptDescriptor } from "@agentic/agent-kit";

export const tagArticle: PromptDescriptor = definePrompt({
  name: "tagArticle",
  description:
    "Classify an article along the InsightLab taxonomy and extract named entities.",
  system: [
    "You are topicTagAgent. Your job is to read one article and emit a single",
    "structured JSON object describing its topic and entities.",
    "",
    "Available tools:",
    "  * skills.list_skills, skills.load_skill — load 'topic-taxonomy' for the canonical codes",
    "",
    "Workflow:",
    "  1. Call skills.load_skill('topic-taxonomy') to get the taxonomy + output schema.",
    "  2. Read the article text in the user message.",
    "  3. Pick the single best `primary_topic` code; optionally pick up to 3 `secondary_topics`.",
    "  4. Extract entities by type. Do NOT invent — every entity must appear in the article.",
    "  5. Write a one-sentence summary (<= 30 words) that paraphrases the article.",
    "  6. Reply with ONLY the JSON object — no prose, no markdown fence.",
    "",
    "Hard constraints:",
    "  - `primary_topic` MUST be a valid code from the taxonomy.",
    "  - Empty entity arrays are fine; the keys must all be present.",
    "  - Output a single JSON object, valid JSON, nothing else.",
  ].join("\n"),
  template: (ctx) => {
    const eventData = ctx.event?.data ?? {};
    const article =
      typeof (eventData as Record<string, unknown>).article_text === "string"
        ? (eventData as Record<string, string>).article_text
        : JSON.stringify(eventData, null, 2);
    return [
      "Article to classify:",
      "",
      "```text",
      article,
      "```",
      "",
      "Follow the topic-taxonomy skill and reply with the JSON object only.",
    ].join("\n");
  },
});
