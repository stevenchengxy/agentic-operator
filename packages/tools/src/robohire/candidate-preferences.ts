// candidate-preferences.ts — pull a candidate's job-seeking expectations
// (求职意向 / 期望职位 / 期望城市 / 期望薪资 / 工作模式) out of a parsed resume and
// render them into the free-form `candidatePreferences` string that RoboHire's
// POST /api/v1/match-resume accepts.
//
// Why this exists (ported 1:1 from the old AO fix): the resume-download event
// carries only transport metadata and RoboHire /parse-resume returns no typed
// expectation fields, so the candidate's own expectations never reached the
// matcher — the ontology's Candidate_Expectation object (and the four
// matchResume rules gating on it) had no data to judge. Extraction happens
// once (deterministically, at the RESUME_PROCESSED assembler) into the
// structured shape below; the match input loader then formats it into
// `candidatePreferences`. When nothing is found we return {} / '' so the match
// call degrades to exactly the previous behaviour (no candidatePreferences
// sent) — zero regression by construction.

export type CandidateExpectationNested = {
  expected_salary_monthly_min: number | null;
  expected_salary_monthly_max: number | null;
  expected_cities: string[];
  expected_industries: string[];
  expected_roles: string[];
  expected_work_mode: string | null;
};

type ExtractSource =
  | string
  | { parsed?: Record<string, unknown> | null; rawText?: string | null }
  | null
  | undefined;

const EMPTY: Record<string, never> = {};

// Splits a value like "深圳、广州 / 北京" on the separators Chinese resumes use.
const LIST_SEP = /[、,，/;；|\s]+/;

const ROLE_LABELS = [
  "期望职位",
  "期望岗位",
  "意向职位",
  "意向岗位",
  "应聘职位",
  "目标职位",
  "求职意向",
];
const CITY_LABELS = [
  "期望城市",
  "期望工作地点",
  "期望地点",
  "意向城市",
  "工作城市",
  "意向工作地",
];
const INDUSTRY_LABELS = ["期望行业", "意向行业", "目标行业"];

function normalizeSource(source: ExtractSource): {
  parsed: Record<string, unknown> | null;
  rawText: string | null;
} {
  if (source == null) return { parsed: null, rawText: null };
  if (typeof source === "string") return { parsed: null, rawText: source };
  return { parsed: source.parsed ?? null, rawText: source.rawText ?? null };
}

