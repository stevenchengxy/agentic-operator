import { describe, it, expect } from "vitest";
import { verifyReportGrounding, allowedCounts, correctionInstruction, residualWarningHtml, visibleText, looksDegenerate } from "./report-verify";
import type { DomainOntology } from "./ontology-types";

const ont = {
  domainId: "rec",
  actions: [
    { id: "a1", name: "processResume", actor: ["Agent"], trigger: ["RESUME_DOWNLOADED"], triggered_event: ["RESUME_PROCESSED", "RESUME_LOCKED_CONFLICT"], target_objects: [], tool_use: ["parseResumeApi"], system_prompt: "", user_prompt: "" },
    { id: "a2", name: "matchResume", actor: ["Agent"], trigger: ["RESUME_PROCESSED"], triggered_event: ["MATCH_PASSED"], target_objects: [], tool_use: [], system_prompt: "", user_prompt: "" },
    { id: "a3", name: "jdReview", actor: ["Human"], trigger: ["JD_GENERATED"], triggered_event: ["JD_APPROVED"], target_objects: [], tool_use: [], system_prompt: "", user_prompt: "" },
  ],
  events: [{ name: "RESUME_DOWNLOADED" }, { name: "RESUME_PROCESSED" }, { name: "MATCH_PASSED" }],
  rules: new Array(262).fill(0).map((_, i) => ({ id: `r${i}` })),
  objects: new Array(44).fill(0).map((_, i) => ({ id: `o${i}`, name: `对象${i}` })),
  workflow: [],
  source: "snapshot",
} as unknown as DomainOntology;

describe("looksDegenerate (#DEGEN 退化正文检测)", () => {
  it("mock 回声被识破（实锤事故：主网关 mock 时的报告正文）", () => {
    const r = looksDegenerate("Mock response from mock-model-v1: received # 报告主题\nAgents Generation · Ontology 领域分析报告…");
    expect(r.degenerate).toBe(true);
    expect(r.reason).toContain("mock");
  });
  it("过短正文不构成报告", () => {
    expect(looksDegenerate("<article><p>好的。</p></article>").degenerate).toBe(true);
  });
  it("正常长报告通过", () => {
    const body = `<article><h1>领域分析</h1>${"<p>本域围绕招聘流程建模，事件链路完整，规则密度高，关键闸口清晰，数据对象层次分明，风险集中在断链与信息缺失场景。</p>".repeat(12)}</article>`;
    expect(looksDegenerate(body).degenerate).toBe(false);
  });
});

describe("verifyReportGrounding (#REPORT-VERIFY)", () => {
  it("passes a grounded report (real names + real counts, incl. legit alternate口径)", () => {
    const html = `<html><body>
      <h1>分析</h1><p>共 3 个动作（其中 2 个 Agent 动作、1 个 Human），262 条规则，44 个数据对象。</p>
      <p>链路：RESUME_DOWNLOADED → processResume → RESUME_PROCESSED → matchResume。</p>
    </body></html>`;
    const r = verifyReportGrounding(html, ont);
    expect(r.violations).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("catches a fabricated event reference (正文引用了不存在的名字)", () => {
    const html = `<body><p>随后触发 CANDIDATE_ARCHIVED_FINAL 事件进入归档。</p></body>`;
    const r = verifyReportGrounding(html, ont);
    expect(r.ok).toBe(false);
    expect(r.violations).toContainEqual(expect.objectContaining({ kind: "unknown_reference", token: "CANDIDATE_ARCHIVED_FINAL" }));
  });

  it("a token present only in the DIGEST (model 合法转述) passes", () => {
    const html = `<body><p>字段 CLIENT_SPECIAL_FLAG 来自客户定制。</p></body>`;
    const bad = verifyReportGrounding(html, ont);
    expect(bad.ok).toBe(false); // 没有 digest 佐证 → 违规
    const good = verifyReportGrounding(html, ont, { extraField: "CLIENT_SPECIAL_FLAG" });
    expect(good.ok).toBe(true); // digest 里有 → 合法转述
  });

  it("catches count mismatches but allows every legit口径", () => {
    const bad = verifyReportGrounding(`<body>本域共有 300 条规则与 5 个动作。</body>`, ont);
    expect(bad.violations.map((v) => v.kind)).toEqual(["count_mismatch", "count_mismatch"]);
    const counts = allowedCounts(ont);
    expect(counts.动作.has(3)).toBe(true); // 全量
    expect(counts.动作.has(2)).toBe(true); // Agent 动作
    expect(counts.动作.has(1)).toBe(true); // Human 动作
    expect(counts.事件.has(3)).toBe(true); // events 表
    expect(counts.事件.has(6)).toBe(true); // 事件图去重口径（trigger∪emit 共 6 个不同事件名）
  });

  it("legit per-stage cluster / per-action sub-counts (from digest.analysis) are NOT false-flagged", () => {
    // The report is EXPECTED to cite per-stage rule-cluster sizes etc.; those are real computed data,
    // not the grand total. With the analysis digest, allowedCounts must accept them — a hallucinated
    // number that matches nothing still gets flagged.
    const digest = {
      analysis: {
        ruleAnalysis: {
          total: 262,
          clusters: [{ stage: "简历匹配", count: 174, mandatory: 120 }, { stage: "去重", count: 28 }],
          levelDistribution: [{ level: "mandatory", count: 200 }],
          perAction: [{ action: "matchResume", linkedRules: 31 }],
          unmodeledStages: [{ stage: "JD创建", rules: 12 }],
        },
        gaps: { agentActionsWithoutTools: ["matchResume", "jdReview"] }, // length 2
      },
    };
    const counts = allowedCounts(ont, digest);
    expect(counts.规则.has(174)).toBe(true); // cluster size
    expect(counts.规则.has(28)).toBe(true);
    expect(counts.规则.has(120)).toBe(true); // mandatory-in-cluster
    expect(counts.规则.has(31)).toBe(true); // per-action linkage
    expect(counts.规则.has(12)).toBe(true); // unmodeled-stage rules
    expect(counts.动作.has(2)).toBe(true); // agentActionsWithoutTools length (also = Agent 动作数)
    expect(counts.规则.has(999)).toBe(false); // still catches a hallucinated number

    const ok = verifyReportGrounding(`<body><p>简历匹配阶段规则最密，共 174 条规则；matchResume 关联 31 条规则。</p></body>`, ont, digest);
    expect(ok.violations.filter((v) => v.kind === "count_mismatch")).toEqual([]);
    const bad = verifyReportGrounding(`<body><p>本域共 999 条规则。</p></body>`, ont, digest);
    expect(bad.violations.map((v) => v.kind)).toContain("count_mismatch");
  });

  it("style/script 里的 token 不算正文（visibleText 剥离）", () => {
    const html = `<style>.X_FAKE_TOKEN{color:red}</style><body><p>正常内容。</p></body>`;
    expect(visibleText(html)).not.toContain("X_FAKE_TOKEN");
    expect(verifyReportGrounding(html, ont).ok).toBe(true);
  });

  it("correction instruction + residual warning carry actionable detail", () => {
    const r = verifyReportGrounding(`<body>共 300 条规则，触发 FAKE_EVENT_NAME。</body>`, ont);
    const inst = correctionInstruction(r.violations);
    expect(inst).toContain("FAKE_EVENT_NAME");
    expect(inst).toContain("262");
    const warn = residualWarningHtml(r.violations);
    expect(warn).toContain("审校警示");
    expect(warn).toContain("请勿采信");
  });
});
