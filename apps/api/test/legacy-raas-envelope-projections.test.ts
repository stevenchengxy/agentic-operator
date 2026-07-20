import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  unwrapLegacyRaasEventData,
  wrapLegacyRaasEventData,
} from "@tenants/zhaopin";

describe("legacy RAAS inbound contract", () => {
  it.each(["REQUIREMENT_LOGGED", "CLARIFICATION_READY"])(
    "recovers job_requisition_id from entity_id for %s",
    (eventName) => {
      const flat = unwrapLegacyRaasEventData(
        {
          entity_type: "Job_Requisition",
          entity_id: "JR-entity-1",
          event_id: "evt-in-1",
          payload: { title: "平台工程师" },
          trace: { trace_id: "trace-in-1" },
        },
        { eventName: `zhaopin/${eventName}` },
      );

      expect(flat).toMatchObject({
        title: "平台工程师",
        job_requisition_id: "JR-entity-1",
        requirement_id: "JR-entity-1",
        subject: "JR-entity-1",
        __correlationId: "trace-in-1",
      });
    },
  );

  it("keeps a JobPosting-anchored JD_REJECTED distinct from its requisition", () => {
    const flat = unwrapLegacyRaasEventData(
      {
        entity_type: "Job_Posting",
        entity_id: "JP-rejected-1",
        event_id: "evt-jd-rejected-1",
        payload: { reason: "请补充技能要求" },
      },
      { eventName: "JD_REJECTED" },
    );

    expect(flat).toMatchObject({
      job_posting_id: "JP-rejected-1",
      reason: "请补充技能要求",
    });
    expect(flat.job_requisition_id).toBeUndefined();
  });

  it("does not reinterpret another event's entity_id as a requisition", () => {
    const flat = unwrapLegacyRaasEventData(
      {
        entity_type: "Candidate",
        entity_id: "candidate-1",
        event_id: "evt-in-2",
        payload: { upload_id: "upload-1" },
      },
      { eventName: "CANDIDATE_IDENTITY_REQUESTED" },
    );

    expect(flat.job_requisition_id).toBeUndefined();
    expect(flat.requirement_id).toBeUndefined();
    expect(flat.subject).toBe("candidate-1");
  });
});

