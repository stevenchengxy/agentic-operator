import type { ToolContext } from "@agentic/agent-kit";

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const text = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "";
  }
}

function firstText(source: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = text(source[key]);
    if (value) return value;
  }
  return "";
}

/** Event fields are explicit partner input and therefore override backfill. */
export function recruitmentSources(ctx: ToolContext): {
  explicit: Record<string, unknown>;
  backfill: Record<string, unknown>;
  merged: Record<string, unknown>;
} {
  const explicit = ctx.event?.data ?? {};
  const backfill = asRecord(ctx.lastResult) ?? {};
  return { explicit, backfill, merged: { ...backfill, ...explicit } };
}

function resumeObjectText(value: unknown): string {
  const record = asRecord(value);
  if (!record) return "";
  const parsed = asRecord(record.data) ?? record;
  return (
    firstText(parsed, ["parsed_content", "rawText", "raw_text", "resume_text"]) ||
    stringify(parsed)
  );
}

export function resumeTextForRecruitment(ctx: ToolContext): string {
  const { explicit, backfill } = recruitmentSources(ctx);
  const explicitText = firstText(explicit, [
    "resume",
    "resume_text",
    "parsed_content",
    "candidate_resume",
    "resume_body",
  ]);
  if (explicitText) return explicitText;
  const explicitObject = resumeObjectText(
    explicit.resume ?? explicit.parsed_resume ?? explicit.parsed,
  );
  if (explicitObject) return explicitObject;

  const backfillText = firstText(backfill, [
    "resume",
    "resume_text",
    "parsed_content",
    "candidate_resume",
    "resume_body",
  ]);
  if (backfillText) return backfillText;
  return resumeObjectText(
    backfill.resume ?? backfill.parsed_resume ?? backfill.parsed,
  );
}

/** Stable plain-text projection of a RAAS JobRequisition object. */
export function flattenJobRequisition(value: unknown): string {
  const job = asRecord(value);
  if (!job) return "";
  const lines: string[] = [];
  const add = (label: string, keys: string[]) => {
    const value = firstText(job, keys);
    if (value) lines.push(`${label}: ${value}`);
  };
  add("职位", ["client_job_title", "posting_title", "title"]);
  add("岗位类型", ["client_job_type", "job_type", "recruitment_type"]);
  add("期望级别", ["expected_level"]);
  add("工作城市", ["city", "work_city"]);
  add("薪资范围", ["salary_range"]);
  add("学历要求", ["degree_requirement"]);
  add("专业要求", ["education_requirement"]);
  add("语言要求", ["language_requirements"]);
  const years = job.work_years;
  if (typeof years === "number" || (typeof years === "string" && years.trim())) {
    lines.push(`工作年限: ${String(years)} 年`);
  }
  for (const [label, key] of [
    ["必备技能", "must_have_skills"],
    ["加分技能", "nice_to_have_skills"],
  ] as const) {
    const values = job[key];
    if (Array.isArray(values) && values.length > 0) {
      lines.push(`${label}: ${values.map(String).join("、")}`);
    }
  }
  add("排除条件", ["negative_requirement"]);
  add("岗位职责", ["job_responsibility", "responsibilities"]);
  add("任职要求", ["job_requirement", "hard_requirements", "requirement"]);
  return lines.join("\n");
}

export function jobTextForRecruitment(ctx: ToolContext): string {
  const { explicit, backfill } = recruitmentSources(ctx);
  const explicitText = firstText(explicit, [
    "jd",
    "jd_text",
    "job_description",
    "jobDescription",
    "jd_body",
    "jd_content",
  ]);
  if (explicitText) return explicitText;
  const explicitObject = flattenJobRequisition(
    explicit.job_requisition ?? explicit.job ?? explicit.requirement,
  );
  if (explicitObject) return explicitObject;

  const backfillText = firstText(backfill, [
    "jd",
    "jd_text",
    "job_description",
    "jobDescription",
    "jd_body",
    "jd_content",
  ]);
  if (backfillText) return backfillText;
  return flattenJobRequisition(
    backfill.job_requisition ?? backfill.job ?? backfill.requirement,
  );
}

