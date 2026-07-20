import type { ToolContext } from "@agentic/agent-kit";
import { afterEach, describe, expect, it, vi } from "vitest";

import { getGlobalToolCatalogEntry } from "../registry";
import {
  InviteCandidateApiError,
  inviteCandidateApi,
  prepareInviteCandidateRequest,
} from "./invite-candidate";

function context(
  data: Record<string, unknown>,
  lastResult?: unknown,
): ToolContext {
  return {
    tenantSlug: "adapter-test",
    agentName: "invite",
    actionName: "inviteCandidateApi",
    correlationId: "corr-invite-1",
    event: { name: "tool:inviteCandidateApi", data },
    lastResult,
    config: {
      api_key_env: "ROBOHIRE_API_KEY",
      base_url_env: "ROBOHIRE_API_BASE_URL",
    },
  } as ToolContext;
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.ROBOHIRE_API_KEY;
  delete process.env.ROBOHIRE_API_BASE_URL;
});

describe("inviteCandidateApi canonical adapter", () => {
  it("projects only canonical vendor fields and never forwards business fields", async () => {
    const prepared = await prepareInviteCandidateRequest({
      resume: "  canonical resume  ",
      jd: " canonical JD ",
      candidate_email: " candidate@example.test ",
      interview_language: "zh",
      interview_duration: 30,
      passing_score: 80,
      candidate_id: "business-candidate-id",
      job_requisition_id: "business-jr-id",
      correlation_id: "business-correlation-id",
      resume_text: "legacy alias must not be used",
      jd_text: "legacy alias must not be used",
      robohire_resume_id: "legacy alias must not be used",
      robohire_job_id: "legacy alias must not be used",
    });

    expect(prepared).toEqual({
      ok: true,
      body: {
        resume: "canonical resume",
        jd: "canonical JD",
        candidate_email: "candidate@example.test",
        interview_language: "zh",
        interview_duration: 30,
        passing_score: 80,
      },
    });
  });

  it("rejects thin business payloads before network with a human-readable terminal error", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      inviteCandidateApi.handler(
        context({
          candidate_id: "candidate-1",
          job_requisition_id: "jr-1",
          resume_text: "legacy resume alias",
          jd_text: "legacy JD alias",
          robohire_resume_id: "legacy-provider-alias",
          robohire_job_id: "legacy-provider-alias",
        }),
      ),
    ).rejects.toMatchObject({
      name: "InviteCandidateApiError",
      code: "invite_candidate_input_invalid",
      status: 400,
      retryable: false,
      terminal: true,
      details: {
        missing: ["resume_or_resume_id", "jd_or_job_id"],
      },
    });
    await expect(
      inviteCandidateApi.handler(context({ candidate_id: "candidate-1" })),
    ).rejects.toThrow("不会自己查业务数据库");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends one allow-listed canonical request and normalizes its receipt", async () => {
    process.env.ROBOHIRE_API_KEY = "test-key";
    process.env.ROBOHIRE_API_BASE_URL = "https://robohire.test/api/v1";
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          success: true,
          data: {
            login_url: "https://interview.test/login-1",
            qrcode_url: "https://interview.test/qr-1",
            user_id: 42,
            request_introduction_id: "intro-1",
          },
          requestId: "request-1",
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await inviteCandidateApi.handler(
      context({
        resume_id: "robohire-resume-1",
        job_id: "robohire-job-1",
        candidate_email: "candidate@example.test",
        linked_assessment_id: "null",
        candidate_id: "must-not-leak",
        job_requisition_id: "must-not-leak",
      }),
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://robohire.test/api/v1/invite-candidate",
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      resume_id: "robohire-resume-1",
      job_id: "robohire-job-1",
      candidate_email: "candidate@example.test",
      linked_assessment_id: "null",
    });
    expect(result.data).toMatchObject({
      success: true,
      error_code: null,
      login_url: "https://interview.test/login-1",
      qrcode_url: "https://interview.test/qr-1",
      user_id: 42,
      request_introduction_id: "intro-1",
      request_id: "request-1",
      error_message: null,
    });
  });

  it("keeps deterministic 4xx failures in-band for failure-event routing", async () => {
    process.env.ROBOHIRE_API_KEY = "test-key";
    process.env.ROBOHIRE_API_BASE_URL = "https://robohire.test/api/v1";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ message: "candidate rejected" }), {
          status: 422,
        }),
      ),
    );

    await expect(
      inviteCandidateApi.handler(context({ resume: "resume", jd: "JD" })),
    ).resolves.toMatchObject({
      data: {
        success: false,
        error_code: "ROBOHIRE_4XX",
        http_status: 422,
        error_message: "candidate rejected",
      },
      meta: { terminalBusinessFailure: true },
    });
  });

  it("classifies throttling and dependency failures as typed retryable errors", async () => {
    process.env.ROBOHIRE_API_KEY = "test-key";
    process.env.ROBOHIRE_API_BASE_URL = "https://robohire.test/api/v1";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ message: "slow down" }), { status: 429 }),
      ),
    );

    const promise = inviteCandidateApi.handler(
      context({ resume: "resume", jd: "JD" }),
    );
    await expect(promise).rejects.toBeInstanceOf(InviteCandidateApiError);
    await expect(
      inviteCandidateApi.handler(context({ resume: "resume", jd: "JD" })),
    ).rejects.toMatchObject({
      code: "invite_candidate_upstream_unavailable",
      status: 429,
      retryable: true,
      terminal: false,
    });
  });

  it("publishes the exact request boundary and fail-closed write policy", () => {
    // The legacy name aliases to the canonical GoHire implementation whose
    // credentials resolve via the trusted integration store (with fail-closed
    // env-reference overrides) — the write policy itself is unchanged.
    const catalog = getGlobalToolCatalogEntry("inviteCandidateApi");
    expect(catalog).toMatchObject({
      operation: "write",
      effectScope: "external",
      sandboxPolicy: "requires_attempt_grant",
      credentialPosture: "server_managed",
      probeRequired: true,
    });
    expect(catalog?.probeSafety).toBeUndefined();
    expect(Object.keys(catalog?.argsSchema ?? {})).toEqual([
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
      "interview_duration",
      "interview_mode",
      "passing_score",
      "linked_assessment_id",
    ]);
    expect(catalog?.argsSchema).not.toHaveProperty("candidate_id");
    expect(catalog?.argsSchema).not.toHaveProperty("job_requisition_id");
    expect(catalog?.argsSchema).not.toHaveProperty("candidate_name");
  });
});
