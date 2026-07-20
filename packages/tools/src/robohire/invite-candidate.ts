/**
 * inviteCandidateApi — wraps POST /api/v1/invite-candidate on the real
 * RoboHire.io API. This endpoint SENDS the interview invitation (it is not a
 * body generator) and returns the issued login / QR URLs. Downstream code must
 * persist this receipt and must not deliver a second webhook/email.
 *
 * Per-tenant config (manifest `tool_use[].config`): see rest-helper.ts.
 */

import { defineTool } from "@agentic/agent-kit";
import { z } from "zod";

import { rhFetch } from "./rest-helper";

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export type InviteCandidateFailureCode =
  | "invite_candidate_input_invalid"
  | "invite_candidate_upstream_unavailable";

/** Stable classification consumed by runtime retry/error policies. */
export class InviteCandidateApiError extends Error {
  readonly terminal: boolean;

  constructor(
    readonly code: InviteCandidateFailureCode,
    message: string,
    readonly status: number,
    readonly retryable: boolean,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "InviteCandidateApiError";
    this.terminal = !retryable;
  }
}

/** The canonical RoboHire request. Business-system identifiers are not part
 * of this adapter contract and must be resolved before the tool is called. */
export interface RoboHireInviteCandidateRequest {
  resume?: string;
  resume_id?: string;
  jd?: string;
  job_id?: string;
  hiring_request_id?: string;
  candidate_email?: string;
  recruiter_email?: string;
  interviewer_requirement?: string;
  job_title?: string;
  company_name?: string;
  interview_language?: "en" | "zh" | "ja";
  interview_duration?: number;
  interview_mode?: string;
  passing_score?: number;
  linked_assessment_id?: string;
}

export type PreparedInvitation = {
  ok: true;
  body: RoboHireInviteCandidateRequest;
};

const STRING_FIELDS = [
  "resume",
  "resume_id",
  "jd",
  "job_id",
  "hiring_request_id",
  "candidate_email",
  "recruiter_email",
  "interviewer_requirement",
  "job_title",
  "company_name",
  "interview_language",
  "interview_mode",
  "linked_assessment_id",
] as const;

function invalidInput(
  message: string,
  details?: Record<string, unknown>,
): InviteCandidateApiError {
  return new InviteCandidateApiError(
    "invite_candidate_input_invalid",
    message,
    400,
    false,
    details,
  );
}

/** Validate and project an allow-listed vendor body. Unknown business fields
 * are deliberately not forwarded, and this function performs no I/O. */
export async function prepareInviteCandidateRequest(
  raw: Record<string, unknown>,
): Promise<PreparedInvitation> {
  const body: Record<string, unknown> = {};
  for (const key of STRING_FIELDS) {
    const value = raw[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== "string") {
      throw invalidInput(
        `inviteCandidateApi 里的 ${key} 应该是文本，请在调用 RoboHire 前把上游数据整理好。`,
        { field: key, received_type: typeof value },
      );
    }
    const normalized = value.trim();
    if (normalized) body[key] = normalized;
  }

  const language = body.interview_language;
  if (
    language !== undefined &&
    !new Set(["en", "zh", "ja"]).has(String(language))
  ) {
    throw invalidInput(
      `inviteCandidateApi 的 interview_language 只支持 en、zh 或 ja，当前是 ${String(language)}。`,
      { field: "interview_language", allowed: ["en", "zh", "ja"] },
    );
  }

  const duration = raw.interview_duration;
  if (duration !== undefined && duration !== null) {
    if (
      typeof duration !== "number" ||
      !Number.isFinite(duration) ||
      duration <= 0
    ) {
      throw invalidInput(
        "inviteCandidateApi 的 interview_duration 必须是大于 0 的分钟数。",
        { field: "interview_duration", received: duration },
      );
    }
    body.interview_duration = duration;
  }

  const passingScore = raw.passing_score;
  if (passingScore !== undefined && passingScore !== null) {
    if (
      typeof passingScore !== "number" ||
      !Number.isFinite(passingScore) ||
      passingScore < 0 ||
      passingScore > 100
    ) {
      throw invalidInput(
        "inviteCandidateApi 的 passing_score 必须是 0 到 100 之间的数字。",
        { field: "passing_score", received: passingScore },
      );
    }
    body.passing_score = passingScore;
  }

  const missing: string[] = [];
  if (!body.resume && !body.resume_id) missing.push("resume_or_resume_id");
  if (!body.jd && !body.job_id) missing.push("jd_or_job_id");
  if (missing.length > 0) {
    const needs = [
      missing.includes("resume_or_resume_id")
        ? "简历内容 resume（或 RoboHire 的 resume_id）"
        : null,
      missing.includes("jd_or_job_id")
        ? "JD 内容 jd（或 RoboHire 的 job_id）"
        : null,
    ].filter(Boolean);
    throw invalidInput(
      `inviteCandidateApi 还缺${needs.join("、")}。请先让上游步骤读取并整理好这些数据再调用；这个 RoboHire adapter 不会自己查业务数据库。`,
      { missing },
    );
  }

  return {
    ok: true,
    body: body as RoboHireInviteCandidateRequest,
  };
}

