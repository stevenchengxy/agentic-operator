import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, getDb, tenants } from "@agentic/db";
import {
  lookupAuthoritativeStrongCandidates,
  runCandidateDedupLookup,
} from "../../../tenants/zhaopin/src/tools/candidate-dedup";
import {
  normEmail,
  normGender,
  normGraduationYear,
  normIdentityText,
  normName,
  normPhone,
  resolveLockedRecruiterOwner,
  resolveRecruiterOwner,
  selectDedup,
} from "../../../tenants/zhaopin/src/tools/dedup-logic";
import type { RaasPgSession } from "../../../tenants/zhaopin/src/tools/raas-pg";

const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const tenantId = `zhaopin-dedup-${suffix}`;
const tenantSlug = `zhaopin-dedup-${suffix}`;

function toolContext(args: {
  lastResult: Record<string, unknown>;
  eventData?: Record<string, unknown>;
  subject?: string;
}) {
  return {
    agentName: "zhaopinDedupTest",
    actionName: "candidateDedupLookup",
    correlationId: `cor-${suffix}`,
    tenantSlug,
    subject: args.subject,
    lastResult: args.lastResult,
    event: {
      name: "TEST_RESUME",
      data: args.eventData ?? {},
    },
  };
}

const candidateDedupLookup = {
  handler: (ctx: ReturnType<typeof toolContext>) =>
    runCandidateDedupLookup(ctx, {
      authoritativeLookup: async () => ({
        byPhone: null,
        byNameEmail: null,
      }),
    }),
};

function pgSession(
  ...resultBatches: Record<string, unknown>[][]
): RaasPgSession {
  let callIndex = 0;
  return {
    query: async () => {
      const rows = resultBatches[callIndex] ?? [];
      callIndex += 1;
      return { rows, rowCount: rows.length };
    },
  } as unknown as RaasPgSession;
}

describe("zhaopin dedup normalizers", () => {
  it("normalizes the strong identity fields", () => {
    expect(normPhone("138-1234-5678")).toBe("13812345678");
    expect(normPhone("+86 138 1234 5678")).toBe("13812345678");
    expect(normPhone(null)).toBe("");
    expect(normEmail("  Wei.Liu@ACME.com ")).toBe("wei.liu@acme.com");
    expect(normName(" 刘 伟 ")).toBe("刘伟");
    expect(normName("Wei Liu")).toBe("weiliu");
  });

  it("normalizes weak-rule gender, text, and graduation year", () => {
    expect(normGender(" 女 ")).toBe("female");
    expect(normGender("M")).toBe("male");
    expect(normIdentityText(" 清华 大学 ")).toBe("清华大学");
    expect(normGraduationYear("2022年06月")).toBe("2022");
    expect(normGraduationYear(2021)).toBe("2021");
  });
});

