import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "@agentic/agent-kit";
import { fetchActionRules } from "../../../packages/tools/src/ontology/fetch-action-rules";
import { evaluateMatchRules } from "../../../tenants/zhaopin/src/tools/evaluate-match-rules";
import { foldRuleDecision } from "../../../tenants/zhaopin/src/tools/rule-fold-logic";

const SAVED_ENV = {
  TEST_RULES_BASE_URL: process.env.TEST_RULES_BASE_URL,
  TEST_RULES_API_KEY: process.env.TEST_RULES_API_KEY,
};

const LIVE_RAAS_RULE_IDS = [
  "10-25",
  "10-26",
  "10-35",
  "10-49",
  "10-43",
  "10-56",
  "10-51",
  "10-45",
  "10-42",
  "10-34",
  "10-32",
];

const liveRules = LIVE_RAAS_RULE_IDS.map((id) => ({
  id,
  enforcementLevel: "mandatory",
}));

function restoreEnv(name: keyof typeof SAVED_ENV): void {
  const value = SAVED_ENV[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function toolContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    agentName: "ruleCheckForMatchResume",
    actionName: "ruleCheckForMatchResume",
    correlationId: "corr-test",
    tenantSlug: "zhaopin",
    event: { name: "RESUME_PROCESSED", data: {} },
    ontologyActionName: "ruleCheckForMatchResume",
    config: {
      base_url_env: "TEST_RULES_BASE_URL",
      api_key_env: "TEST_RULES_API_KEY",
      domain: "RAAS-v1",
      action: "ruleCheckForMatchResume",
    },
    ...overrides,
  };
}

