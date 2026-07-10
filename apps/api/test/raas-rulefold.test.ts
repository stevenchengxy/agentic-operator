import { describe, it, expect } from "vitest";
import { foldRuleDecision } from "../../../tenants/raas/src/tools/rule-fold-logic";

describe("foldRuleDecision (fail-closed)", () => {
  it("passes when all rules explicitly pass", () => {
    const v = foldRuleDecision({
      rule_results: [
        { rule_id: "R1", status: "pass" },
        { rule_id: "R2", status: "passed" },
      ],
    });
    expect(v).toMatchObject({ decision: "pass", emit: "CLIENT_RULES_PASSED", infraDegraded: false });
  });

  it("passes when no rules apply (empty array)", () => {
    expect(foldRuleDecision({ rule_results: [] })).toMatchObject({
      decision: "pass",
      emit: "CLIENT_RULES_PASSED",
    });
  });

  it("fails when any rule fails", () => {
    const v = foldRuleDecision({
      rule_results: [
        { rule_id: "R1", status: "pass" },
        { rule_id: "R2", status: "fail", reason: "竞业限制" },
      ],
    });
    expect(v.decision).toBe("fail");
    expect(v.emit).toBe("CLIENT_RULES_FAILED");
    expect(v.failedRules).toContain("R2");
  });

  it("fail-closed: insufficient_info on a non-flag rule fails", () => {
    expect(
      foldRuleDecision({ rule_results: [{ rule_id: "R3", status: "insufficient_info" }] }).decision,
    ).toBe("fail");
  });

  it("fail-closed: pending fails", () => {
    expect(foldRuleDecision({ rule_results: [{ rule_id: "R4", status: "pending" }] }).decision).toBe("fail");
  });

  it("flag_only uncertain rules do NOT fail the candidate", () => {
    const v = foldRuleDecision({
      rule_results: [
        { rule_id: "R1", status: "pass" },
        { rule_id: "R5", status: "insufficient_info", flag_only: true },
      ],
    });
    expect(v.decision).toBe("pass");
  });

  it("infra: a non-array / missing result is fail-closed + infraDegraded", () => {
    expect(foldRuleDecision(null)).toMatchObject({ decision: "fail", infraDegraded: true });
    expect(foldRuleDecision("not json")).toMatchObject({ decision: "fail", infraDegraded: true });
    expect(foldRuleDecision({ notes: "no rules here" })).toMatchObject({
      decision: "fail",
      infraDegraded: true,
    });
  });

  it("accepts a JSON-string payload", () => {
    expect(
      foldRuleDecision(JSON.stringify({ rule_results: [{ rule_id: "R1", status: "fail" }] })).decision,
    ).toBe("fail");
  });
});