describe("authoritative RAAS candidate lookup", () => {
  it("applies the same normalized phone and name+email rules after SQL prefiltering", async () => {
    const result = await lookupAuthoritativeStrongCandidates(
      pgSession(
        [
          {
            candidate_id: "raas-phone",
            name: "手机号候选人",
            mobile: "+86 138-1234-5678",
            mobile_normalized: "00000000000",
            email: null,
            employee_id: "EMP-PHONE",
          },
          {
            candidate_id: "prefilter-only",
            name: "后缀相似",
            mobile: "13912345678",
            mobile_normalized: "13912345678",
            email: null,
            employee_id: null,
          },
        ],
        [
          {
            candidate_id: "wrong-name",
            name: "王五",
            mobile: null,
            mobile_normalized: null,
            email: "WEI@EXAMPLE.COM",
            employee_id: null,
          },
          {
            candidate_id: "raas-name-email",
            name: " 刘 伟 ",
            mobile: null,
            mobile_normalized: null,
            email: "WEI@EXAMPLE.COM",
            employee_id: "EMP-PAIR",
          },
        ],
      ),
      {
        phone: "13812345678",
        name: "刘伟",
        email: "wei@example.com",
        lookupPhone: true,
        lookupNameEmail: true,
      },
    );

    expect(result).toEqual({
      byPhone: { candidateId: "raas-phone", owner: "EMP-PHONE" },
      byNameEmail: {
        candidateId: "raas-name-email",
        owner: "EMP-PAIR",
      },
    });
  });

  it("fails closed when one strong signal matches multiple RAAS candidates", async () => {
    await expect(
      lookupAuthoritativeStrongCandidates(
        pgSession([
          {
            candidate_id: "raas-a",
            name: "A",
            mobile: "13812345678",
            mobile_normalized: "13812345678",
            email: null,
            employee_id: null,
          },
          {
            candidate_id: "raas-b",
            name: "B",
            mobile: "13812345678",
            mobile_normalized: "13812345678",
            email: null,
            employee_id: null,
          },
        ]),
        {
          phone: "13812345678",
          name: "",
          email: "",
          lookupPhone: true,
          lookupNameEmail: false,
        },
      ),
    ).rejects.toThrow(/ambiguous RAAS phone match.*raas-a.*raas-b/);
  });

  it("propagates authoritative database failures", async () => {
    const unavailable = {
      query: async () => {
        throw new Error("partner database unavailable");
      },
    } as unknown as RaasPgSession;

    await expect(
      lookupAuthoritativeStrongCandidates(unavailable, {
        phone: "13812345678",
        name: "",
        email: "",
        lookupPhone: true,
        lookupNameEmail: false,
      }),
    ).rejects.toThrow("partner database unavailable");
  });
});

const INPUT = {
  phone: "13812345678",
  email: "wei@acme.com",
  name: "刘伟",
  gender: "male",
  school: "清华大学",
  major: "计算机科学",
  degree: "本科",
  graduationYear: "2020",
};

describe("selectDedup (phone > name+email > six fields)", () => {
  it("returns a new candidate when nothing matches", () => {
    expect(selectDedup(INPUT, {})).toMatchObject({
      sameAsCandidateId: null,
      matchedCandidateId: null,
      isNew: true,
      tier: null,
      needsReview: false,
    });
  });

  it("reuses a candidate on a phone match", () => {
    const verdict = selectDedup(INPUT, {
      byPhone: { candidateId: "cand-phone" },
    });
    expect(verdict).toMatchObject({
      sameAsCandidateId: "cand-phone",
      matchedCandidateId: "cand-phone",
      tier: "phone",
      isNew: false,
      needsReview: false,
    });
  });

  it("reuses a candidate only when name and email match together", () => {
    const verdict = selectDedup(INPUT, {
      byNameEmail: { candidateId: "cand-name-email" },
    });
    expect(verdict).toMatchObject({
      sameAsCandidateId: "cand-name-email",
      tier: "name_email",
      isNew: false,
    });

    expect(
      selectDedup(
        { ...INPUT, name: "" },
        { byNameEmail: { candidateId: "must-not-merge" } },
      ),
    ).toMatchObject({ sameAsCandidateId: null, isNew: true, tier: null });
    expect(
      selectDedup(
        { ...INPUT, email: "" },
        { byNameEmail: { candidateId: "must-not-merge" } },
      ),
    ).toMatchObject({ sameAsCandidateId: null, isNew: true, tier: null });
  });

  it("treats a six-field hit as review-only and never reuses its candidate id", () => {
    const verdict = selectDedup(INPUT, {
      bySixFields: { candidateId: "cand-suspect", owner: "recruiter-B" },
    });
    expect(verdict).toEqual({
      sameAsCandidateId: null,
      matchedCandidateId: "cand-suspect",
      tier: "six_fields",
      isNew: true,
      needsReview: true,
      lockConflict: false,
    });
  });

  it("does not apply the weak rule if any of its six fields is missing", () => {
    const verdict = selectDedup(
      { ...INPUT, major: "" },
      { bySixFields: { candidateId: "must-not-match" } },
    );
    expect(verdict).toMatchObject({
      sameAsCandidateId: null,
      matchedCandidateId: null,
      tier: null,
      isNew: true,
      needsReview: false,
    });
  });

  it("honors rule precedence", () => {
    const phone = selectDedup(INPUT, {
      byPhone: { candidateId: "cand-phone" },
      byNameEmail: { candidateId: "cand-name-email" },
      bySixFields: { candidateId: "cand-weak" },
    });
    expect(phone).toMatchObject({
      sameAsCandidateId: "cand-phone",
      tier: "phone",
    });

    const nameEmail = selectDedup(INPUT, {
      byNameEmail: { candidateId: "cand-name-email" },
      bySixFields: { candidateId: "cand-weak" },
    });
    expect(nameEmail).toMatchObject({
      sameAsCandidateId: "cand-name-email",
      tier: "name_email",
    });
  });

  it("enforces owner locks only after a strong identity match", () => {
    expect(
      selectDedup(
        { ...INPUT, owner: "recruiter-A" },
        { byPhone: { candidateId: "cand-1", owner: "recruiter-B" } },
      ).lockConflict,
    ).toBe(true);
    expect(
      selectDedup(
        { ...INPUT, owner: "recruiter-A" },
        { byNameEmail: { candidateId: "cand-1", owner: "recruiter-A" } },
      ).lockConflict,
    ).toBe(false);
    expect(
      selectDedup(INPUT, {
        byPhone: { candidateId: "cand-1", owner: "recruiter-B" },
      }).lockConflict,
    ).toBe(false);
  });
});

