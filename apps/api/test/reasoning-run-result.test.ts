import path from "node:path";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readReasoningRunResult } from "../src/services/reasoning/run-result";

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function validV2Output(parentRunId: string): Record<string, any> {
  const compilerVersion = "qualified-rule-check/v3";
  const domainId = "rules-test";
  const action = "matchResume";
  const scenario = "pre_match";
  const queryIr = {
    version: "rule-link-query-ir/v2",
    domainId,
    actionHint: action,
  };
  const harnessPlan = {
    version: "reasoning-harness/v2",
    methods: ["graph_react", "evidence_grounding"],
    capabilityAnchors: [action],
    objectAnchors: ["Resume"],
    evidenceAnchors: [],
    stopConditions: ["all rules assessed"],
    publicRationale: "link-first selection",
  };
  const selectedRules = [
    {
      id: "R-1",
      enforcementLevel: "mandatory",
      linkPaths: [
        {
          linkId: "link-1",
          predicate: "SCOPED_TO",
          subject: { type: "Rule", id: "R-1", displayName: "R-1" },
          object: {
            type: "PolicyScope",
            id: "csi:universal",
            displayName: "CSI",
          },
        },
      ],
    },
  ];
  const semanticPaths = selectedRules.map((rule) => ({
    ruleId: rule.id,
    linkPaths: rule.linkPaths,
  }));
  const ruleIds = ["R-1"];
  const evidenceKeys = ["resume"];
  const evidencePlan: unknown[] = [];
  const fullSemanticPathsSha256 = sha256(JSON.stringify(semanticPaths));
  const compilerId = `pc:${createHash("sha256")
    .update(
      JSON.stringify({
        compilerVersion,
        domainId,
        action,
        scenario,
        queryIr,
        ruleIds,
        evidenceKeys,
        harnessPlan,
        semanticPaths,
        evidencePlan,
      }),
    )
    .digest("hex")}`;
  const systemPrompt = "system prompt";
  const userPrompt = "user prompt";
  const promptSha256 = `sha256:${createHash("sha256")
    .update(systemPrompt)
    .update("\0")
    .update(userPrompt)
    .update("\0")
    .update(fullSemanticPathsSha256)
    .digest("hex")}`;
  const selectionExecution = {
    purpose: "semantic-rule-selection",
    language: "cypher",
    query: "MATCH (r:Rule)-[:SCOPED_TO]->(s) RETURN r, s",
    fingerprint: "sha256:selection",
    readOnly: true,
    domainLocked: true,
    linkOnly: true,
    fallbackUsed: false,
    rowCount: 1,
  };
  const coverageExecution = {
    ...selectionExecution,
    purpose: "mandatory-link-coverage",
    query: "MATCH (r:Rule)-[:APPLIES_TO]->(o) RETURN r, o",
    fingerprint: "sha256:coverage",
    rowCount: 0,
  };
  return {
    decision: "eligible_with_flags",
    domainId,
    action,
    scenario,
    ruleBundleId: "sha256:bundle",
    ruleCount: 1,
    queryIr,
    harnessPlan,
    promptCompiler: { compilerId, compilerVersion, evidenceKeys },
    assessments: [{ ruleId: "R-1", status: "satisfied" }],
    audit: {
      hiddenChainOfThoughtExposed: false,
      ruleSelection: {
        queryFingerprint: selectionExecution.fingerprint,
        queryExecution: selectionExecution,
        queryExecutions: [selectionExecution, coverageExecution],
        selectedRules,
        mandatoryCount: 1,
        optionalCount: 0,
      },
      compiledPrompt: {
        compilerId,
        compilerVersion,
        promptSha256,
        fullSemanticPathsSha256,
        scenario,
        ruleIds,
        evidenceKeys,
        harnessPlan,
        semanticLinkCount: 1,
        evidencePlan,
        systemPrompt,
        userPrompt,
      },
      qualityCheck: {
        agent: "QualifiedAgent",
        executionMode: "isolated-child-run",
        assessmentCount: 1,
        statusCounts: {
          satisfied: 1,
          violated: 0,
          optional_unmet: 0,
          not_applicable: 0,
          insufficient_evidence: 0,
        },
        run: {
          role: "qualified",
          executionMode: "isolated-child-run",
          runId: "run-child",
          parentRunId,
          compilerId,
          promptSha256,
          ruleBundleId: "sha256:bundle",
          assessmentCount: 1,
        },
      },
    },
  };
}

