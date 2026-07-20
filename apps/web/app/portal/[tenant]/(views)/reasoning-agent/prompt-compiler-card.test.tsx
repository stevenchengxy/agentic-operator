import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CompiledPrompt, QualifiedAgentRunReceipt } from "./contracts";
import { PromptCompilerCard } from "./page";

const prompt: CompiledPrompt = {
  compilerId: "pc:v3",
  compilerVersion: "qualified-rule-check/v3",
  promptSha256: "sha256:prompt",
  fullSemanticPathsSha256: "sha256:paths",
  scenario: "pre_match_resume_rule_check",
  ruleIds: ["R-1", "R-2"],
  evidenceKeys: ["resume", "jobRequisition"],
  harnessPlan: {
    version: "reasoning-harness/v2",
    methods: ["graph_react", "evidence_grounding"],
    capabilityAnchors: ["matchResume"],
    objectAnchors: ["Resume", "Job_Requisition"],
    evidenceAnchors: [],
    stopConditions: ["all rules assessed"],
    publicRationale: "link-first",
  },
  semanticLinkCount: 12,
  evidencePlan: [
    {
      ruleId: "R-1",
      relevance: "direct",
      summary: "degree evidence",
      evidence: [
        {
          path: "resume.education[0].degree",
          actualValue: "本科",
          verified: true,
        },
      ],
    },
  ],
  systemPrompt: "exact system prompt",
  userPrompt: "exact user prompt with RuleBundle",
};

const qualifiedRun: QualifiedAgentRunReceipt = {
  role: "qualified",
  executionMode: "isolated-child-run",
  runId: "run-child",
  parentRunId: "run-parent",
  correlationId: "cor-1",
  compilerId: prompt.compilerId,
  promptSha256: prompt.promptSha256!,
  ruleBundleId: "sha256:bundle",
  provider: "custom",
  model: "qualified-model",
  tokensIn: 100,
  tokensOut: 20,
  durationMs: 900,
  steps: 1,
  assessmentCount: 2,
};

describe("PromptCompilerCard", () => {
  it("renders the dynamic compiler lineage and keeps full prompts collapsed", () => {
    const html = renderToStaticMarkup(
      <PromptCompilerCard
        prompt={prompt}
        receipt={null}
        qualifiedRun={qualifiedRun}
        ruleBundleId="sha256:bundle"
        executedPrompt={{
          source: "verified-qualified-child-step",
          runId: "run-child",
          parentRunId: "run-parent",
          runStatus: "ok",
          provider: "custom",
          model: "qualified-model",
          systemPrompt: prompt.systemPrompt,
          userPrompt: prompt.userPrompt,
        }}
      />,
    );

    expect(html).toContain('data-testid="prompt-compiler-card"');
    expect(html).toContain('data-testid="prompt-compiler-receipt"');
    expect(html).toContain("pc:v3");
    expect(html).toContain("graph_react → evidence_grounding");
    expect(html).toContain("receipt verified");
    expect(html).toContain("exact match");
    expect(html).toContain('data-testid="prompt-system-details"');
    expect(html).toContain('data-testid="prompt-user-details"');
    expect(html).not.toMatch(/<details[^>]*\sopen(?:=|\s|>)/);
  });

  it("never invents full prompt text from a compact receipt", () => {
    const html = renderToStaticMarkup(
      <PromptCompilerCard
        prompt={null}
        receipt={{
          compilerReceipt: {
            compilerId: prompt.compilerId,
            compilerVersion: "qualified-rule-check/v3",
            promptSha256: prompt.promptSha256!,
            fullSemanticPathsSha256: prompt.fullSemanticPathsSha256,
          },
          ruleCount: 2,
          qualifiedRun,
          assessmentCount: 2,
        }}
        qualifiedRun={qualifiedRun}
        ruleBundleId="sha256:bundle"
        executedPrompt={null}
      />,
    );

    expect(html).toContain("compact compiler receipt");
    expect(html).not.toContain('data-testid="prompt-system-details"');
    expect(html).not.toContain("exact system prompt");
  });
});
