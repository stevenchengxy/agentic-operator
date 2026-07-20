import { afterEach, describe, it, expect, vi } from "vitest";
import { FACTORY_TOOLS, sandboxEvidenceFingerprint } from "./tools";
import type { BrainCtx } from "./brain-types";
import type { GeneratedAgentSpec } from "./spec-types";
import type { DomainOntology } from "./ontology-types";
import { sandboxDesignReviewSubjectDigest } from "./sandbox-design-review";
import { SANDBOX_BROKER_REGISTRATION_SCHEMA } from "./ports";

// Phase 0(a): finish must enforce the documented acceptance bar (acceptance.ts), not just
// coverage + code + fullChainRan. An agent with an unresolved tool, or a chain that ran but
// degraded, must be REJECTED by finish — previously finish let these through.

const finish = FACTORY_TOOLS.find((t) => t.name === "finish")!;
const okIO = [{ field: "a", type: "string" }];
const testRegistry = [{
  name: "x",
  operation: "compute" as const,
  effectScope: "none" as const,
  sandboxPolicy: "pure" as const,
}];

afterEach(() => vi.unstubAllEnvs());

function spec(p: Partial<GeneratedAgentSpec> & { actionName: string }): GeneratedAgentSpec {
  return {
    key: p.actionName, actionName: p.actionName, slug: p.slug ?? `d-${p.actionName}`, short: p.short ?? p.actionName,
    domainId: "rec", nameZh: p.actionName, kind: "llm", trigger: p.trigger ?? [], emit: p.emit ?? [],
    tools: p.tools ?? ["x"], unresolvedTools: p.unresolvedTools ?? [], objects: [], systemPrompt: "do the thing",
    toolPolicies: p.toolPolicies ?? { x: { operation: "compute", effectScope: "none", sandboxPolicy: "pure" } },
    userPrompt: "", steps: [], ruleRefs: [], retries: 1, hitl: false, confidence: 1, promptSource: "llm",
    inputSchema: p.inputSchema ?? okIO, outputSchema: p.outputSchema, generatedCode: p.generatedCode ?? "export const x = 1;",
    // sandbox_run refreshes these exact empty bindings before hashing.  Keep
    // the hand-built sandbox receipt faithful to that production snapshot.
    integrationRequirements: [],
    integrationBindings: [],
  } as GeneratedAgentSpec;
}

function ont(actionNames: string[]): DomainOntology {
  return { domainId: "rec", objects: [], rules: [], events: [], workflow: [], source: "allmeta", actions: actionNames.map((n) => ({ id: n, name: n, actor: ["Agent"], trigger: [], triggered_event: [], target_objects: [], tool_use: [], system_prompt: "", user_prompt: "" })) } as DomainOntology;
}

function mk(specs: GeneratedAgentSpec[], sandbox: Partial<NonNullable<BrainCtx["lastSandbox"]>>): BrainCtx {
  const ontology = ont(specs.map((s) => s.actionName));
  const ctx = {
    domain: "rec",
    ontology,
    specs,
    testCases: [{ id: "tc1", name: "approved", scenario: "approved", kind: "pass", entryEvent: "START", payload: { a: "ok" }, expectedOutcome: "done" }],
    awaitingApproval: false,
    emit: () => {},
    realTools: testRegistry,
    conversationId: "finish-gate-run",
    ports: {
      factoryScope: { tenantId: "ten-finish", tenantSlug: "finish-tenant" },
      reflection: { record: async () => {} },
      acceptance: { record: async () => {} },
      drafts: { save: async () => specs.length },
    },
    lastSandbox: null,
  } as unknown as BrainCtx;
  const fingerprint = sandboxEvidenceFingerprint({ domain: ctx.domain, specs, ontology, testCases: ctx.testCases, realTools: testRegistry });
  const subjectDigest = sandboxDesignReviewSubjectDigest({ domain: ctx.domain, fingerprint });
  ctx.lastSandbox = {
    specsFingerprint: fingerprint,
    deployed: specs.length,
    agentsRan: specs.length,
    ranAgents: specs.map((s) => s.slug),
    reachedTerminal: true,
    reachedSuccessTerminal: true,
    fullChainRan: true,
    degradedAgents: [],
    simulated: false,
    appId: "finish-gate-sandbox-app",
    committedManifestFunctionIds: specs.map((spec) => spec.slug),
    brokerRegistration: {
      schema: SANDBOX_BROKER_REGISTRATION_SCHEMA,
      appId: "finish-gate-sandbox-app",
      expectedFunctionCount: specs.length,
      observedFunctionCount: specs.length,
      connected: true,
      verified: true,
      evidence: "dev_graphql",
      checkedAt: new Date(0).toISOString(),
    },
    fidelityFailures: [],
    functionTester: specs.map((spec) => ({
      short: spec.short,
      pass: true,
      ran: true,
      emitNames: spec.emit,
      reasons: [],
      tier: "external-container",
      qualification: "promotable",
    })),
    toolMode: "evidence_replay",
    externalLiveCalls: 0,
    replayReceipts: [],
    sandboxReplayEvidenceComplete: true,
    designReviewSubjectDigest: subjectDigest,
    designReviewReceipt: {
      challengeId: "challenge-1",
      kind: "sandbox_design_review",
      protocolVersion: 1,
      digest: "d".repeat(64),
      subjectDigest,
      authorizationDigest: "a".repeat(64),
      actor: "reviewer-1",
      runId: ctx.conversationId!,
      conversationId: ctx.conversationId!,
      consumedAt: new Date(1_000).toISOString(),
      expiresAt: new Date(60_000).toISOString(),
    },
    ts: 1,
    ...sandbox,
  };
  return ctx;
}

