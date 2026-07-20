import { describe, expect, it } from "vitest";
import { assembleEmitPayload, mergeStepResults } from "./message-envelope";
import { selectEmittedEvent } from "./emit-select";
import {
  checkCandidateIdentity,
  zhaopinPrompts,
} from "../../../tenants/zhaopin/src/prompts/index";
import { routeInterviewInvitation as routeZhaopinInvitation } from "../../../tenants/zhaopin/src/tools/route-interview-invitation";
import { routeInterviewInvitation as routeRaasInvitation } from "../../../tenants/raas/src/tools/route-interview-invitation";
import { routeMatchOutcome } from "../../../tenants/zhaopin/src/tools/route-match-outcome";

function parsePromptOutput(
  prompt: { output?: { parse(value: unknown): unknown } },
  value: unknown,
): unknown {
  expect(
    prompt.output,
    "prompt must declare a structured output schema",
  ).toBeDefined();
  return prompt.output!.parse(value);
}

describe("zhaopin six-agent structured contracts", () => {
  it("validates required output fields and known types before blob offload", () => {
    const missing = assembleEmitPayload({
      incoming: { candidate_id: "C-1" },
      lastResult: { score: "95" },
      meta: { producedBy: "matchResume", sourceRun: "run-contract-missing" },
      contractSchema: [
        { field: "candidate_id", type: "string" },
        { field: "score", type: "number" },
        { field: "explanation", type: "string", required: false },
      ],
    });
    expect(missing.contractErrors).toEqual([
      {
        field: "score",
        kind: "type_mismatch",
        expectedType: "number",
        actualType: "string",
      },
    ]);

    const beforeOffload = assembleEmitPayload({
      lastResult: { document: "large-document" },
      meta: { producedBy: "processResume", sourceRun: "run-contract-offload" },
      contractSchema: [{ field: "document", type: "string" }],
      offload: () => ({ __ref: "blob", hash: "sha256:fixture", bytes: 14 }),
    });
    expect(beforeOffload.contractErrors).toEqual([]);
    expect(beforeOffload.payload.document).toEqual({
      __ref: "blob",
      hash: "sha256:fixture",
      bytes: 14,
    });
  });

  it("treats null as missing for required runtime output fields", () => {
    const assembled = assembleEmitPayload({
      lastResult: { invitation_id: null },
      meta: { producedBy: "inviteInternalInterview", sourceRun: "run-contract-null" },
      contractSchema: [{ field: "invitation_id", type: "string" }],
    });
    expect(assembled.missing).toEqual(["invitation_id"]);
    expect(assembled.contractErrors).toEqual([
      { field: "invitation_id", kind: "missing", expectedType: "string" },
    ]);
  });

  it("declares a runtime output schema for every hand-authored logic prompt", () => {
    for (const [name, prompt] of Object.entries(zhaopinPrompts)) {
      expect(prompt.output, `${name} is missing output schema`).toBeDefined();
    }
  });

  it("createJD retains verified RoboHire jd_content through persistence output", () => {
    let state: unknown = {
      title: "高级 Java 后端工程师（上海）",
      jd_content: "## 职位概述\n完整且可发布的 JD 正文",
      request_id: "rh-jd-1",
      stages: { parse: "success", generate: "success" },
    };
    state = mergeStepResults(state, {
      job_requisition_id: "JR-1",
      job_posting_id: "JP-1",
      jd_persisted: true,
    });

    const assembled = assembleEmitPayload({
      incoming: { job_requisition_id: "JR-1" },
      lastResult: state,
      meta: { producedBy: "createJD", sourceRun: "run-jd" },
    });
    expect(assembled.payload.jd_content).toBe(
      "## 职位概述\n完整且可发布的 JD 正文",
    );
    expect(assembled.payload.jd_persisted).toBe(true);
  });

  it("candidate identity retains same_person after the terminal ontology result", () => {
    let state: unknown = parsePromptOutput(checkCandidateIdentity, {
      same_person: true,
      same_as_candidate_id: "C-existing",
      matched_tier: 1,
      dedup_action: "merge",
      needs_review: false,
      decision_reason: "手机号精确一致",
    });
    state = mergeStepResults(state, {
      rules: [{ id: "identity-phone", mandatory: true }],
      source: "allmeta",
      count: 1,
    });

    const assembled = assembleEmitPayload({
      incoming: { candidate_id: "C-upload" },
      lastResult: state,
      meta: {
        producedBy: "ruleCheckForCandidateIdentity",
        sourceRun: "run-id",
      },
    });
    expect(assembled.payload.same_person).toBe(true);
    expect(assembled.payload.same_as_candidate_id).toBe("C-existing");
    expect(assembled.payload.source).toBe("allmeta");
  });

  it("matchResume sends every score meeting the explicit JR threshold to interview", async () => {
    const routed = await routeMatchOutcome.handler({
      agentName: "matchResume",
      actionName: "routeMatchOutcome",
      correlationId: "cor-match",
      tenantSlug: "zhaopin",
      lastResult: {
        matchScore: 95,
        verdict: "excellent",
        job_requisition: { resume_match_score_threshold: "90" },
      },
    });
    const state = mergeStepResults(
      { matchScore: 95, verdict: "excellent" },
      routed.data,
    );
    expect(
      selectEmittedEvent(
        ["MATCH_PASSED_NEED_INTERVIEW", "MATCH_FAILED"],
        state,
      ),
    ).toBe("MATCH_PASSED_NEED_INTERVIEW");
    expect(routed.data.resume_match_score_threshold).toBe(90);
  });

  it("matchResume rejects scores below the explicit threshold and fails on missing score", async () => {
    const failed = await routeMatchOutcome.handler({
      agentName: "matchResume",
      actionName: "routeMatchOutcome",
      correlationId: "cor-match-fail",
      tenantSlug: "zhaopin",
      lastResult: {
        matchScore: 39,
        resume_match_score_threshold: 40,
      },
    });
    expect(failed.data._emit).toBe("MATCH_FAILED");
    await expect(
      routeMatchOutcome.handler({
        agentName: "matchResume",
        actionName: "routeMatchOutcome",
        correlationId: "cor-match-missing",
        tenantSlug: "zhaopin",
        lastResult: {
          matchScore: null,
          resume_match_score_threshold: 40,
        },
      }),
    ).rejects.toThrow(/no valid 0-100 matchScore/);
  });

  it("fails closed when the threshold is absent, invalid, or conflicts", async () => {
    const base = {
      agentName: "matchResume",
      actionName: "routeMatchOutcome",
      correlationId: "cor-match-threshold",
      tenantSlug: "zhaopin",
    };
    await expect(
      routeMatchOutcome.handler({
        ...base,
        lastResult: { matchScore: 80 },
      }),
    ).rejects.toThrow(/threshold is required.*no default/i);
    await expect(
      routeMatchOutcome.handler({
        ...base,
        lastResult: {
          matchScore: 80,
          resume_match_score_threshold: 101,
        },
      }),
    ).rejects.toThrow(/between 0 and 100/);
    await expect(
      routeMatchOutcome.handler({
        ...base,
        event: {
          name: "MATCH_RULE_CHECK_PASSED",
          data: { resume_match_score_threshold: 70 },
        },
        lastResult: {
          matchScore: 80,
          job_requisition: { resume_match_score_threshold: 75 },
        },
      }),
    ).rejects.toThrow(/conflicting match thresholds/);
  });

  it("routes only an explicit RoboHire success receipt to SENT", async () => {
    for (const route of [routeZhaopinInvitation, routeRaasInvitation]) {
      const result = await route.handler({
        agentName: "inviteInternalInterview",
        actionName: "routeInterviewInvitation",
        correlationId: "cor-invite",
        tenantSlug: route === routeZhaopinInvitation ? "zhaopin" : "raas",
        lastResult: {
          success: true,
          login_url: "https://robohire.example/interview/real-receipt",
          request_id: "req-real",
          _record: { upserted: true },
        },
      });
      expect(result.data).toMatchObject({
        _emit: "INTERVIEW_INVITATION_SENT",
        invitation_sent: true,
        interview_link: "https://robohire.example/interview/real-receipt",
      });
    }
  });

  it("fails closed when the RoboHire receipt is false or missing", async () => {
    for (const route of [routeZhaopinInvitation, routeRaasInvitation]) {
      for (const lastResult of [
        { success: false, error_message: "upstream rejected invite" },
        { request_id: "req-without-success" },
        {},
      ]) {
        const result = await route.handler({
          agentName: "inviteInternalInterview",
          actionName: "routeInterviewInvitation",
          correlationId: "cor-invite-failed",
          tenantSlug: route === routeZhaopinInvitation ? "zhaopin" : "raas",
          lastResult,
        });
        expect(result.data).toMatchObject({
          _emit: "INTERVIEW_INVITATION_FAILED",
          invitation_sent: false,
        });
      }
    }
  });
});
