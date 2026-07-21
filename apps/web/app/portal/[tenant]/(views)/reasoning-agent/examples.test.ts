import { describe, expect, it } from "vitest";
import type { Translate } from "@/app/portal/lib/preferences-context";
import { translate } from "@/lib/i18n";
import {
  BYTEDANCE_MATCH_RESUME_EXAMPLE,
  BYTEDANCE_MATCH_RESUME_EXAMPLE_DATA,
  BYTEDANCE_MATCH_RESUME_PROMPT,
  MATCH_RESUME_EXAMPLE,
  MATCH_RESUME_EXAMPLE_DATA,
  MATCH_RESUME_PROMPT,
  getReasoningTestExamples,
} from "./examples";

const enT: Translate = (key, vars) => translate("en", key, vars);
const zhT: Translate = (key, vars) => translate("zh", key, vars);

describe("Reasoning Agent resume-match examples", () => {
  it("contains complete Tencent IEG Candidate, Resume, Job Requisition and JD evidence", () => {
    const candidate = JSON.parse(MATCH_RESUME_EXAMPLE.candidate);
    const resume = JSON.parse(MATCH_RESUME_EXAMPLE.resume);
    const job = JSON.parse(MATCH_RESUME_EXAMPLE.jobRequisition);
    const jd = JSON.parse(MATCH_RESUME_EXAMPLE.jd);

    expect(candidate).toMatchObject({
      candidate_id: "Candidate-RSN-IEG-001",
      nationality: "中国",
      work_years: 7.8,
    });
    expect(resume.education).toHaveLength(1);
    expect(resume.employment_history).toHaveLength(3);
    expect(resume.projects).toHaveLength(2);
    expect(resume.raw_text).toContain("中软国际科技服务有限公司");
    expect(resume.raw_text).toContain("腾讯IEG天美工作室");
    expect(resume.raw_text).not.toContain("……");
    expect(job).toMatchObject({
      client_name: "腾讯",
      client_department_name: "IEG",
      csi_department_name: "RAAS交付管理部",
    });
    expect(job.must_have_skills.length).toBeGreaterThanOrEqual(5);
    expect(jd).toMatchObject({ client: "腾讯", business_group: "IEG" });
    expect(jd.mandatory_requirements.length).toBeGreaterThanOrEqual(4);
  });

  it("contains a complete ByteDance target with a conflicting historical Tencent assignment", () => {
    const candidate = JSON.parse(BYTEDANCE_MATCH_RESUME_EXAMPLE.candidate);
    const resume = JSON.parse(BYTEDANCE_MATCH_RESUME_EXAMPLE.resume);
    const job = JSON.parse(BYTEDANCE_MATCH_RESUME_EXAMPLE.jobRequisition);
    const jd = JSON.parse(BYTEDANCE_MATCH_RESUME_EXAMPLE.jd);
    const inputs = JSON.parse(BYTEDANCE_MATCH_RESUME_EXAMPLE.genericInputs);

    expect(candidate).toMatchObject({
      candidate_id: "Candidate-RSN-BD-001",
      nationality: "中国",
      work_years: 8,
    });
    expect(resume.education).toHaveLength(1);
    expect(resume.employment_history).toHaveLength(4);
    expect(resume.projects).toHaveLength(2);
    expect(resume.employment_history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          company: "中软国际科技服务有限公司",
          client_name: "腾讯",
          client_department_name: "IEG",
        }),
        expect.objectContaining({
          company: "博彦科技股份有限公司",
          client_name: "字节",
          business_type: "非BPO研发外包",
        }),
      ]),
    );
    expect(job).toMatchObject({
      client_name: "字节",
      client_department_name: "抖音电商",
    });
    expect(jd).toMatchObject({ client: "字节", business_group: "抖音电商" });
    expect(inputs.application_history[0]).toMatchObject({
      job_requisition_id: job.job_requisition_id,
      result: "面试淘汰",
    });
    expect(inputs.compliance_documents[0]).toMatchObject({
      verification_status: "有效",
      conclusion: "无异常且可回流",
    });
  });

  it("keeps target scope out of prompts and generic inputs", () => {
    for (const prompt of [MATCH_RESUME_PROMPT, BYTEDANCE_MATCH_RESUME_PROMPT]) {
      expect(prompt).not.toMatch(/腾讯|字节|IEG|抖音电商/);
      expect(prompt).toContain("目标 Job Requisition");
      expect(prompt).toContain("语义 Links");
      expect(prompt).toContain("规范 Action 必须通过 GOVERNS/RELEVANT_TO");
    }
    for (const data of [
      MATCH_RESUME_EXAMPLE_DATA,
      BYTEDANCE_MATCH_RESUME_EXAMPLE_DATA,
    ]) {
      expect(data.genericInputs.rule_scope).toMatchObject({
        capability_anchors: ["ruleCheckForMatchResume", "matchResume"],
        target_scope_source: "job_requisition_and_jd",
        csi_policy: "include_universal",
        include_client_wide_rules: true,
        include_department_rules: true,
        exclude_other_clients: true,
        exclude_other_departments: true,
      });
      expect(data.genericInputs.rule_scope).not.toHaveProperty("client");
      expect(data.genericInputs.rule_scope).not.toHaveProperty(
        "client_department",
      );
      expect(data.genericInputs.rule_scope).not.toHaveProperty(
        "selection_keywords",
      );
    }
  });

  it("offers both complete examples to the UI selector", () => {
    const examples = getReasoningTestExamples(zhT);
    expect(examples.map((example) => example.id)).toEqual([
      "tencent-ieg",
      "bytedance-ecommerce",
    ]);
    expect(examples.map((example) => example.label)).toEqual([
      "腾讯 · IEG",
      "字节 · 抖音电商",
    ]);
    expect(
      getReasoningTestExamples(enT).map((example) => example.label),
    ).toEqual(["Tencent · IEG", "ByteDance · Douyin E-commerce"]);
    for (const example of examples) {
      expect(example.prompt.length).toBeGreaterThan(100);
      expect(Object.values(example.context).every(Boolean)).toBe(true);
    }
  });
});
