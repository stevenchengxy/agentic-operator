import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import zhaopinRegistry, {
  buildAllmetaWrites,
  candidateMatchRichness,
  normalizeCandidateMatchSnapshot,
  persistPostgresWithSession,
  persistRaasExternal,
  readRaasRuleContext,
} from "@tenants/zhaopin";
import {
  inviteCandidateApi,
  prepareInviteCandidateRequest,
} from "@agentic/tools/robohire";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.ROBOHIRE_API_KEY;
  delete process.env.ROBOHIRE_API_BASE_URL;
});

const baseSnapshot = {
  job_requisition_id: "JR-1",
  client_id: "CLI-1",
  title: "高级后端工程师",
  jd_content: "完整 JD",
};

const postgresProfile = {
  targetMode: "postgres" as const,
  postgresUrlEnv: "RAAS_POSTGRES_URL",
};
const allmetaProfile = {
  targetMode: "allmeta" as const,
  allmetaBaseUrlEnv: "ALLMETA_BASE_URL",
  allmetaApiKeyEnv: "ALLMETA_API_KEY",
  allmetaDomainId: "Agents-generation",
};

describe("zhaopin write-before-emit persistence contract", () => {
  it("commits PG first, forwards the persisted id to Allmeta, and returns a receipt", async () => {
    const order: string[] = [];
    const allmetaWrites: Array<Record<string, unknown>> = [];
    const receipt = await persistRaasExternal(
      {
        tenantSlug: "zhaopin",
        phase: "job_posting",
        snapshot: baseSnapshot,
        env: {
          RAAS_POSTGRES_URL: "postgresql://raas.test/db",
          ALLMETA_BASE_URL: "http://allmeta.test",
          ALLMETA_API_KEY: "test-key",
          ALLMETA_DOMAIN: "Agents-generation",
        },
        profile: { ...postgresProfile, ...allmetaProfile, targetMode: "both" },
      },
      {
        postgres: async () => {
          order.push("postgres");
          return { job_posting_id: "JP-PERSISTED" };
        },
        allmeta: async ({ domain, write }) => {
          order.push("allmeta");
          allmetaWrites.push({ domain, ...write });
        },
      },
    );

    expect(order).toEqual(["postgres", "allmeta"]);
    expect(receipt).toMatchObject({
      enabled: true,
      postgres: "written",
      allmeta: "written",
      ids: { job_posting_id: "JP-PERSISTED" },
    });
    expect(allmetaWrites[0]).toMatchObject({
      domain: "Agents-generation",
      label: "Job_Posting",
      payload: { job_posting_id: "JP-PERSISTED" },
    });
  });

  it("rejects on a configured PG failure and never starts Allmeta", async () => {
    const allmeta = vi.fn();
    await expect(
      persistRaasExternal(
        {
          tenantSlug: "zhaopin",
          phase: "job_posting",
          snapshot: baseSnapshot,
          env: {
            RAAS_POSTGRES_URL: "postgresql://raas.test/db",
            ALLMETA_BASE_URL: "http://allmeta.test",
            ALLMETA_API_KEY: "test-key",
          },
          profile: { ...postgresProfile, ...allmetaProfile, targetMode: "both" },
        },
        {
          postgres: async () => {
            throw new Error("partner PG unavailable");
          },
          allmeta,
        },
      ),
    ).rejects.toThrow("partner PG unavailable");
    expect(allmeta).not.toHaveBeenCalled();
  });

  it("POSTs strict Allmeta writes to the Agents-generation domain", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ upserted: ["JP-1"] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await persistRaasExternal({
      tenantSlug: "zhaopin",
      phase: "job_posting",
      snapshot: baseSnapshot,
      env: {
        ALLMETA_BASE_URL: "http://allmeta.test/",
        ALLMETA_API_KEY: "secret",
        ALLMETA_DOMAIN: "Agents-generation",
      },
      profile: allmetaProfile,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(
      "http://allmeta.test/api/v1/ontology/instances/Job_Posting?domain=Agents-generation&validate=strict",
    );
    expect(init?.headers).toMatchObject({ Authorization: "Bearer secret" });
    expect(JSON.parse(String(init?.body))).toMatchObject({
      domainId: "Agents-generation",
      job_requisition_id: ["JR-1"],
    });
  });

  it("resolves client_id/title from JobRequisition for entity_id-only JD retries", async () => {
    const queries: Array<{ sql: string; values: unknown[] }> = [];
    const session = {
      query: vi.fn(async (sql: string, values: unknown[] = []) => {
        queries.push({ sql, values });
        if (sql.includes("FROM job_requisition r")) {
          return {
            rows: [
              {
                client_id: "CLI-FROM-JR",
                client_job_title: "JR title",
                job_requisition_specification_id: "SPEC-1",
              },
            ],
            rowCount: 1,
          };
        }
        if (sql.includes("SELECT job_posting_id FROM job_posting")) {
          return { rows: [], rowCount: 0 };
        }
        return { rows: [], rowCount: 1 };
      }),
    };

    const ids = await persistPostgresWithSession(
      session as never,
      "job_posting",
      { entity_id: "JR-RETRY", jd_content: "rejected JD retry" },
      { job_posting_id: "JP-STABLE" },
    );

    expect(ids).toEqual({ job_posting_id: "JP-STABLE" });
    const insert = queries.find((query) =>
      query.sql.includes("INSERT INTO job_posting"),
    );
    expect(insert?.values.slice(0, 5)).toEqual([
      "JP-STABLE",
      "JR-RETRY",
      "CLI-FROM-JR",
      "JR title",
      "rejected JD retry",
    ]);
    const specificationTransition = queries.find((query) =>
      query.sql.includes("UPDATE job_requisition_specification"),
    );
    expect(specificationTransition?.sql).toContain("AND status = 'draft'");
    expect(specificationTransition?.sql).toContain(
      "status = 'pending_publish'",
    );
    expect(specificationTransition?.values).toEqual(["SPEC-1"]);
    expect(queries.indexOf(specificationTransition!)).toBeGreaterThan(
      queries.indexOf(insert!),
    );
  });

  it("updates non-empty JR matching fields before writing the generated posting", async () => {
    const queries: Array<{ sql: string; values: unknown[] }> = [];
    const session = {
      query: vi.fn(async (sql: string, values: unknown[] = []) => {
        queries.push({ sql, values });
        if (sql.includes("FROM job_requisition r")) {
          return {
            rows: [
              {
                client_id: "CLI-1",
                client_job_title: "平台工程师",
                job_requisition_specification_id: null,
              },
            ],
            rowCount: 1,
          };
        }
        if (sql.includes("SELECT job_posting_id FROM job_posting")) {
          return { rows: [], rowCount: 0 };
        }
        return { rows: [], rowCount: 1 };
      }),
    };

    await persistPostgresWithSession(
      session as never,
      "job_posting",
      {
        job_requisition_id: "JR-STRUCTURED",
        title: "平台工程师",
        jd_content: "完整 JD",
        must_have_skills: ["TypeScript", "PostgreSQL"],
        nice_to_have_skills: ["Kubernetes"],
        hardRequirements: "必须掌握 TypeScript",
        qualifications: "五年以上经验",
        work_years: 5,
      },
      { job_posting_id: "JP-STRUCTURED" },
    );

    const jrUpdate = queries.find((query) =>
      query.sql.includes("UPDATE job_requisition\n"),
    );
    expect(jrUpdate?.sql).toContain("must_have_skills = $2::jsonb");
    expect(jrUpdate?.sql).toContain("nice_to_have_skills = $3::jsonb");
    expect(jrUpdate?.sql).toContain("work_years");
    expect(jrUpdate?.values).toEqual([
      "JR-STRUCTURED",
      JSON.stringify(["TypeScript", "PostgreSQL"]),
      JSON.stringify(["Kubernetes"]),
      5,
      "五年以上经验",
      "必须掌握 TypeScript",
    ]);
    const postingInsert = queries.find((query) =>
      query.sql.includes("INSERT INTO job_posting"),
    );
    expect(queries.indexOf(jrUpdate!)).toBeLessThan(
      queries.indexOf(postingInsert!),
    );
  });
});

describe("interview persistence compatibility", () => {
  it("preserves numeric GoHire user ids and the original RoboHire receipt in PG", async () => {
    const queries: Array<{ sql: string; values: unknown[] }> = [];
    const rawReceipt = {
      success: true,
      requestId: "rh-request-numeric-user",
      data: {
        login_url: "https://gohire.test/interview/numeric-user",
        user_id: 90210,
        message: "invitation created",
      },
    };
    const session = {
      query: vi.fn(async (sql: string, values: unknown[] = []) => {
        queries.push({ sql, values });
        return {
          rows: [
            {
              interview_invitation_id: "INV-1",
              application_id: "APP-1",
            },
          ],
          rowCount: 1,
        };
      }),
    };

    const ids = await persistPostgresWithSession(
      session as never,
      "interview",
      {
        success: true,
        correlation_id: "corr-numeric-user",
        login_url: "https://gohire.test/interview/numeric-user",
        request_introduction_id: "RI-NUMERIC",
        raw: rawReceipt,
      },
      {},
    );

    expect(ids).toEqual({ application_id: "APP-1" });
    const update = queries.find((query) =>
      query.sql.includes("UPDATE interview_invitation SET"),
    );
    expect(update?.values).toEqual([
      "corr-numeric-user",
      "https://gohire.test/interview/numeric-user",
      null,
      90210,
      "RI-NUMERIC",
      JSON.stringify(rawReceipt),
    ]);
  });

  it.each([
    ["duration_minutes", 31],
    ["interview_duration_minutes", 32],
    ["job_interview_duration", 33],
    ["interview_duration", 34],
  ])("maps the %s duration alias into Interview_Record", (key, duration) => {
    const writes = buildAllmetaWrites(
      "interview",
      {
        success: true,
        candidate_id: "C-DURATION",
        job_requisition_id: "JR-DURATION",
        [key]: String(duration),
      },
      {
        interview_record_id: "IR-DURATION",
        communication_log_id: "CL-DURATION",
      },
    );

    expect(
      writes.find((write) => write.label === "Interview_Record")?.payload,
    ).toMatchObject({ duration_minutes: duration });
  });

  it("keeps the requested interview mode and writes auditable raw invitation notes", () => {
    const writes = buildAllmetaWrites(
      "interview",
      {
        success: true,
        candidate_id: "C-NOTES",
        job_requisition_id: "JR-NOTES",
        interview_mode: "电话面试",
        login_url: "https://gohire.test/interview/notes",
        qrcode_url: "https://gohire.test/qr/notes",
        raw: {
          success: true,
          requestId: "rh-request-notes",
          data: {
            user_id: 77,
            request_introduction_id: "RI-NOTES",
            gohire_job_id: 88,
            reused: true,
            message: "reused invitation",
          },
        },
      },
      {
        interview_record_id: "IR-NOTES",
        communication_log_id: "CL-NOTES",
      },
    );

    const payload = writes.find(
      (write) => write.label === "Interview_Record",
    )?.payload;
    expect(payload).toMatchObject({
      interview_mode: "电话面试",
      recording_url: "https://gohire.test/interview/notes",
    });
    expect(JSON.parse(String(payload?.raw_interview_notes))).toEqual({
      invite_request_id: "rh-request-notes",
      invite_user_id: 77,
      invite_request_introduction_id: "RI-NOTES",
      invite_gohire_job_id: 88,
      invite_reused: true,
      invite_qrcode_url: "https://gohire.test/qr/notes",
      invite_login_url: "https://gohire.test/interview/notes",
      invite_message: "reused invitation",
    });
  });
});

describe("candidate match evidence persistence", () => {
  const detailedMatch = {
    candidate_id: "C-MATCH",
    job_requisition_id: "JR-MATCH",
    matchScore: 88,
    _emit: "MATCH_PASSED_NEED_INTERVIEW",
    requestId: "RH-REQ-1",
    savedAs: "match-result.json",
    data: {
      overallMatchScore: {
        score: 88,
        grade: "A",
        breakdown: {
          skillMatchScore: 91,
          experienceScore: 84,
          potentialScore: 86,
        },
      },
      overallFit: {
        verdict: "Strong Match",
        hiringRecommendation: "STRONG_MATCH",
        summary: "技能和项目经验均符合岗位要求",
      },
      mustHaveAnalysis: {
        mustHaveScore: 90,
        disqualified: false,
        candidateEvaluation: {
          matchedSkills: [{ skill: "TypeScript" }, { skill: "PostgreSQL" }],
          missingSkills: [{ skill: "Kafka" }],
          matchedExperiences: [{ candidateEvidence: "负责过高并发招聘平台" }],
        },
      },
      niceToHaveAnalysis: {
        candidateEvaluation: { matchedSkills: ["Kubernetes"] },
      },
    },
  };

  it("normalizes Shape-D evidence into RAAS rich columns", () => {
    expect(normalizeCandidateMatchSnapshot(detailedMatch)).toMatchObject({
      score: 88,
      skillsScore: 91,
      experienceScore: 84,
      experienceAssessment: "负责过高并发招聘平台",
      matchedSkills: ["TypeScript", "PostgreSQL", "Kubernetes"],
      missingSkills: ["Kafka"],
      advantages: ["TypeScript", "PostgreSQL", "Kubernetes"],
      disadvantages: ["Kafka"],
      aiSummary: "技能和项目经验均符合岗位要求",
      finalRecommendation: "STRONG_MATCH",
      dimensionScores: { skill: 91, experience: 84, potential: 86 },
      coreTags: ["TypeScript", "PostgreSQL", "Kubernetes"],
      qualificationRetained: true,
    });
  });

  it("writes detailed provider evidence to runtime_state and the match-pool row", async () => {
    const queries: Array<{ sql: string; values: unknown[] }> = [];
    const session = {
      query: vi.fn(async (sql: string, values: unknown[] = []) => {
        queries.push({ sql, values });
        if (sql.includes("FROM job_posting")) {
          return {
            rows: [{ job_posting_id: "JP-MATCH", client_id: "CLI-MATCH" }],
            rowCount: 1,
          };
        }
        if (
          sql.includes("FROM candidate_match_result\n") ||
          sql.includes("FROM candidate_match_result_runtime_state")
        ) {
          return { rows: [], rowCount: 0 };
        }
        return { rows: [], rowCount: 1 };
      }),
    };

    await expect(
      persistPostgresWithSession(
        session as never,
        "candidate_match",
        detailedMatch,
        { candidate_match_result_id: "CMR-MATCH" },
      ),
    ).resolves.toEqual({
      candidate_match_result_id: "CMR-MATCH",
      job_posting_id: "JP-MATCH",
    });

    const runtimeInsert = queries.find((query) =>
      query.sql.includes("INSERT INTO candidate_match_result_runtime_state"),
    );
    expect(runtimeInsert?.sql).toContain("must_have_analysis");
    expect(runtimeInsert?.sql).toContain("experience_assessment");
    expect(runtimeInsert?.values.slice(5, 23)).toEqual([
      null,
      91,
      null,
      null,
      84,
      "负责过高并发招聘平台",
      88,
      JSON.stringify(["TypeScript", "PostgreSQL", "Kubernetes"]),
      JSON.stringify(["Kafka"]),
      JSON.stringify(detailedMatch.data.mustHaveAnalysis),
      JSON.stringify(detailedMatch.data.niceToHaveAnalysis),
      null,
      true,
      JSON.stringify(["TypeScript", "PostgreSQL", "Kubernetes"]),
      JSON.stringify(["Kafka"]),
      "技能和项目经验均符合岗位要求",
      "STRONG_MATCH",
      JSON.stringify(detailedMatch),
    ]);
    const mainInsert = queries.find((query) =>
      query.sql.includes("INSERT INTO candidate_match_result ("),
    );
    expect(mainInsert?.sql).toContain("dimension_scores");
    expect(mainInsert?.values.slice(7, 10)).toEqual([
      JSON.stringify({ skill: 91, experience: 84, potential: 86 }),
      JSON.stringify(["TypeScript", "PostgreSQL", "Kubernetes"]),
      null,
    ]);
  });

  it("does not let a sparse retry overwrite an existing richer match", async () => {
    const queries: string[] = [];
    const richRuntime = {
      candidate_match_result_id: "CMR-EXISTING",
      total_weighted_score: 90,
      skills_score: 92,
      experience_score: 88,
      experience_assessment: "完整经验说明",
      matched_skills: ["TypeScript"],
      missing_skills: ["Kafka"],
      must_have_analysis: { score: 90 },
      nice_to_have_analysis: { score: 80 },
      advantages: ["TypeScript"],
      disadvantages: ["Kafka"],
      ai_summary: "完整总结",
      final_recommendation: "STRONG_MATCH",
    };
    expect(candidateMatchRichness(richRuntime)).toBeGreaterThan(4);
    const session = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.includes("FROM job_posting")) {
          return {
            rows: [{ job_posting_id: "JP-MATCH", client_id: "CLI-MATCH" }],
            rowCount: 1,
          };
        }
        if (sql.includes("FROM candidate_match_result\n")) {
          return {
            rows: [{ candidate_match_result_id: "CMR-EXISTING" }],
            rowCount: 1,
          };
        }
        if (sql.includes("FROM candidate_match_result_runtime_state")) {
          return { rows: [richRuntime], rowCount: 1 };
        }
        throw new Error(`unexpected write: ${sql}`);
      }),
    };

    await expect(
      persistPostgresWithSession(
        session as never,
        "candidate_match",
        {
          candidate_id: "C-MATCH",
          job_requisition_id: "JR-MATCH",
          matchScore: 89,
          _emit: "MATCH_PASSED_NEED_INTERVIEW",
        },
        {},
      ),
    ).resolves.toEqual({
      candidate_match_result_id: "CMR-EXISTING",
      job_posting_id: "JP-MATCH",
    });
    expect(queries).toHaveLength(3);
    expect(queries.some((sql) => /\b(?:INSERT|UPDATE)\b/.test(sql))).toBe(
      false,
    );
  });
});

