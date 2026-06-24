/**
 * foldRuleDecision — RAAS tenant tool. Runs as the LAST action of
 * ruleCheckerForClientResume, right after the LLM rule-evaluator step. It owns
 * the deterministic, fail-closed verdict (see rule-fold-logic.ts) so an LLM
 * outage or an ambiguous answer can never silently pass a candidate, and routes
 * the agent via `_emit` (CLIENT_RULES_PASSED / CLIENT_RULES_FAILED) which the
 * runtime's branch-emit reads.
 */

import { z } from "zod";
import { defineTool } from "@agentic/agent-kit";
import { foldRuleDecision } from "./rule-fold-logic";

export const foldRuleDecisionTool = defineTool({
  name: "foldRuleDecision",
  description:
    "Deterministically fold the per-rule LLM results (from the previous step) " +
    "into a fail-closed client-rules verdict and route via _emit " +
    "(CLIENT_RULES_PASSED / CLIENT_RULES_FAILED). Any failing or insufficient " +
    "rule — or an unparseable evaluator output — fails closed.",
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
