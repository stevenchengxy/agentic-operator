import { afterEach, describe, expect, it, vi } from "vitest";

import type { BrainCtx, TestCase } from "./brain-types";
import {
  ontologyContentHash,
  sandboxEvidenceFingerprint,
  specsFingerprint,
} from "./evidence-fingerprint";
import type { DomainOntology } from "./ontology-types";
import type { GeneratedAgentSpec } from "./spec-types";
import { FACTORY_TOOLS, normalizeQuestion } from "./tools";
import type { RealTool } from "./tool-catalog";
import { SANDBOX_BROKER_REGISTRATION_SCHEMA, SandboxLifecycleBlockedError } from "./ports";
import type {
  FactoryAuthorizationChallenge,
  FactoryAuthorizationChallengeStore,
} from "./authorization-challenge";
import {
  INTEGRATION_PROFILE_AUTHORIZATION_PROTOCOL_VERSION,
  integrationProfileConfigDigest,
  integrationProfileToolDefinitionDigest,
} from "./integration-profile-authorization";

const sandboxRun = FACTORY_TOOLS.find((tool) => tool.name === "sandbox_run")!;
const finish = FACTORY_TOOLS.find((tool) => tool.name === "finish")!;

function reviewChallengeStore(): FactoryAuthorizationChallengeStore {
  return {
    async issue(_domain, input) {
      const digest = input.subjectDigest;
      const token = `authorize_sandbox_design_review:v1:${digest}`;
      return {
        id: `fac-${digest.slice(0, 12)}`,
        kind: input.kind,
        protocolVersion: 1,
        digest,
        subjectDigest: input.subjectDigest,
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
      } satisfies FactoryAuthorizationChallenge;
    },
    async restore() { return null; },
    async consume(_domain, { challenge, answer, actor }) {
      if (answer !== challenge.token) throw new Error("wrong review token");
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
}

async function approveAndRunSandbox(ctx: BrainCtx) {
  const review = await sandboxRun.execute({}, ctx);
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
  return sandboxRun.execute({}, ctx);
}

afterEach(() => vi.unstubAllEnvs());

function makeSpec(): GeneratedAgentSpec {
  return {
    key: "work",
    actionName: "work",
    slug: "rec-work",
    short: "WorkAgent",
    domainId: "rec",
    nameZh: "处理",
    kind: "llm",
    trigger: ["WORK_REQUESTED"],
    emit: ["WORK_COMPLETED"],
    tools: ["meta.ping"],
    toolSideEffects: { "meta.ping": "read" },
    toolPolicies: {
      "meta.ping": {
        operation: "read",
        effectScope: "none",
        sandboxPolicy: "pure",
      },
    },
    toolConfigs: { "meta.ping": { timeout_ms: 1_000 } },
    toolProfileRefs: { "meta.ping": "profile-meta-production" },
    sandboxToolConfigs: { "meta.ping": { timeout_ms: 1_000 } },
    sandboxToolProfileRefs: { "meta.ping": "profile-meta-sandbox" },
    unresolvedTools: [],
    objects: [],
    systemPrompt: "Perform the work",
    userPrompt: "",
    decisionLogic: "emit WORK_COMPLETED",
    steps: [],
    plan: [{ stepId: "ping", kind: "tool", tool: "meta.ping" }],
    ruleRefs: [],
    retries: 1,
    hitl: false,
    confidence: 1,
    promptSource: "llm",
    inputSchema: [{ field: "a", type: "string" }],
    outputSchema: [{ field: "a", type: "string" }],
    generatedCode: "export async function handler() { return { a: 'ok' }; }",
    codeSource: "ai",
    codeExecuted: false,
  };
}

function makeOntology(): DomainOntology {
  return {
    domainId: "rec",
    source: "allmeta",
    objects: [],
    rules: [],
    workflow: [],
    actions: [{
      id: "work",
      name: "work",
      actor: ["Agent"],
      trigger: ["WORK_REQUESTED"],
      triggered_event: ["WORK_COMPLETED"],
      target_objects: [],
      tool_use: ["meta.ping"],
      system_prompt: "",
      user_prompt: "",
    }],
    events: [
      { name: "WORK_REQUESTED", payload: { event_data: [{ name: "a", type: "string" }] } },
      { name: "WORK_COMPLETED", payload: { event_data: [{ name: "a", type: "string" }] } },
    ],
  } as unknown as DomainOntology;
}

function makeCases(): TestCase[] {
  return [
    {
      id: "tc-1",
      name: "happy",
      scenario: "normal work",
      kind: "pass",
      entryEvent: "WORK_REQUESTED",
      payload: { a: "input" },
      expectedOutcome: "WORK_COMPLETED",
    },
    {
      id: "tc-2",
      name: "tool timeout",
      scenario: "the selected tool times out",
      kind: "fault",
      entryEvent: "WORK_REQUESTED",
      payload: { a: "input", __fault: { tool: "meta.ping", kind: "timeout" } },
      expectedOutcome: "must not report a clean success",
    },
  ];
}

const realTools: RealTool[] = [{
  name: "meta.ping",
  category: "meta",
  configKeys: ["timeout_ms"],
  sideEffect: "read",
  operation: "read",
  effectScope: "none",
  sandboxPolicy: "pure",
  credentialEnv: ["EVIDENCE_TEST_TOKEN"],
}];

describe("canonical sandbox evidence fingerprint", () => {
  it("content-addresses modern links as an order-independent optional set", () => {
    const ontology = makeOntology();
    const first = { id: "l1", kind: "action-trigger", status: "approved", from: { type: "Event", id: "WORK_REQUESTED" }, to: { type: "Action", id: "work" } };
    const second = { id: "l2", kind: "action-emission", status: "approved", from: { type: "Action", id: "work" }, to: { type: "Event", id: "WORK_COMPLETED" } };
    expect(ontologyContentHash({ ...ontology, links: [first, second] }))
      .toBe(ontologyContentHash({ ...ontology, links: [second, first] }));
    expect(ontologyContentHash({ ...ontology, links: [first] }))
      .not.toBe(ontologyContentHash({ ...ontology, links: [second] }));
  });

  it("is stable for object-key/spec-set ordering but includes the full generated spec", () => {
    const first = makeSpec();
    const second = { ...makeSpec(), key: "other", actionName: "other", slug: "rec-other", short: "OtherAgent" };
    expect(specsFingerprint([first, second])).toBe(specsFingerprint([second, first]));

    const reordered = { ...first, inputSchema: [{ type: "string", field: "a" }] } as GeneratedAgentSpec;
    expect(specsFingerprint([first])).toBe(specsFingerprint([reordered]));
  });

  it("changes for every execution-bearing evidence dimension", () => {
    const ontology = makeOntology();
    const spec = makeSpec();
    const cases = makeCases();
    const base = sandboxEvidenceFingerprint({
      domain: "rec",
      specs: [spec],
      ontology,
      testCases: cases,
      testDataOverrides: { a: "approved" },
      realTools,
      env: { EVIDENCE_TEST_TOKEN: "token-v1" },
    });
    const changed = [
      sandboxEvidenceFingerprint({ domain: "rec", specs: [{ ...spec, generatedCode: `${spec.generatedCode}\n// changed` }], ontology, testCases: cases, testDataOverrides: { a: "approved" }, realTools, env: { EVIDENCE_TEST_TOKEN: "token-v1" } }),
      sandboxEvidenceFingerprint({ domain: "rec", specs: [spec], ontology, testCases: [{ ...cases[0]!, payload: { a: "different" } }], testDataOverrides: { a: "approved" }, realTools, env: { EVIDENCE_TEST_TOKEN: "token-v1" } }),
      sandboxEvidenceFingerprint({ domain: "rec", specs: [spec], ontology, testCases: cases, testDataOverrides: { a: "different" }, realTools, env: { EVIDENCE_TEST_TOKEN: "token-v1" } }),
      sandboxEvidenceFingerprint({ domain: "rec", specs: [spec], ontology: { ...ontology, rules: [{ id: "new-rule" }] }, testCases: cases, testDataOverrides: { a: "approved" }, realTools, env: { EVIDENCE_TEST_TOKEN: "token-v1" } }),
      sandboxEvidenceFingerprint({ domain: "rec", specs: [{ ...spec, tools: ["meta.other"] }], ontology, testCases: cases, testDataOverrides: { a: "approved" }, realTools, env: { EVIDENCE_TEST_TOKEN: "token-v1" } }),
      sandboxEvidenceFingerprint({ domain: "rec", specs: [spec], ontology, testCases: cases, testDataOverrides: { a: "approved" }, realTools: [{ ...realTools[0]!, configKeys: ["base_url"] }], env: { EVIDENCE_TEST_TOKEN: "token-v1" } }),
      sandboxEvidenceFingerprint({ domain: "rec", specs: [spec], ontology, testCases: cases, testDataOverrides: { a: "approved" }, realTools: [{ ...realTools[0]!, probeStatus: "verified", definitionHash: "new-probe-hash", capabilities: [{ systems: ["Meta"], kinds: ["api"], roles: ["call"] }] }], env: { EVIDENCE_TEST_TOKEN: "token-v1" } }),
      sandboxEvidenceFingerprint({ domain: "rec", specs: [spec], ontology, testCases: cases, testDataOverrides: { a: "approved" }, realTools, env: { EVIDENCE_TEST_TOKEN: "token-v2" } }),
      sandboxEvidenceFingerprint({ domain: "rec", specs: [spec], ontology, testCases: cases, testDataOverrides: { a: "approved" }, testCoverageWaiver: { cells: ["reject:work"], confirmedAt: 1 }, realTools, env: { EVIDENCE_TEST_TOKEN: "token-v1" } }),
    ];
    for (const fingerprint of changed) expect(fingerprint).not.toBe(base);
    expect(base).not.toContain("token-v1");
  });

  it("invalidates evidence when a selected runtime provider's availability changes", () => {
    const requirement = {
      id: "work:integration:1",
      actionName: "work",
      system: "LLM Gateway",
      kind: "external_api",
      role: "calls",
      operations: [],
      objectTypes: [],
      replayable: true,
    };
    const runtimeSpec = {
      ...makeSpec(),
      integrationRequirements: [requirement],
      integrationBindings: [{
        requirement,
        bindingKind: "runtime" as const,
        bindingId: "agent-runtime.reason",
        status: "resolved" as const,
        reason: "available",
      }],
    };
    const capability = [{ systems: ["LLM Gateway"], kinds: ["external_api"], roles: ["calls"] }];
    const common = { domain: "rec", specs: [runtimeSpec], ontology: makeOntology(), testCases: makeCases() };
    const available = sandboxEvidenceFingerprint({
      ...common,
      integrationCapabilities: [{ id: "agent-runtime.reason", status: "available", capabilities: capability }],
    });
    const unavailable = sandboxEvidenceFingerprint({
      ...common,
      integrationCapabilities: [{ id: "agent-runtime.reason", status: "needs_config", reason: "credential missing", capabilities: capability }],
    });
    expect(unavailable).not.toBe(available);
  });

  it("canonicalizes verified probe hashes but invalidates evidence when the verified set changes", () => {
    const common = {
      domain: "rec",
      specs: [makeSpec()],
      ontology: makeOntology(),
      testCases: makeCases(),
    };
    const withHashes = (verifiedDefinitionHashes: string[]) => sandboxEvidenceFingerprint({
      ...common,
      realTools: [{ ...realTools[0]!, probeStatus: "verified", verifiedDefinitionHashes }],
    });

    expect(withHashes(["hash-b", "hash-a", "hash-a"])).toBe(withHashes(["hash-a", "hash-b"]));
    expect(withHashes(["hash-a", "hash-b", "hash-c"])).not.toBe(withHashes(["hash-a", "hash-b"]));
  });
});

function confirmedMetaTool(config: Record<string, unknown> = { timeout_ms: 1_000 }): RealTool {
  const tool: RealTool = {
    name: "meta.ping",
    category: "meta",
    configKeys: ["timeout_ms"],
    sideEffect: "read",
    operation: "read",
    effectScope: "none",
    sandboxPolicy: "pure",
  };
  return {
    ...tool,
    integrationProfiles: [{
      id: "profile-meta-production",
      profileKey: "primary",
      toolName: "meta.ping",
      tenantId: "ten-evidence",
      domainId: "rec",
      environment: "production",
      config,
      confirmedBy: "usr-human",
      toolDefinitionDigest: integrationProfileToolDefinitionDigest(tool),
      configDigest: integrationProfileConfigDigest(config),
      authorizationProtocolVersion: INTEGRATION_PROFILE_AUTHORIZATION_PROTOCOL_VERSION,
      confirmedAt: "2026-07-13T00:00:00.000Z",
    }, {
      id: "profile-meta-sandbox",
      profileKey: "primary",
      toolName: "meta.ping",
      tenantId: "ten-evidence",
      domainId: "rec",
      environment: "sandbox",
      config,
      confirmedBy: "usr-human",
      toolDefinitionDigest: integrationProfileToolDefinitionDigest(tool),
      configDigest: integrationProfileConfigDigest(config),
      authorizationProtocolVersion: INTEGRATION_PROFILE_AUTHORIZATION_PROTOCOL_VERSION,
      confirmedAt: "2026-07-13T00:00:00.000Z",
    }],
  };
}

function makeCtx(toolState: RealTool[] = [confirmedMetaTool()]): BrainCtx {
  const spec = makeSpec();
  const ontology = makeOntology();
  return {
    domain: "rec",
    conversationId: "run-review-test",
    goal: "generate",
    specs: [spec],
    ontology,
    testCases: makeCases(),
    testDataOverrides: { a: "approved" },
    awaitingApproval: false,
    spent: { sandboxRuns: 0, refines: 0, turns: 0, tokenEstimate: 0 },
    defects: [],
    sandboxSeq: 0,
    attemptHistory: {},
    emit: () => {},
    ports: {
      factoryScope: { tenantId: "ten-evidence", tenantSlug: "evidence-tenant" },
      authorizationChallenges: reviewChallengeStore(),
      toolRegistry: { list: async () => toolState },
      sandbox: {
        deployAndObserve: async () => ({
          appId: "rec-sb",
          functionsRegistered: 1,
          committedManifestFunctionIds: ["rec-work"],
          brokerRegistration: {
            schema: SANDBOX_BROKER_REGISTRATION_SCHEMA,
            appId: "rec-sb",
            expectedFunctionCount: 1,
            observedFunctionCount: 1,
            connected: true,
            verified: true,
            evidence: "dev_graphql",
            checkedAt: new Date(0).toISOString(),
          },
          deployed: 1,
          ran: 1,
          reachedSuccessTerminal: true,
          fullChainRan: true,
          degradedAgents: [],
          runs: [{ id: "rec-work", status: "Completed" }],
          fingerprint: "deployment-1",
          simulated: false,
          toolMode: "evidence_replay",
          externalLiveCalls: 0,
          replayReceipts: [],
          sandboxReplayEvidenceComplete: true,
          cassetteRefs: [{
            bindingId: "binding-meta-a",
            specSlugs: ["rec-work"],
            tool: "meta.ping",
            path: "/evidence/meta-a.json",
            definitionHash: "a".repeat(64),
            contentHash: "b".repeat(64),
            evidenceMode: "signed-fixture",
            configHash: "c".repeat(64),
            attestationKeyId: "cassette-hmac-test",
            attestationExpiresAt: "2099-07-16T00:00:00.000Z",
          }, {
            bindingId: "binding-meta-b",
            specSlugs: ["rec-work"],
            tool: "meta.ping",
            path: "/evidence/meta-b.json",
            definitionHash: "d".repeat(64),
            contentHash: "e".repeat(64),
            evidenceMode: "live-probe",
            configHash: "f".repeat(64),
            attestationKeyId: "cassette-hmac-test",
            attestationExpiresAt: "2099-07-16T00:00:00.000Z",
          }],
          functionTester: [{ short: "WorkAgent", pass: true, ran: true, emitNames: ["WORK_COMPLETED"], reasons: [], tier: "external-container", fixtureMode: "scripted", qualification: "promotable" }],
          agentRuns: [{
            agentSlug: "rec-work",
            agentShort: "WorkAgent",
            status: "Completed",
            degraded: false,
            triggerEvent: "WORK_REQUESTED",
            inputPayload: { a: "input" },
            tools: ["meta.ping"],
            outputEvent: "WORK_COMPLETED",
            reasoning: "done",
            outputPayload: { a: "ok" },
            runId: "run-1",
          }],
        }),
        teardown: async () => {},
      },
      reflection: { record: async () => {}, list: async () => [] },
      acceptance: { record: async () => {} },
      drafts: { save: async (_domain: string, specs: GeneratedAgentSpec[]) => specs.length, list: async () => [] },
    },
  } as unknown as BrainCtx;
}

describe("sandbox_run → finish evidence parity", () => {
  it("requires an authenticated reviewer and asks for concrete feedback after decline", async () => {
    const ctx = makeCtx();
    const deploy = vi.fn(ctx.ports.sandbox.deployAndObserve);
    ctx.ports.sandbox.deployAndObserve = deploy;
    await sandboxRun.execute({}, ctx);
    const challenge = Object.values(ctx.pendingAuthorizationChallenges ?? {})[0]!;
    const decline = challenge.options.find((option) => option.value !== challenge.token)!;
    ctx.clarificationAnswerEvidence = {
      [normalizeQuestion(challenge.question)]: {
        question: challenge.question,
        context: challenge.context,
        options: challenge.options,
        answer: decline.value,
        actor: "usr-reviewer",
        answeredAt: Date.now(),
      },
    };

    const declined = await sandboxRun.execute({}, ctx);
    expect(declined.ok).toBe(false);
    expect(declined.output).toEqual(expect.objectContaining({
      next: "ask_user",
      reason: "human_requested_design_rework",
      question: expect.stringContaining("具体修改"),
    }));
    expect(deploy).not.toHaveBeenCalled();

    const ctxWithoutActor = makeCtx();
    const noActorDeploy = vi.fn(ctxWithoutActor.ports.sandbox.deployAndObserve);
    ctxWithoutActor.ports.sandbox.deployAndObserve = noActorDeploy;
    await sandboxRun.execute({}, ctxWithoutActor);
    const actorChallenge = Object.values(ctxWithoutActor.pendingAuthorizationChallenges ?? {})[0]!;
    ctxWithoutActor.clarificationAnswerEvidence = {
      [normalizeQuestion(actorChallenge.question)]: {
        question: actorChallenge.question,
        context: actorChallenge.context,
        options: actorChallenge.options,
        answer: actorChallenge.token,
        answeredAt: Date.now(),
      },
    };
    const missingActor = await sandboxRun.execute({}, ctxWithoutActor);
    expect(missingActor.ok).toBe(false);
    expect((missingActor.output as Record<string, unknown>).authorizationRequired).toBe(true);
    expect(noActorDeploy).not.toHaveBeenCalled();
  });

  it("creates no sandbox App before exact human review and invalidates approval after a spec change", async () => {
    const ctx = makeCtx();
    const original = ctx.ports.sandbox.deployAndObserve;
    const deploy = vi.fn(original);
    ctx.ports.sandbox.deployAndObserve = deploy;

    const first = await sandboxRun.execute({}, ctx);
    expect(first.ok).toBe(false);
    expect((first.output as Record<string, unknown>).authorizationRequired).toBe(true);
    expect(deploy).not.toHaveBeenCalled();

    const challenge = Object.values(ctx.pendingAuthorizationChallenges ?? {})[0]!;
    const question = challenge.question;
    const context = challenge.context;
    const options = challenge.options;
    const approve = options.find((option) => option.value === challenge.token)!;
    ctx.clarificationAnswerEvidence = {
      [normalizeQuestion(question)]: {
        question,
        context,
        options,
        answer: approve.value,
        actor: "usr-reviewer",
        answeredAt: Date.now(),
      },
    };
    ctx.specs[0] = { ...ctx.specs[0]!, generatedCode: `${ctx.specs[0]!.generatedCode}\n// reviewed design changed` };

    const changed = await sandboxRun.execute({}, ctx);
    expect(changed.ok).toBe(false);
    expect((changed.output as Record<string, unknown>).authorizationRequired).toBe(true);
    expect(ctx.clarifyPrompt?.question).not.toBe(question);
    expect(deploy).not.toHaveBeenCalled();
  });

  it("passes the canonical candidate fingerprint to the deployer", async () => {
    const ctx = makeCtx();
    let received: string | undefined;
    const original = ctx.ports.sandbox.deployAndObserve;
    ctx.ports.sandbox.deployAndObserve = async (domain, specs, options) => {
      received = options?.candidateFingerprint;
      return original(domain, specs, options);
    };
    expect((await approveAndRunSandbox(ctx)).ok).toBe(true);
    expect(received).toBe(ctx.lastSandbox?.specsFingerprint);
    expect(received).toMatch(/^sandbox-evidence:v6:/);
    expect(ctx.lastSandbox?.designReviewReceipt).toEqual(expect.objectContaining({
      kind: "sandbox_design_review",
      actor: "usr-reviewer",
    }));
    expect(ctx.lastSandbox?.cassetteRefs).toHaveLength(2);
    expect(ctx.lastSandbox?.cassetteRefs?.map((ref) => ref.bindingId)).toEqual([
      "binding-meta-a",
      "binding-meta-b",
    ]);
  });

  it("turns missing sandbox config/cleanup capability into human-readable ask_user", async () => {
    const ctx = makeCtx();
    ctx.ports.sandbox.deployAndObserve = async () => {
      throw new SandboxLifecycleBlockedError({
        code: "sandbox_config_missing",
        next: "ask_user",
        question: "Inngest 测试环境还没配好；请让运维配置独立沙箱密钥，不要把密钥发到对话里。",
        missing: ["INNGEST_SANDBOX_CONFIG_REFS"],
      });
    };
    const result = await approveAndRunSandbox(ctx);
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("不要把密钥发到对话里");
    expect(result.output).toEqual(expect.objectContaining({
      next: "ask_user",
      reason: "sandbox_config_missing",
      missing: ["INNGEST_SANDBOX_CONFIG_REFS"],
    }));
    expect(ctx.lastSandbox).toBeFalsy();
  });

  it("parks when the human-review challenge service is unavailable", async () => {
    const ctx = makeCtx();
    const deploy = vi.fn(ctx.ports.sandbox.deployAndObserve);
    ctx.ports.sandbox.deployAndObserve = deploy;
    ctx.ports.authorizationChallenges = {
      ...reviewChallengeStore(),
      issue: async () => { throw new Error("challenge store offline"); },
    };

    const result = await sandboxRun.execute({}, ctx);

    expect(result).toMatchObject({
      ok: false,
      output: {
        next: "ask_user",
        reason: "sandbox_design_review_unavailable",
        missing: ["sandbox design review challenge"],
      },
    });
    expect(result.summary).toContain("没有创建 Inngest 沙箱 App");
    expect(deploy).not.toHaveBeenCalled();
  });

  it("parks before review when the current execution-resource snapshot is unavailable", async () => {
    const ctx = makeCtx();
    const deploy = vi.fn(ctx.ports.sandbox.deployAndObserve);
    ctx.ports.sandbox.deployAndObserve = deploy;
    ctx.ports.toolRegistry = { list: async () => { throw new Error("catalog offline"); } };

    const result = await sandboxRun.execute({}, ctx);

    expect(result).toMatchObject({
      ok: false,
      output: {
        next: "ask_user",
        reason: "execution_resources_unavailable",
        missing: ["execution_resources_snapshot"],
      },
    });
    expect(result.summary).toContain("不会生成、修改或部署代码");
    expect(deploy).not.toHaveBeenCalled();
    expect(ctx.pendingAuthorizationChallenges).toBeFalsy();
    expect(ctx.lastSandbox).toBeFalsy();
  });

  it("parks instead of throwing when the sandbox runtime returns no trustworthy lifecycle receipt", async () => {
    const ctx = makeCtx();
    ctx.ports.sandbox.deployAndObserve = async () => { throw new Error("transport reset"); };

    const result = await approveAndRunSandbox(ctx);

    expect(result).toMatchObject({
      ok: false,
      output: {
        next: "ask_user",
        reason: "sandbox_runtime_unavailable",
        missing: ["sandbox execution receipt", "sandbox cleanup receipt"],
      },
    });
    expect(result.summary).toContain("不会直接重试或复用可能残留的 App");
    expect(ctx.lastSandbox).toBeFalsy();
  });

  it("parks finish when current execution resources cannot be revalidated", async () => {
    const ctx = makeCtx();
    expect((await approveAndRunSandbox(ctx)).ok).toBe(true);
    const save = vi.fn(ctx.ports.drafts!.save);
    ctx.ports.drafts!.save = save;
    ctx.ports.toolRegistry = { list: async () => { throw new Error("catalog offline"); } };

    const result = await finish.execute({ summary: "ship" }, ctx);

    expect(result).toMatchObject({
      ok: false,
      output: {
        next: "ask_user",
        reason: "execution_resources_unavailable",
        missing: ["execution_resources_snapshot"],
      },
    });
    expect(result.summary).toContain("没有可靠清单时不会生成、修改或部署代码");
    expect(save).not.toHaveBeenCalled();
  });

  it("invalidates the sandbox receipt when tool-effectiveness evidence cannot be stored", async () => {
    const ctx = makeCtx();
    ctx.ports.toolStats = {
      record: async () => { throw new Error("stats offline"); },
      successRates: async () => ({}),
    };

    const result = await approveAndRunSandbox(ctx);

    expect(result).toMatchObject({
      ok: false,
      output: {
        next: "ask_user",
        reason: "sandbox_tool_stats_unavailable",
        missing: ["tool effectiveness receipt"],
        sandboxExecuted: true,
      },
    });
    expect(result.summary).toContain("不能复用这次不完整的证据");
    expect(ctx.lastSandbox).toBeNull();
  });

  it("passes finish when nothing changed after a successful sandbox", async () => {
    const ctx = makeCtx();
    let persistedEvidence: import("./ports").AgentDraftRegressionEvidence | undefined;
    ctx.ports.drafts!.save = async (_domain, specs, regression) => {
      persistedEvidence = regression;
      return specs.length;
    };
    const sandbox = await approveAndRunSandbox(ctx);
    expect(sandbox.ok).toBe(true);
    expect(ctx.lastSandbox?.specsFingerprint).toMatch(/^sandbox-evidence:v6:/);

    const result = await finish.execute({ summary: "ship" }, ctx);
    expect(result.ok, result.summary).toBe(true);
    expect(persistedEvidence).toEqual(expect.objectContaining({
      evidenceFingerprint: ctx.lastSandbox?.specsFingerprint,
      approvedTestCases: ctx.testCases,
      toolMode: "evidence_replay",
      externalLiveCalls: 0,
      replayReceipts: [],
      sandboxReplayEvidenceComplete: true,
      sandboxDesignReview: {
        fingerprint: ctx.lastSandbox?.specsFingerprint,
        subjectDigest: ctx.lastSandbox?.designReviewSubjectDigest,
        receipt: ctx.lastSandbox?.designReviewReceipt,
      },
      cassetteRefs: ctx.lastSandbox?.cassetteRefs,
    }));
  });

  it("fails closed when the selected confirmed profile changes after sandbox", async () => {
    const toolState: RealTool[] = [confirmedMetaTool()];
    const ctx = makeCtx(toolState);
    expect((await approveAndRunSandbox(ctx)).ok).toBe(true);
    toolState[0] = confirmedMetaTool({ timeout_ms: 2_000 });

    const result = await finish.execute({ summary: "ship" }, ctx);
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("profile primary 已变更");
    expect(result.summary).toContain("重新 sandbox");
  });
});
