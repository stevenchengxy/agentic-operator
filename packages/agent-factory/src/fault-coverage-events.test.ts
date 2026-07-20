import { describe, it, expect } from "vitest";
import { FACTORY_TOOLS, normalizeQuestion } from "./tools";
import { proposeTestCases } from "./test-cases";
import type { BrainCtx, BrainEvent, TestCase } from "./brain-types";
import type { GeneratedAgentSpec } from "./spec-types";
import type { FactoryAuthorizationChallengeStore } from "./authorization-challenge";
import { SANDBOX_BROKER_REGISTRATION_SCHEMA } from "./ports";

// #W3-FAULT / #W2-4 — the two NEW event fields the factory frontend consumes must actually flow
// through the REAL emit path (not just exist as types):
//   1. test.cases carries `coverage` + a backfilled `fault` case (tooled entry agent).
//   2. sandbox carries `caseVerdicts` (per-kind incl. fault) so the UI can prove error propagation.
// Both run deterministically: no gateway → authorTestCases falls back to goldenFixture; the sandbox
// deployer is stubbed. This is the plumbing proof behind the transcript render.

function tooledEntrySpec(): GeneratedAgentSpec {
  return {
    key: "process-resume", actionName: "process-resume", slug: "d-process-resume", short: "简历处理", domainId: "rec",
    nameZh: "简历处理", kind: "llm", trigger: ["RESUME_RECEIVED"], emit: ["RESUME_PARSED"], tools: ["parseResumeApi"],
    toolPolicies: { parseResumeApi: { operation: "compute", effectScope: "external", sandboxPolicy: "live_external" } },
    unresolvedTools: [], objects: [], systemPrompt: "p", userPrompt: "", steps: [], ruleRefs: [], retries: 1,
    hitl: false, confidence: 1, promptSource: "llm", inputSchema: [{ field: "resume_id", type: "string" }],
  } as unknown as GeneratedAgentSpec;
}

