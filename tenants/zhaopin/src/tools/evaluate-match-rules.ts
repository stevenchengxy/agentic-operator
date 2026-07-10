/**
 * evaluateMatchRules — 招聘-v1 (zhaopin) deterministic match-rule evaluator.
 *
 * Sits between `ontology.fetchActionRules` (which pulls the LIVE executor=Agent
 * rules for `ruleCheckForMatchResume` from Allmeta domain RAAS-v1) and
 * `foldRuleDecision` in agent 10-1. It reads the fetched rule set from
 * `ctx.lastResult` and stamps a pass/fail STATUS on each rule DETERMINISTICALLY
 * from the candidate signals in `ctx.event.data` — no LLM sits on the verdict
 * path, so the gate is reproducible whether the gateway is `mock` or a real
 * provider. Without this step the raw fetch output (rules with no `status`) would
 * fold to PASS for everyone — a fail-OPEN hazard, incl. when Allmeta is down.
 *
 * Fail-closed contract:
 *   - `ctx.lastResult` is not a successful Allmeta fetch (source !== "allmeta")
 *     → emit a single `status:"error"` rule so foldRuleDecision fails closed
 *     (never fail-open on an outage / misconfig).
 *   - any restricted-employer token (related-companies / reflux rules) or a
 *     disallowed nationality (nationality rule) present → that rule `status:"fail"`.
 *   - clean candidate + real rules → all `status:"pass"` → MATCH_RULE_CHECK_PASSED.
 *
 * The rule-id → domain classification below is derived from the live RAAS-v1
 * rule ids (curl /api/v1/ontology/actions/ruleCheckForMatchResume/rules).
 */

import { z } from "zod";
import { defineTool } from "@agentic/agent-kit";

// Restricted-employer tokens the 互不挖角红线 (related-companies) + 回流冷冻期
// (reflux) rules freeze on. Matched case-insensitively against the candidate's
// résumé / work-history text.
const RESTRICTED_EMPLOYER_TOKENS = [
  // Each restricted employer listed in BOTH CJK and Latin romanization so an
  // English-language résumé can't defeat the red line by encoding.
  "华为", "huawei", "海思", "hisilicon",
  "荣耀", "honor",
  "oppo", "vivo", "realme", "iqoo", "一加", "oneplus",
  "小米", "xiaomi", "红米", "redmi",
  "腾讯", "tencent",
  "字节", "bytedance", "字节跳动", "抖音", "tiktok", "douyin",
];

// Rule-id → domain classification (live RAAS-v1 rule ids).
const RELATED_COMPANY_RULES = new Set(["10-25", "10-26", "10-32"]);
const NATIONALITY_RULES = new Set(["10-35"]);
const REFLUX_RULES = new Set(["10-49", "10-43", "10-56", "10-51", "10-45", "10-42", "10-34"]);

// Nationalities allowed without a special channel. A non-CN nationality trips the
// 腾讯外籍候选人实名与通道限制规范 rule unless a permitted channel is present.
const CN_NATIONALITY = new Set(["中国", "china", "cn", "prc", "中华人民共和国"]);

interface FetchedRule {
  id?: string;
  rule_id?: string;
  businessLogicRuleName?: string;
  standardizedLogicRule?: string;
  [k: string]: unknown;
}

const ruleId = (r: FetchedRule): string => String(r.id ?? r.rule_id ?? "");

export const evaluateMatchRules = defineTool({
  name: "evaluateMatchRules",
  description:
    "Deterministically evaluate the LIVE match-check rules fetched by " +
    "ontology.fetchActionRules (related-companies freeze / nationality / reflux " +
    "cooldown) against the candidate signals in the event, stamping a pass/fail " +
    "status per rule for foldRuleDecision. Fail-closed on any restricted signal " +
    "or an Allmeta fetch failure — never fail-open.",
  output: z.record(z.string(), z.unknown()),
  // eslint-disable-next-line @typescript-eslint/require-await
  async handler(ctx) {
    const fetched = (ctx.lastResult ?? {}) as { rules?: FetchedRule[]; source?: string };

    // Fail-closed on infra: the previous step must be a SUCCESSFUL Allmeta fetch
    // that returned a non-empty rule set. `source !== "allmeta"` catches an
    // outage/misconfig (fetchActionRules stamps source:"error:…"/"unconfigured");
    // an EMPTY rule set with source:"allmeta" (a 200 lacking `rules`, or the
    // action's rules deleted) is ALSO treated as degraded — this gate is known to
    // carry rules, so 0 rules must never silently pass a violator.
    if (
      !fetched ||
      fetched.source !== "allmeta" ||
      !Array.isArray(fetched.rules) ||
      fetched.rules.length === 0
    ) {
      return {
        data: {
          rule_results: [
            {
              rule_id: "rule_fetch",
              status: "error",
              reason: `规则拉取失败/为空或未配置 Allmeta（source=${String(fetched?.source ?? "none")}, count=${Array.isArray(fetched?.rules) ? fetched.rules.length : 0}）——从严判定不通过。`,
              flag_only: false,
            },
          ],
          evaluated: 0,
          source: fetched?.source ?? "unconfigured",
          infra_degraded: true,
        },
      };
    }

    // Candidate signals: every string field the upstream carried, plus a
    // whole-payload fallback so a token anywhere in the résumé is still caught.
    const data = (ctx.event?.data ?? {}) as Record<string, unknown>;
    const signalText = [
      data.resume, data.resume_text, data.work_experience,
      data.employer_history, data.companies, data.summary,
      JSON.stringify(data),
    ]
      .filter((v): v is string => typeof v === "string")
      .join(" ")
      .toLowerCase();

    const nationality = String(data.nationality ?? data.country ?? "").trim().toLowerCase();
    // A permitted channel must be an OPERATOR/server-set boolean flag — NEVER a
    // candidate-supplied string. Trusting any non-empty `work_permit` value would
    // let a foreign candidate self-clear the nationality red line with junk.
    const hasPermittedChannel =
      data.channel_verified === true || data.nationality_channel === true;

    const hitEmployer = RESTRICTED_EMPLOYER_TOKENS.find((t) => signalText.includes(t.toLowerCase()));
    const nationalityBlocked =
      nationality.length > 0 && !CN_NATIONALITY.has(nationality) && !hasPermittedChannel;

    const rule_results = fetched.rules.map((r) => {
      const id = ruleId(r);
      const name = String(r.businessLogicRuleName ?? r.standardizedLogicRule ?? id);
      let status = "pass";
      let reason = `未命中限制：${name}`;

      if ((RELATED_COMPANY_RULES.has(id) || REFLUX_RULES.has(id)) && hitEmployer) {
        status = "fail";
        reason = `命中受限雇主「${hitEmployer}」→ ${name}`;
      } else if (NATIONALITY_RULES.has(id) && nationalityBlocked) {
        status = "fail";
        reason = `国籍「${nationality}」无合规通道 → ${name}`;
      }
      return { rule_id: id || name, status, reason, flag_only: false };
    });

    return {
      data: {
        rule_results,
        evaluated: rule_results.length,
        source: fetched.source,
        infra_degraded: false,
        failed: rule_results.filter((r) => r.status === "fail").map((r) => r.rule_id),
      },
    };
  },
});
