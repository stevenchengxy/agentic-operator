import { describe, expect, it } from "vitest";
import {
  ReasoningAgent,
  auditExtractedEvidenceFacts,
  auditRuleEvidencePlan,
  compactQualificationToolData,
  deriveRuleSelectionQueryIr,
  finalizeReasoningOutput,
  foldRuleDecision,
  normalizeRule,
  normalizeRuleQueryExecution,
  normalizeRuleQueryExecutions,
  normalizeSelectionQueryIr,
  resolveTargetRuleScope,
  type RuleAssessment,
  type RuleBundle,
  type ReasoningHarnessPlan,
  type RuleQueryExecution,
} from "./reasoning-agent";
import type { AgentContext } from "../types";
import { agentRegistry } from "../registry";
import { compileQualificationPrompt } from "./prompt-compiler";

class InspectableReasoningAgent extends ReasoningAgent {
  messages(input: unknown, correlationId: string) {
    return this.buildMessages(
      input as never,
      {
        tenantSlug: "tenant-a",
        correlationId,
        runId: correlationId,
      } as AgentContext,
    );
  }
}

function bundle(): RuleBundle {
  return {
    bundleId: "sha256:test",
    domainId: "rules-test",
    action: "ruleCheckForMatchResume",
    scenario: "pre_match_resume_rule_check",
    fetchedAt: "2026-07-13T00:00:00.000Z",
    queryIr: {
      version: "rule-link-query-ir/v2",
      domainId: "rules-test",
      actionHint: "ruleCheckForMatchResume",
      query: "ruleCheckForMatchResume",
      intentTerms: ["简历匹配"],
      capabilityAnchors: ["简历规则检查"],
      objectAnchors: ["Candidate", "Resume", "Job_Requisition"],
      evidenceAnchors: [],
      strongKeywords: ["简历匹配"],
      keywords: ["简历匹配"],
      objectTypes: ["Candidate", "Resume", "Job_Requisition"],
      applicableClient: "",
      applicableDepartment: "",
      executor: "Agent",
      enforcementLevels: ["mandatory", "optional"],
      allowedRelationships: [
        "SCOPED_TO",
        "GOVERNS",
        "APPLIES_TO",
        "RELEVANT_TO",
      ],
      maxHops: 2,
      limit: 40,
    },
    actionSteps: [],
    rules: [
      {
        id: "M-1",
        name: "硬性学历要求",
        logic: "学历必须满足职位要求。",
        submissionCriteria: "",
        businessReason: "",
        enforcementLevel: "mandatory",
        failurePolicy: "block",
        executor: "Agent",
        applicableClient: "",
        applicableDepartment: "",
        relatedEntities: ["Resume", "Job_Requisition"],
        relatedObjectTypes: ["Resume", "Job_Requisition"],
        linkedActions: ["ruleCheckForMatchResume"],
        applicabilityScope: "csi_universal",
        selectionScore: 170,
        matchReasons: ["SCOPED_TO:csi:universal"],
        linkPaths: [
          {
            linkId: "link-M-1-scope",
            status: "active",
            confidence: 1,
            subject: { type: "Rule", id: "M-1", displayName: "硬性学历要求" },
            predicate: "SCOPED_TO",
            object: {
              type: "PolicyScope",
              id: "csi:universal",
              displayName: "CSI 通用",
            },
            semanticRelationship: "硬性学历要求适用于 CSI 通用作用域",
            evidence: ["applicableClient=通用"],
          },
        ],
        matchedAnchors: ["csi:universal"],
        scopeReason: "SCOPED_TO csi:universal",
      },
      {
        id: "O-1",
        name: "优选行业经验",
        logic: "具备同行业经验优先。",
        submissionCriteria: "",
        businessReason: "",
        enforcementLevel: "optional",
        failurePolicy: "warn",
        executor: "Agent",
        applicableClient: "",
        applicableDepartment: "",
        relatedEntities: ["Candidate", "JD"],
        relatedObjectTypes: ["Candidate"],
        linkedActions: [],
        applicabilityScope: "csi_universal",
        selectionScore: 31,
        matchReasons: ["SCOPED_TO:csi:universal", "keyword:行业"],
        linkPaths: [
          {
            linkId: "link-O-1-scope",
            status: "active",
            confidence: 1,
            subject: { type: "Rule", id: "O-1", displayName: "优选行业经验" },
            predicate: "SCOPED_TO",
            object: {
              type: "PolicyScope",
              id: "csi:universal",
              displayName: "CSI 通用",
            },
            semanticRelationship: "优选行业经验适用于 CSI 通用作用域",
            evidence: ["applicableClient=通用"],
          },
        ],
        matchedAnchors: ["csi:universal", "行业"],
        scopeReason: "SCOPED_TO csi:universal",
      },
    ],
  };
}