describe("legacy RAAS outbound projections", () => {
  it("projects JD_GENERATED onto Job_Posting and exposes only canonical nested fields", () => {
    const wire = wrapLegacyRaasEventData({
      eventId: "evt-jd-1",
      eventName: "JD_GENERATED",
      subject: "JR-1",
      sourceAgent: "some-runtime-name",
      correlationId: "trace-jd-1",
      emittedAt: "2026-07-13T01:02:03.000Z",
      payload: {
        jobPostingId: "JP-1",
        jobRequisitionId: "JR-1",
        clientId: "client-1",
        jd: "# 高级平台工程师",
        content_base64: "must-not-cross-the-raas-payload-boundary",
        last_result: { private: true },
        local_blob: { __ref: "blob", hash: "sha256", bytes: 9999 },
      },
    });

    expect(wire).toMatchObject({
      entity_type: "Job_Posting",
      entity_id: "JP-1",
      event_id: "evt-jd-1",
      source_action: "createJD",
      trace: {
        trace_id: "trace-jd-1",
        event_name: "JD_GENERATED",
      },
      payload: {
        job_posting_id: "JP-1",
        job_requisition_id: "JR-1",
        client_id: "client-1",
        jd_content: "# 高级平台工程师",
      },
    });
    expect(wire.payload).toEqual({
      job_posting_id: "JP-1",
      job_requisition_id: "JR-1",
      client_id: "client-1",
      jd_content: "# 高级平台工程师",
    });
    expect(wire.content_base64).toBeUndefined();
    expect(wire.last_result).toBeUndefined();
    expect(wire.local_blob).toBeUndefined();
  });

  it("fails closed when an outbound Event has no reviewed projection", () => {
    expect(() => wrapLegacyRaasEventData({
      eventId: "evt-unknown",
      eventName: "UNREVIEWED_FUTURE_EVENT",
      payload: { candidate_id: "candidate-1", private_note: "do-not-drop-silently" },
    })).toThrow(/projection is not declared/);
  });

  it("adds the old PASS rule-check vocabulary", () => {
    const wire = wrapLegacyRaasEventData({
      eventId: "evt-rule-pass",
      eventName: "MATCH_RULE_CHECK_PASSED",
      payload: {
        candidateId: "candidate-1",
        jobRequisitionId: "JR-1",
        clientId: "client-1",
        rule_results: [
          { rule_id: "rule-1", rule_name: "国籍限制", status: "pass" },
        ],
      },
    });

    expect(wire).toMatchObject({
      entity_type: "Candidate",
      entity_id: "candidate-1",
      source_action: "ruleCheckForMatchResume",
      payload: {
        candidate_id: "candidate-1",
        resume_id: null,
        job_requisition_id: "JR-1",
        client_id: "client-1",
        rule_check_result: "通过",
        rule_check_reason: "",
        upload_id: null,
        rule_check_rules: [
          { rule_id: "rule-1", rule_name: "国籍限制", status: "pass" },
        ],
      },
    });
  });

  it("adds the old FAIL rule-check vocabulary and never leaks a score", () => {
    const wire = wrapLegacyRaasEventData({
      eventId: "evt-rule-fail",
      eventName: "MATCH_RULE_CHECK_FAILED",
      payload: {
        candidate_id: "candidate-2",
        resume_id: "resume-2",
        job_requisition_id: "JR-2",
        client_id: "client-2",
        upload_id: "upload-2",
        reason: "命中关联公司冷冻期",
        failed_rules: [{ rule_id: "freeze", rule_name: "冷冻期" }],
        matchScore: 99,
      },
    });

    expect(wire.payload).toMatchObject({
      candidate_id: "candidate-2",
      resume_id: "resume-2",
      job_requisition_id: "JR-2",
      client_id: "client-2",
      rule_check_result: "未通过",
      rule_check_reason: "命中关联公司冷冻期",
      failed_rules: [{ rule_id: "freeze", rule_name: "冷冻期" }],
      matching_score: null,
      upload_id: "upload-2",
      success: false,
    });
  });

  it.each([
    ["MATCH_PASSED_NEED_INTERVIEW", "匹配", true],
    ["MATCH_PASSED_NO_INTERVIEW", "匹配", true],
    ["MATCH_FAILED", "不匹配", false],
  ] as const)(
    "projects %s with canonical match anchors",
    (eventName, overallStatus, success) => {
      const wire = wrapLegacyRaasEventData({
        eventId: `evt-${eventName}`,
        eventName,
        payload: {
          candidateId: "candidate-3",
          jobRequisitionId: "JR-3",
          uploadId: "upload-3",
          matchScore: 88,
          request_id: "robohire-request-3",
          savedAs: "robohire-match-3",
          data: {
            summary: "匹配良好",
            overallMatchScore: { score: 88, grade: "B" },
            mustHaveAnalysis: { mustHaveScore: 90, disqualified: false },
            content_base64: "must-not-leak",
            blob: { __ref: "blob", hash: "private", bytes: 9000 },
            last_result: { private: true },
          },
        },
      });

      expect(wire).toMatchObject({
        entity_type: "Candidate",
        entity_id: "candidate-3",
        source_action: "matchResume",
        payload: {
          job_requisition_id: "JR-3",
          candidate_id: "candidate-3",
          matching_score: 88,
          upload_id: "upload-3",
          job_posting_id: null,
          candidate_match_result_id: null,
          overall_status: overallStatus,
          success,
          requestId: "robohire-request-3",
          savedAs: "robohire-match-3",
          data: {
            summary: "匹配良好",
            overallMatchScore: { score: 88, grade: "B" },
            mustHaveAnalysis: { mustHaveScore: 90, disqualified: false },
          },
        },
      });
    },
  );

  it("uses Interview_Record semantics and old receipt aliases for SENT", () => {
    const wire = wrapLegacyRaasEventData({
      eventId: "evt-invite-sent",
      eventName: "INTERVIEW_INVITATION_SENT",
      correlationId: "invite-correlation-1",
      emittedAt: "2026-07-13T02:03:04.000Z",
      payload: {
        candidateId: "candidate-4",
        jobRequisitionId: "JR-4",
        interviewRecordId: "interview-4",
        communicationLogId: "communication-4",
        candidateMatchResultId: "cmr-4",
        interview_link: "https://example.test/interview/4",
        qrcodeUrl: "https://example.test/qr/4",
        userId: 44,
        requestIntroductionId: "intro-4",
        gohireJobId: "gohire-4",
        to: "candidate4@example.test",
        interviewLanguage: "zh",
        interview_duration: 30,
        robohireRequestId: "robohire-4",
      },
    });

    expect(wire).toMatchObject({
      entity_type: "Interview_Record",
      entity_id: "interview-4",
      source_action: "inviteInternalInterview",
      payload: {
        candidate_id: "candidate-4",
        job_requisition_id: "JR-4",
        candidate_match_result_id: "cmr-4",
        correlation_id: "invite-correlation-1",
        interview_record_id: "interview-4",
        communication_log_id: "communication-4",
        login_url: "https://example.test/interview/4",
        qrcode_url: "https://example.test/qr/4",
        user_id: 44,
        request_introduction_id: "intro-4",
        gohire_job_id: "gohire-4",
        candidate_email: "candidate4@example.test",
        interview_language: "zh",
        interview_duration_minutes: 30,
        robohire_request_id: "robohire-4",
        sent_at: "2026-07-13T02:03:04.000Z",
      },
    });
  });

  it("uses Candidate semantics and stable failure fields for FAILED", () => {
    const wire = wrapLegacyRaasEventData({
      eventId: "evt-invite-failed",
      eventName: "INTERVIEW_INVITATION_FAILED",
      correlationId: "invite-correlation-2",
      emittedAt: "2026-07-13T03:04:05.000Z",
      payload: {
        candidateId: "candidate-5",
        jobRequisitionId: "JR-5",
        reason: "投递通道未配置",
        status: 503,
      },
    });

    expect(wire).toMatchObject({
      entity_type: "Candidate",
      entity_id: "candidate-5",
      source_action: "inviteInternalInterview",
      payload: {
        candidate_id: "candidate-5",
        job_requisition_id: "JR-5",
        correlation_id: "invite-correlation-2",
        error_code: "UNKNOWN",
        error_message: "投递通道未配置",
        http_status: 503,
        failed_at: "2026-07-13T03:04:05.000Z",
      },
    });
  });
});

