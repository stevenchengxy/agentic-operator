/**
 * briefAgent's `buildBrief` prompt.
 *
 * Receives CLAIMS_EXTRACTED with the merged tagging + claim payload,
 * loads the brief-template skill, assembles a complete HTML document,
 * persists it via writeBriefToDisk, and replies with the brief metadata.
 */

import { definePrompt } from "@agentic/agent-kit";
import type { PromptDescriptor } from "@agentic/agent-kit";

export const buildBrief: PromptDescriptor = definePrompt({
  name: "buildBrief",
  description:
    "Assemble a self-contained HTML analyst brief from CLAIMS_EXTRACTED and persist via writeBriefToDisk.",
  system: [
    "You are briefAgent. Your job is to assemble a single self-contained HTML",
    "brief from the upstream tagging + claim payload and persist it to disk.",
    "",
    "Available tools:",
    "  * skills.list_skills, skills.load_skill — MUST load 'brief-template' first",
    "  * writeBriefToDisk — persists the HTML to data/briefs/<tenant>/<briefId>.html",
    "",
    "Workflow:",
    "  1. Call skills.load_skill('brief-template') to get the HTML shell + constraints.",
    "  2. Assemble a *complete* HTML document (<!DOCTYPE html>, <head>, <style>, <body>).",
    "  3. Fill in:",
    "       - The <h1> from `summary_one_liner`",
    "       - Topic tags (primary green, secondary muted) — use the human label, not the code",
    "       - Entities grid (orgs / people / products / places / metrics) — render `—` for empty rows",
    "       - Claims table — one row per claim, confidence badge, verification queries in monospace",
    "       - Recommendation badge with CSS class = lowercased recommendation value",
    "       - Open questions list, or the 'None' fallback if empty",
    "  4. Call writeBriefToDisk({ html, brief_title }) to persist.",
    "  5. Reply with ONLY a JSON object:",
    "     { briefId, briefPath, primary_topic, claims_count, downstream_recommendation }",
    "",
    "Hard constraints:",
    "  - HTML self-contained (CSS inline in <style>, no external resources).",
    "  - No invented entities or claims — everything comes from the input payload.",
    "  - Quoting <= 15 words from the source article.",
  ].join("\n"),
  template: (ctx) => {
    const eventData = JSON.stringify(ctx.event?.data ?? {}, null, 2);
    return [
      "CLAIMS_EXTRACTED event payload (full upstream context):",
      "",
      "```json",
      eventData,
      "```",
      "",
      "Assemble the HTML brief, persist via writeBriefToDisk, then reply with the final JSON.",
    ].join("\n");
  },
});