describe("RAAS rule context", () => {
  it("uses only schema-backed tables and exposes unknown BP decision as a fail-closed gap", async () => {
    const sqlSeen: string[] = [];
    const session = {
      query: vi.fn(async (sql: string) => {
        sqlSeen.push(sql);
        if (sql.includes("FROM candidate c")) {
          return {
            rows: [{ candidate_json: { candidate_id: "C-1", name: "王小明" } }],
            rowCount: 1,
          };
        }
        if (sql.includes("FROM job_requisition r")) {
          return {
            rows: [
              {
                requirement_json: {
                  job_requisition_id: "JR-1",
                  client_job_type: "BPO",
                },
                specification_json: { sd_org_name: "IEG" },
                client_json: { client_id: "CLI-1", client_name: "腾讯" },
                department_json: {
                  client_department_id: "D-1",
                  dept_name: "IEG",
                },
              },
            ],
            rowCount: 1,
          };
        }
        if (sql.includes("FROM resume r")) {
          return {
            rows: [
              {
                resume_json: {
                  resume_id: "R-1",
                  raw_parse_result: {
                    experience: [
                      {
                        company: "腾讯",
                        endDate: "2024-01",
                        employment_type: "FTE",
                      },
                    ],
                  },
                },
              },
            ],
            rowCount: 1,
          };
        }
        if (sql.includes("FROM application")) {
          return {
            rows: [
              {
                application_id: "A-1",
                job_requisition_id: "JR-1",
                status: "面试淘汰",
                occurred_at: "2026-01-01T00:00:00.000Z",
                compliance_credential: "bp-proof-1",
              },
            ],
            rowCount: 1,
          };
        }
        if (sql.includes("FROM blacklist")) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes("FROM interview_record")) {
          return {
            rows: [
              {
                interview_record_id: "I-1",
                job_requisition_id: "JR-1",
                interview_result: "未通过",
              },
            ],
            rowCount: 1,
          };
        }
        throw new Error(`unexpected SQL: ${sql}`);
      }),
    };

    const context = await readRaasRuleContext(session as never, {
      candidateId: "C-1",
      jobRequisitionId: "JR-1",
    });

    expect(context).toMatchObject({
      client_name: "腾讯",
      studio: "IEG",
      job_type: "BPO",
      // #CREDENTIAL-VERDICT-FIX — the loader reports raw credential EVIDENCE, never a verdict.
      // It used to derive `compliance_credential_verified: true` from "any non-empty string",
      // which silently passed the mandatory compliance gate for a "rejected"/"expired" credential.
      compliance_credentials: ["bp-proof-1"],
      compliance_credential_present: true,
      client_bp_decision: null,
      rule_context_complete: false,
    });
    expect(context.resume.experience).toEqual([
      expect.objectContaining({ company: "腾讯", endDate: "2024-01" }),
    ]);
    expect(context.application_history[0]).toMatchObject({
      status: "面试淘汰",
      occurred_at: "2026-01-01T00:00:00.000Z",
    });
    expect(context.rule_context_missing).toContain("client_bp_decision");
    expect(sqlSeen.join("\n")).toContain("FROM application");
    expect(sqlSeen.join("\n")).toContain("FROM interview_record");
    expect(sqlSeen.join("\n")).toContain("FROM blacklist");
  });

  // #CREDENTIAL-VERDICT-FIX — regression for a live fail-OPEN bug: the loader derived
  // `compliance_credential_verified = targetApplications.some(r => r.compliance_credential !== "")`,
  // so a credential literally reading "rejected" counted as verified, stayed OUT of
  // rule_context_missing, and let the mandatory compliance rule pass silently. Judging credential
  // VALIDITY is an ontology rule decision; the loader may only report evidence.
  it("never turns a rejected/expired credential into a verified verdict — it reports raw evidence", async () => {
    const rows = (credential: string) => ({
      rows: [{ application_id: "A-1", job_requisition_id: "JR-1", compliance_credential: credential }],
      rowCount: 1,
    });
    const sessionFor = (credential: string) => ({
      query: vi.fn(async (sql: string) => {
        if (sql.includes("FROM candidate c")) return { rows: [{ candidate_json: { candidate_id: "C-1" } }], rowCount: 1 };
        if (sql.includes("FROM job_requisition r")) return { rows: [{ requirement_json: { job_requisition_id: "JR-1" }, specification_json: null, client_json: null, department_json: null }], rowCount: 1 };
        if (sql.includes("FROM resume r")) return { rows: [{ resume_json: { resume_id: "R-1", raw_parse_result: { experience: [{ company: "腾讯", endDate: "2024-01" }] } } }], rowCount: 1 };
        if (sql.includes("FROM application")) return rows(credential);
        if (sql.includes("FROM blacklist")) return { rows: [], rowCount: 0 };
        if (sql.includes("FROM interview_record")) return { rows: [], rowCount: 0 };
        throw new Error(`unexpected SQL: ${sql}`);
      }),
    });

    const rejected = await readRaasRuleContext(sessionFor("rejected") as never, { candidateId: "C-1", jobRequisitionId: "JR-1" });
    // The raw value reaches the ontology verbatim; no boolean verdict is manufactured for it.
    expect(rejected.compliance_credentials).toEqual(["rejected"]);
    expect(rejected).not.toHaveProperty("compliance_credential_verified");
    // Presence ≠ validity: the rule engine decides, and the context is still incomplete overall.
    expect(rejected.compliance_credential_present).toBe(true);
    expect(rejected.rule_context_complete).toBe(false);

    // An ABSENT credential is missing evidence → the mandatory rule must go insufficient_info.
    const absent = await readRaasRuleContext(sessionFor("") as never, { candidateId: "C-1", jobRequisitionId: "JR-1" });
    expect(absent.compliance_credentials).toEqual([]);
    expect(absent.compliance_credential_present).toBe(false);
    expect(absent.rule_context_missing).toContain("compliance_credential");
  });
});