describe("resolveRecruiterOwner", () => {
  it("keeps the requesting recruiter distinct from the lock holder", () => {
    expect(
      resolveRecruiterOwner([
        { owner: "generic-owner", employee_id: "EMP-1" },
        { locked_by_employee_id: "EMP-LOCK" },
      ]),
    ).toBe("EMP-1");
    expect(
      resolveLockedRecruiterOwner([
        { employee_id: "EMP-1" },
        { locked_by_employee_id: "EMP-LOCK" },
      ]),
    ).toBe("EMP-LOCK");
    expect(
      resolveRecruiterOwner([
        { recruiter_id: "REC-1" },
        { employee_id: "EMP-2" },
      ]),
    ).toBe("EMP-2");
  });

  it("uses recruiter aliases and config default without any subject fallback", () => {
    expect(resolveRecruiterOwner([{ recruiter_id: "REC-1" }], "DEFAULT")).toBe(
      "REC-1",
    );
    expect(resolveRecruiterOwner([], "DEFAULT")).toBe("DEFAULT");
    // A generic runtime subject is intentionally not accepted by this API.
    expect(resolveRecruiterOwner([])).toBe("");
  });
});

describe("candidateDedupLookup storage integration", () => {
  beforeAll(() => {
    const now = new Date();
    getDb()
      .insert(tenants)
      .values({
        id: tenantId,
        slug: tenantSlug,
        name: "Zhaopin dedup test",
        createdAt: now,
        updatedAt: now,
      })
      .run();
  });

  afterAll(() => {
    getDb().delete(tenants).where(eq(tenants.id, tenantId)).run();
  });

  it("falls back to RAAS strong identity and safely backfills local strong indexes", async () => {
    const identity = {
      name: `权威回填-${suffix}`,
      phone: `131${String(Date.now()).slice(-8)}`,
      email: `authoritative-${suffix}@example.com`,
    };
    const authoritative = await runCandidateDedupLookup(
      toolContext({
        lastResult: identity,
        eventData: { employee_id: "EMP-INCOMING" },
      }),
      {
        authoritativeLookup: async (request) => {
          expect(request).toMatchObject({
            lookupPhone: true,
            lookupNameEmail: true,
          });
          return {
            byPhone: {
              candidateId: "raas-authoritative-candidate",
              owner: "EMP-AUTHORITATIVE",
            },
            byNameEmail: null,
          };
        },
      },
    );

    expect(authoritative.data).toMatchObject({
      candidate_id: "raas-authoritative-candidate",
      same_as_candidate_id: "raas-authoritative-candidate",
      tier: "phone",
      is_new: false,
      lock_conflict: true,
    });

    let fallbackCalled = false;
    const cachedPair = await runCandidateDedupLookup(
      toolContext({
        lastResult: { name: identity.name, email: identity.email },
        eventData: { employee_id: "EMP-INCOMING" },
      }),
      {
        authoritativeLookup: async () => {
          fallbackCalled = true;
          throw new Error("backfilled name+email index was not used");
        },
      },
    );
    expect(fallbackCalled).toBe(false);
    expect(cachedPair.data).toMatchObject({
      candidate_id: "raas-authoritative-candidate",
      same_as_candidate_id: "raas-authoritative-candidate",
      tier: "name_email",
      is_new: false,
      lock_conflict: true,
    });
  });

  it("does not register a new candidate when the authoritative database fails", async () => {
    const identity = {
      name: `数据库失败-${suffix}`,
      phone: `132${String(Date.now()).slice(-8)}`,
    };
    let lookupCalls = 0;
    await expect(
      runCandidateDedupLookup(toolContext({ lastResult: identity }), {
        authoritativeLookup: async () => {
          lookupCalls += 1;
          throw new Error("RAAS PostgreSQL unavailable");
        },
      }),
    ).rejects.toThrow("RAAS PostgreSQL unavailable");

    const retry = await runCandidateDedupLookup(
      toolContext({ lastResult: identity }),
      {
        authoritativeLookup: async () => {
          lookupCalls += 1;
          return { byPhone: null, byNameEmail: null };
        },
      },
    );
    expect(lookupCalls).toBe(2);
    expect(retry.data).toMatchObject({ is_new: true, tier: null });
  });

  it("fails closed when authoritative lookup is required but RAAS_POSTGRES_URL is missing", async () => {
    await expect(
      runCandidateDedupLookup(
        toolContext({
          lastResult: {
            name: `缺少连接-${suffix}`,
            phone: `134${String(Date.now()).slice(-8)}`,
          },
        }),
        { connectionString: "" },
      ),
    ).rejects.toThrow(/reviewed postgres_url_env profile is required/);
  });

  it("rejects a PostgreSQL phone match that conflicts with a local name+email match", async () => {
    const pair = {
      name: `跨索引冲突-${suffix}`,
      email: `conflict-${suffix}@example.com`,
    };
    const local = await candidateDedupLookup.handler(
      toolContext({ lastResult: pair }),
    );

    await expect(
      runCandidateDedupLookup(
        toolContext({
          lastResult: {
            ...pair,
            phone: `133${String(Date.now()).slice(-8)}`,
          },
        }),
        {
          authoritativeLookup: async (request) => {
            expect(request).toMatchObject({
              lookupPhone: true,
              lookupNameEmail: false,
            });
            return {
              byPhone: { candidateId: "different-raas-candidate" },
              byNameEmail: null,
            };
          },
        },
      ),
    ).rejects.toThrow(
      new RegExp(
        `conflicting identity indexes.*different-raas-candidate.*${String(local.data.candidate_id)}`,
      ),
    );
  });

  it("creates a distinct candidate for a repeated six-field weak match", async () => {
    const profile = {
      name: `弱匹配-${suffix}`,
      gender: "女",
      education_history: [
        {
          institution: "清华大学",
          field: "计算机科学",
          degree: "本科",
          graduationYear: "2022年",
        },
      ],
    };
    const first = await candidateDedupLookup.handler(
      toolContext({
        lastResult: profile,
        eventData: { employee_id: "EMP-A" },
      }),
    );
    const second = await candidateDedupLookup.handler(
      toolContext({
        lastResult: profile,
        eventData: { employee_id: "EMP-B" },
      }),
    );

    expect(first.data).toMatchObject({
      same_as_candidate_id: null,
      matched_candidate_id: null,
      is_new: true,
      needs_review: false,
    });
    expect(second.data).toMatchObject({
      same_as_candidate_id: null,
      matched_candidate_id: first.data.candidate_id,
      tier: "six_fields",
      is_new: true,
      needs_review: true,
      lock_conflict: false,
    });
    expect(second.data.candidate_id).not.toBe(first.data.candidate_id);
  });

  it("requires name and email together for the second strong tier", async () => {
    const sharedEmail = `${suffix}@example.com`;
    const firstIdentity = {
      name: `姓名邮箱-A-${suffix}`,
      email: sharedEmail,
    };
    const first = await candidateDedupLookup.handler(
      toolContext({ lastResult: firstIdentity }),
    );
    const sameEmailDifferentName = await candidateDedupLookup.handler(
      toolContext({
        lastResult: { name: `姓名邮箱-B-${suffix}`, email: sharedEmail },
      }),
    );
    const sameNameDifferentEmail = await candidateDedupLookup.handler(
      toolContext({
        lastResult: {
          name: firstIdentity.name,
          email: `other-${suffix}@example.com`,
        },
      }),
    );
    const exactPair = await candidateDedupLookup.handler(
      toolContext({ lastResult: firstIdentity }),
    );

    expect(sameEmailDifferentName.data).toMatchObject({
      same_as_candidate_id: null,
      is_new: true,
    });
    expect(sameEmailDifferentName.data.candidate_id).not.toBe(
      first.data.candidate_id,
    );
    expect(sameNameDifferentEmail.data).toMatchObject({
      same_as_candidate_id: null,
      is_new: true,
    });
    expect(sameNameDifferentEmail.data.candidate_id).not.toBe(
      first.data.candidate_id,
    );
    expect(exactPair.data).toMatchObject({
      candidate_id: first.data.candidate_id,
      same_as_candidate_id: first.data.candidate_id,
      tier: "name_email",
      is_new: false,
    });
  });

  it("reads employee_id as owner and never treats the runtime subject as owner", async () => {
    const identity = {
      name: `强匹配-${suffix}`,
      phone: `136${String(Date.now()).slice(-8)}`,
    };
    const created = await candidateDedupLookup.handler(
      toolContext({
        lastResult: identity,
        eventData: { employee_id: "EMP-OWNER" },
      }),
    );
    const otherEmployee = await candidateDedupLookup.handler(
      toolContext({
        lastResult: identity,
        eventData: { employee_id: "EMP-OTHER" },
      }),
    );
    const genericSubjectOnly = await candidateDedupLookup.handler(
      toolContext({
        lastResult: identity,
        subject: "EMP-OTHER",
      }),
    );

    expect(otherEmployee.data).toMatchObject({
      candidate_id: created.data.candidate_id,
      tier: "phone",
      is_new: false,
      lock_conflict: true,
    });
    expect(genericSubjectOnly.data).toMatchObject({
      candidate_id: created.data.candidate_id,
      tier: "phone",
      is_new: false,
      lock_conflict: false,
    });
  });

  it("detects B-owns/A-uploads even when the event carries both identities", async () => {
    const identity = {
      name: `显式锁冲突-${suffix}`,
      phone: `135${String(Date.now()).slice(-8)}`,
    };
    const created = await candidateDedupLookup.handler(
      toolContext({
        lastResult: identity,
        eventData: { employee_id: "EMP-B" },
      }),
    );
    const conflict = await candidateDedupLookup.handler(
      toolContext({
        lastResult: identity,
        eventData: {
          employee_id: "EMP-A",
          locked_by_employee_id: "EMP-B",
        },
      }),
    );
    expect(conflict.data).toMatchObject({
      candidate_id: created.data.candidate_id,
      lock_conflict: true,
      locked_by_employee_id: "EMP-B",
      requesting_recruiter_id: "EMP-A",
    });
  });
});