function finalAuditContext(
  testBundle: RuleBundle = bundle(),
  evidence: Record<string, unknown> = {
    candidate: { industry_experience: false },
    resume: {
      education: "大专",
      industry: "互联网",
      employment_history: [
        { end_date: "2021-01-15" },
        { end_date: "2026-05-20" },
      ],
    },
    jd: { education: "本科" },
  },
) {
  const harnessPlan: ReasoningHarnessPlan = {
    version: "reasoning-harness/v2",
    methods: ["graph_react", "evidence_grounding", "rule_by_rule_verification"],
    capabilityAnchors: ["简历规则检查"],
    objectAnchors: ["Candidate", "Resume", "Job_Requisition"],
    evidenceAnchors: [],
    stopConditions: ["每条规则均完成判定"],
    publicRationale: "沿本体语义 Links 检索并逐条核验规则。",
  };
  const queryExecution: RuleQueryExecution = {
    purpose: "semantic-rule-selection",
    language: "cypher",
    query:
      "MATCH (r:Rule {domainId: $domainId})-[:SCOPED_TO]->(scope:PolicyScope) RETURN r, scope",
    parameters: { domainId: "rules-test" },
    fingerprint: "sha256:test-query",
    readOnly: true,
    domainLocked: true,
    linkOnly: true,
    fallbackUsed: false,
    durationMs: 3,
    rowCount: 2,
    pathPattern: "(Rule)-[:SCOPED_TO]->(PolicyScope)",
  };
  const coverageExecution: RuleQueryExecution = {
    ...queryExecution,
    purpose: "mandatory-link-coverage",
    query:
      'MATCH (r:Rule {domainId: $domainId, enforcementLevel: "mandatory"}) OPTIONAL MATCH (r)-[:SCOPED_TO]->(scope:PolicyScope) RETURN r, scope',
    fingerprint: "sha256:test-coverage-query",
    rowCount: 0,
  };
  const fallbackCompiler = compileQualificationPrompt({
    domainId: testBundle.domainId,
    action: testBundle.action,
    scenario: testBundle.scenario,
    userPrompt: "deterministic-finalize",
    evidence: {},
    queryIr: testBundle.queryIr,
    rules: testBundle.rules,
    harnessPlan,
  });
  return {
    parentRunId: "run-parent-test",
    correlationId: "cor-test",
    userPrompt: "test",
    evidence,
    harnessPlan,
    queryExecution,
    queryExecutions: [queryExecution, coverageExecution],
    queryDiagnostics: null,
    trace: [],
    qualifiedRun: {
      role: "qualified" as const,
      executionMode: "isolated-child-run" as const,
      runId: "run-qualified-test",
      parentRunId: "run-parent-test",
      correlationId: "cor-test",
      compilerId: fallbackCompiler.compilerId,
      promptSha256: fallbackCompiler.promptSha256,
      ruleBundleId: "sha256:test",
      provider: "test-provider",
      model: "test-model",
      tokensIn: 10,
      tokensOut: 5,
      durationMs: 12,
      steps: 1,
      assessmentCount: 2,
    },
  };
}

function temporalBundle(thresholdMonths = 6): RuleBundle {
  const testBundle = bundle();
  testBundle.rules[0] = {
    ...testBundle.rules[0]!,
    name: "通用离职间隔规则",
    logic: `若候选人历史经历离职不满${thresholdMonths}个月，则拦截；离职满${thresholdMonths}个月及以上允许继续。`,
    submissionCriteria: "候选人历史任职经历包含可核验的离职日期。",
  };
  return testBundle;
}

function temporalEvidence(endDate: string): Record<string, unknown> {
  return {
    evaluation_context: { as_of_date: "2026-07-14" },
    active_locks: [],
    resume: {
      industry: "互联网",
      employment_history: [
        {
          company: "历史任职单位",
          studio: "原工作室",
          end_date: endDate,
        },
      ],
    },
    jobRequisition: { client_studio: "目标工作室" },
  };
}