describe("persisted reasoning run result", () => {
  let root = "";
  let previous: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "agentic-reasoning-result-"));
    previous = process.env.AGENTIC_ARTIFACTS_DIR;
    process.env.AGENTIC_ARTIFACTS_DIR = root;
  });

  afterEach(async () => {
    if (previous === undefined) delete process.env.AGENTIC_ARTIFACTS_DIR;
    else process.env.AGENTIC_ARTIFACTS_DIR = previous;
    await rm(root, { recursive: true, force: true });
  });

  it("returns null while a run has not produced its final artifact", async () => {
    await expect(readReasoningRunResult("run-waiting")).resolves.toBeNull();
  });

  it("reads a versioned post-fold result envelope", async () => {
    const runId = "run-audit-1";
    const directory = path.join(root, runId);
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, "reasoning-result.json"),
      JSON.stringify({
        schemaVersion: "reasoning-result/v2",
        runId,
        output: validV2Output(runId),
      }),
    );

    await expect(readReasoningRunResult(runId)).resolves.toMatchObject({
      schemaVersion: "reasoning-result/v2",
      runId,
      output: { decision: "eligible_with_flags" },
    });
  });

  it("rejects v2 Prompt, Links, or child receipt tampering", async () => {
    const mutations: Array<{
      name: string;
      apply: (output: Record<string, any>) => void;
      error: RegExp;
    }> = [
      {
        name: "prompt",
        apply: (output) => {
          output.audit.compiledPrompt.userPrompt = "tampered";
        },
        error: /Prompt content hash mismatch/,
      },
      {
        name: "links",
        apply: (output) => {
          output.audit.ruleSelection.selectedRules[0].linkPaths[0].linkId =
            "tampered-link";
        },
        error: /Semantic Link paths hash mismatch/,
      },
      {
        name: "child",
        apply: (output) => {
          output.audit.qualityCheck.run.compilerId = "pc:tampered";
        },
        error: /QualifiedAgent child receipt mismatch/,
      },
    ];

    for (const mutation of mutations) {
      const runId = `run-tamper-${mutation.name}`;
      const directory = path.join(root, runId);
      await mkdir(directory, { recursive: true });
      const output = validV2Output(runId);
      mutation.apply(output);
      await writeFile(
        path.join(directory, "reasoning-result.json"),
        JSON.stringify({ schemaVersion: "reasoning-result/v2", runId, output }),
      );
      await expect(readReasoningRunResult(runId)).rejects.toThrow(
        mutation.error,
      );
    }
  });

  it("keeps reading v1 artifacts created by historical runs", async () => {
    const runId = "run-audit-legacy";
    const directory = path.join(root, runId);
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, "reasoning-result.json"),
      JSON.stringify({
        schemaVersion: "reasoning-result/v1",
        runId,
        output: { decision: "eligible", audit: { trace: [] } },
      }),
    );

    await expect(readReasoningRunResult(runId)).resolves.toMatchObject({
      schemaVersion: "reasoning-result/v1",
      runId,
    });
  });

  it("keeps reading historical v2 compiler receipts without v3 path digests", async () => {
    const runId = "run-audit-v2-compiler";
    const directory = path.join(root, runId);
    await mkdir(directory, { recursive: true });
    const output = validV2Output(runId);
    output.promptCompiler.compilerVersion = "qualified-rule-check/v2";
    output.audit.compiledPrompt.compilerVersion = "qualified-rule-check/v2";
    delete output.audit.compiledPrompt.fullSemanticPathsSha256;
    delete output.audit.compiledPrompt.semanticLinkCount;
    delete output.audit.compiledPrompt.harnessPlan;
    delete output.audit.compiledPrompt.evidencePlan;
    await writeFile(
      path.join(directory, "reasoning-result.json"),
      JSON.stringify({ schemaVersion: "reasoning-result/v2", runId, output }),
    );

    await expect(readReasoningRunResult(runId)).resolves.toMatchObject({
      schemaVersion: "reasoning-result/v2",
      runId,
    });
  });

  it("rejects a mismatched or malformed envelope", async () => {
    const runId = "run-audit-2";
    const directory = path.join(root, runId);
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, "reasoning-result.json"),
      JSON.stringify({
        schemaVersion: "reasoning-result/v1",
        runId: "another-run",
        output: {},
      }),
    );

    await expect(readReasoningRunResult(runId)).rejects.toThrow(
      /invalid envelope/,
    );
  });
});
