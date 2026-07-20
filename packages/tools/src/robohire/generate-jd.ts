/**
 * generateJdApi — real RoboHire POST /api/v1/jobs/generate-jd adapter.
 *
 * The endpoint reports parse/generate stage truth inside `meta.stages`; HTTP
 * 200 (and even envelope success=true) is not sufficient.  This adapter turns
 * stage degradation and malformed empty output into typed failures so a
 * generated workflow cannot persist an "Untitled" placeholder as a JD.
 */

import { defineTool, type ToolContext } from "@agentic/agent-kit";
import { z } from "zod";

import { flattenJobRequisition, recruitmentSources } from "./recruitment-input";
import { rhFetch } from "./rest-helper";

const LANGUAGES = new Set(["en", "zh", "zh-TW", "ja", "es", "fr", "pt", "de"]);

type GenerateJdFailureCode =
  | "generate_jd_input_invalid"
  | "generate_jd_upstream_rejected"
  | "generate_jd_upstream_unavailable"
  | "generate_jd_stage_failed"
  | "generate_jd_output_invalid";

export class GenerateJdApiError extends Error {
  readonly terminal: boolean;

  constructor(
    readonly code: GenerateJdFailureCode,
    message: string,
    readonly status: number,
    readonly retryable: boolean,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "GenerateJdApiError";
    this.terminal = !retryable;
  }
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const text = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

function firstText(source: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = text(source[key]);
    if (value) return value;
  }
  return "";
}

function resolveInput(ctx: ToolContext): {
  prompt: string;
  language?: string;
  companyName?: string;
  department?: string;
} {
  const { explicit, backfill, merged } = recruitmentSources(ctx);
  let prompt =
    firstText(explicit, ["prompt", "requirement_brief", "job_brief"]) ||
    firstText(backfill, ["prompt", "requirement_brief", "job_brief"]);
  if (!prompt) {
    const requirement = asRecord(
      merged.job_requisition ?? merged.requirement ?? merged.job,
    );
    const specification = asRecord(merged.specification);
    prompt = flattenJobRequisition({
      ...(specification ?? {}),
      ...(requirement ?? merged),
    });
    const clarifications = Array.isArray(merged.clarifications)
      ? merged.clarifications
          .map((item) => asRecord(item))
          .map((item) => firstText(item ?? {}, ["content", "answer", "text"]))
          .filter(Boolean)
      : [];
    if (clarifications.length > 0) {
      prompt += `\n需求澄清:\n${clarifications.map((item) => `- ${item}`).join("\n")}`;
    }
    // RoboHire's public contract caps the free-text prompt at 4,000 chars.
    // Keep the deterministic projection usable for large partner records.
    prompt = prompt.slice(0, 4_000);
  }
  if (prompt.length < 4 || prompt.length > 4_000) {
    throw new GenerateJdApiError(
      "generate_jd_input_invalid",
      `generateJdApi: prompt must contain 4-4000 characters (received ${prompt.length})`,
      400,
      false,
    );
  }
  const language = firstText(merged, ["language", "locale"]);
  if (language && !LANGUAGES.has(language)) {
    throw new GenerateJdApiError(
      "generate_jd_input_invalid",
      `generateJdApi: unsupported language ${language}`,
      400,
      false,
    );
  }
  const companyName = firstText(merged, [
    "companyName",
    "company_name",
    "client_name",
    "sd_org_name",
  ]);
  const department = firstText(merged, [
    "department",
    "department_name",
    "client_department_id",
  ]);
  return {
    prompt,
    ...(language ? { language } : {}),
    ...(companyName ? { companyName } : {}),
    ...(department ? { department } : {}),
  };
}

// The emptiness check MUST mirror the fields assembleGeneratedJdContent
// consumes, or a thin-but-assemblable 200 gets discarded as "empty" (the old
// AO shipped exactly this bug: a 5-field whitelist vs an 8-field assembler).
// The title is deliberately NOT a hard gate: RoboHire's placeholder failure
// shape is `title:"Untitled"` + EMPTY content fields, so content presence
// alone separates placeholder from usable — real content under a placeholder
// title still assembles into a JD.
const ASSEMBLABLE_JD_FIELDS = [
  "description",
  "qualifications",
  "hardRequirements",
  "niceToHave",
  "interviewRequirements",
  "evaluationRules",
  "benefits",
] as const;

