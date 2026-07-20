import { describe, expect, it } from "vitest";

import {
  extractCandidateExpectation,
  formatCandidatePreferences,
} from "./candidate-preferences";

describe("extractCandidateExpectation", () => {
  it("returns {} when nothing expectation-like is present", () => {
    expect(extractCandidateExpectation(null)).toEqual({});
    expect(extractCandidateExpectation("")).toEqual({});
    expect(
      extractCandidateExpectation("张三\n后端工程师\n技能: Go, Kubernetes"),
    ).toEqual({});
  });

  it("extracts roles/cities/industries from labelled lines with mixed separators", () => {
    const raw = [
      "求职意向：后端工程师、平台工程师",
      "期望城市: 深圳、广州 / 北京",
      "期望行业：金融科技,互联网",
    ].join("\n");
    const exp = extractCandidateExpectation(raw);
    expect(exp).toMatchObject({
      expected_roles: ["后端工程师", "平台工程师"],
      expected_cities: ["深圳", "广州", "北京"],
      expected_industries: ["金融科技", "互联网"],
    });
  });

  it("parses K-range salaries (15-20K) into monthly CNY", () => {
    const exp = extractCandidateExpectation("期望薪资：15-20K");
    expect(exp).toMatchObject({
      expected_salary_monthly_min: 15000,
      expected_salary_monthly_max: 20000,
    });
  });

  it("parses 万-range salaries (1.5万-2万)", () => {
    const exp = extractCandidateExpectation("期望月薪 1.5万-2万");
    expect(exp).toMatchObject({
      expected_salary_monthly_min: 15000,
      expected_salary_monthly_max: 20000,
    });
  });

  it("parses a single salary figure (月薪 18k)", () => {
    const exp = extractCandidateExpectation("月薪 18k");
    expect(exp).toMatchObject({
      expected_salary_monthly_min: 18000,
      expected_salary_monthly_max: 18000,
    });
  });

  it("does not mistake experience years (5-10 年经验) for a salary range", () => {
    const exp = extractCandidateExpectation("工作经验：5-10 年经验\n技能: Go");
    expect(exp).toEqual({});
  });

  it("a generic 期望职位 line must not shadow the real 期望薪资 line (regression)", () => {
    const raw = [
      "期望职位：资深后端工程师",
      "期望薪资：25-30K",
    ].join("\n");
    const exp = extractCandidateExpectation(raw);
    expect(exp).toMatchObject({
      expected_roles: ["资深后端工程师"],
      expected_salary_monthly_min: 25000,
      expected_salary_monthly_max: 30000,
    });
  });

  it("detects work mode keywords", () => {
    expect(extractCandidateExpectation("接受远程办公")).toMatchObject({
      expected_work_mode: "远程",
    });
    expect(extractCandidateExpectation("希望混合办公模式")).toMatchObject({
      expected_work_mode: "混合",
    });
  });

  it("prefers typed parsed fields over raw-text extraction", () => {
    const exp = extractCandidateExpectation({
      parsed: {
        expected_roles: ["数据工程师"],
        expected_salary_monthly_min: 20000,
        expected_salary_monthly_max: 26000,
      },
      rawText: "期望职位：前端工程师\n期望薪资：10-12K",
    });
    expect(exp).toMatchObject({
      expected_roles: ["数据工程师"],
      expected_salary_monthly_min: 20000,
      expected_salary_monthly_max: 26000,
    });
  });
});

describe("formatCandidatePreferences", () => {
  it("returns '' for empty/absent expectations", () => {
    expect(formatCandidatePreferences({})).toBe("");
    expect(formatCandidatePreferences(null)).toBe("");
    expect(formatCandidatePreferences(undefined)).toBe("");
  });

  it("renders the free-form preference lines RoboHire accepts", () => {
    const text = formatCandidatePreferences({
      expected_salary_monthly_min: 15000,
      expected_salary_monthly_max: 20000,
      expected_cities: ["深圳", "广州"],
      expected_industries: ["金融科技"],
      expected_roles: ["后端工程师"],
      expected_work_mode: "混合",
    });
    expect(text).toContain("期望职位: 后端工程师");
    expect(text).toContain("期望城市: 深圳、广州");
    expect(text).toContain("期望月薪: 15000-20000");
    expect(text).toContain("期望行业: 金融科技");
    expect(text).toContain("工作模式: 混合");
  });

  it("collapses equal min/max to a single figure", () => {
    expect(
      formatCandidatePreferences({
        expected_salary_monthly_min: 18000,
        expected_salary_monthly_max: 18000,
        expected_cities: [],
        expected_industries: [],
        expected_roles: [],
        expected_work_mode: null,
      }),
    ).toBe("期望月薪: 18000");
  });
});
