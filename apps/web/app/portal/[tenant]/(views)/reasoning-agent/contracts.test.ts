import { describe, expect, it } from "vitest";
import { parseReasoningOutput } from "./contracts";

const harnessPlan = {
  version: "reasoning-harness/v2",
  methods: ["graph_react", "rule_by_rule_verification"],
  capabilityAnchors: ["matchResume"],
  objectAnchors: ["Resume"],
  evidenceAnchors: [],
  stopConditions: ["all rules assessed"],
  publicRationale: "Follow reviewed semantic links.",
};

const queryIr = {
  version: "rule-link-query-ir/v2",
  domainId: "rules-test",
  actionHint: "matchResume",
  query: "match resume",
  intentTerms: ["match"],
  capabilityAnchors: ["matchResume"],
  objectAnchors: ["Resume"],
  evidenceAnchors: [],
  strongKeywords: ["match"],
  keywords: ["match"],
  objectTypes: ["Resume"],
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
};

const selectionExecution = {
  purpose: "semantic-rule-selection",
  language: "cypher",
  query: "MATCH (r:Rule)-[link]->(scope) RETURN r, link, scope",
  parameters: { domainId: "rules-test" },
  fingerprint: "sha256:selection",
  readOnly: true,
  domainLocked: true,
  linkOnly: true,
  fallbackUsed: false,
  durationMs: 5,
  rowCount: 1,
  pathPattern: "(Rule)-[link]->(Scope)",
};

const coverageExecution = {
  ...selectionExecution,
  purpose: "mandatory-link-coverage",
  query: "MATCH (r:Rule) WHERE r.enforcementLevel = 'mandatory' RETURN r",
  fingerprint: "sha256:coverage",
  rowCount: 0,
};

function v2Result(): Record<string, any> {
  const queryExecutions = [selectionExecution, coverageExecution];
  return {
    intentSummary: "Check the resume against selected rules.",
    strategy: "graph-first",
    answerSummary: "Eligible.",
    decision: "eligible",
    domainId: "rules-test",
    action: "matchResume",
    scenario: "pre_match",
    ruleBundleId: "sha256:bundle",
    ruleCount: 1,
    queryIr,
    harnessPlan,
    promptCompiler: {
      compilerId: "qualified-prompt",
      compilerVersion: "v2",
      evidenceKeys: ["resume"],
    },
    assessments: [],
    flags: [],
    missingEvidence: [],
    audit: {
      visibility: "auditable_reasoning_summary",
      hiddenChainOfThoughtExposed: false,
      input: {
        userPrompt: "check",
        evidence: { resume: { id: "resume-1" } },
        evidenceKeys: ["resume"],
      },
      harnessPlan,
      ruleSelection: {
        source: "allmeta",
        mode: "generated-cypher/semantic-link-selection",
        selectionBasis: "semantic-links",
        queryFingerprint: selectionExecution.fingerprint,
        readOnly: true,
        domainLocked: true,
        linkOnly: true,
        fallbackUsed: false,
        queryExecution: selectionExecution,
        queryExecutions,
        fetchedAt: "2026-07-14T00:00:00.000Z",
        mandatoryCount: 1,
        optionalCount: 0,
        diagnostics: null,
        queryAgent: {
          selectionStrategy: "semantic-link-traversal",
          modelRationale: "The capability boundary reaches this rule.",
          harnessPlan,
          queryExecution: selectionExecution,
          queryExecutions,
          filters: {
            actionHint: "matchResume",
            client: "",
            department: "",
            objectTypes: ["Resume"],
            keywords: ["match"],
            executor: "Agent",
            enforcementLevels: ["mandatory", "optional"],
            includeCsiUniversal: true,
            includeClientGeneral: false,
            includeClientDepartment: false,
          },
        },
        selectedRules: [
          {
            id: "rule-1",
            name: "Resume match",
            logic: "resume must match",
            submissionCriteria: "parsed resume",
            businessReason: "quality",
            enforcementLevel: "mandatory",
            failurePolicy: "block",
            executor: "Agent",
            applicableClient: "",
            applicableDepartment: "",
            relatedEntities: [],
            relatedObjectTypes: ["Resume"],
            linkedActions: ["matchResume"],
            applicabilityScope: "csi_universal",
            selectionScore: 100,
            matchReasons: ["GOVERNS"],
            linkPaths: [
              {
                linkId: "link-1",
                status: "active",
                confidence: 0.98,
                subject: {
                  type: "Action",
                  id: "matchResume",
                  displayName: "Match Resume",
                },
                predicate: "GOVERNS",
                object: {
                  type: "Rule",
                  id: "rule-1",
                  displayName: "Resume match",
                },
                semanticRelationship: "Match Resume is governed by this rule.",
                evidence: [],
              },
            ],
            matchedAnchors: ["matchResume"],
            scopeReason: "canonical capability boundary",
          },
        ],
      },
      compiledPrompt: {
        compilerId: "qualified-prompt",
        compilerVersion: "v2",
        promptSha256: "sha256:prompt",
        scenario: "pre_match",
        ruleIds: ["rule-1"],
        evidenceKeys: ["resume"],
        systemPrompt: "system",
        userPrompt: "user",
      },
      qualityCheck: {
        agent: "QualifiedAgent",
        executionMode: "isolated-child-run",
        run: {
          role: "qualified",
          executionMode: "isolated-child-run",
          runId: "run-child",
          parentRunId: "run-parent",
          correlationId: "corr-1",
          compilerId: "qualified-prompt",
          promptSha256: "sha256:prompt",
          ruleBundleId: "sha256:bundle",
          provider: "test",
          model: "test-model",
          tokensIn: 10,
          tokensOut: 5,
          durationMs: 20,
          steps: 1,
          assessmentCount: 0,
        },
        assessmentCount: 0,
        statusCounts: {
          satisfied: 0,
          violated: 0,
          optional_unmet: 0,
          not_applicable: 0,
          insufficient_evidence: 0,
        },
        mandatoryBlocked: 0,
        mandatoryPending: 0,
        optionalFlagged: 0,
      },
      trace: [],
    },
    runtime: { agents: [], edges: [] },
  };
}

