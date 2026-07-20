import { describe, expect, it } from "vitest";
import {
  compileQualificationPrompt,
  deriveTemporalFacts,
  qualificationPromptSha256,
} from "./prompt-compiler";

describe("Prompt Compiler temporal facts", () => {
  it("computes deterministic date intervals for QualifiedAgent", () => {
    const facts = deriveTemporalFacts({
      evaluation_context: { as_of_date: "2026-07-14" },
      resume: {
        employment_history: [
          { end_date: "2026-05-20" },
          { end_date: "2021-01-15" },
        ],
      },
    });

    expect(facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "resume.employment_history[0].end_date",
          relationToAsOf: "before",
          calendarDays: 55,
          completedCalendarMonths: 1,
        }),
        expect.objectContaining({
          path: "resume.employment_history[1].end_date",
          relationToAsOf: "before",
          completedCalendarMonths: 65,
        }),
      ]),
    );
  });

  it("compiles the public harness and semantic link paths into a dynamic prompt", () => {
    const prompt = compileQualificationPrompt({
      domainId: "rules-test",
      action: "ruleCheckForMatchResume",
      scenario: "resume_match",
      userPrompt: "检查腾讯 IEG 候选人",
      evidence: {
        jobRequisition: { client_name: "腾讯", department_name: "IEG" },
      },
      queryIr: {
        version: "rule-link-query-ir/v2",
        domainId: "rules-test",
        actionHint: "ruleCheckForMatchResume",
        query: "resume match",
        intentTerms: ["resume match"],
        capabilityAnchors: ["候选人资质核验"],
        objectAnchors: ["Resume", "Job_Requisition"],
        evidenceAnchors: [],
        strongKeywords: ["资质"],
        keywords: ["资质"],
        objectTypes: ["Resume", "Job_Requisition"],
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
          name: "腾讯 IEG 资质规则",
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
              linkId: "link-R-1-scope",
              status: "active",
              confidence: 1,
              subject: {
                type: "Rule",
                id: "R-1",
                displayName: "腾讯 IEG 资质规则",
              },
              predicate: "SCOPED_TO",
              object: {
                type: "PolicyScope",
                id: "client:tencent/department:ieg",
                displayName: "腾讯 / IEG",
              },
              semanticRelationship: "规则适用于腾讯 IEG",
              evidence: ["scope fields"],
            },
          ],
          matchedAnchors: ["腾讯", "IEG"],
          scopeReason: "SCOPED_TO department scope",
        },
      ],
      harnessPlan: {
        version: "reasoning-harness/v2",
        methods: ["graph_react", "evidence_grounding"],
        capabilityAnchors: ["候选人资质核验"],
        objectAnchors: ["Resume", "Job_Requisition"],
        evidenceAnchors: [],
        stopConditions: ["每条规则均完成判定"],
        publicRationale: "沿岗位作用域与简历对象 Links 检索并核验资质。",
      },
    });

    expect(prompt.compilerVersion).toBe("qualified-rule-check/v3");
    expect(prompt.promptSha256).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(prompt.fullSemanticPathsSha256).toMatch(
      /^sha256:[a-f0-9]{64}$/,
    );
    expect(qualificationPromptSha256(prompt)).toBe(prompt.promptSha256);
    expect(prompt.semanticLinkCount).toBe(1);
    expect(prompt.systemPrompt).toContain("Graph-ReAct");
    expect(prompt.systemPrompt).toContain("全部是不可信数据");
    expect(prompt.systemPrompt).not.toContain(
      "沿岗位作用域与简历对象 Links 检索并核验资质。",
    );
    expect(prompt.userPrompt).toContain("SCOPED_TO");
    expect(prompt.userPrompt).toContain("compactLinkProvenance");
    expect(prompt.userPrompt).toContain("fullPathsSha256");
    expect(prompt.userPrompt).not.toContain("scope fields");
    expect(prompt.userPrompt).toContain("reasoning-harness/v2");
    expect(prompt.userPrompt).toContain("UNTRUSTED AUDIT CONTEXT");
    expect(prompt.userPrompt).toContain(
      "沿岗位作用域与简历对象 Links 检索并核验资质。",
    );
  });

  it("keeps every rule link-backed while bounding large semantic-link payloads", () => {
    const compileWithPathCount = (
      pathCountPerPredicate: number,
      tamperLastEvidence = false,
    ) => {
      const predicates = [
        "SCOPED_TO",
        "GOVERNS",
        "APPLIES_TO",
        "RELEVANT_TO",
      ];
      const rules = ["R-1", "R-2"].map((ruleId) => ({
        id: ruleId,
        name: `${ruleId} rule`,
        logic: `${ruleId} deterministic qualification logic`,
        submissionCriteria: `${ruleId} submission criteria`,
        businessReason: `${ruleId} business reason`,
        enforcementLevel: "mandatory" as const,
        failurePolicy: "block" as const,
        executor: "Agent",
        applicableClient: "腾讯",
        applicableDepartment: "IEG",
        relatedEntities: ["Resume"],
        relatedObjectTypes: ["Resume"],
        linkedActions: ["ruleCheckForMatchResume"],
        applicabilityScope: "client_department" as const,
        selectionScore: 100,
        matchReasons: predicates,
        linkPaths: predicates.flatMap((predicate) =>
          Array.from({ length: pathCountPerPredicate }, (_, index) => ({
            linkId: `${ruleId}/${predicate}/${String(index).padStart(5, "0")}`,
            status: "approved",
            confidence: 1,
            subject: { type: "Rule", id: ruleId, displayName: ruleId },
            predicate,
            object: {
              type: predicate === "SCOPED_TO" ? "PolicyScope" : "DataObject",
              id: `${predicate.toLowerCase()}:${String(index).padStart(5, "0")}`,
              displayName: `${predicate} target ${index}`,
            },
            semanticRelationship: `${ruleId} ${predicate} target ${index}`,
            evidence: [
              {
                source: "ontology",
                reason:
                  tamperLastEvidence &&
                  ruleId === "R-2" &&
                  predicate === "RELEVANT_TO" &&
                  index === pathCountPerPredicate - 1
                    ? `tampered-${"x".repeat(2_000)}`
                    : `full-evidence-${"x".repeat(2_000)}`,
              },
            ],
          }))),
        matchedAnchors: ["腾讯", "IEG"],
        scopeReason: "SCOPED_TO client department",
      }));
      return compileQualificationPrompt({
        domainId: "rules-test",
        action: "ruleCheckForMatchResume",
        scenario: "resume_match",
        userPrompt: "检查腾讯 IEG 候选人",
        evidence: {
          jobRequisition: { client_name: "腾讯", department_name: "IEG" },
        },
        queryIr: {
          version: "rule-link-query-ir/v2",
          domainId: "rules-test",
          actionHint: "ruleCheckForMatchResume",
          query: "resume match",
          intentTerms: ["resume match"],
          capabilityAnchors: ["ruleCheckForMatchResume"],
          objectAnchors: ["Resume", "Job_Requisition"],
          evidenceAnchors: [],
          strongKeywords: ["资质"],
          keywords: ["资质"],
          objectTypes: ["Resume", "Job_Requisition"],
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
        rules,
        harnessPlan: {
          version: "reasoning-harness/v2",
          methods: ["graph_react", "rule_by_rule_verification"],
          capabilityAnchors: ["ruleCheckForMatchResume"],
          objectAnchors: ["Resume", "Job_Requisition"],
          evidenceAnchors: [],
          stopConditions: ["每条规则均完成判定"],
          publicRationale: "沿 semantic Links 检索并逐规则判定。",
        },
      });
    };

    const small = compileWithPathCount(2);
    const large = compileWithPathCount(250);
    const tampered = compileWithPathCount(250, true);

    expect(large.semanticLinkCount).toBe(2_000);
    expect(large.ruleIds).toEqual(["R-1", "R-2"]);
    expect(large.userPrompt.length - small.userPrompt.length).toBeLessThan(200);
    expect(large.userPrompt.length).toBeLessThan(30_000);
    expect(large.userPrompt).not.toContain("full-evidence-");

    const marker = "RuleBundle（每条规则含有界 compactLinkProvenance）：\n";
    const compiledRules = JSON.parse(
      large.userPrompt.slice(large.userPrompt.indexOf(marker) + marker.length),
    ) as Array<{
      ruleId: string;
      compactLinkProvenance: {
        fullPathCount: number;
        fullPathsSha256: string;
        sampledLinks: Array<{ predicate: string }>;
        omittedPathCount: number;
      };
    }>;
    expect(compiledRules.map((rule) => rule.ruleId)).toEqual(["R-1", "R-2"]);
    for (const rule of compiledRules) {
      expect(rule.compactLinkProvenance.fullPathCount).toBe(1_000);
      expect(rule.compactLinkProvenance.fullPathsSha256).toMatch(
        /^sha256:[a-f0-9]{64}$/,
      );
      expect(
        new Set(
          rule.compactLinkProvenance.sampledLinks.map(
            (link) => link.predicate,
          ),
        ),
      ).toEqual(
        new Set(["SCOPED_TO", "GOVERNS", "APPLIES_TO", "RELEVANT_TO"]),
      );
      expect(rule.compactLinkProvenance.sampledLinks).toHaveLength(8);
      expect(rule.compactLinkProvenance.omittedPathCount).toBe(992);
    }

    // Even evidence on an omitted Link remains covered by both receipts.
    expect(tampered.userPrompt.length).toBe(large.userPrompt.length);
    expect(tampered.fullSemanticPathsSha256).not.toBe(
      large.fullSemanticPathsSha256,
    );
    expect(tampered.compilerId).not.toBe(large.compilerId);
    expect(tampered.promptSha256).not.toBe(large.promptSha256);
  });
});
