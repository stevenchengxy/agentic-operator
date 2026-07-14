import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { AgentRunRecord } from "@agentic/contracts";
import {
  AgentInputValidationError,
  OutputSchemaValidationError,
  bindTriggerInputs,
  compileAgentPrompts,
  normalizeAgentForExecution,
  parseValidateAndRepairOutput,
  resolveAgentEmissions,
  validateAgentInputs,
} from "./agent-execution";
import { persistTerminalRunArtifacts } from "./artifacts";

function definition(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: "5-candidate-assessor",
    name: "candidateAssessor",
    title: "Candidate Assessor",
    description: "Assess a candidate.",
    actor: ["Agent"],
    trigger: ["CANDIDATE_READY"],
    trigger_bindings: {
      CANDIDATE_READY: {
        prompt: {
          template: "Assess {{event.candidate.name}} for {{event.job.title}}.",
        },
        candidate: { path: "$.candidate" },
      },
    },
    inputs: [
      {
        id: "prompt",
        kind: "prompt",
        required: true,
        schema: { type: "string", minLength: 1 },
      },
      {
        id: "candidate",
        kind: "value",
        required: true,
        schema: {
          type: "object",
          required: ["id", "name"],
          properties: {
            id: { type: "string" },
            name: { type: "string" },
          },
          additionalProperties: false,
        },
      },
      {
        id: "resume",
        kind: "file",
        required: false,
        schema: { type: "object" },
      },
    ],
    ontology_instructions: "Use only supplied evidence.",
    user_prompt_template: "<candidate>{{json inputs.candidate}}</candidate>",
    generated: true,
    tool_use: [{ name: "matchResumeApi" }],
    actions: [
      {
        order: "1",
        name: "assessCandidate",
        description: "Assess the candidate.",
        type: "logic",
      },
    ],
    outputs: [
      {
        id: "assessment",
        required: true,
        schema: {
          type: "object",
          required: ["recommendation", "score"],
          properties: {
            recommendation: {
              type: "string",
              enum: ["advance", "hold", "reject"],
            },
            score: { type: "number", minimum: 0, maximum: 100 },
          },
          additionalProperties: false,
        },
      },
      { id: "summary", required: true, schema: { type: "string" } },
    ],
    output_config: {
      format: "json",
      strict: true,
      repair_attempts: 1,
      unwrap_single_output: false,
      artifact: {
        filename: "output.json",
        persist_individual_outputs: false,
        persist_run_input: true,
        persist_run_record: true,
        persist_raw_response: false,
      },
    },
    triggered_event: ["CANDIDATE_ASSESSED", "AUDIT_READY"],
    output_bindings: {
      CANDIDATE_ASSESSED: {
        candidate_id: { input: "candidate", path: "$.id" },
        recommendation: {
          output: "assessment",
          path: "$.recommendation",
        },
      },
      AUDIT_READY: { summary: { output: "summary" } },
    },
    provider: "mock",
    model: "mock-model-v1",
    ...overrides,
  };
}