function meaningfulJd(data: Record<string, unknown>): boolean {
  return ASSEMBLABLE_JD_FIELDS.some((field) => text(data[field]).length > 0);
}

/** Canonical Markdown carried by JD_GENERATED and persisted for matching. */
export function assembleGeneratedJdContent(
  data: Record<string, unknown>,
): string {
  const sections: string[] = [`# ${text(data.title)}`];
  const append = (heading: string, keys: string[]) => {
    const body = firstText(data, keys);
    if (body) sections.push(`## ${heading}\n${body}`);
  };
  append("职位描述", ["description"]);
  append("任职要求", ["qualifications"]);
  append("硬性要求", ["hardRequirements", "hard_requirements"]);
  append("加分项", ["niceToHave", "nice_to_have"]);
  append("面试要求", ["interviewRequirements", "interview_requirements"]);
  append("评估标准", ["evaluationRules", "evaluation_rules"]);
  append("薪资福利", ["benefits", "salaryBenefits", "salary_benefits"]);
  return sections.join("\n\n");
}

/** Convert RoboHire's numbered/bulleted requirement prose into JSONB skills. */
export function proseToSkillArray(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return value
    .split("\n")
    .map((line) =>
      line.replace(/^\s*(?:[-*•·]|\d+\s*[.．、)）])\s*/, "").trim(),
    )
    .filter(Boolean);
}

export const generateJdApi = defineTool({
  name: "generateJdApi",
  description:
    "Call RoboHire.io POST /api/v1/jobs/generate-jd with a 4-4000 character recruitment prompt. " +
    "Accepts {prompt, language?, companyName?, department?}; it can also consume a Job_Requisition-shaped previous result. " +
    "Returns verified JD fields plus request_id/stages/raw and rejects failed vendor stages or empty placeholder output.",
  output: z.record(z.string(), z.unknown()),
  async handler(ctx) {
    const input = resolveInput(ctx);
    const response = await rhFetch<Record<string, unknown>>(
      ctx,
      "POST",
      "/jobs/generate-jd",
      input,
    );
    if (!response.ok) {
      const retryable =
        response.status === 0 ||
        response.status === 429 ||
        response.status >= 500;
      throw new GenerateJdApiError(
        retryable
          ? "generate_jd_upstream_unavailable"
          : "generate_jd_upstream_rejected",
        `${response.message} — body=${JSON.stringify(response.errorBody)}`,
        response.status,
        retryable,
      );
    }

    const envelope = asRecord(response.data) ?? {};
    if (envelope.success === false) {
      throw new GenerateJdApiError(
        "generate_jd_upstream_rejected",
        `generateJdApi: upstream rejected generation — ${firstText(envelope, ["error", "message"]) || "unknown reason"}`,
        response.status,
        false,
      );
    }
    const meta = asRecord(envelope.meta) ?? {};
    const stages = asRecord(meta.stages) ?? {};
    const failedStages = ["parse", "generate"].filter(
      (stage) => text(stages[stage]).toLowerCase() === "failed",
    );
    if (failedStages.length) {
      throw new GenerateJdApiError(
        "generate_jd_stage_failed",
        `generateJdApi: upstream stage failed (${failedStages.join(",")})`,
        502,
        true,
        {
          stages,
          request_id: envelope.requestId ?? envelope.request_id ?? null,
        },
      );
    }
    const data = asRecord(envelope.data) ?? envelope;
    if (!meaningfulJd(data)) {
      throw new GenerateJdApiError(
        "generate_jd_output_invalid",
        "generateJdApi: upstream returned no usable JD content",
        502,
        true,
        {
          stages,
          request_id: envelope.requestId ?? envelope.request_id ?? null,
        },
      );
    }

    return {
      data: {
        ...data,
        must_have_skills:
          Array.isArray(data.must_have_skills) &&
          data.must_have_skills.length > 0
            ? data.must_have_skills
            : proseToSkillArray(data.hardRequirements),
        nice_to_have_skills:
          Array.isArray(data.nice_to_have_skills) &&
          data.nice_to_have_skills.length > 0
            ? data.nice_to_have_skills
            : proseToSkillArray(data.niceToHave),
        jd_content: assembleGeneratedJdContent(data),
        request_id: envelope.requestId ?? envelope.request_id ?? null,
        stages,
        raw: envelope,
      },
      meta: {
        provider: "robohire.io",
        endpoint: "POST /api/v1/jobs/generate-jd",
        upstreamStatus: response.status,
      },
    };
  },
});