export const inviteCandidateApi = defineTool({
  name: "inviteCandidateApi",
  description:
    "Call RoboHire.io POST /api/v1/invite-candidate to SEND an interview invitation for a candidate. " +
    "Accepts only the canonical RoboHire request: one of resume/resume_id and one of jd/job_id, plus documented optional vendor fields. " +
    "It never reads or writes a business database; upstream workflow steps must resolve business records before this side-effecting call. Normalizes the receipt to " +
    "{success, login_url, qrcode_url, user_id, request_introduction_id, request_id, raw}. " +
    "Do not chain this with another email/webhook sender.",
  output: z.record(z.string(), z.unknown()),
  async handler(ctx) {
    const previous = asRecord(ctx.lastResult);
    const raw = {
      ...previous,
      ...(ctx.event?.data ?? {}),
    } as Record<string, unknown>;
    const prepared = await prepareInviteCandidateRequest(raw);
    const body = prepared.body;
    const res = await rhFetch<Record<string, unknown>>(
      ctx,
      "POST",
      "/invite-candidate",
      body,
    );
    if (!res.ok) {
      // Deterministic client/business rejection is a terminal invitation
      // outcome: keep it in-band so the workflow can persist the failure and
      // emit INTERVIEW_INVITATION_FAILED. Network errors, throttling and 5xx
      // remain exceptions so Inngest retries instead of publishing a false
      // terminal failure during a transient outage.
      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        const body =
          res.errorBody &&
          typeof res.errorBody === "object" &&
          !Array.isArray(res.errorBody)
            ? (res.errorBody as Record<string, unknown>)
            : {};
        return {
          data: {
            ...body,
            success: false,
            error_code: res.status === 402 ? "ROBOHIRE_QUOTA" : "ROBOHIRE_4XX",
            http_status: res.status,
            error_message: String(
              body.error_message ?? body.message ?? res.message,
            ),
            raw: res.errorBody,
          },
          meta: {
            provider: "robohire.io",
            endpoint: "POST /api/v1/invite-candidate",
            upstreamStatus: res.status,
            terminalBusinessFailure: true,
          },
        };
      }
      throw new InviteCandidateApiError(
        "invite_candidate_upstream_unavailable",
        `inviteCandidateApi 暂时没能确认 RoboHire 的调用结果（HTTP ${res.status || "network"}）。这是可重试的依赖故障，但上游必须保持稳定的去重键：${res.message}`,
        res.status,
        true,
        {
          error_body: res.errorBody,
          delivery_outcome: "unknown",
          requires_idempotent_retry: true,
        },
      );
    }
    const envelope =
      res.data && typeof res.data === "object" && !Array.isArray(res.data)
        ? (res.data as Record<string, unknown>)
        : {};
    const nested =
      envelope.data &&
      typeof envelope.data === "object" &&
      !Array.isArray(envelope.data)
        ? (envelope.data as Record<string, unknown>)
        : envelope;
    const explicitlyFailed =
      envelope.success === false || nested.success === false;
    const loginUrl =
      typeof nested.login_url === "string" ? nested.login_url : null;
    const reused = nested.reused === true;
    const success = !explicitlyFailed && (Boolean(loginUrl) || reused);
    const errorMessage = success
      ? null
      : String(
          nested.error_message ??
            nested.message ??
            envelope.error ??
            (explicitlyFailed
              ? "RoboHire reported invitation failure"
              : "RoboHire returned 2xx without login_url"),
        );
    return {
      data: {
        ...nested,
        // Derived `success` must win over any nested value: a nominal 2xx with
        // no issued login URL is a business failure, not a sent invitation.
        success,
        error_code: success ? null : "GOHIRE_REJECTED",
        login_url: loginUrl,
        qrcode_url:
          typeof nested.qrcode_url === "string" ? nested.qrcode_url : null,
        user_id: nested.user_id ?? null,
        request_introduction_id:
          typeof nested.request_introduction_id === "string"
            ? nested.request_introduction_id
            : null,
        request_id:
          typeof envelope.requestId === "string"
            ? envelope.requestId
            : typeof envelope.request_id === "string"
              ? envelope.request_id
              : null,
        error_message: errorMessage,
        persistence_warning:
          typeof nested.persistenceWarning === "string"
            ? nested.persistenceWarning
            : null,
        raw: envelope,
      },
      meta: {
        provider: "robohire.io",
        endpoint: "POST /api/v1/invite-candidate",
        upstreamStatus: res.status,
      },
    };
  },
});
