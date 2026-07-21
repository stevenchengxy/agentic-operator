import { describe, expect, it } from "vitest";
import type { Translate } from "@/app/portal/lib/preferences-context";
import { translate } from "@/lib/i18n";
import type {
  ReasoningRunResponse,
  ReasoningRunStep,
} from "@/lib/hooks/useReasoningAgentContext";
import { projectReasoningToolAudit } from "./audit-projection";

const zhT: Translate = (key, vars) => translate("zh", key, vars);

function projectAudit(
  steps: ReasoningRunStep[],
  children: ReasoningRunResponse["children"] = [],
) {
  return projectReasoningToolAudit(steps, zhT, children);
}

const baseStep = {
  id: "step-1",
  ord: 1,
  name: "placeholder",
  type: "tool",
  status: "ok",
  startedAt: null,
  endedAt: null,
  durationMs: 1,
  error: null,
  provider: null,
  model: null,
  tokensIn: null,
  tokensOut: null,
  input: null,
  output: null,
} satisfies ReasoningRunStep;

describe("projectReasoningToolAudit", () => {
  it("keeps a completed RuleBundle visible when a later step fails", () => {
    const steps: ReasoningRunStep[] = [
      {
        ...baseStep,
        id: "step-0",
        ord: 0,
        name: "llm.call",
        input: {
          messages: [
            {
              role: "user",
              content:
                '用户请求：\ncheck this resume\n\n业务场景：pre_match\n\n通用输入证据：\n{"resume":{"id":"resume-1"}}',
            },
          ],
        },
      },
      {
        ...baseStep,
        name: "select_applicable_rules",
        output: {
          ok: true,
          data: {
            bundleId: "sha256:bundle",
            domainId: "rules-test",
            action: "matchResume",
            scenario: "pre_match",
            fetchedAt: "2026-07-13T00:00:00.000Z",
            queryIr: {
              domainId: "rules-test",
              action: "matchResume",
              query: "match resume",
              strongKeywords: [],
              keywords: [],
              objectTypes: ["Resume"],
              applicableClient: "",
              applicableDepartment: "",
              executor: "Agent",
              enforcementLevels: ["mandatory", "optional"],
              limit: 10,
            },
            rules: [
              {
                id: "r-1",
                name: "Required education",
                logic: "degree must match",
                submissionCriteria: "resume parsed",
                businessReason: "quality",
                enforcementLevel: "mandatory",
                failurePolicy: "block",
                executor: "Agent",
                applicableClient: "",
                applicableDepartment: "",
                relatedEntities: [],
                relatedObjectTypes: ["Resume"],
                linkedActions: ["matchResume"],
                selectionScore: 100,
                matchReasons: ["action-linked"],
              },
            ],
            mandatoryCount: 1,
            optionalCount: 0,
            auditInput: {
              userPrompt: "check this resume",
              evidence: { resume: { id: "resume-1" } },
              evidenceKeys: ["resume"],
            },
            queryAgent: {
              mode: "compiled-cypher/universal-rule-selection",
              readOnly: true,
              domainLocked: true,
              stageIndependent: true,
              rationale: "resume evidence",
              diagnostics: { scannedRuleCount: 262 },
            },
          },
        },
      },
      {
        ...baseStep,
        id: "step-2",
        ord: 2,
        name: "llm.call",
        status: "failed",
        error: "provider unavailable",
      },
    ];

    const audit = projectAudit(steps);
    expect(audit.ruleSelection?.rules).toHaveLength(1);
    expect(audit.ruleSelection?.queryAgent.diagnostics).toEqual({
      scannedRuleCount: 262,
    });
    expect(audit.input?.evidenceKeys).toEqual(["resume"]);
    expect(audit.compiledPrompt).toBeNull();
  });

  it("ignores truncated or malformed receipts", () => {
    const audit = projectAudit([
      {
        ...baseStep,
        name: "select_applicable_rules",
        output: { _truncated: true, _preview: "{}" },
      },
    ]);
    expect(audit).toEqual({
      input: null,
      ruleSelection: null,
      compiledPrompt: null,
      compilerReceipt: null,
      executedQualifiedPrompt: null,
    });
  });

  it("projects compact compiler receipts without requiring duplicated prompts", () => {
    const qualifiedRun = {
      role: "qualified",
      executionMode: "isolated-child-run",
      runId: "run-child",
      parentRunId: "run-parent",
      correlationId: "cor-1",
      compilerId: "pc:v3",
      promptSha256: "sha256:prompt",
      ruleBundleId: "sha256:bundle",
      provider: "test",
      model: "test-model",
      tokensIn: 100,
      tokensOut: 20,
      durationMs: 30,
      steps: 1,
      assessmentCount: 2,
    };
    const audit = projectAudit([
      {
        ...baseStep,
        name: "compile_qualified_prompt",
        output: {
          ok: true,
          data: {
            compilerReceipt: {
              compilerId: "pc:v3",
              compilerVersion: "qualified-rule-check/v3",
              promptSha256: "sha256:prompt",
              fullSemanticPathsSha256: "sha256:paths",
            },
            ruleCount: 2,
            qualifiedRun,
            assessmentCount: 2,
          },
        },
      },
    ]);

    expect(audit.compiledPrompt).toBeNull();
    expect(audit.compilerReceipt).toMatchObject({
      ruleCount: 2,
      assessmentCount: 2,
      compilerReceipt: {
        compilerVersion: "qualified-rule-check/v3",
        fullSemanticPathsSha256: "sha256:paths",
      },
    });
    expect(JSON.stringify(audit)).not.toContain("systemPrompt");
    expect(JSON.stringify(audit)).not.toContain("userPrompt");
  });

  it("keeps historical full compiler tool payloads projectable", () => {
    const audit = projectAudit([
      {
        ...baseStep,
        name: "compile_qualified_prompt",
        output: {
          ok: true,
          data: {
            compilerId: "pc:v2",
            compilerVersion: "qualified-rule-check/v2",
            promptSha256: "sha256:prompt-v2",
            scenario: "resume_match",
            ruleIds: ["R-1"],
            evidenceKeys: ["resume"],
            systemPrompt: "historical system prompt",
            userPrompt: "historical user prompt",
            assessmentCount: 1,
          },
        },
      },
    ]);

    expect(audit.compiledPrompt?.systemPrompt).toBe("historical system prompt");
    expect(audit.compilerReceipt).toMatchObject({
      ruleCount: 1,
      assessmentCount: 1,
      compilerReceipt: {
        compilerId: "pc:v2",
        promptSha256: "sha256:prompt-v2",
      },
    });
  });

  it("recovers the exact executed prompt from one verified QualifiedAgent child", () => {
    const childRun = {
      id: "run-child",
      parentRunId: "run-parent",
      status: "failed",
      agentName: "reasoningAgent",
      startedAt: "2026-07-14T01:00:00.000Z",
      endedAt: "2026-07-14T01:00:10.000Z",
      durationMs: 10_000,
      tokensIn: null,
      tokensOut: null,
      model: "qualified-model",
      error: "provider unavailable",
      currentStepName: "llm.call",
      currentStepOrd: 1,
      stepCount: 1,
    } satisfies ReasoningRunResponse["children"][number]["run"];
    const children: ReasoningRunResponse["children"] = [
      {
        role: "qualified",
        runtimeRole: "qualified",
        run: childRun,
        steps: [
          {
            ...baseStep,
            name: "llm.call",
            status: "failed",
            input: {
              agent: "reasoningAgent",
              runtimeRole: "qualified",
              parentRunId: "run-parent",
              provider: "custom",
              model: "qualified-model",
              messages: [
                { role: "system", content: "exact system prompt" },
                { role: "user", content: "exact user prompt" },
              ],
            },
          },
        ],
      },
    ];

    const audit = projectAudit([], children);
    expect(audit.executedQualifiedPrompt).toEqual({
      source: "verified-qualified-child-step",
      runId: "run-child",
      parentRunId: "run-parent",
      runStatus: "failed",
      provider: "custom",
      model: "qualified-model",
      systemPrompt: "exact system prompt",
      userPrompt: "exact user prompt",
    });
  });

  it("does not project ambiguous or malformed child messages", () => {
    const children = [
      {
        role: "qualified",
        runtimeRole: "qualified",
        run: {
          id: "run-child",
          parentRunId: "run-parent",
          status: "running",
          agentName: "reasoningAgent",
          startedAt: null,
          endedAt: null,
          durationMs: null,
          tokensIn: null,
          tokensOut: null,
          model: null,
          error: null,
          currentStepName: "llm.call",
          currentStepOrd: 1,
          stepCount: 1,
        },
        steps: [
          {
            ...baseStep,
            name: "llm.call",
            input: {
              agent: "reasoningAgent",
              runtimeRole: "qualified",
              parentRunId: "run-parent",
              messages: [
                { role: "system", content: "one" },
                { role: "system", content: "duplicate" },
                { role: "user", content: "user" },
              ],
            },
          },
        ],
      },
    ] as ReasoningRunResponse["children"];

    expect(projectAudit([], children).executedQualifiedPrompt).toBeNull();
  });

  it("projects a generated Cypher receipt and semantic link paths", () => {
    const harnessPlan = {
      version: "reasoning-harness/v2",
      methods: ["graph_react", "evidence_grounding"],
      capabilityAnchors: ["候选人资质核验"],
      objectAnchors: ["Resume"],
      evidenceAnchors: [],
      stopConditions: ["每条规则均完成判定"],
      publicRationale: "沿语义 Links 检索规则。",
    };
    const queryExecution = {
      purpose: "semantic-rule-selection",
      language: "cypher",
      query: "MATCH (r:Rule {domainId:$domainId})-[:SCOPED_TO]->(s) RETURN r,s",
      parameters: { domainId: "rules-test" },
      fingerprint: "sha256:query",
      readOnly: true,
      domainLocked: true,
      linkOnly: true,
      fallbackUsed: false,
      durationMs: 8,
      rowCount: 1,
      pathPattern: "(Rule)-[:SCOPED_TO]->(PolicyScope)",
    };
    const queryExecutions = [
      queryExecution,
      {
        ...queryExecution,
        purpose: "mandatory-link-coverage",
        query:
          'MATCH (r:Rule {domainId:$domainId, enforcementLevel:"mandatory"}) OPTIONAL MATCH (r)-[:SCOPED_TO]->(s) RETURN r,s',
        fingerprint: "sha256:coverage",
        rowCount: 0,
      },
    ];
    const audit = projectAudit([
      {
        ...baseStep,
        name: "select_applicable_rules",
        output: {
          ok: true,
          data: {
            bundleId: "sha256:new-bundle",
            domainId: "rules-test",
            action: "matchResume",
            scenario: "resume_match",
            fetchedAt: "2026-07-14T00:00:00.000Z",
            selectionBasis: "semantic-links",
            harnessPlan,
            queryExecution,
            queryExecutions,
            queryIr: {
              version: "rule-link-query-ir/v2",
              domainId: "rules-test",
              actionHint: "matchResume",
              query: "resume match",
              intentTerms: ["资质"],
              capabilityAnchors: ["候选人资质核验"],
              objectAnchors: ["Resume"],
              evidenceAnchors: [],
              strongKeywords: ["资质"],
              keywords: ["资质"],
              objectTypes: ["Resume"],
              applicableClient: "腾讯",
              applicableDepartment: "IEG",
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
            rules: [
              {
                id: "R-1",
                name: "资质规则",
                logic: "资质有效",
                submissionCriteria: "",
                businessReason: "",
                enforcementLevel: "mandatory",
                failurePolicy: "block",
                executor: "Agent",
                applicableClient: "腾讯",
                applicableDepartment: "IEG",
                relatedEntities: ["Resume"],
                relatedObjectTypes: ["Resume"],
                linkedActions: [],
                applicabilityScope: "client_department",
                selectionScore: 100,
                matchReasons: ["SCOPED_TO"],
                linkPaths: [
                  {
                    subject: {
                      type: "Rule",
                      id: "R-1",
                      displayName: "资质规则",
                    },
                    predicate: "SCOPED_TO",
                    object: {
                      type: "PolicyScope",
                      id: "client:tencent/department:ieg",
                      displayName: "腾讯 / IEG",
                    },
                    semanticRelationship: "资质规则适用于腾讯 IEG",
                    evidence: [],
                  },
                ],
                matchedAnchors: ["腾讯", "IEG"],
                scopeReason: "department scope",
              },
            ],
            mandatoryCount: 1,
            optionalCount: 0,
            queryAgent: {
              mode: "generated-cypher/semantic-link-selection",
              readOnly: true,
              domainLocked: true,
              linkOnly: true,
              fallbackUsed: false,
              rationale: "link-first",
              harnessPlan,
              queryExecution,
              queryExecutions,
              diagnostics: { selectedRuleCount: 1 },
            },
          },
        },
      },
    ]);

    expect(audit.ruleSelection?.queryExecution?.query).toContain("SCOPED_TO");
    expect(audit.ruleSelection?.queryExecutions).toHaveLength(2);
    expect(audit.ruleSelection?.queryExecutions?.[1]?.purpose).toBe(
      "mandatory-link-coverage",
    );
    expect(audit.ruleSelection?.rules[0]?.linkPaths[0]?.object.id).toBe(
      "client:tencent/department:ieg",
    );
    expect(audit.ruleSelection?.harnessPlan?.methods).toContain("graph_react");
  });
});