describe("zhaopin legacy RAAS workflow topology", () => {
  it("keeps approval and ontology boundaries aligned with the live contract", () => {
    const workflow = JSON.parse(
      readFileSync(
        new URL("../../../models/zhaopin-v1/workflow_v1.json", import.meta.url),
        "utf8",
      ),
    ) as Array<{
      name: string;
      trigger: string[];
      tool_use?: Array<{
        name: string;
        config?: Record<string, unknown>;
      }>;
    }>;
    const byName = (name: string) =>
      workflow.find((agent) => agent.name === name);

    const identity = byName("ruleCheckForCandidateIdentity");
    expect(identity?.trigger).toEqual(["CANDIDATE_IDENTITY_REQUESTED"]);
    expect(
      identity?.tool_use?.find(
        (tool) => tool.name === "ontology.fetchActionRules",
      )?.config,
    ).toEqual({
      action: "ruleCheckForCandidateIdentity",
      domain: "Agents-generation",
      // Server-owned environment REFERENCES (names, never secrets):
      // ontology.fetchActionRules resolves its trusted Allmeta origin/key via
      // readEnvironmentReference and fails closed when the refs are absent —
      // a live run without them dead-ends the identity gate.
      base_url_env: "ALLMETA_BASE_URL",
      api_key_env: "ALLMETA_API_KEY",
    });

    const matchRule = byName("ruleCheckForMatchResume");
    expect(
      matchRule?.tool_use?.find(
        (tool) => tool.name === "reasoning.evaluateRules",
      )?.config,
    ).toMatchObject({
      action: "ruleCheckForMatchResume",
      scenario: "pre_match_resume_rule_check",
      passEvent: "MATCH_RULE_CHECK_PASSED",
      failEvent: "MATCH_RULE_CHECK_FAILED",
    });
    expect(
      matchRule?.tool_use?.find(
        (tool) => tool.name === "reasoning.evaluateRules",
      )?.config,
    ).not.toHaveProperty("domainId");

    expect(byName("inviteInternalInterview")?.trigger).toEqual([
      "INTERVIEW_INVITATION_REQUESTED",
    ]);
  });
});