describe("single-send invitation contract", () => {
  const ctx = {
    tenantSlug: "zhaopin",
    agentName: "inviteInternalInterview",
    actionName: "inviteCandidateApi",
    correlationId: "corr-1",
    event: {
      name: "INTERVIEW_INVITATION_REQUESTED",
      data: {
        candidate_id: "C-1",
        job_requisition_id: "JR-1",
        resume: "canonical resume body",
        job_id: "rh-job-1",
      },
    },
    config: {
      api_key_env: "ROBOHIRE_API_KEY",
      base_url_env: "ROBOHIRE_API_BASE_URL",
    },
  } as never;

  it("unwraps a nested successful receipt and deterministic routing emits SENT", async () => {
    let requestBody: Record<string, unknown> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: unknown, init?: RequestInit) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            success: true,
            requestId: "rh-request-1",
            data: {
              login_url: "https://gohire.test/interview/1",
              qrcode_url: "https://gohire.test/qr/1",
              user_id: "U-1",
              request_introduction_id: "RI-1",
            },
          }),
          { status: 200 },
        );
      }),
    );
    process.env.ROBOHIRE_API_KEY = "test-key";
    process.env.ROBOHIRE_API_BASE_URL = "https://robohire.test/api/v1";
    const invitation = await inviteCandidateApi.handler(ctx);
    expect(invitation.data).toMatchObject({
      success: true,
      login_url: "https://gohire.test/interview/1",
      request_id: "rh-request-1",
    });
    expect(requestBody).toMatchObject({
      resume: "canonical resume body",
      job_id: "rh-job-1",
    });
    expect(requestBody).not.toHaveProperty("resume_text");
    expect(requestBody).not.toHaveProperty("candidate_id");

    const routed =
      await zhaopinRegistry.tools!.routeInterviewInvitation!.handler({
        ...(ctx as object),
        actionName: "routeInterviewInvitation",
        lastResult: invitation.data,
      } as never);
    expect(routed.data).toMatchObject({
      _emit: "INTERVIEW_INVITATION_SENT",
      invitation_sent: true,
    });
  });

  it("treats 2xx without login_url as FAILED instead of sent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ success: true, data: { message: "accepted" } }),
            { status: 200 },
          ),
      ),
    );
    process.env.ROBOHIRE_API_KEY = "test-key";
    process.env.ROBOHIRE_API_BASE_URL = "https://robohire.test/api/v1";
    const invitation = await inviteCandidateApi.handler(ctx);
    expect(invitation.data).toMatchObject({
      success: false,
      error_code: "GOHIRE_REJECTED",
      login_url: null,
    });
    const routed =
      await zhaopinRegistry.tools!.routeInterviewInvitation!.handler({
        ...(ctx as object),
        actionName: "routeInterviewInvitation",
        lastResult: invitation.data,
      } as never);
    expect(routed.data).toMatchObject({
      _emit: "INTERVIEW_INVITATION_FAILED",
      invitation_sent: false,
    });
  });

  it("keeps non-429 4xx in-band as FAILED but throws transient 5xx", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: "invalid candidate" }), {
          status: 400,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: "upstream down" }), {
          status: 503,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    process.env.ROBOHIRE_API_KEY = "test-key";
    process.env.ROBOHIRE_API_BASE_URL = "https://robohire.test/api/v1";
    await expect(inviteCandidateApi.handler(ctx)).resolves.toMatchObject({
      data: {
        success: false,
        error_code: "ROBOHIRE_4XX",
        http_status: 400,
      },
    });
    await expect(inviteCandidateApi.handler(ctx)).rejects.toThrow("503");
  });

  it("throws a typed terminal input error for missing canonical material before external delivery", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      inviteCandidateApi.handler({
        ...(ctx as object),
        event: {
          name: "INTERVIEW_INVITATION_REQUESTED",
          data: { candidate_id: "C-1", resume: "resume" },
        },
      } as never),
    ).rejects.toMatchObject({
      name: "InviteCandidateApiError",
      code: "invite_candidate_input_invalid",
      terminal: true,
      retryable: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not backfill a thin RAAS invitation from hidden database state", async () => {
    await expect(prepareInviteCandidateRequest({
      candidate_id: "C-THIN",
      job_requisition_id: "JR-THIN",
    })).rejects.toMatchObject({
      name: "InviteCandidateApiError",
      code: "invite_candidate_input_invalid",
      terminal: true,
      details: {
        missing: ["resume_or_resume_id", "jd_or_job_id"],
      },
    });
  });

  it("emits both the delivery fact and a classified vendor persistence warning", async () => {
    const routed =
      await zhaopinRegistry.tools!.routeInterviewInvitation!.handler({
        ...(ctx as object),
        actionName: "routeInterviewInvitation",
        lastResult: {
          success: true,
          login_url: "https://gohire.test/interview/warn",
          persistence_warning: "vendor DB write failed",
        },
      } as never);
    expect(routed.data._emits).toEqual([
      expect.objectContaining({
        event: "INTERVIEW_INVITATION_FAILED",
        payload: expect.objectContaining({
          error_code: "PERSISTENCE_WARNING",
        }),
      }),
      expect.objectContaining({ event: "INTERVIEW_INVITATION_SENT" }),
    ]);
  });

  it("manifest contains exactly one external invitation sender", () => {
    const workflow = JSON.parse(
      readFileSync(
        resolve(process.cwd(), "../../models/zhaopin-v1/workflow_v1.json"),
        "utf8",
      ),
    ) as Array<{ name: string; actions: Array<{ name: string }> }>;
    const invite = workflow.find(
      (agent) => agent.name === "inviteInternalInterview",
    )!;
    expect(invite.actions.map((action) => action.name)).toEqual([
      "inviteCandidateApi",
      "records.upsert",
      "persistRaasEntities",
      "routeInterviewInvitation",
    ]);
  });
});