describe("reasoning agent deterministic rule fold", () => {
  it("deploys only the Reasoning orchestrator and never registers an internal QualifiedAgent", () => {
    const agent = new ReasoningAgent();
    expect(agent.inngestEnabled).toBe(true);
    expect(agentRegistry.get("qualifiedAgent")).toBeUndefined();
    expect(agentRegistry.get("reasoningQualifiedAgent")).toBeUndefined();
  });

  it("returns only a compact compiler receipt to the outer orchestrator", () => {
    const testBundle = bundle();
    const auditContext = finalAuditContext();
    const compiled = compileQualificationPrompt({
      domainId: testBundle.domainId,
      action: testBundle.action,
      scenario: testBundle.scenario,
      userPrompt: "deterministic-finalize",
      evidence: {},
      queryIr: testBundle.queryIr,
      rules: testBundle.rules,
      harnessPlan: auditContext.harnessPlan,
    });
    const data = compactQualificationToolData(
      compiled,
      {
        ...auditContext.qualifiedRun,
        compilerId: compiled.compilerId,
        promptSha256: compiled.promptSha256,
      },
      testBundle.rules.length,
    );

    expect(Object.keys(data).sort()).toEqual([
      "assessmentCount",
      "compilerReceipt",
      "qualifiedRun",
      "ruleCount",
    ]);
    expect(data.compilerReceipt).toEqual({
      compilerId: compiled.compilerId,
      compilerVersion: compiled.compilerVersion,
      promptSha256: compiled.promptSha256,
      fullSemanticPathsSha256: compiled.fullSemanticPathsSha256,
    });
    expect(data.ruleCount).toBe(2);
    expect(JSON.stringify(data)).not.toContain(compiled.systemPrompt);
    expect(JSON.stringify(data)).not.toContain(compiled.userPrompt);
    expect(Buffer.byteLength(JSON.stringify(data))).toBeLessThan(1_500);
  });

  it("makes the selected RuleBundle immutable after compilation starts", async () => {
    const agent = new InspectableReasoningAgent();
    const runId = "run-phase-guard";
    agent.messages(
      {
        prompt: "检查规则",
        domainId: "rules-test",
        action: "ruleCheckForMatchResume",
      },
      runId,
    );
    const internal = agent as unknown as {
      states: Map<string, { phase: string }>;
    };
    internal.states.get(runId)!.phase = "compiled";
    const handlers = agent.getToolHandlers({
      tenantSlug: "tenant-a",
      correlationId: runId,
      runId,
    } as AgentContext);

    await expect(handlers.select_applicable_rules!({})).rejects.toThrow(
      /not allowed after phase=compiled/,
    );
  });

  it("records only runtime-resolved evidence facts and a bounded fact-to-rule plan", () => {
    const evidence = {
      candidate: { name: "林澈" },
      jobRequisition: { client_name: "腾讯" },
      resume: {
        employment_history: [
          { company: "荣耀终端有限公司", end_date: "2026-06-20" },
        ],
      },
      evaluation_context: { as_of_date: "2026-07-14" },
    };
    const analysis = auditExtractedEvidenceFacts(
      [
        {
          category: "target_job",
          purpose: "scope_selection",
          label: "目标客户",
          evidencePath: "jobRequisition.client_name",
          relevance: "决定客户规则作用域",
        },
        {
          category: "risk_signal",
          purpose: "scope_selection",
          label: "简历历史客户不能决定目标作用域",
          evidencePath: "resume.employment_history[0].company",
          relevance: "模型误标的 scope purpose 必须被 runtime 降级",
        },
        {
          category: "risk_signal",
          purpose: "rule_evaluation",
          label: "不存在的事实",
          evidencePath: "resume.employment_history[9].company",
          relevance: "必须被标记为未验证",
        },
      ],
      evidence,
    );

    expect(analysis).toMatchObject({
      verifiedCount: 2,
      unverifiedCount: 1,
      facts: [
        { value: "腾讯", verified: true },
        {
          value: "荣耀终端有限公司",
          verified: true,
          purpose: "rule_evaluation",
        },
        { value: null, verified: false },
      ],
    });
    expect(analysis.temporalFacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "resume.employment_history[0].end_date",
          completedCalendarMonths: 0,
        }),
      ]),
    );
    expect(
      auditExtractedEvidenceFacts(
        [
          {
            category: "qualification",
            purpose: "rule_evaluation",
            label: "技能",
            evidencePath: "resume.skills",
            relevance: "用于技能规则判定",
          },
        ],
        { resume: { skills: ["React", "TypeScript"] } },
      ).facts[0],
    ).toMatchObject({
      value: '["React","TypeScript"]',
      verified: true,
    });

    const plan = auditRuleEvidencePlan(
      [
        {
          ruleId: "M-1",
          relevance: "direct",
          evidencePaths: ["resume.employment_history[0].company"],
          summary: "近期荣耀经历需要按红线核验",
        },
      ],
      evidence,
      bundle().rules,
    );
    expect(plan).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "M-1",
          relevance: "direct",
          evidence: [
            expect.objectContaining({
              actualValue: "荣耀终端有限公司",
              verified: true,
            }),
          ],
        }),
        expect.objectContaining({
          ruleId: "O-1",
          relevance: "no_direct_signal",
        }),
      ]),
    );
  });

  it("requires a caller-supplied bound domain and real action", () => {
    const agent = new InspectableReasoningAgent();
    expect(() =>
      agent.messages({ prompt: "检查规则" }, "cor-missing"),
    ).toThrow();

    const messages = agent.messages(
      {
        prompt: "检查规则",
        domainId: "live-domain-a",
        action: "realActionFromOntology",
      },
      "cor-bound",
    );
    expect(messages[0]?.content).toContain("live-domain-a");
    expect(messages[0]?.content).toContain("realActionFromOntology");
    expect(JSON.stringify(messages)).not.toContain("ruleCheckForMatchResume");
    expect(JSON.stringify(messages)).not.toContain("rules-test");
  });

  it("blocks when a mandatory rule is violated and flags unmet optional rules", () => {
    const output = finalizeReasoningOutput(
      {
        intentSummary: "检查候选人是否符合职位规则",
        strategy: "constrained_react",
        answerSummary: "学历不符合，不能进入匹配。",
        assessments: [
          {
            ruleId: "M-1",
            status: "violated",
            reason: "简历学历低于 JD 要求。",
            evidence: ["resume.education=大专", "jd.education=本科"],
          },
          {
            ruleId: "O-1",
            status: "optional_unmet",
            reason: "没有同行业经历。",
            evidence: ["candidate.industry_experience=false"],
          },
        ],
        missingEvidence: [],
      },
      bundle(),
      undefined,
      finalAuditContext(),
    );

    expect(output.decision).toBe("ineligible");
    expect(output.answerSummary).toContain("1 条 mandatory 规则被违反");
    expect(output.answerSummary).toContain("M-1 硬性学历要求");
    expect(output.answerSummary).not.toContain("学历不符合，不能进入匹配");
    expect(output.domainId).toBe("rules-test");
    expect(output.scenario).toBe("pre_match_resume_rule_check");
    expect(output.promptCompiler.compilerVersion).toBe(
      "qualified-rule-check/v3",
    );
    expect(output.runtime.agents.map((item) => item.id)).toEqual([
      "reasoning",
      "query",
      "compiler",
      "qualified",
      "fold",
    ]);
    expect(output.flags).toEqual(["O-1 优选行业经验: 没有同行业经历。"]);
    expect(output.assessments[0]).toMatchObject({
      ruleName: "硬性学历要求",
      enforcementLevel: "mandatory",
      failurePolicy: "block",
    });
    expect(output.audit).toMatchObject({
      visibility: "auditable_reasoning_summary",
      hiddenChainOfThoughtExposed: false,
      ruleSelection: {
        source: "allmeta",
        mandatoryCount: 1,
        optionalCount: 1,
        queryAgent: {
          selectionStrategy: "semantic-link-traversal",
          filters: { actionHint: "ruleCheckForMatchResume" },
        },
      },
      qualityCheck: {
        agent: "QualifiedAgent",
        executionMode: "isolated-child-run",
        run: { runId: "run-qualified-test" },
        assessmentCount: 2,
        mandatoryBlocked: 1,
        optionalFlagged: 1,
      },
    });
    expect(output.audit.ruleSelection.selectedRules).toHaveLength(2);
    expect(output.audit.compiledPrompt.systemPrompt).toContain(
      "QualifiedAgent",
    );
    expect(output.audit.trace.map((entry) => entry.event)).toEqual([
      "intent.accepted",
      "query_ir.compiled",
      "rules.selected",
      "prompt.compiled",
      "quality.checked",
      "decision.folded",
    ]);
    expect(JSON.stringify(output)).not.toContain("specificScenarioStage");
  });

  it("rejects malformed rule enforcement instead of guessing", () => {
    expect(() =>
      normalizeRule({
        id: "bad-enforcement",
        enforcementLevel: "required",
        failurePolicy: "block",
      }),
    ).toThrow(/expected mandatory or optional/);
    expect(() =>
      normalizeRule({
        id: "bad-policy",
        enforcementLevel: "mandatory",
        failurePolicy: "continue",
      }),
    ).toThrow(/expected block or warn/);
  });

  it("derives applicability only from the direct SCOPED_TO semantic link", () => {
    const normalized = normalizeRule({
      id: "scope-from-link",
      enforcementLevel: "mandatory",
      failurePolicy: "block",
      applicabilityScope: "client_department",
      applicableClient: "腾讯",
      applicableDepartment: "IEG",
      linkPaths: [
        {
          linkId: "link-scope-from-link",
          status: "active",
          confidence: 1,
          subject: { type: "Rule", id: "scope-from-link" },
          predicate: "SCOPED_TO",
          object: { type: "PolicyScope", id: "csi:universal" },
        },
      ],
    });
    expect(normalized?.applicabilityScope).toBe("csi_universal");
  });

  it("fails closed instead of inferring applicability from Rule properties", () => {
    expect(() =>
      normalizeRule({
        id: "property-only-scope",
        enforcementLevel: "optional",
        failurePolicy: "warn",
        applicableClient: "腾讯",
        applicableDepartment: "IEG",
        linkPaths: [
          {
            linkId: "link-property-only",
            status: "active",
            confidence: 1,
            subject: { type: "Rule", id: "property-only-scope" },
            predicate: "APPLIES_TO",
            object: { type: "DataObject", id: "Resume" },
          },
        ],
      }),
    ).toThrow(/no direct Rule-\[:SCOPED_TO\]->PolicyScope link/);
  });

  it("requires auditable identity, status, and bounded confidence on every Link", () => {
    expect(() =>
      normalizeRule({
        id: "incomplete-link-metadata",
        enforcementLevel: "mandatory",
        failurePolicy: "block",
        linkPaths: [
          {
            subject: { type: "Rule", id: "incomplete-link-metadata" },
            predicate: "SCOPED_TO",
            object: { type: "PolicyScope", id: "csi:universal" },
            confidence: 1.2,
          },
        ],
      }),
    ).toThrow(/non-empty linkId\/status and confidence within \[0,1\]/);
  });

  it("never accepts an echoed Allmeta response that swaps the locked domain or action", () => {
    const fallback = {
      ...bundle().queryIr,
      applicableClient: "字节",
      applicableDepartment: "抖音电商",
    };
    const normalized = normalizeSelectionQueryIr(
      {
        ...fallback,
        domainId: "foreign-domain",
        actionHint: "foreignAction",
        applicableClient: "腾讯",
        applicableDepartment: "IEG",
      },
      fallback,
    );
    expect(normalized.domainId).toBe("rules-test");
    expect(normalized.actionHint).toBe("ruleCheckForMatchResume");
    expect(normalized.applicableClient).toBe("字节");
    expect(normalized.applicableDepartment).toBe("抖音电商");
  });

  it("accepts only real domain-locked Cypher that resolves scope through links", () => {
    const receipt = normalizeRuleQueryExecution(
      {
        language: "cypher",
        query:
          "MATCH (r:Rule {domainId: $domainId})-[:SCOPED_TO]->(scope:PolicyScope) RETURN r, scope",
        parameters: { domainId: "rules-test" },
        fingerprint: "sha256:real-query",
        readOnly: true,
        domainLocked: true,
        linkOnly: true,
        fallbackUsed: false,
        durationMs: 12,
        rowCount: 2,
        pathPattern: "(Rule)-[:SCOPED_TO]->(PolicyScope)",
      },
      "rules-test",
    );
    expect(receipt.query).toContain("SCOPED_TO");
    expect(receipt.purpose).toBe("semantic-rule-selection");
    expect(receipt.parameters).toEqual({ domainId: "rules-test" });

    expect(() =>
      normalizeRuleQueryExecution(
        {
          ...receipt,
          query:
            "MATCH (r:Rule {domainId: $domainId}) WHERE r.applicableClient = $client RETURN r",
        },
        "rules-test",
      ),
    ).toThrow(/scope through SCOPED_TO links/);
  });

  it("preserves the selection and mandatory-link-coverage Cypher receipts", () => {
    const selection = {
      purpose: "semantic-rule-selection",
      language: "cypher",
      query:
        "MATCH (r:Rule {domainId: $domain})-[:SCOPED_TO]->(scope:PolicyScope) RETURN r, scope",
      parameters: { domain: "rules-test" },
      fingerprint: "sha256:selection",
      readOnly: true,
      domainLocked: true,
      linkOnly: true,
      fallbackUsed: false,
      durationMs: 12,
      rowCount: 7,
      pathPattern: "Rule-[:SCOPED_TO]->PolicyScope",
    };
    const coverage = {
      ...selection,
      purpose: "mandatory-link-coverage",
      query:
        'MATCH (r:Rule {domainId: $domain, enforcementLevel: "mandatory"}) OPTIONAL MATCH (r)-[:SCOPED_TO]->(scope:PolicyScope) RETURN r, scope',
      fingerprint: "sha256:coverage",
      rowCount: 0,
    };

    expect(
      normalizeRuleQueryExecutions(
        [selection, coverage],
        selection,
        "rules-test",
      ),
    ).toEqual([
      expect.objectContaining({
        purpose: "semantic-rule-selection",
        rowCount: 7,
      }),
      expect.objectContaining({
        purpose: "mandatory-link-coverage",
        rowCount: 0,
      }),
    ]);
    expect(() =>
      normalizeRuleQueryExecutions(
        [selection, { ...coverage, rowCount: 1 }],
        selection,
        "rules-test",
      ),
    ).toThrow(/mandatory-link-coverage found 1/);
    expect(() =>
      normalizeRuleQueryExecutions(undefined, selection, "rules-test"),
    ).toThrow(/exactly 2 Cypher receipts/);
  });

  it("fails closed when the child assessment count omits a mandatory rule", () => {
    expect(() =>
      finalizeReasoningOutput(
        {
          intentSummary: "执行规则检查",
          answerSummary: "需要补充证据。",
          assessments: [
            {
              ruleId: "O-1",
              status: "passed",
              reason: "具有行业经验。",
              evidence: ["resume.industry=互联网"],
            },
          ],
          missingEvidence: [],
        },
        bundle(),
        undefined,
        finalAuditContext(),
      ),
    ).toThrow(/assessment count/);
  });

  it("never lets optional failures override a mandatory pass", () => {
    const assessments: RuleAssessment[] = [
      {
        ruleId: "M-1",
        ruleName: "Mandatory",
        enforcementLevel: "mandatory",
        failurePolicy: "block",
        status: "satisfied",
        reason: "ok",
        evidence: [],
      },
      {
        ruleId: "O-1",
        ruleName: "Optional",
        enforcementLevel: "optional",
        failurePolicy: "warn",
        status: "optional_unmet",
        reason: "not met",
        evidence: [],
      },
    ];

    expect(foldRuleDecision(assessments)).toBe("eligible_with_flags");
  });

  it("normalizes known provider aliases but fails closed on unknown statuses", () => {
    const output = finalizeReasoningOutput(
      {
        intentSummary: "执行规则检查",
        answerSummary: "模型返回了未知状态。",
        assessments: [
          {
            ruleId: "M-1",
            status: "something_new",
            reason: "provider-specific status",
            evidence: [],
          },
          {
            ruleId: "O-1",
            status: "passed",
            reason: "optional evidence met",
            evidence: ["resume.industry=互联网"],
          },
        ],
        missingEvidence: [],
      },
      bundle(),
      undefined,
      finalAuditContext(),
    );

    expect(output.decision).toBe("review_required");
    expect(output.assessments[0]?.status).toBe("insufficient_evidence");
    expect(output.assessments[1]?.status).toBe("satisfied");
    expect(output.missingEvidence.join(" ")).toContain("something_new");
  });

  it("re-reads assessment citations and fails closed on any missing path", () => {
    const output = finalizeReasoningOutput(
      {
        intentSummary: "执行证据回验",
        answerSummary: "模型摘要不可信",
        assessments: [
          {
            ruleId: "M-1",
            status: "violated",
            reason: "引用了不存在的学历路径。",
            evidence: ["resume.education_history[9].degree=大专"],
          },
          {
            ruleId: "O-1",
            status: "satisfied",
            reason: "存在行业字段。",
            evidence: ["resume.industry=金融"],
          },
        ],
        missingEvidence: [],
      },
      bundle(),
      undefined,
      finalAuditContext(),
    );

    expect(output.assessments[0]).toMatchObject({
      ruleId: "M-1",
      status: "insufficient_evidence",
      evidence: [],
    });
    expect(output.assessments[1]?.evidence).toEqual(["resume.industry=互联网"]);
    expect(output.missingEvidence.join(" ")).toContain("json.path=value");
  });

  it("rejects a QualifiedAgent receipt that does not match the compiler", () => {
    const audit = finalAuditContext();
    audit.qualifiedRun.promptSha256 = "sha256:tampered";
    expect(() =>
      finalizeReasoningOutput(
        {
          intentSummary: "执行规则检查",
          answerSummary: "结果",
          assessments: [
            {
              ruleId: "M-1",
              status: "satisfied",
              reason: "学历字段存在。",
              evidence: ["resume.education=大专"],
            },
            {
              ruleId: "O-1",
              status: "satisfied",
              reason: "行业字段存在。",
              evidence: ["resume.industry=互联网"],
            },
          ],
          missingEvidence: [],
        },
        bundle(),
        undefined,
        audit,
      ),
    ).toThrow(/receipt does not match/);
  });

  it("fails closed when a model status contradicts its own auditable reason", () => {
    const output = finalizeReasoningOutput(
      {
        intentSummary: "执行时间规则检查",
        answerSummary: "模型摘要不作为裁决依据",
        assessments: [
          {
            ruleId: "M-1",
            status: "violated",
            reason: "离职已超过6个月，符合要求，应为 satisfied。",
            evidence: ["resume.employment_history[0].end_date=2021-01-15"],
          },
          {
            ruleId: "O-1",
            status: "satisfied",
            reason: "间隔不足6个月，触发拦截，应为 violated。",
            evidence: ["resume.employment_history[1].end_date=2026-05-20"],
          },
        ],
        missingEvidence: [],
      },
      bundle(),
      undefined,
      finalAuditContext(),
    );

    expect(output.assessments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "M-1",
          status: "insufficient_evidence",
        }),
        expect.objectContaining({
          ruleId: "O-1",
          status: "insufficient_evidence",
        }),
      ]),
    );
    expect(output.decision).toBe("review_required");
    expect(output.missingEvidence.join(" ")).toContain("Quality Guard");
  });

  it("fails closed when a cited date deterministically contradicts a temporal threshold claim", () => {
    const testBundle = temporalBundle(6);
    const evidence = temporalEvidence("2024-03-15");
    const output = finalizeReasoningOutput(
      {
        intentSummary: "执行离职间隔检查",
        answerSummary: "模型摘要不作为裁决依据",
        assessments: [
          {
            ruleId: "M-1",
            status: "violated",
            reason: "从原工作室跨至目标工作室，离职不满6个月，触发拦截。",
            evidence: [
              "resume.employment_history[0].studio=原工作室",
              "jobRequisition.client_studio=目标工作室",
              "resume.employment_history[0].end_date=2024-03-15",
            ],
          },
          {
            ruleId: "O-1",
            status: "satisfied",
            reason: "存在行业经历。",
            evidence: ["resume.industry=互联网"],
          },
        ],
        missingEvidence: [],
      },
      testBundle,
      undefined,
      finalAuditContext(testBundle, evidence),
    );

    expect(output.assessments[0]).toMatchObject({
      ruleId: "M-1",
      status: "insufficient_evidence",
    });
    expect(output.assessments[0]?.reason).toContain("确定性时间事实冲突");
    expect(output.missingEvidence.join(" ")).toContain("27个完整月");
    expect(output.decision).toBe("review_required");
  });

  it("requires a verified date citation for a decisive temporal threshold claim", () => {
    const testBundle = temporalBundle(3);
    const evidence = temporalEvidence("2026-06-20");
    const output = finalizeReasoningOutput(
      {
        intentSummary: "执行离职间隔检查",
        answerSummary: "模型摘要不作为裁决依据",
        assessments: [
          {
            ruleId: "M-1",
            status: "violated",
            reason: "候选人离职不足3个月，且未上传解除凭证。",
            evidence: ["active_locks=[]"],
          },
          {
            ruleId: "O-1",
            status: "satisfied",
            reason: "存在行业经历。",
            evidence: ["resume.industry=互联网"],
          },
        ],
        missingEvidence: [],
      },
      testBundle,
      undefined,
      finalAuditContext(testBundle, evidence),
    );

    expect(output.assessments[0]).toMatchObject({
      ruleId: "M-1",
      status: "insufficient_evidence",
      evidence: ["active_locks=[]"],
    });
    expect(output.assessments[0]?.reason).toContain("日期 json.path");
    expect(output.decision).toBe("review_required");
  });

  it("preserves a decisive temporal status when the cited deterministic fact supports it", () => {
    const testBundle = temporalBundle(6);
    const evidence = temporalEvidence("2026-06-20");
    const output = finalizeReasoningOutput(
      {
        intentSummary: "执行离职间隔检查",
        answerSummary: "模型摘要不作为裁决依据",
        assessments: [
          {
            ruleId: "M-1",
            status: "violated",
            reason: "候选人离职不满6个月，触发拦截。",
            evidence: [
              "resume.employment_history[0].end_date=2026-06-20",
            ],
          },
          {
            ruleId: "O-1",
            status: "satisfied",
            reason: "存在行业经历。",
            evidence: ["resume.industry=互联网"],
          },
        ],
        missingEvidence: [],
      },
      testBundle,
      undefined,
      finalAuditContext(testBundle, evidence),
    );

    expect(output.assessments[0]).toMatchObject({
      ruleId: "M-1",
      status: "violated",
    });
    expect(output.decision).toBe("ineligible");
  });

  it("does not apply the temporal guard to a non-temporal rule", () => {
    const output = finalizeReasoningOutput(
      {
        intentSummary: "执行非时间规则检查",
        answerSummary: "模型摘要不作为裁决依据",
        assessments: [
          {
            ruleId: "M-1",
            status: "violated",
            reason: "简历学历低于岗位要求。",
            evidence: ["resume.education=大专", "jd.education=本科"],
          },
          {
            ruleId: "O-1",
            status: "satisfied",
            reason: "存在行业经历。",
            evidence: ["resume.industry=互联网"],
          },
        ],
        missingEvidence: [],
      },
      bundle(),
      undefined,
      finalAuditContext(),
    );

    expect(output.assessments[0]?.status).toBe("violated");
    expect(output.decision).toBe("ineligible");
  });

  it("derives a reusable selection IR from generic recruitment inputs", () => {
    const queryIr = deriveRuleSelectionQueryIr({
      prompt: "检查该候选人在腾讯 IEG 的回流规则",
      domainId: "rules-test",
      action: "someFutureRecruitmentAction",
      scenario: "future_rule_check",
      inputs: {
        candidate_id: "c-1",
        resume: { work_history: [] },
        job_requisition: {
          id: "jr-1",
          client_name: "腾讯",
          client_department_name: "IEG",
        },
        csi_department: {
          csi_department_id: "csi-1",
          dept_name: "RAAS交付管理部",
        },
        rule_scope: {
          selection_keywords: ["回流", "黑名单", "简历完整性"],
          capability_anchors: ["ruleCheckForMatchResume", "matchResume"],
        },
        interview_history: [],
      },
    });

    expect(queryIr).toMatchObject({
      domainId: "rules-test",
      actionHint: "someFutureRecruitmentAction",
      applicableClient: "腾讯",
      applicableDepartment: "IEG",
      executor: "Agent",
    });
    expect(queryIr.objectTypes).toEqual(
      expect.arrayContaining([
        "Candidate",
        "Resume",
        "Job_Requisition",
        "Client",
        "Client_Department",
        "CSI_Department",
        "Interview_Record",
      ]),
    );
    expect(queryIr.strongKeywords).toEqual(["回流", "黑名单", "简历完整性"]);
    expect(queryIr.capabilityAnchors).toEqual([
      "someFutureRecruitmentAction",
      "ruleCheckForMatchResume",
      "matchResume",
    ]);
    expect(queryIr.allowedRelationships).toEqual([
      "SCOPED_TO",
      "GOVERNS",
      "APPLIES_TO",
      "RELEVANT_TO",
    ]);
  });

  it("takes target client and department from the Job Requisition, never the prompt or Resume history", () => {
    const input = {
      prompt: "请按腾讯 IEG 规则检查这个候选人",
      domainId: "rules-test",
      action: "ruleCheckForMatchResume",
      applicableClient: "腾讯",
      applicableDepartment: "IEG",
      inputs: {
        rule_scope: { client: "腾讯", client_department: "IEG" },
      },
      resume: {
        employment_history: [
          { client_name: "腾讯", client_department_name: "IEG" },
        ],
      },
      jobRequisition: {
        client_name: "字节",
        client_department_name: "抖音电商",
      },
      jd: { client: "字节", business_group: "抖音电商" },
    };

    expect(deriveRuleSelectionQueryIr(input)).toMatchObject({
      applicableClient: "字节",
      applicableDepartment: "抖音电商",
    });
    expect(resolveTargetRuleScope(input)).toMatchObject({
      client: "字节",
      department: "抖音电商",
      clientSource: "job_requisition",
      departmentSource: "job_requisition",
    });
    expect(resolveTargetRuleScope(input).conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "client",
          selectedValue: "字节",
          ignoredValue: "腾讯",
        }),
      ]),
    );
  });

  it("may complete a missing department only from a source for the same target client", () => {
    expect(
      resolveTargetRuleScope({
        prompt: "检查",
        domainId: "rules-test",
        action: "ruleCheckForMatchResume",
        jobRequisition: { client_name: "字节" },
        jd: { client: "字节", business_group: "抖音电商" },
        inputs: {
          rule_scope: { client: "腾讯", client_department: "IEG" },
        },
      }),
    ).toMatchObject({
      client: "字节",
      department: "抖音电商",
      clientSource: "job_requisition",
      departmentSource: "jd",
    });
  });

  it("fails closed when Job Requisition and JD disagree on target scope", () => {
    expect(() =>
      resolveTargetRuleScope({
        prompt: "检查",
        domainId: "rules-test",
        action: "ruleCheckForMatchResume",
        jobRequisition: {
          client_name: "字节",
          client_department_name: "抖音电商",
        },
        jd: { client: "腾讯", business_group: "IEG" },
      }),
    ).toThrow(/TARGET_SCOPE_CONFLICT/);
  });

  it("does not recursively treat nested target-document history as target scope", () => {
    const scope = resolveTargetRuleScope({
      prompt: "检查",
      domainId: "rules-test",
      action: "ruleCheckForMatchResume",
      jobRequisition: {
        client_name: "字节",
        history: [{ client_name: "腾讯", client_department_name: "IEG" }],
      },
      jd: { client: "字节" },
    });
    expect(scope).toMatchObject({
      client: "字节",
      department: "",
      departmentSource: "missing",
    });
  });

  it("fails closed when structured target documents omit the client", () => {
    expect(() =>
      deriveRuleSelectionQueryIr({
        prompt: "检查",
        domainId: "rules-test",
        action: "ruleCheckForMatchResume",
        applicableClient: "腾讯",
        jobRequisition: { client_department_name: "IEG" },
        jd: { title: "前端开发" },
      }),
    ).toThrow(/TARGET_SCOPE_INCOMPLETE/);
  });
});
