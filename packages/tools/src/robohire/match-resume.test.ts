import type { ToolContext } from "@agentic/agent-kit";
import { afterEach, describe, expect, it, vi } from "vitest";

import { matchResumeApi } from "./match-resume";

function context(data: Record<string, unknown>): ToolContext {
  return {
    tenantSlug: "zhaopin",
    agentName: "matchResume",
    actionName: "matchResumeApi",
    correlationId: "corr-match-1",
    event: { name: "MATCH_RULE_CHECK_PASSED", data },
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

describe("matchResumeApi", () => {
  it("preserves detailed analysis and envelope metadata for the RAAS event contract", async () => {
    process.env.ROBOHIRE_API_KEY = "test-key";
    process.env.ROBOHIRE_API_BASE_URL = "https://robohire.test/api/v1";
    const analysis = {
      overallMatchScore: { score: 91, grade: "A", confidence: "High" },
      overallFit: {
        verdict: "Strong Match",
        hiringRecommendation: "Strongly Recommend",
        summary: "核心技能与岗位要求高度匹配",
      },
      mustHaveAnalysis: {
        mustHaveScore: 100,
        disqualified: false,
      },
    };
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            success: true,
            data: analysis,
            requestId: "rh-match-request-1",
            savedAs: "robohire-match-1",
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await matchResumeApi.handler(
      context({ resume: "候选人简历正文", jd: "岗位描述正文" }),
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://robohire.test/api/v1/match-resume",
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      resume: "候选人简历正文",
      jd: "岗位描述正文",
    });
    expect(result.data).toMatchObject({
      matchScore: 91,
      verdict: "Strong Match",
      hiringRecommendation: "Strongly Recommend",
      summary: "核心技能与岗位要求高度匹配",
      data: analysis,
      requestId: "rh-match-request-1",
      savedAs: "robohire-match-1",
      raw: analysis,
    });
  });

  it("normalizes the compact RoboHire response without dropping its data", async () => {
    process.env.ROBOHIRE_API_KEY = "test-key";
    process.env.ROBOHIRE_API_BASE_URL = "https://robohire.test/api/v1";
    const analysis = {
      matchScore: 67,
      recommendation: "GOOD_MATCH",
      summary: "经验基本匹配",
      matchAnalysis: { skillsScore: 72 },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              success: true,
              data: analysis,
              request_id: "rh-match-request-2",
              saved_as: "robohire-match-2",
            }),
          ),
      ),
    );

    const result = await matchResumeApi.handler(
      context({ resume_text: "简历", job_description: "JD" }),
    );

    expect(result.data).toMatchObject({
      matchScore: 67,
      hiringRecommendation: "GOOD_MATCH",
      summary: "经验基本匹配",
      data: analysis,
      requestId: "rh-match-request-2",
      savedAs: "robohire-match-2",
    });
  });

  it("forwards candidatePreferences to RoboHire when provided", async () => {
    process.env.ROBOHIRE_API_KEY = "test-key";
    process.env.ROBOHIRE_API_BASE_URL = "https://robohire.test/api/v1";
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ success: true, data: { matchScore: 80 } }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await matchResumeApi.handler(
      context({
        resume: "简历正文",
        jd: "JD 正文",
        candidatePreferences: "期望职位: 后端工程师\n期望月薪: 15000-20000",
      }),
    );

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      resume: "简历正文",
      jd: "JD 正文",
      candidatePreferences: "期望职位: 后端工程师\n期望月薪: 15000-20000",
    });
  });

  it("accepts the snake_case candidate_preferences alias", async () => {
    process.env.ROBOHIRE_API_KEY = "test-key";
    process.env.ROBOHIRE_API_BASE_URL = "https://robohire.test/api/v1";
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ success: true, data: { matchScore: 80 } }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await matchResumeApi.handler(
      context({
        resume: "简历正文",
        jd: "JD 正文",
        candidate_preferences: "期望城市: 深圳",
      }),
    );

    expect(
      JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
        .candidatePreferences,
    ).toBe("期望城市: 深圳");
  });

  it("omits candidatePreferences when empty or absent (zero-regression)", async () => {
    process.env.ROBOHIRE_API_KEY = "test-key";
    process.env.ROBOHIRE_API_BASE_URL = "https://robohire.test/api/v1";
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ success: true, data: { matchScore: 80 } }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await matchResumeApi.handler(
      context({ resume: "简历正文", jd: "JD 正文", candidatePreferences: "  " }),
    );

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      resume: "简历正文",
      jd: "JD 正文",
    });
  });
});