afterEach(() => {
  restoreEnv("TEST_RULES_BASE_URL");
  restoreEnv("TEST_RULES_API_KEY");
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("ontology.fetchActionRules runtime hardening", () => {
  it("uses profile timeout_ms through AbortSignal and fails closed on timeout", async () => {
    process.env.TEST_RULES_BASE_URL = "https://allmeta.example";
    process.env.TEST_RULES_API_KEY = "test-key";

    let receivedSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string | URL | Request, init?: RequestInit) => {
        receivedSignal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          receivedSignal?.addEventListener(
            "abort",
            () =>
              reject(
                receivedSignal?.reason ??
                  new DOMException("aborted", "AbortError"),
              ),
            { once: true },
          );
        });
      }),
    );

    await expect(fetchActionRules.handler(toolContext({
      config: {
        ...toolContext().config,
        timeout_ms: 10,
      },
    }))).rejects.toThrow(
      /timed out after 10ms.*fail closed/i,
    );
    expect(receivedSignal).toBeInstanceOf(AbortSignal);
    expect(receivedSignal?.aborted).toBe(true);
  });

  it("fails closed on a non-2xx Allmeta response", async () => {
    process.env.TEST_RULES_BASE_URL = "https://allmeta.example";
    process.env.TEST_RULES_API_KEY = "test-key";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("service unavailable", { status: 503 })),
    );

    await expect(fetchActionRules.handler(toolContext())).rejects.toThrow(
      /Allmeta HTTP 503.*fail closed/i,
    );
  });

  it("fails closed on a network error", async () => {
    process.env.TEST_RULES_BASE_URL = "https://allmeta.example";
    process.env.TEST_RULES_API_KEY = "test-key";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("network unreachable");
      }),
    );

    await expect(fetchActionRules.handler(toolContext())).rejects.toThrow(
      /network unreachable.*fail closed/i,
    );
  });

  it("keeps two rule-check actions isolated and accepts only explicit executor/enforcement values", async () => {
    process.env.TEST_RULES_BASE_URL = "https://allmeta.example";
    process.env.TEST_RULES_API_KEY = "test-key";
    const requested: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: URL | RequestInfo) => {
      requested.push(String(input));
      return new Response(JSON.stringify({
        rules: [
          { id: "agent-mandatory", executor: "Agent", enforcementLevel: "mandatory" },
          { id: "agent-optional", executor: "Agent", mandatory: false },
          { id: "agent-boolean", executor: "Agent", mandatory: true },
          { id: "human", executor: "Human", enforcementLevel: "mandatory" },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }));

    for (const action of ["ruleCheckForMatchResume", "ruleCheckForInterviewInvitation"]) {
      const result = await fetchActionRules.handler(toolContext({
        agentName: action,
        ontologyActionName: action,
        config: {
          ...toolContext().config,
          action,
        },
      }));
      const data = result.data as { rules: Array<{ id: string }>; mandatory: Array<{ id: string }> };
      expect(data.rules.map((rule) => rule.id)).toEqual([
        "agent-mandatory",
        "agent-optional",
        "agent-boolean",
      ]);
      expect(data.mandatory.map((rule) => rule.id)).toEqual([
        "agent-mandatory",
        "agent-boolean",
      ]);
    }
    expect(requested).toHaveLength(2);
    expect(requested[0]).toContain("/ruleCheckForMatchResume/rules?domain=RAAS-v1");
    expect(requested[1]).toContain("/ruleCheckForInterviewInvitation/rules?domain=RAAS-v1");
  });

  it("fails closed on missing or fuzzy executor/enforcement data instead of hiding it", async () => {
    process.env.TEST_RULES_BASE_URL = "https://allmeta.example";
    process.env.TEST_RULES_API_KEY = "test-key";
    const malformed = [
      { id: "missing-executor", enforcementLevel: "mandatory" },
      { id: "fuzzy-executor", executor: "Agentic", enforcementLevel: "mandatory" },
      { id: "missing-enforcement", executor: "Agent" },
      { id: "fuzzy-enforcement", executor: "Agent", enforcementLevel: "mandatory-ish" },
    ];
    for (const rule of malformed) {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(
        JSON.stringify({ rules: [rule] }),
        { status: 200, headers: { "content-type": "application/json" } },
      )));
      await expect(fetchActionRules.handler(toolContext())).rejects.toThrow(
        /invalid or missing (?:executor|enforcementLevel).*fail closed/i,
      );
    }
  });

  it("rejects a profile bound to a different ontology action before network", async () => {
    process.env.TEST_RULES_BASE_URL = "https://allmeta.example";
    process.env.TEST_RULES_API_KEY = "test-key";
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(fetchActionRules.handler(toolContext({
      ontologyActionName: "ruleCheckForInterviewInvitation",
    }))).rejects.toThrow(/does not match profile action.*fail closed/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("zhaopin unknown live-rule policy", () => {
  it("blocks an unknown mandatory rule for manual review instead of passing it", async () => {
    const result = await evaluateMatchRules.handler(
      toolContext({
        lastResult: {
          source: "allmeta",
          rules: [
            {
              id: "NEW-MANDATORY-1",
              businessLogicRuleName: "新强制合规规则",
              enforcementLevel: "mandatory",
            },
          ],
        },
      }),
    );

    const data = result.data as {
      rule_results: Array<Record<string, unknown>>;
    };
    expect(data.rule_results[0]).toMatchObject({
      rule_id: "NEW-MANDATORY-1",
      status: "insufficient_info",
      flag_only: false,
    });
    expect(foldRuleDecision(data)).toMatchObject({
      decision: "fail",
      emit: "MATCH_RULE_CHECK_FAILED",
    });
  });

  it("marks an unknown optional rule for review without blocking", async () => {
    const result = await evaluateMatchRules.handler(
      toolContext({
        lastResult: {
          source: "allmeta",
          rules: [
            {
              id: "NEW-OPTIONAL-1",
              businessLogicRuleName: "新可选建议规则",
              enforcementLevel: "optional",
            },
          ],
        },
      }),
    );

    const data = result.data as {
      rule_results: Array<Record<string, unknown>>;
    };
    expect(data.rule_results[0]).toMatchObject({
      rule_id: "NEW-OPTIONAL-1",
      status: "insufficient_info",
      flag_only: true,
    });
    expect(foldRuleDecision(data)).toMatchObject({
      decision: "pass",
      emit: "MATCH_RULE_CHECK_PASSED",
    });
  });

  it("does not pass a known employer rule without structured work-history facts", async () => {
    const result = await evaluateMatchRules.handler(
      toolContext({
        lastResult: {
          source: "allmeta",
          rules: [{ id: "10-25", enforcementLevel: "mandatory" }],
        },
      }),
    );
    expect(result.data).toMatchObject({
      rule_results: [
        {
          rule_id: "10-25",
          status: "insufficient_info",
          flag_only: false,
        },
      ],
    });
    expect(foldRuleDecision(result.data)).toMatchObject({ decision: "fail" });
  });

  it("uses structured employer records and exit dates for cooldown decisions", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-13T00:00:00Z"));

    const recent = await evaluateMatchRules.handler(
      toolContext({
        event: {
          name: "RESUME_PROCESSED",
          data: {
            resume: JSON.stringify({
              experience: [{ company: "Huawei", endDate: "2026-06-01" }],
            }),
          },
        },
        lastResult: {
          source: "allmeta",
          rules: [{ id: "10-25", enforcementLevel: "mandatory" }],
        },
      }),
    );
    expect(recent.data).toMatchObject({
      rule_results: [{ rule_id: "10-25", status: "fail", flag_only: false }],
    });

    const expired = await evaluateMatchRules.handler(
      toolContext({
        event: {
          name: "RESUME_PROCESSED",
          data: {
            resume: JSON.stringify({
              experience: [{ company: "Huawei", endDate: "2026-01-01" }],
            }),
          },
        },
        lastResult: {
          source: "allmeta",
          rules: [{ id: "10-25", enforcementLevel: "mandatory" }],
        },
      }),
    );
    expect(expired.data).toMatchObject({
      rule_results: [{ rule_id: "10-25", status: "pass", flag_only: false }],
    });

    const noExitDate = await evaluateMatchRules.handler(
      toolContext({
        event: {
          name: "RESUME_PROCESSED",
          data: {
            resume: JSON.stringify({
              experience: [{ company: "Huawei" }],
            }),
          },
        },
        lastResult: {
          source: "allmeta",
          rules: [{ id: "10-25", enforcementLevel: "mandatory" }],
        },
      }),
    );
    expect(noExitDate.data).toMatchObject({
      rule_results: [
        { rule_id: "10-25", status: "insufficient_info", flag_only: false },
      ],
    });
  });

  it("fails the 11-rule gate when required resume/application facts are absent", async () => {
    const result = await evaluateMatchRules.handler(
      toolContext({
        lastResult: {
          source: "allmeta",
          rules: liveRules,
          mandatory: liveRules,
        },
      }),
    );
    const data = result.data as {
      rule_results: Array<{ rule_id: string; status: string }>;
    };
    const byId = Object.fromEntries(
      data.rule_results.map((rule) => [rule.rule_id, rule.status]),
    );

    // 10-35 explicitly defaults an omitted nationality to Chinese in the live
    // ontology.  All history-dependent rules remain unresolved, including the
    // non-employer 10-32 position-cooldown rule.
    expect(byId["10-35"]).toBe("pass");
    for (const id of LIVE_RAAS_RULE_IDS.filter(
      (ruleId) => ruleId !== "10-35",
    )) {
      expect(byId[id]).toBe("insufficient_info");
    }
    expect(foldRuleDecision(data)).toMatchObject({
      decision: "fail",
      emit: "MATCH_RULE_CHECK_FAILED",
    });
  });

  it("still lets a fully evidenced clean candidate pass all 11 live rules", async () => {
    const result = await evaluateMatchRules.handler(
      toolContext({
        event: {
          name: "RESUME_PROCESSED",
          data: {
            resume: JSON.stringify({
              nationality: "中国",
              experience: [
                {
                  company: "腾讯",
                  employment_type: "正式",
                  endDate: "2025-01-01",
                },
              ],
            }),
            job_requisition_id: "JR-CLEAN-1",
            client_name: "阿里巴巴",
            application_history: [],
          },
        },
        lastResult: {
          source: "allmeta",
          rules: liveRules,
          mandatory: liveRules,
        },
      }),
    );
    const data = result.data as {
      rule_results: Array<{ rule_id: string; status: string }>;
    };
    expect(data.rule_results).toHaveLength(11);
    expect(data.rule_results.every((rule) => rule.status === "pass")).toBe(
      true,
    );
    expect(foldRuleDecision(data)).toMatchObject({
      decision: "pass",
      emit: "MATCH_RULE_CHECK_PASSED",
    });
  });

  it("requires target-client/channel facts before a foreign candidate can pass 10-35", async () => {
    const evaluate = (extra: Record<string, unknown>) =>
      evaluateMatchRules.handler(
        toolContext({
          event: {
            name: "RESUME_PROCESSED",
            data: {
              resume: JSON.stringify({ nationality: "美国", experience: [] }),
              ...extra,
            },
          },
          lastResult: {
            source: "allmeta",
            rules: [{ id: "10-35", enforcementLevel: "mandatory" }],
          },
        }),
      );

    await expect(evaluate({})).resolves.toMatchObject({
      data: { rule_results: [{ status: "insufficient_info" }] },
    });
    await expect(
      evaluate({ client_name: "腾讯", job_type: "普通外包" }),
    ).resolves.toMatchObject({
      data: { rule_results: [{ status: "fail" }] },
    });
    await expect(
      evaluate({ client_name: "腾讯", job_type: "外籍人国内工作" }),
    ).resolves.toMatchObject({
      data: { rule_results: [{ status: "pass" }] },
    });
  });

  it("evaluates 10-32 from same-position history instead of employer tokens", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-13T00:00:00Z"));
    const result = await evaluateMatchRules.handler(
      toolContext({
        event: {
          name: "RESUME_PROCESSED",
          data: {
            job_requisition_id: "JR-32",
            application_history: [
              {
                job_requisition_id: "JR-32",
                status: "面试淘汰",
                occurred_at: "2026-06-20",
              },
            ],
          },
        },
        lastResult: {
          source: "allmeta",
          rules: [{ id: "10-32", enforcementLevel: "mandatory" }],
        },
      }),
    );
    expect(result.data).toMatchObject({
      rule_results: [{ rule_id: "10-32", status: "fail" }],
    });
  });

  it("uses trusted platform facts accumulated by a preceding RAAS context tool", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-13T00:00:00Z"));
    const result = await evaluateMatchRules.handler(
      toolContext({
        event: {
          name: "RESUME_PROCESSED",
          data: { job_requisition_id: "JR-CONTEXT" },
        },
        lastResult: {
          source: "allmeta",
          rules: [{ id: "10-32", enforcementLevel: "mandatory" }],
          application_history: [
            {
              job_requisition_id: "JR-CONTEXT",
              status: "筛选淘汰",
              occurred_at: "2026-07-01",
            },
          ],
        },
      }),
    );
    expect(result.data).toMatchObject({
      rule_results: [{ rule_id: "10-32", status: "fail" }],
    });
  });
});