describe("Agent Definition v2 execution helpers", () => {
  it("normalizes v1 without opting it into v2 emission behavior", () => {
    const normalized = normalizeAgentForExecution({
      id: "legacy",
      name: "legacyAgent",
      actor: ["Agent"],
      trigger: ["START"],
      actions: [{ order: "1", name: "work", description: "", type: "logic" }],
      triggered_event: ["FIRST", "SECOND"],
      input_data: { prompt: "Legacy request", answer: 42 },
      unknown_extension: { preserved: true },
    });

    assert.equal(normalized.compatibilityMode, "v1");
    assert.equal(normalized.definition.output_config.strict, false);
    assert.equal(normalized.definition.inputs[0]?.id, "prompt");
    assert.deepEqual(normalized.definition.unknown_extension, {
      preserved: true,
    });

    const emissions = resolveAgentEmissions({
      definition: normalized,
      inputs: {},
      outputs: "legacy result",
      source: { agentName: "legacyAgent", runId: "run-legacy" },
    });
    assert.equal(emissions.length, 1);
    assert.equal(emissions[0]?.name, "FIRST");
    assert.equal(emissions[0]?.payload.last_result, "legacy result");
  });

  it("binds and validates named inputs before execution", () => {
    const bound = bindTriggerInputs(definition(), {
      name: "CANDIDATE_READY",
      data: {
        // An explicit trigger binding is authoritative over the Studio-style
        // top-level prompt convenience field.
        prompt: "Do not replace the authored binding.",
        candidate: { id: "cand-1", name: "Ada" },
        job: { title: "AI Engineer" },
      },
      subject: "cand-1",
    });
    assert.equal(bound.prompt, "Assess Ada for AI Engineer.");
    assert.deepEqual(bound.candidate, { id: "cand-1", name: "Ada" });
    assert.deepEqual(validateAgentInputs(definition(), bound).values, bound);

    assert.throws(
      () =>
        validateAgentInputs(definition(), {
          prompt: "Assess",
          candidate: { id: "cand-1" },
          undeclared: true,
        }),
      (error: unknown) => {
        assert.ok(error instanceof AgentInputValidationError);
        assert.ok(error.issues.some((issue) => issue.code === "input_unknown"));
        assert.ok(
          error.issues.some((issue) => issue.path === "/inputs/candidate/name"),
        );
        return true;
      },
    );
  });

  it("compiles deterministic system/user roles with exact prompt first", () => {
    const inputs = {
      prompt: "Assess this candidate exactly as requested.",
      candidate: { name: "<Ada>", id: "cand-1" },
      resume: {
        artifactId: "art-resume",
        name: "resume.pdf",
        contentType: "application/pdf",
        path: "/secret/internal/path.pdf",
      },
    };
    const first = compileAgentPrompts(definition(), inputs, {
      tenantInstructions: "Tenant policy: redact personal data.",
      run: { subject: "cand-1" },
    });
    const second = compileAgentPrompts(definition(), inputs, {
      tenantInstructions: "Tenant policy: redact personal data.",
      run: { subject: "cand-1" },
    });

    assert.deepEqual(first, second);
    assert.equal(first.messages[0]?.role, "system");
    assert.equal(first.messages[1]?.role, "user");
    assert.ok(first.user.startsWith(inputs.prompt));
    assert.match(first.user, /<agent-inputs>/);
    assert.match(first.user, /\\u003cAda\\u003e/);
    assert.match(first.user, /<attachments>/);
    assert.doesNotMatch(first.user, /secret\/internal/);
    assert.match(first.system, /Use only supplied evidence/);
    assert.match(first.system, /matchResumeApi/);
    assert.match(first.system, /"assessment"/);
  });

  it("strictly validates output and honors the bounded repair count", async () => {
    let repairs = 0;
    const result = await parseValidateAndRepairOutput({
      definition: definition(),
      candidate: "not json",
      repair: async ({ issues, invalidResponse }) => {
        repairs += 1;
        assert.equal(invalidResponse, "not json");
        assert.ok(issues.length > 0);
        return JSON.stringify({
          assessment: { recommendation: "advance", score: 91 },
          summary: "Strong evidence.",
        });
      },
    });
    assert.equal(repairs, 1);
    assert.equal(result.valid, true);
    assert.equal(result.repaired, true);
    assert.deepEqual(result.value, {
      assessment: { recommendation: "advance", score: 91 },
      summary: "Strong evidence.",
    });

    repairs = 0;
    await assert.rejects(
      parseValidateAndRepairOutput({
        definition: definition({
          output_config: {
            format: "json",
            strict: true,
            repair_attempts: 3,
            unwrap_single_output: false,
            artifact: {
              filename: "output.json",
              persist_individual_outputs: false,
              persist_run_input: true,
              persist_run_record: true,
              persist_raw_response: false,
            },
          },
        }),
        candidate: "bad",
        repair: async ({ attempt, maxAttempts }) => {
          repairs += 1;
          assert.equal(attempt, repairs);
          assert.equal(maxAttempts, 3);
          return "still bad";
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof OutputSchemaValidationError);
        assert.equal(error.attempts, 3);
        return true;
      },
    );
    assert.equal(repairs, 3);
  });

  it("rejects remote JSON Schema refs", async () => {
    await assert.rejects(
      parseValidateAndRepairOutput({
        definition: definition({
          outputs: [
            {
              id: "assessment",
              required: true,
              schema: { $ref: "https://example.com/output.json" },
            },
          ],
        }),
        candidate: JSON.stringify({ assessment: {} }),
      }),
      (error: unknown) => {
        assert.ok(error instanceof OutputSchemaValidationError);
        assert.ok(
          error.issues.some(
            (issue) => issue.code === "json_schema_remote_ref_forbidden",
          ),
        );
        return true;
      },
    );
  });

  it("maps every v2 emitted event to named inputs/outputs", () => {
    const outputs = {
      assessment: { recommendation: "hold", score: 63 },
      summary: "Needs verification.",
    };
    const emissions = resolveAgentEmissions({
      definition: definition(),
      inputs: {
        prompt: "Assess",
        candidate: { id: "cand-7", name: "Grace" },
      },
      outputs,
      source: {
        agentName: "candidateAssessor",
        runId: "run-7",
        subject: "cand-7",
      },
    });
    assert.equal(emissions.length, 2);
    assert.deepEqual(emissions[0]?.payload, {
      source_agent: "candidateAssessor",
      source_run: "run-7",
      subject: "cand-7",
      candidate_id: "cand-7",
      recommendation: "hold",
    });
    assert.deepEqual(emissions[0]?.outputPortIds, ["assessment"]);
    assert.equal(emissions[1]?.payload.summary, "Needs verification.");
  });
});

describe("terminal artifact lifecycle", () => {
  let root: string;
  let previousRoot: string | undefined;

  after(async () => {
    if (previousRoot === undefined) delete process.env.AGENTIC_ARTIFACTS_DIR;
    else process.env.AGENTIC_ARTIFACTS_DIR = previousRoot;
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("atomically persists exact output.json and run-record.json", async () => {
    previousRoot = process.env.AGENTIC_ARTIFACTS_DIR;
    root = await mkdtemp(path.join(os.tmpdir(), "agentic-runtime-artifacts-"));
    process.env.AGENTIC_ARTIFACTS_DIR = root;
    const record: AgentRunRecord = {
      schemaVersion: 1,
      runId: "run-artifact-1",
      tenantId: "ten-1",
      agentId: "agt-1",
      status: "ok",
      invocationSource: "studio",
      target: { kind: "live", agentVersionId: "agv-1" },
      definitionHash: "sha256:test",
      sessionId: null,
      correlationId: "cor-1",
      subject: "subject-1",
      validation: { inputValid: true, outputValid: true, issues: [] },
      artifacts: [],
      emittedEvents: [],
      timing: {
        queuedAt: null,
        startedAt: new Date("2026-07-15T00:00:00.000Z"),
        endedAt: new Date("2026-07-15T00:00:01.000Z"),
        durationMs: 1_000,
      },
      error: null,
    };
    const output = { assessment: { score: 88 }, summary: "Advance" };
    const persisted = await persistTerminalRunArtifacts({ record, output });

    assert.equal(persisted.output?.logicalName, "output.json");
    assert.equal(persisted.runRecord.logicalName, "run-record.json");
    assert.deepEqual(
      JSON.parse(
        await readFile(
          path.join(root, "run-artifact-1", "output.json"),
          "utf8",
        ),
      ),
      output,
    );
    const recordOnDisk = JSON.parse(
      await readFile(
        path.join(root, "run-artifact-1", "run-record.json"),
        "utf8",
      ),
    ) as { status: string; definitionHash: string };
    assert.equal(recordOnDisk.status, "ok");
    assert.equal(recordOnDisk.definitionHash, "sha256:test");
  });
});
