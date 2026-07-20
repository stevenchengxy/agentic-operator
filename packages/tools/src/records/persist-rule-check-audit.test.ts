import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildRuleCheckAuditAllmetaPayload,
  buildRuleCheckAuditRecord,
  persistRuleCheckAuditExternal,
  persistRuleCheckAuditWithSession,
  type PersistRuleCheckAuditExternalArgs,
} from "./persist-rule-check-audit";

function input(
  overrides: Partial<PersistRuleCheckAuditExternalArgs> = {},
): PersistRuleCheckAuditExternalArgs {
  return {
    tenantSlug: "zhaopin",
    ontologyActionName: "ruleCheckForMatchResume",
    agentName: "generated-rule-check-agent",
    correlationId: "trace-1",
    runId: "run-1",
    eventData: {
      upload_id: "upload-1",
      candidate_id: "candidate-1",
      resume_id: "resume-1",
      job_requisition_id: "jr-1",
      parsed_resume: { skills: ["TypeScript"] },
      job_requisition: {
        job_requisition_id: "jr-1",
        client_id: "client-1",
        business_group: "BG-1",
      },
    },
    lastResult: {
      nested_reasoning_run_id: "reasoning-run-1",
      rule_decision: "eligible_with_flags",
      reasoning_rule_engine: {
        decision: "eligible_with_flags",
        ruleBundleId: "bundle-1",
        ruleCount: 2,
        missingEvidence: [],
        assessments: [
          {
            ruleId: "10-25",
            ruleName: "mandatory clear",
            enforcementLevel: "mandatory",
            failurePolicy: "block",
            status: "satisfied",
            reason: "history is outside cooldown",
            evidence: ["application_history[0].ended_at=2025-01-01"],
          },
          {
            ruleId: "10-51",
            ruleName: "optional approval",
            enforcementLevel: "optional",
            failurePolicy: "warn",
            status: "optional_unmet",
            reason: "approval evidence was not supplied",
            evidence: [],
          },
        ],
        audit: {
          input: { userPrompt: "evaluate this candidate" },
          compiledPrompt: { systemPrompt: "apply the selected rules" },
          qualityCheck: {
            run: {
              model: "qualified-model",
              durationMs: 42,
              tokensIn: 120,
              tokensOut: 30,
              steps: 1,
            },
          },
          ruleSelection: {
            source: "allmeta",
            selectedRules: [{ id: "10-25" }, { id: "10-51" }],
          },
        },
      },
    },
    config: {
      tenant: "zhaopin",
      domain: "Agents-generation",
      action: "ruleCheckForMatchResume",
      postgres_url_env: "RAAS_POSTGRES_URL",
      allmeta_base_url_env: "ALLMETA_BASE_URL",
      allmeta_api_key_env: "ALLMETA_API_KEY",
    },
    env: {
      RAAS_POSTGRES_URL: "postgresql://raas.test/audit",
      ALLMETA_BASE_URL: "http://allmeta.test",
      ALLMETA_API_KEY: "secret",
    },
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("persistRuleCheckAudit contract", () => {
  it("folds explicit mandatory/optional evidence and builds a stable audit", () => {
    const args = input();
    const first = buildRuleCheckAuditRecord(args, {
      tenant: "zhaopin",
      domain: "Agents-generation",
      action: "ruleCheckForMatchResume",
    });
    const replay = buildRuleCheckAuditRecord(args, {
      tenant: "zhaopin",
      domain: "Agents-generation",
      action: "ruleCheckForMatchResume",
    });

    expect(first.audit_id).toBe(replay.audit_id);
    expect(first.audit_id).toMatch(/^rca_[a-f0-9]{40}$/);
    expect(first).toMatchObject({
      decision: "PASS",
      rules_evaluated: 2,
      rules_total_in_ontology: 2,
      llm_model: "qualified-model",
      llm_duration_ms: 42,
      llm_prompt_tokens: 120,
      llm_completion_tokens: 30,
      client_name: "client-1",
      business_group: "BG-1",
    });
    expect(first.flags).toEqual([
      expect.objectContaining({
        rule_id: "10-25",
        enforcement_level: "mandatory",
        result: "PASS",
        next_action: "continue",
      }),
      expect.objectContaining({
        rule_id: "10-51",
        enforcement_level: "optional",
        result: "FAIL",
        severity: "flag_only",
        next_action: "continue",
      }),
    ]);

    const allmeta = buildRuleCheckAuditAllmetaPayload(first);
    expect(allmeta).toMatchObject({
      audit_id: first.audit_id,
      decision: "PASS",
      rules_evaluated: 2,
      rule_source: "allmeta",
    });
    expect(JSON.parse(String(allmeta.rule_provenance))).toEqual([
      expect.objectContaining({
        rule_id: "10-25",
        status: "satisfied",
        evidence: ["application_history[0].ended_at=2025-01-01"],
      }),
      expect.objectContaining({
        rule_id: "10-51",
        status: "optional_unmet",
        blocking: false,
      }),
    ]);
  });

  it("writes PostgreSQL before optional Allmeta and returns exact receipts", async () => {
    const order: string[] = [];
    const result = await persistRuleCheckAuditExternal(input(), {
      postgres: async ({ audit }) => {
        order.push("postgres");
        expect(audit.flags).toHaveLength(2);
      },
      allmeta: async ({ domain, audit }) => {
        order.push("allmeta");
        expect(domain).toBe("Agents-generation");
        expect(audit.audit_id).toMatch(/^rca_/);
      },
    });

    expect(order).toEqual(["postgres", "allmeta"]);
    expect(result.receipt).toMatchObject({
      decision: "PASS",
      rules_evaluated: 2,
      postgres: "written",
      allmeta: "written",
      domain: "Agents-generation",
      action: "ruleCheckForMatchResume",
    });
  });

  it("uses only Allmeta's strict HTTP instance API when mirroring", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ upserted: ["audit"] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await persistRuleCheckAuditExternal(input(), {
      postgres: async () => undefined,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(
      "http://allmeta.test/api/v1/ontology/instances/Rule_Check_Audit?domain=Agents-generation&validate=strict",
    );
    expect(init).toMatchObject({ method: "POST", redirect: "error" });
    expect(init?.headers).toMatchObject({ Authorization: "Bearer secret" });
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({
      domainId: "Agents-generation",
      decision: "PASS",
      candidate_id: "candidate-1",
    });
  });

  it("fails before persistence on missing scope/evidence or inconsistent folds", async () => {
    const postgres = vi.fn();
    await expect(
      persistRuleCheckAuditExternal(
        input({
          config: {
            ...input().config,
            tenant: "another-tenant",
          },
        }),
        { postgres },
      ),
    ).rejects.toThrow(/tenant scope mismatch/);

    const mismatch = input();
    mismatch.lastResult = {
      ...(mismatch.lastResult as Record<string, unknown>),
      rule_decision: "eligible",
      reasoning_rule_engine: {
        ...((mismatch.lastResult as Record<string, unknown>)
          .reasoning_rule_engine as Record<string, unknown>),
        decision: "eligible",
        assessments: [
          {
            ruleId: "10-46",
            ruleName: "credential hard block",
            enforcementLevel: "mandatory",
            failurePolicy: "block",
            status: "violated",
            reason: "credential is absent",
            evidence: ["compliance_document.status=missing"],
          },
        ],
        ruleCount: 1,
      },
    };
    await expect(
      persistRuleCheckAuditExternal(mismatch, { postgres }),
    ).rejects.toThrow(/claimed decision PASS.*fold FAIL/);
    expect(postgres).not.toHaveBeenCalled();
  });

  it("requires explicit enforcement and keeps infrastructure failures out of business audit", async () => {
    const noEnforcement = input();
    const result = noEnforcement.lastResult as Record<string, unknown>;
    const reasoning = result.reasoning_rule_engine as Record<string, unknown>;
    reasoning.assessments = [
      {
        ruleId: "ambiguous",
        status: "satisfied",
        reason: "no enforcement metadata",
      },
    ];
    reasoning.ruleCount = 1;
    await expect(
      persistRuleCheckAuditExternal(noEnforcement, {
        postgres: async () => undefined,
      }),
    ).rejects.toThrow(/no explicit enforcement level/);

    const infra = input({
      eventData: {
        ...input().eventData,
        fail_reason: "llm-call-error",
      },
    });
    await expect(
      persistRuleCheckAuditExternal(infra, {
        postgres: async () => undefined,
      }),
    ).rejects.toThrow(/must be parked\/retried/);
  });

  it("atomically replaces per-rule rows and rolls back any failed write", async () => {
    const audit = buildRuleCheckAuditRecord(input(), {
      tenant: "zhaopin",
      domain: "Agents-generation",
      action: "ruleCheckForMatchResume",
    });
    const queries: string[] = [];
    await persistRuleCheckAuditWithSession(
      {
        query: vi.fn(async (sql: string) => {
          queries.push(sql);
          return {};
        }),
      },
      audit,
    );
    expect(queries[0]).toBe("BEGIN");
    expect(queries.some((sql) => sql.includes('INSERT INTO "RuleCheckAudit"'))).toBe(true);
    expect(queries.some((sql) => sql.includes('DELETE FROM "RuleCheckFlag"'))).toBe(true);
    expect(
      queries.filter((sql) => sql.includes('INSERT INTO "RuleCheckFlag"')),
    ).toHaveLength(2);
    expect(queries.at(-1)).toBe("COMMIT");

    const rollback: string[] = [];
    await expect(
      persistRuleCheckAuditWithSession(
        {
          query: vi.fn(async (sql: string) => {
            rollback.push(sql);
            if (sql.includes('INSERT INTO "RuleCheckFlag"')) {
              throw new Error("flag table unavailable");
            }
            return {};
          }),
        },
        audit,
      ),
    ).rejects.toThrow("flag table unavailable");
    expect(rollback.at(-1)).toBe("ROLLBACK");
    expect(rollback).not.toContain("COMMIT");
  });
});

