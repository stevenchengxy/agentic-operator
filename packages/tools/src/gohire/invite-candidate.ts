/**
 * gohireInviteCandidateApi — POST {base}/invite-candidate on the GoHire ATS
 * API. Canonical implementation for the recruitment invitation call; the
 * legacy `inviteCandidateApi` / `gohire.inviteCandidate` names alias here.
 *
 * This endpoint SENDS the interview invitation (it is not a body generator)
 * and returns the issued login / QR URLs. Downstream code must persist this
 * receipt and must not deliver a second webhook/email.
 *
 * Contract (shared with the RoboHire wrapper — one request validator in
 * ../robohire/invite-candidate):
 *   - Accepts only the canonical vendor request (allow-listed fields; one of
 *     resume/resume_id and one of jd/job_id). It never reads or writes a
 *     business database — upstream workflow steps resolve business records.
 *   - Deterministic 4xx (except 429) is a TERMINAL business outcome returned
 *     in-band as {success:false, error_code, ...} so the workflow can persist
 *     the failure; network errors / 429 / 5xx throw a typed retryable error
 *     so the runtime retries under a stable dedup key.
 *   - A nominal 2xx without login_url (unless reused=true) is success:false —
 *     never report a sent invitation without an issued receipt.
 *
 * Credential / base-URL resolution: see rest-helper.ts.
 */

import { defineTool } from "@agentic/agent-kit";
import { z } from "zod";

import {
  InviteCandidateApiError,
  prepareInviteCandidateRequest,
} from "../robohire/invite-candidate";
import { ghFetch } from "./rest-helper";

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export const gohireInviteCandidateApi = defineTool({
  name: "gohireInviteCandidateApi",
  description:
    "Call GoHire POST /invite-candidate to SEND an interview invitation for a candidate. " +
    "Accepts only the canonical request: one of resume/resume_id and one of jd/job_id, plus documented optional vendor fields. " +
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
    const res = await ghFetch<Record<string, unknown>>(
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
        const errorBody =
          res.errorBody &&
          typeof res.errorBody === "object" &&
          !Array.isArray(res.errorBody)
            ? (res.errorBody as Record<string, unknown>)
            : {};
        return {
          data: {
            ...errorBody,
            success: false,
            error_code: res.status === 402 ? "GOHIRE_QUOTA" : "GOHIRE_4XX",
            http_status: res.status,
            error_message: String(
              errorBody.error_message ?? errorBody.message ?? res.message,
            ),
            raw: res.errorBody,
          },
          meta: {
            provider: "gohire",
            endpoint: "POST /invite-candidate",
            upstreamStatus: res.status,
            terminalBusinessFailure: true,
          },
        };
      }
      throw new InviteCandidateApiError(
        "invite_candidate_upstream_unavailable",
        `gohireInviteCandidateApi 暂时没能确认 GoHire 的调用结果（HTTP ${res.status || "network"}）。这是可重试的依赖故障，但上游必须保持稳定的去重键：${res.message}`,
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
              ? "GoHire reported invitation failure"
              : "GoHire returned 2xx without login_url"),
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
        provider: "gohire",
        endpoint: "POST /invite-candidate",
        upstreamStatus: res.status,
      },
    };
  },
});
