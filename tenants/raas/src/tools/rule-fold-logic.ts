/**
 * Pure fail-closed rule-decision fold — migrated from the old RuleCheck agent's
 * `foldDecision`. The LLM evaluates each client rule independently (status per
 * rule); this deterministic fold owns the VERDICT so an LLM outage or an
 * ambiguous answer can never silently pass a candidate.
 *
 * Fail-closed contract:
 *   - any rule explicitly failing            → FAIL
 *   - any non-flag-only rule that is
 *     insufficient_info / pending / unknown   → FAIL (fail-closed)
 *   - unparseable / missing rule results      → FAIL + infraDegraded (evaluator broke)
 *   - all rules explicitly pass (or none apply)→ PASS
 */

export interface RuleResult {
  rule_id?: string;
  status?: string;
  reason?: string;
  flag_only?: boolean;
}

export type RuleEmit = "CLIENT_RULES_PASSED" | "CLIENT_RULES_FAILED";

export interface FoldVerdict {
  decision: "pass" | "fail";
  emit: RuleEmit;
  failedRules: string[];
  reason: string;
  infraDegraded: boolean;
}

const PASS_STATUSES = new Set(["pass", "passed", "ok", "compliant", "met", "通过"]);
const FAIL_STATUSES = new Set([
  "fail", "failed", "reject", "rejected", "violation", "not_met", "不通过", "违反",
]);
const UNCERTAIN_STATUSES = new Set([
  "insufficient_info", "insufficient", "pending", "unknown", "error", "存疑",
]);

/** Pull the rule-results array out of whatever the LLM step returned, or null
 *  if it can't be found (treated as an evaluator/infra failure). */
function extractRuleResults(input: unknown): RuleResult[] | null {
  let v: unknown = input;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return null;
    }
  }
  if (Array.isArray(v)) return v as RuleResult[];
  if (v && typeof v === "object") {
    const obj = v as Record<string, unknown>;
    for (const key of ["rule_results", "ruleResults", "results", "rules"]) {
      if (Array.isArray(obj[key])) return obj[key] as RuleResult[];
    }
  }
  return null;
}

function ruleFails(r: RuleResult): boolean {
  const status = String(r.status ?? "").trim().toLowerCase();
  if (FAIL_STATUSES.has(status)) return true;
  if (!r.flag_only && UNCERTAIN_STATUSES.has(status)) return true; // fail-closed
  if (!r.flag_only && status.length > 0 && !PASS_STATUSES.has(status)) return true;
  return false;
}

export function foldRuleDecision(input: unknown): FoldVerdict {
  const rules = extractRuleResults(input);
  if (rules === null) {
    // Evaluator produced nothing parseable — fail closed, flag as infra so an
    // operator can tell a real rejection from an evaluator outage.
    return {
      decision: "fail",
      emit: "CLIENT_RULES_FAILED",
      failedRules: [],
      reason: "无法解析规则评估结果（评估器异常）——按从严判定为不通过。",
      infraDegraded: true,
    };
  }

  const failedRules = rules
    .filter(ruleFails)
    .map((r, i) => r.rule_id ?? `rule_${i}`);

  if (failedRules.length > 0) {
    return {
      decision: "fail",
      emit: "CLIENT_RULES_FAILED",
      failedRules,
      reason: `未通过 ${failedRules.length} 条客户规则：${failedRules.join(", ")}`,
      infraDegraded: false,
    };
  }
  return {
    decision: "pass",
    emit: "CLIENT_RULES_PASSED",
    failedRules: [],
    reason: rules.length === 0 ? "无适用客户规则" : "全部客户规则通过",
    infraDegraded: false,
  };
}