describe("finish gate enforces the acceptance bar (Phase 0a)", () => {
  it("rejects delivery when an agent has an unresolved tool, even though the chain ran", async () => {
    const specs = [spec({ actionName: "createJD", unresolvedTools: ["ghostTool"] })];
    const r = await finish.execute({ summary: "ship it" }, mk(specs, {}));
    expect(r.ok).toBe(false);
    expect(r.summary).toContain("验收");
  });

  it("rejects delivery when the chain ran but an agent degraded", async () => {
    const specs = [spec({ actionName: "createJD" })];
    const r = await finish.execute({ summary: "ship it" }, mk(specs, { degradedAgents: ["createJD"] }));
    expect(r.ok).toBe(false);
  });

  it("passes delivery when coverage + code + sandbox + acceptance bar are all met", async () => {
    const specs = [spec({ actionName: "createJD" })];
    const r = await finish.execute({ summary: "ship it" }, mk(specs, {}));
    expect(r.ok, r.summary).toBe(true);
  });

  it("uses the same exact-case suite proof as acceptance when fullChainRan is a late snapshot", async () => {
    const specs = [spec({ actionName: "createJD" })];
    const r = await finish.execute({ summary: "ship it" }, mk(specs, {
      fullChainRan: false,
      expectedCaseIds: ["tc1"],
      caseVerdicts: {
        allPass: true,
        results: [{ caseId: "tc1", kind: "pass", pass: true, reason: "approved case passed" }],
      },
    }));
    expect(r.ok, r.summary).toBe(true);
  });

  it("does not use a successful terminal alone as a complete-suite fallback", async () => {
    const specs = [spec({ actionName: "createJD" })];
    const r = await finish.execute({ summary: "ship it" }, mk(specs, {
      fullChainRan: false,
      reachedSuccessTerminal: true,
      caseVerdicts: undefined,
    }));
    expect(r.ok).toBe(false);
    expect(r.summary).toContain("完整批准套件");
  });

  it("rejects an older green receipt when the latest Inngest transport attempt failed", async () => {
    const specs = [spec({ actionName: "createJD" })];
    const r = await finish.execute(
      { summary: "ship it" },
      mk(specs, {
        transportAccepted: false,
        transportError: "entry event enqueue rejected",
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.summary).toContain("投递未被真实接受");
  });

  it("never accepts simulated evidence in production even when the legacy flag is set", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("FACTORY_ALLOW_SIMULATED_FINISH", "1");
    const specs = [spec({ actionName: "createJD" })];
    const r = await finish.execute({ summary: "ship it" }, mk(specs, { simulated: true }));
    expect(r.ok).toBe(false);
    expect(r.summary).toContain("不能作为交付证据");
  });

  it("fails closed in production when a green local run has no remote execution receipt", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const specs = [spec({ actionName: "createJD" })];
    const r = await finish.execute({ summary: "ship it" }, mk(specs, {}));
    expect(r).toMatchObject({
      ok: false,
      output: {
        next: "ask_user",
        reason: "external_execution_receipt_invalid",
      },
    });
    expect(r.summary).toContain("不会把本地 worker/process");
  });
});