const reviewChallenges: FactoryAuthorizationChallengeStore = {
  async issue(_domain, input) {
    const digest = input.subjectDigest;
    const token = `authorize_sandbox_design_review:v1:${digest}`;
    return {
      id: `fac-${digest.slice(0, 12)}`,
      kind: input.kind,
      protocolVersion: 1,
      digest,
      subjectDigest: digest,
      token,
      question: input.question,
      context: `sandbox_design_review_authorization:v1:${digest}`,
      options: [
        { label: input.declineLabel, value: `decline_sandbox_design_review:v1:${digest}`, recommended: true },
        { label: input.confirmLabel, value: token, recommended: false },
      ],
      runId: input.runId,
      conversationId: input.conversationId,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
  },
  async restore() { return null; },
  async consume(_domain, { challenge, actor }) {
    return {
      challengeId: challenge.id,
      kind: challenge.kind,
      protocolVersion: challenge.protocolVersion,
      digest: challenge.digest,
      subjectDigest: challenge.subjectDigest,
      authorizationDigest: challenge.digest,
      actor,
      runId: challenge.runId,
      conversationId: challenge.conversationId,
      consumedAt: new Date().toISOString(),
      expiresAt: challenge.expiresAt,
    };
  },
};

function makeCtx(over: Partial<BrainCtx> = {}): { ctx: BrainCtx; events: BrainEvent[] } {
  const events: BrainEvent[] = [];
  const ctx = {
    domain: "rec",
    conversationId: "fault-review-run",
    specs: [tooledEntrySpec()],
    ontology: {
      objects: [],
      events: [{ name: "RESUME_RECEIVED", payload: { event_data: [{ name: "resume_id", type: "string" }] } }],
      actions: [{
        id: "process-resume",
        name: "process-resume",
        actor: ["Agent"],
        trigger: ["RESUME_RECEIVED"],
        triggered_event: ["RESUME_PARSED"],
        target_objects: [],
        tool_use: [],
        system_prompt: "",
        user_prompt: "",
      }],
    },
    spent: { sandboxRuns: 0, refines: 0, turns: 0 },
    realTools: [
      { name: "parseResumeApi", operation: "compute", effectScope: "external", sandboxPolicy: "live_external" },
      { name: "mail.sendInvitation", operation: "write", effectScope: "external", sandboxPolicy: "requires_attempt_grant" },
    ],
    emit: (e: BrainEvent) => { events.push(e); },
    ...over,
    ports: { authorizationChallenges: reviewChallenges, ...(over.ports ?? {}) },
  } as unknown as BrainCtx;
  return { ctx, events };
}

async function approveAndRunSandbox(ctx: BrainCtx) {
  const sandboxTool = FACTORY_TOOLS.find((tool) => tool.name === "sandbox_run")!;
  const review = await sandboxTool.execute({}, ctx);
  expect(review.ok).toBe(false);
  const challenge = Object.values(ctx.pendingAuthorizationChallenges ?? {})[0]!;
  const question = challenge.question;
  const context = challenge.context;
  const options = challenge.options;
  const approve = options.find((option) => option.value === challenge.token);
  expect(approve).toBeTruthy();
  ctx.clarificationAnswerEvidence = {
    [normalizeQuestion(question)]: {
      question,
      context,
      options,
      answer: approve!.value,
      actor: "usr-reviewer",
      answeredAt: Date.now(),
    },
  };
  return sandboxTool.execute({}, ctx);
}

describe("#W2-4 test.cases event carries coverage + a fault case", () => {
  it("proposeTestCases emits coverage and backfills a fault-injection case for the tooled entry agent", async () => {
    const { ctx, events } = makeCtx();
    await proposeTestCases(ctx);

    const tc = events.find((e) => e.t === "test.cases") as Extract<BrainEvent, { t: "test.cases" }> | undefined;
    expect(tc).toBeTruthy();
    // coverage must ride the event (this is what the transcript coverage strip renders).
    expect(tc!.coverage).toBeTruthy();
    expect(Array.isArray(tc!.coverage!.required)).toBe(true);
    expect(tc!.coverage!.required.some((c) => c.startsWith("fault:"))).toBe(true);
    // a real fault case must be present in the suite (violet ⚡故障注入 chip in the UI).
    const fault = tc!.cases.find((c) => c.kind === "fault");
    expect(fault).toBeTruthy();
    expect((fault!.payload as { __fault?: { tool: string; kind: string } }).__fault).toEqual({ tool: "parseResumeApi", kind: "timeout" });
  });
});

describe("#W3-FAULT sandbox event carries caseVerdicts", () => {
  it("sandbox_run threads the deployer's per-kind verdicts onto the emitted sandbox event", async () => {
    const cases: TestCase[] = [
      { id: "p1", name: "happy", scenario: "s", kind: "pass", entryEvent: "RESUME_RECEIVED", payload: { resume_id: "r1" }, expectedOutcome: "ok" },
      { id: "f1", name: "fault", scenario: "s", kind: "fault", entryEvent: "RESUME_RECEIVED", payload: { resume_id: "r1", __fault: { tool: "parseResumeApi", kind: "timeout" } }, expectedOutcome: "graceful" },
    ];
    const caseVerdicts = {
      allPass: true,
      results: [
        { kind: "pass", pass: true, reason: "reached success terminal" },
        { kind: "fault", pass: true, reason: "refused a success terminal under injected fault" },
      ],
      byKind: { pass: { total: 1, passed: 1 }, reject: { total: 0, passed: 0 }, edge: { total: 0, passed: 0 }, fault: { total: 1, passed: 1 } },
    };
    const { ctx, events } = makeCtx({
      testCases: cases,
      ports: {
        sandbox: {
          deployAndObserve: async () => ({
            appId: "agentic-operator-rec-sb", functionsRegistered: 1, ran: 2, deployed: 1,
            committedManifestFunctionIds: ["d-process-resume"],
            brokerRegistration: {
              schema: SANDBOX_BROKER_REGISTRATION_SCHEMA,
              appId: "agentic-operator-rec-sb",
              expectedFunctionCount: 1,
              observedFunctionCount: 1,
              connected: true,
              verified: true,
              evidence: "dev_graphql",
              checkedAt: new Date(0).toISOString(),
            },
            reachedSuccessTerminal: true, fullChainRan: true, degradedAgents: [], runs: [{ id: "run-1", status: "Completed" }],
            fingerprint: "fp", simulated: false, toolMode: "evidence_replay", externalLiveCalls: 0,
            replayReceipts: [], sandboxReplayEvidenceComplete: true,
            agentRuns: [], caseVerdicts,
          }),
        },
      } as unknown as BrainCtx["ports"],
    });

    await approveAndRunSandbox(ctx);

    const sb = events.find((e) => e.t === "sandbox") as Extract<BrainEvent, { t: "sandbox" }> | undefined;
    expect(sb).toBeTruthy();
    expect(sb!.caseVerdicts).toBeTruthy();
    expect(sb!.caseVerdicts!.allPass).toBe(true);
    // the fault verdict specifically — the UI's "⚡ 故障注入通过" line depends on it.
    expect(sb!.caseVerdicts!.byKind.fault).toEqual({ total: 1, passed: 1 });
    expect(sb!.caseVerdicts!.results.some((r) => r.kind === "fault" && r.pass)).toBe(true);
  });

  it("does not call a gated external write an end-to-end sandbox success", async () => {
    const writeSpec = {
      ...tooledEntrySpec(),
      tools: ["mail.sendInvitation"],
      toolPolicies: { "mail.sendInvitation": { operation: "write", effectScope: "external", sandboxPolicy: "requires_attempt_grant" } },
    } as GeneratedAgentSpec;
    const cases: TestCase[] = [
      { id: "p1", name: "happy", scenario: "s", kind: "pass", entryEvent: "RESUME_RECEIVED", payload: { resume_id: "r1" }, expectedOutcome: "ok" },
      { id: "f1", name: "fault", scenario: "s", kind: "fault", entryEvent: "RESUME_RECEIVED", payload: { resume_id: "r1", __fault: { tool: "mail.sendInvitation", kind: "timeout" } }, expectedOutcome: "graceful" },
    ];
    const { ctx } = makeCtx({
      specs: [writeSpec],
      testCases: cases,
      ports: {
        sandbox: {
          deployAndObserve: async () => ({
            appId: "agentic-operator-rec-sb",
            functionsRegistered: 1,
            ran: 1,
            deployed: 1,
            reachedSuccessTerminal: true,
            fullChainRan: true,
            degradedAgents: [],
            runs: [{ id: "run-1", status: "Completed" }],
            fingerprint: "fp",
            simulated: false,
            toolMode: "gated",
            externalLiveCalls: 0,
            registeredIds: ["d-process-resume"],
            agentRuns: [],
          }),
        },
        reflection: { record: async () => {}, list: async () => [] },
      } as unknown as BrainCtx["ports"],
    });

    const result = await approveAndRunSandbox(ctx);

    expect(result.ok).toBe(false);
    expect(result.summary).toContain("外部写缺少当前 attempt");
    expect(ctx.lastSandbox).toMatchObject({
      toolMode: "gated",
      externalWritesRequired: true,
    });
  });
});