describe("reasoning result version contracts", () => {
  it("accepts a complete v2 result", () => {
    expect(
      parseReasoningOutput(v2Result(), "reasoning-result/v2").ruleCount,
    ).toBe(1);
  });

  it("accepts v3 with a full semantic-path receipt and keeps v2 compatible", () => {
    const value = v2Result();
    value.promptCompiler.compilerVersion = "qualified-rule-check/v3";
    value.audit.compiledPrompt.compilerVersion = "qualified-rule-check/v3";
    value.audit.compiledPrompt.fullSemanticPathsSha256 =
      "sha256:full-semantic-paths";

    const parsed = parseReasoningOutput(value, "reasoning-result/v2");
    expect(parsed.audit.compiledPrompt).toMatchObject({
      compilerVersion: "qualified-rule-check/v3",
      fullSemanticPathsSha256: "sha256:full-semantic-paths",
    });
  });

  it("rejects v3 without its full semantic-path receipt", () => {
    const value = v2Result();
    value.promptCompiler.compilerVersion = "qualified-rule-check/v3";
    value.audit.compiledPrompt.compilerVersion = "qualified-rule-check/v3";
    expect(() =>
      parseReasoningOutput(value, "reasoning-result/v2"),
    ).toThrow(/invalid reasoning-result\/v2/);
  });

  it.each([
    ["isolated child receipt", (value: Record<string, any>) => {
      delete value.audit.qualityCheck.run;
    }],
    ["promptSha256", (value: Record<string, any>) => {
      delete value.audit.compiledPrompt.promptSha256;
    }],
    ["exactly two query executions", (value: Record<string, any>) => {
      value.audit.ruleSelection.queryExecutions = [selectionExecution];
    }],
    ["linkOnly", (value: Record<string, any>) => {
      delete value.audit.ruleSelection.linkOnly;
    }],
  ])("rejects v2 without %s", (_label, mutate) => {
    const value = v2Result();
    mutate(value);
    expect(() =>
      parseReasoningOutput(value, "reasoning-result/v2"),
    ).toThrow(/invalid reasoning-result\/v2/);
  });

  it.each([
    ["empty linkId", "linkId", ""],
    ["empty status", "status", ""],
    ["confidence below zero", "confidence", -0.01],
    ["confidence above one", "confidence", 1.01],
  ])("rejects v2 link triples with %s", (_label, key, invalid) => {
    const value = v2Result();
    value.audit.ruleSelection.selectedRules[0].linkPaths[0][key] = invalid;
    expect(() =>
      parseReasoningOutput(value, "reasoning-result/v2"),
    ).toThrow(/invalid reasoning-result\/v2/);
  });

  it("keeps missing link metadata compatible only for v1", () => {
    const value = v2Result();
    const link = value.audit.ruleSelection.selectedRules[0].linkPaths[0];
    delete link.linkId;
    delete link.status;
    delete link.confidence;
    delete value.audit.qualityCheck.run;
    delete value.audit.qualityCheck.executionMode;
    delete value.audit.compiledPrompt.promptSha256;
    delete value.audit.ruleSelection.linkOnly;
    delete value.audit.ruleSelection.fallbackUsed;

    const parsed = parseReasoningOutput(value, "reasoning-result/v1");
    expect(parsed.audit.ruleSelection.selectedRules[0]?.linkPaths[0]).toEqual(
      expect.objectContaining({ linkId: null, status: null, confidence: null }),
    );
    expect(() =>
      parseReasoningOutput(value, "reasoning-result/v2"),
    ).toThrow(/invalid reasoning-result\/v2/);
  });
});