function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) {
    return v
      .map((x) => (typeof x === "string" ? x.trim() : ""))
      .filter(Boolean);
  }
  if (typeof v === "string" && v.trim()) {
    return v
      .split(LIST_SEP)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function firstNonEmpty(candidates: string[][]): string[] {
  for (const c of candidates) if (c.length > 0) return c;
  return [];
}

/** Find "label：value" on one line and split the value into a list. */
function extractListFromText(text: string | null, labels: string[]): string[] {
  if (!text) return [];
  for (const label of labels) {
    // label, optional colon (：/:), then the rest of the line
    const re = new RegExp(`${label}\\s*[：:]?\\s*([^\\n\\r]+)`);
    const m = text.match(re);
    if (m && m[1] && m[1].trim()) {
      const list = m[1]
        .trim()
        .split(LIST_SEP)
        .map((s) => s.trim())
        .filter(Boolean);
      if (list.length > 0) return list;
    }
  }
  return [];
}

function extractWorkMode(text: string | null): string | null {
  if (!text) return null;
  if (/远程|remote/i.test(text)) return "远程";
  if (/混合办公|hybrid/i.test(text)) return "混合";
  if (/现场|驻场|坐班|on-?site/i.test(text)) return "现场";
  return null;
}

function unitMultiplier(unit: string): number {
  if (unit === "k" || unit === "K" || unit === "千") return 1000;
  if (unit === "w" || unit === "W" || unit === "万") return 10000;
  return 1;
}

function toAmount(numStr: string, unit: string): number {
  return Math.round(parseFloat(numStr) * unitMultiplier(unit));
}

function extractSalary(
  parsed: Record<string, unknown> | null,
  rawText: string | null,
): { min: number | null; max: number | null } {
  const pMin = parsed?.expected_salary_monthly_min;
  const pMax = parsed?.expected_salary_monthly_max;
  if (typeof pMin === "number" || typeof pMax === "number") {
    return {
      min: typeof pMin === "number" ? pMin : null,
      max: typeof pMax === "number" ? pMax : null,
    };
  }
  if (!rawText) return { min: null, max: null };

  // Anchor on a salary-specific keyword so we neither grab "5-10 年经验" nor let
  // a generic 期望 (期望职位…) on an earlier line shadow the real 期望薪资 line.
  const kwMatch = rawText.match(/(薪资|月薪|薪酬|年薪|待遇|期望薪)[^\n\r]{0,24}/);
  const window = kwMatch ? kwMatch[0] : "";
  if (!window) return { min: null, max: null };

  const range = window.match(
    /(\d+(?:\.\d+)?)\s*([kK千wW万]?)\s*[-~到至]\s*(\d+(?:\.\d+)?)\s*([kK千wW万]?)/,
  );
  if (range) {
    const unitA = range[2] || range[4];
    const unitB = range[4] || range[2];
    const min = toAmount(range[1]!, unitA ?? "");
    const max = toAmount(range[3]!, unitB ?? "");
    if (min >= 1000 || max >= 1000) return { min, max };
  }
  const single = window.match(/(\d+(?:\.\d+)?)\s*([kK千wW万])/);
  if (single) {
    const v = toAmount(single[1]!, single[2]!);
    if (v >= 1000) return { min: v, max: v };
  }
  return { min: null, max: null };
}

/**
 * Best-effort structured extraction of candidate expectations. Returns a full
 * CandidateExpectationNested when at least one field is found, otherwise {}.
 */
export function extractCandidateExpectation(
  source: ExtractSource,
): CandidateExpectationNested | Record<string, never> {
  const { parsed, rawText } = normalizeSource(source);

  const roles = firstNonEmpty([
    asStringArray(parsed?.expected_roles),
    asStringArray(parsed?.expected_positions),
    extractListFromText(rawText, ROLE_LABELS),
  ]);
  const cities = firstNonEmpty([
    asStringArray(parsed?.expected_cities),
    asStringArray(parsed?.expected_locations),
    extractListFromText(rawText, CITY_LABELS),
  ]);
  const industries = firstNonEmpty([
    asStringArray(parsed?.expected_industries),
    extractListFromText(rawText, INDUSTRY_LABELS),
  ]);
  const workMode =
    asString(parsed?.expected_work_mode) ?? extractWorkMode(rawText);
  const salary = extractSalary(parsed, rawText);

  const hasAny =
    roles.length > 0 ||
    cities.length > 0 ||
    industries.length > 0 ||
    workMode != null ||
    salary.min != null ||
    salary.max != null;
  if (!hasAny) return EMPTY;

  return {
    expected_salary_monthly_min: salary.min,
    expected_salary_monthly_max: salary.max,
    expected_cities: cities,
    expected_industries: industries,
    expected_roles: roles,
    expected_work_mode: workMode,
  };
}

/**
 * Render structured expectations into the free-form string RoboHire accepts.
 * Returns '' for empty/absent expectations so the caller can omit the param.
 */
export function formatCandidatePreferences(
  exp:
    | CandidateExpectationNested
    | Record<string, never>
    | null
    | undefined,
): string {
  if (!exp || typeof exp !== "object") return "";
  const e = exp as Partial<CandidateExpectationNested>;
  const lines: string[] = [];

  if (e.expected_roles && e.expected_roles.length)
    lines.push(`期望职位: ${e.expected_roles.join("、")}`);
  if (e.expected_cities && e.expected_cities.length)
    lines.push(`期望城市: ${e.expected_cities.join("、")}`);

  const min = e.expected_salary_monthly_min;
  const max = e.expected_salary_monthly_max;
  if (typeof min === "number" || typeof max === "number") {
    if (typeof min === "number" && typeof max === "number") {
      lines.push(min === max ? `期望月薪: ${min}` : `期望月薪: ${min}-${max}`);
    } else {
      lines.push(`期望月薪: ${typeof min === "number" ? min : max}`);
    }
  }

  if (e.expected_industries && e.expected_industries.length)
    lines.push(`期望行业: ${e.expected_industries.join("、")}`);
  if (e.expected_work_mode) lines.push(`工作模式: ${e.expected_work_mode}`);

  return lines.join("\n");
}
