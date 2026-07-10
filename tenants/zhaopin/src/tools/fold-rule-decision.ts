/**
 * foldRuleDecision — 招聘-v1 (zhaopin) tenant tool. Runs as the LAST action of
 * ruleCheckForMatchResume (10-1), right after the related-companies / nationality
 * / reflux rule-evaluator steps. It owns the deterministic, fail-closed verdict
 * (see rule-fold-logic.ts) so an LLM outage or an ambiguous answer can never
 * silently pass a candidate INTO matching, and routes the gate via `_emit`
 * (MATCH_RULE_CHECK_PASSED / MATCH_RULE_CHECK_FAILED) which the runtime's
 * branch-emit reads. MATCH_RULE_CHECK_PASSED then triggers matchResume (10-2).
 */

import { z } from "zod";
import { defineTool } from "@agentic/agent-kit";
import { foldRuleDecision } from "./rule-fold-logic";

export const foldRuleDecisionTool = defineTool({
  name: "foldRuleDecision",
  description:
    "Deterministically fold the per-rule results accumulated by the previous " +
    "match-rule steps (related-companies freeze / nationality / reflux cooldown) " +
    "into a fail-closed verdict and route via _emit " +
    "(MATCH_RULE_CHECK_PASSED / MATCH_RULE_CHECK_FAILED). Any failing or " +
    "insufficient rule — or an unparseable evaluator output — fails closed.",
  output: z.record(z.string(), z.unknown()),
  // eslint-disable-next-line @typescript-eslint/require-await
  async handler(ctx) {
    const verdict = foldRuleDecision(ctx.lastResult);
    return {
      data: {
        _emit: verdict.emit,
        decision: verdict.decision,
        failed_rules: verdict.failedRules,
        reason: verdict.reason,
        infra_degraded: verdict.infraDegraded,
      },
    };
  },
});
