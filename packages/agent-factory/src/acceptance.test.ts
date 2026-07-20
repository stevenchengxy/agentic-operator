import { describe, it, expect } from "vitest";
import { acceptanceReport, acceptanceGate } from "./acceptance";
import type { GeneratedAgentSpec } from "./spec-types";
import type { DomainOntology } from "./ontology-types";
import { deriveIntegrationRequirements } from "./integration-binding";
import type { RealTool } from "./tool-catalog";
import type { FunctionTesterEntry } from "./ports";
import { SANDBOX_BROKER_REGISTRATION_SCHEMA } from "./ports";

function spec(p: Partial<GeneratedAgentSpec> & { actionName: string }): GeneratedAgentSpec {
  const tools = p.tools ?? [];
  return {
    key: p.actionName, actionName: p.actionName, slug: p.slug ?? `d-${p.actionName}`, short: p.short ?? p.actionName, domainId: "rec", nameZh: p.actionName, kind: "llm",
    trigger: p.trigger ?? [], emit: p.emit ?? [], tools, unresolvedTools: p.unresolvedTools ?? [], objects: [], systemPrompt: "x", userPrompt: "",
    toolPolicies: p.toolPolicies ?? Object.fromEntries(tools.map((name) => [name, {
      operation: "read" as const,
      effectScope: "external" as const,
      sandboxPolicy: "live_external" as const,
    }])),
    steps: [], ruleRefs: p.ruleRefs ?? [], retries: 1, hitl: false, confidence: 1, promptSource: "llm", inputSchema: p.inputSchema, outputSchema: p.outputSchema,
    decisionTables: p.decisionTables,
    plan: p.plan,
    integrationRequirements: p.integrationRequirements, integrationBindings: p.integrationBindings,
    generatedCode: p.generatedCode ?? "export const agent = 1;", // a real deliverable carries code (has_code bar)
  } as GeneratedAgentSpec;
}
function ont(actionNames: string[]): DomainOntology {
  return { domainId: "rec", objects: [], rules: [], events: [], workflow: [], source: "allmeta", actions: actionNames.map((n) => ({ id: n, name: n, actor: ["Agent"], trigger: [], triggered_event: [], target_objects: [], tool_use: [], system_prompt: "", user_prompt: "" })) };
}
const okIO = [{ field: "a", type: "string" }];
const replayEvidence = {
  toolMode: "evidence_replay" as const,
  externalLiveCalls: 0,
  sandboxReplayEvidenceComplete: true,
  replayReceipts: [],
};

function exactRegistration(specs: GeneratedAgentSpec[]) {
  const ids = specs.map((candidate) => candidate.slug);
  return {
    appId: "agentic-factory-test-app",
    committedManifestFunctionIds: ids,
    brokerRegistration: {
      schema: SANDBOX_BROKER_REGISTRATION_SCHEMA,
      appId: "agentic-factory-test-app",
      expectedFunctionCount: ids.length,
      observedFunctionCount: ids.length,
      connected: true,
      verified: true,
      evidence: "dev_graphql" as const,
      checkedAt: new Date(0).toISOString(),
    },
  };
}

function promotableFunctionTester(specs: GeneratedAgentSpec[]): FunctionTesterEntry[] {
  return specs.map((candidate) => ({
    short: candidate.short,
    pass: true,
    ran: true,
    emitNames: candidate.emit,
    reasons: [] as string[],
    tier: "external-container",
    qualification: "promotable" as const,
  }));
}

const customRuleReader: RealTool = {
  name: "policy.current.read",
  capabilities: [{ systems: ["Policy Store"], kinds: ["rulebase"], roles: ["reads"] }],
};

function boundRuleSpec(actionName = "policyEvaluation"): GeneratedAgentSpec {
  const requirement = {
    id: `${actionName}:policy-store`,
    actionName,
    system: "Policy Store",
    kind: "rulebase",
    role: "reads",
    operations: [],
    objectTypes: [],
    replayable: true,
  };
  return spec({
    actionName,
    tools: [customRuleReader.name],
    ruleRefs: ["current-policy"],
    inputSchema: okIO,
    plan: [{ stepId: "read-policy", kind: "tool", tool: customRuleReader.name }],
    integrationRequirements: [requirement],
    integrationBindings: [{
      requirement,
      bindingKind: "tool",
      bindingId: customRuleReader.name,
      toolName: customRuleReader.name,
      status: "resolved",
      executionRef: {
        kind: "tool",
        toolName: customRuleReader.name,
        planStepIds: ["read-policy"],
      },
      reason: "capability exact match",
    }],
  });
}

function integrationOntology(): DomainOntology {
  const domain = ont(["createJD"]);
  domain.actions[0]!.integration = {
    systems: [
      { name: "Partner PG", kind: "datastore", role: "writes" },
      { name: "RoboHire", kind: "external_api", role: "calls", capability: "POST /generate-jd" },
      { name: "Audit API", kind: "external_api", role: "calls", capability: "POST /audit" },
    ],
  };
  return domain;
}

describe("acceptanceReport (RAAS-v1 bar)", () => {
  it("passes when the whole bar is met", () => {
    const specs = [
      spec({ actionName: "createJD", tools: ["x"], inputSchema: okIO }),
      boundRuleSpec(),
    ];
    const r = acceptanceReport(specs, ont(["createJD", "policyEvaluation"]), { ...exactRegistration(specs), ran: 2, fullChainRan: true, degradedAgents: [], simulated: false, fidelityFailures: [], functionTester: promotableFunctionTester(specs), ...replayEvidence });
    expect(r.allPass).toBe(true);
  });

  it("passes a tool-free pure logic function when its real execution evidence is complete", () => {
    const candidate = spec({ actionName: "normalizePayload", tools: [], inputSchema: okIO });
    const report = acceptanceReport(
      [candidate],
      ont([candidate.actionName]),
      {
        ...exactRegistration([candidate]),
        ran: 1,
        fullChainRan: true,
        degradedAgents: [],
        simulated: false,
        fidelityFailures: [],
        functionTester: promotableFunctionTester([candidate]),
        ...replayEvidence,
      },
    );

    expect(report.allPass).toBe(true);
    expect(report.criteria.find((criterion) => criterion.key === "integration_bindings")).toMatchObject({ pass: true });
    expect(report.criteria.find((criterion) => criterion.key === "tools_resolve")).toMatchObject({ pass: true });
  });

  it("#P3 no_blocking_defects: >0 阻塞缺陷阻断 finish;0 或不传则通过(向后兼容)", () => {
    const specs = [
      spec({ actionName: "createJD", tools: ["x"], inputSchema: okIO }),
      boundRuleSpec(),
    ];
    const sb = { ...exactRegistration(specs), ran: 2, fullChainRan: true, degradedAgents: [], simulated: false, fidelityFailures: [], functionTester: promotableFunctionTester(specs), ...replayEvidence };
    const dom = ont(["createJD", "policyEvaluation"]);
    // 不传 opts → 不加此判据,行为不变(向后兼容)
    expect(acceptanceReport(specs, dom, sb).criteria.find((c) => c.key === "no_blocking_defects")).toBeUndefined();
    // 0 阻塞 → 判据在且通过
    const clean = acceptanceReport(specs, dom, sb, { blockingDefects: 0 });
    expect(clean.criteria.find((c) => c.key === "no_blocking_defects")!.pass).toBe(true);
    expect(clean.allPass).toBe(true);
    // >0 阻塞 → 判据失败,finish 被阻断
    const blocked = acceptanceReport(specs, dom, sb, { blockingDefects: 2 });
    expect(blocked.criteria.find((c) => c.key === "no_blocking_defects")!.pass).toBe(false);
    expect(blocked.allPass).toBe(false);
  });

  it("fails coverage when an Agent action is uncovered", () => {
    const specs = [spec({ actionName: "createJD", tools: ["x"], inputSchema: okIO })];
    const r = acceptanceReport(specs, ont(["createJD", "matchResume"]), { registeredIds: ["d-createJD"], ran: 1, fullChainRan: true, degradedAgents: [], simulated: false });
    expect(r.allPass).toBe(false);
    expect(r.criteria.find((c) => c.key === "coverage")!.pass).toBe(false);
  });

  it("finds sub-agent invokes nested inside foreach plans", () => {
    const parent = spec({ actionName: "batch", short: "batch", inputSchema: okIO });
    parent.plan = [{
      stepId: "each", kind: "foreach", itemsFrom: "input.items", itemKeyFrom: "id",
      body: [{ stepId: "child", kind: "invoke", invoke: "candidate-checker", onError: "terminal" }],
    }];
    const child = spec({ actionName: "helper", short: "candidate-checker" });
    child.isSubAgent = true;
    child.parentAction = "batch";
    const report = acceptanceReport([parent, child], ont(["batch"]), null);
    expect(report.criteria.find((criterion) => criterion.key === "sub_agents_bound")).toMatchObject({
      pass: true,
    });
  });

  it("fails real_register on a simulated sandbox and flags a structurally declared but unbound rule gate", () => {
    const specs = [spec({ actionName: "evaluateSubmission", tools: [], ruleRefs: ["submission-policy"] })];
    const r = acceptanceReport(specs, ont(["evaluateSubmission"]), { functionsRegistered: 1, ran: 1, fullChainRan: true, degradedAgents: [], simulated: true });
    expect(r.criteria.find((c) => c.key === "real_register")!.pass).toBe(false);
    expect(r.criteria.find((c) => c.key === "rule_gates")!.pass).toBe(false);
    expect(r.criteria.find((c) => c.key === "typed_payloads")!.pass).toBe(false);
  });

  it("does not guess a rule gate from an action name when structural evidence is absent", () => {
    const candidate = spec({ actionName: "ruleCheckLookingName", tools: [], inputSchema: okIO });
    const report = acceptanceReport([candidate], ont([candidate.actionName]), null);
    expect(report.criteria.find((criterion) => criterion.key === "rule_gates")!.pass).toBe(true);
    expect(report.perAgent[0]!.items.some((item) => item.key === "rule_gate_bound")).toBe(false);
  });

  it("accepts a custom selected rule reader from capability metadata without a tool-name special case", () => {
    const candidate = spec({
      actionName: "evaluateSubmission",
      tools: [customRuleReader.name],
      ruleRefs: ["submission-policy"],
      inputSchema: okIO,
    });
    const report = acceptanceReport([candidate], ont([candidate.actionName]), null, { registeredTools: [customRuleReader] });
    expect(report.criteria.find((criterion) => criterion.key === "rule_gates")!.pass).toBe(true);
    expect(report.perAgent[0]!.items.find((item) => item.key === "rule_gate_bound")).toMatchObject({ pass: true });
  });

  it("fails has_code when an agent has no generated code (aligns the bar with finish())", () => {
    const specs = [spec({ actionName: "createJD", tools: ["x"], inputSchema: okIO, generatedCode: "" })];
    const r = acceptanceReport(specs, ont(["createJD"]), { registeredIds: ["d-createJD"], ran: 1, fullChainRan: true, degradedAgents: [], simulated: false });
    expect(r.criteria.find((c) => c.key === "has_code")!.pass).toBe(false);
    expect(r.allPass).toBe(false);
  });

  it("excludes mock-platform stand-ins from the real-registration count", () => {
    const specs = [
      spec({ actionName: "createJD", slug: "d-createJD", tools: ["x"], inputSchema: okIO }),
      spec({ actionName: "mock_robohire", slug: "d-mock-robohire", tools: [], inputSchema: okIO }),
    ];
    // only 1 real deliverable → exact proof for that immutable deliverable is sufficient
    const r = acceptanceReport(specs, ont(["createJD"]), { ...exactRegistration([specs[0]!]), ran: 2, fullChainRan: true, degradedAgents: [], simulated: false });
    expect(r.criteria.find((c) => c.key === "real_register")!.pass).toBe(true);
  });

  it("blocks missing, unconfigured, and unprobed integration bindings", () => {
    const domain = integrationOntology();
    const requirements = deriveIntegrationRequirements(domain.actions[0]!);
    const specs = [spec({
      actionName: "createJD",
      tools: ["partner.write", "robo.generate"],
      inputSchema: okIO,
      integrationRequirements: requirements,
      integrationBindings: [
        { requirement: requirements[0]!, toolName: "partner.write", status: "needs_config", reason: "missing secret" },
        { requirement: requirements[1]!, toolName: "robo.generate", status: "needs_probe", reason: "probe required" },
        { requirement: requirements[2]!, status: "missing", reason: "adapter missing" },
      ],
    })];
    const report = acceptanceReport(specs, domain, null);
    const criterion = report.criteria.find((c) => c.key === "integration_bindings")!;
    expect(criterion.pass).toBe(false);
    expect(criterion.detail).toContain("missing 1");
    expect(criterion.detail).toContain("needs_config 1");
    expect(criterion.detail).toContain("needs_probe 1");
    expect(report.perAgent[0]!.items.find((item) => item.key === "integration_bindings")!.pass).toBe(false);
  });

  it("passes integration acceptance only when every requirement resolves to a selected tool", () => {
    const domain = integrationOntology();
    const requirements = deriveIntegrationRequirements(domain.actions[0]!);
    const tools = ["partner.write", "robo.generate", "audit.call"];
    const specs = [spec({
      actionName: "createJD",
      tools,
      inputSchema: okIO,
      plan: tools.map((toolName, index) => ({
        stepId: `integration-${index + 1}`,
        kind: "tool" as const,
        tool: toolName,
      })),
      integrationRequirements: requirements,
      integrationBindings: requirements.map((requirement, index) => ({
        requirement,
        bindingKind: "tool" as const,
        bindingId: tools[index],
        toolName: tools[index],
        executionRef: {
          kind: "tool" as const,
          toolName: tools[index]!,
          planStepIds: [`integration-${index + 1}`],
        },
        status: "resolved" as const,
        reason: "capability exact match",
      })),
    })];
    const report = acceptanceReport(specs, domain, null);
    const criterion = report.criteria.find((c) => c.key === "integration_bindings")!;
    expect(criterion.pass).toBe(true);
    expect(criterion.detail).toContain("3 项外部集成全部 resolved");
  });

  it("rejects a forged resolved binding whose tool was not selected by the agent", () => {
    const domain = integrationOntology();
    domain.actions[0]!.integration = { systems: [{ name: "Partner PG", kind: "datastore", role: "writes" }] };
    const [requirement] = deriveIntegrationRequirements(domain.actions[0]!);
    const report = acceptanceReport([spec({
      actionName: "createJD",
      tools: ["different.tool"],
      inputSchema: okIO,
      integrationRequirements: [requirement!],
      integrationBindings: [{ requirement: requirement!, toolName: "partner.write", status: "resolved", reason: "claimed" }],
    })], domain, null);
    const criterion = report.criteria.find((c) => c.key === "integration_bindings")!;
    expect(criterion.pass).toBe(false);
    expect(criterion.detail).toContain("missing 1");
  });

  it("accepts identified runtime/event bindings and rejects an event not emitted by the spec", () => {
    const domain = ont(["notify"]);
    domain.actions[0]!.triggered_event = ["NOTICE_READY"];
    domain.actions[0]!.side_effects = { notifications: [{ triggered_event: "NOTICE_READY" }] };
    domain.actions[0]!.integration = {
      systems: [
        { name: "LLM Gateway", kind: "external_api", role: "calls" },
        { name: "Event Bus", kind: "event_bus", role: "notifies" },
      ],
    };
    const requirements = deriveIntegrationRequirements(domain.actions[0]!);
    const bindings = [
      {
        requirement: requirements[0]!,
        bindingKind: "runtime" as const,
        bindingId: "agent-runtime.reason",
        executionRef: { kind: "runtime" as const, providerId: "agent-runtime.reason", planStepIds: ["reason"] },
        status: "resolved" as const,
        reason: "available",
      },
      {
        requirement: requirements[1]!,
        bindingKind: "event" as const,
        bindingId: "NOTICE_READY",
        executionRef: { kind: "event" as const, eventNames: ["NOTICE_READY"] },
        status: "resolved" as const,
        reason: "declared event",
      },
    ];
    const accepted = acceptanceReport([spec({
      actionName: "notify",
      emit: ["NOTICE_READY"],
      inputSchema: okIO,
      plan: [{ stepId: "reason", kind: "logic" }],
      integrationRequirements: requirements,
      integrationBindings: bindings,
    })], domain, null);
    expect(accepted.criteria.find((criterion) => criterion.key === "integration_bindings")?.pass).toBe(true);

    const forged = acceptanceReport([spec({
      actionName: "notify",
      emit: [],
      inputSchema: okIO,
      plan: [{ stepId: "reason", kind: "logic" }],
      integrationRequirements: requirements,
      integrationBindings: bindings,
    })], domain, null);
    expect(forged.criteria.find((criterion) => criterion.key === "integration_bindings")?.pass).toBe(false);
  });
});

describe("acceptanceGate (maps the conductor's lastSandbox shape onto the bar)", () => {
  const good = [
    spec({ actionName: "createJD", tools: ["x"], inputSchema: okIO }),
    boundRuleSpec(),
  ];
  const ontGood = ont(["createJD", "policyEvaluation"]);

  it("accepts the conductor field names (deployed/agentsRan) and passes a met bar", () => {
    const r = acceptanceGate(good, ontGood, { ...exactRegistration(good), deployed: 2, agentsRan: 2, fullChainRan: true, degradedAgents: [], simulated: false, fidelityFailures: [], functionTester: promotableFunctionTester(good), ...replayEvidence });
    expect(r.pass).toBe(true);
    expect(r.failing).toEqual([]);
  });

  it("blocks when an agent carries an unresolved tool (the gap finish ignores today)", () => {
    const specs = [
      spec({ actionName: "createJD", tools: ["x"], unresolvedTools: ["ghostTool"], inputSchema: okIO }),
      boundRuleSpec(),
    ];
    const r = acceptanceGate(specs, ontGood, { deployed: 2, agentsRan: 2, fullChainRan: true, degradedAgents: [], simulated: false, fidelityFailures: [], functionTester: [] });
    expect(r.pass).toBe(false);
    expect(r.failing.map((c) => c.key)).toContain("tools_resolve");
  });

  it("blocks finish when an ontology integration still needs a probe", () => {
    const domain = integrationOntology();
    domain.actions[0]!.integration = { systems: [{ name: "RoboHire", kind: "external_api", role: "calls", capability: "POST /generate-jd" }] };
    const [requirement] = deriveIntegrationRequirements(domain.actions[0]!);
    const specs = [spec({
      actionName: "createJD",
      tools: ["robo.generate"],
      inputSchema: okIO,
      integrationRequirements: [requirement!],
      integrationBindings: [{ requirement: requirement!, toolName: "robo.generate", status: "needs_probe", reason: "probe required" }],
    })];
    const result = acceptanceGate(specs, domain, {
      deployed: 1,
      agentsRan: 1,
      fullChainRan: true,
      degradedAgents: [],
      simulated: false,
      fidelityFailures: [],
      functionTester: [],
      toolMode: "live",
    });
    expect(result.pass).toBe(false);
    expect(result.failing.map((criterion) => criterion.key)).toContain("integration_bindings");
  });

  it("blocks when the chain ran but an agent degraded (finish does not catch this today)", () => {
    const r = acceptanceGate(good, ontGood, { deployed: 2, agentsRan: 2, fullChainRan: true, degradedAgents: ["createJD"], simulated: false });
    expect(r.pass).toBe(false);
    expect(r.failing.map((c) => c.key)).toContain("chain_ran");
  });

  it("does not treat one successful terminal as proof that the full approved suite ran", () => {
    const r = acceptanceGate(good, ontGood, {
      deployed: 2,
      agentsRan: 1,
      fullChainRan: false,
      reachedSuccessTerminal: true,
      degradedAgents: [],
      simulated: false,
      fidelityFailures: [],
      functionTester: [],
      ...replayEvidence,
    });
    expect(r.pass).toBe(false);
    expect(r.failing.map((criterion) => criterion.key)).toContain("chain_ran");
  });

  it("accepts an exact all-pass approved-case roster when fullChainRan has not settled", () => {
    const r = acceptanceGate(good, ontGood, {
      ...exactRegistration(good),
      deployed: 2,
      agentsRan: 2,
      fullChainRan: false,
      reachedSuccessTerminal: true,
      expectedCaseIds: ["happy", "reject"],
      caseVerdicts: {
        allPass: true,
        results: [
          { caseId: "happy", kind: "pass", pass: true, reason: "success terminal" },
          { caseId: "reject", kind: "reject", pass: true, reason: "expected fail terminal" },
        ],
      },
      degradedAgents: [],
      simulated: false,
      fidelityFailures: [],
      functionTester: promotableFunctionTester(good),
      ...replayEvidence,
    });
    expect(r.report.criteria.find((criterion) => criterion.key === "chain_ran")).toMatchObject({ pass: true });
  });

  it("rejects duplicate verdict ids even when counts and allPass look green", () => {
    const r = acceptanceGate(good, ontGood, {
      ...exactRegistration(good),
      deployed: 2,
      agentsRan: 2,
      fullChainRan: false,
      expectedCaseIds: ["happy", "reject"],
      caseVerdicts: {
        allPass: true,
        results: [
          { caseId: "happy", kind: "pass", pass: true, reason: "ok" },
          { caseId: "happy", kind: "reject", pass: true, reason: "duplicated" },
        ],
      },
      degradedAgents: [],
      simulated: false,
      fidelityFailures: [],
      functionTester: promotableFunctionTester(good),
      ...replayEvidence,
    });
    expect(r.failing.map((criterion) => criterion.key)).toContain("chain_ran");
  });

  it("blocks chain_ran when required external writes were gated instead of executed", () => {
    const r = acceptanceGate(good, ontGood, {
      deployed: 2,
      agentsRan: 2,
      fullChainRan: true,
      degradedAgents: [],
      simulated: false,
      fidelityFailures: [],
      functionTester: [],
      toolMode: "gated",
      externalWritesRequired: true,
      externalLiveCalls: 0,
    });
    const criterion = r.report.criteria.find((c) => c.key === "chain_ran")!;
    expect(criterion.pass).toBe(false);
    expect(criterion.detail).toContain("evidence_replay");
  });

  it("rejects gated mode even when the chain has no external writes", () => {
    const r = acceptanceGate(good, ontGood, {
      deployed: 2,
      agentsRan: 2,
      fullChainRan: true,
      degradedAgents: [],
      simulated: false,
      fidelityFailures: [],
      functionTester: [],
      toolMode: "gated",
      externalWritesRequired: false,
      externalLiveCalls: 0,
    });
    expect(r.report.criteria.find((c) => c.key === "chain_ran")!.pass).toBe(false);
    expect(r.report.criteria.find((c) => c.key === "sandbox_zero_live_external")!.pass).toBe(false);
    expect(r.pass).toBe(false);
  });

  it("accepts attempt-bound evidence replay only with an exact zero-live runtime ledger", () => {
    const replay = acceptanceGate(good, ontGood, {
      ...exactRegistration(good),
      deployed: 2,
      agentsRan: 2,
      fullChainRan: true,
      degradedAgents: [],
      simulated: false,
      fidelityFailures: [],
      functionTester: promotableFunctionTester(good),
      toolMode: "evidence_replay",
      externalLiveCalls: 0,
      sandboxReplayEvidenceComplete: true,
      replayReceipts: [{
        schema: "agent-factory-sandbox-dispatch/v1",
        attemptId: "attempt-1",
        tenantSlug: "sandbox-1",
        tool: "x",
        kind: "replay",
        effectScope: "external",
        argsHash: "12345678",
        cassetteKey: "87654321",
        definitionHash: "d".repeat(64),
        contentHash: "c".repeat(64),
        at: new Date().toISOString(),
      }],
    });
    expect(replay.report.criteria.find((c) => c.key === "sandbox_zero_live_external")?.pass).toBe(true);
    expect(replay.report.criteria.find((c) => c.key === "chain_ran")?.pass).toBe(true);
    expect(replay.pass).toBe(true);

    const unknown = acceptanceGate(good, ontGood, {
      deployed: 2,
      agentsRan: 2,
      fullChainRan: true,
      degradedAgents: [],
      simulated: false,
      fidelityFailures: [],
      functionTester: [],
      toolMode: "evidence_replay",
      externalLiveCalls: null,
      sandboxReplayEvidenceComplete: false,
    });
    expect(unknown.report.criteria.find((c) => c.key === "sandbox_zero_live_external")?.pass).toBe(false);
    expect(unknown.pass).toBe(false);
  });

  it("returns no failures (pass=false) when there is no sandbox evidence at all", () => {
    const r = acceptanceGate(good, ontGood, null);
    expect(r.pass).toBe(false);
  });

  // #AUDIT-FIX(P1-02) — 三态：真实跑过(ran>0)却【没采到保真证据】= UNKNOWN → 阻断（不再 fail-open）。
  it("BLOCKS execution_fidelity when a real run captured no fidelity evidence (unknown ≠ pass)", () => {
    const r = acceptanceGate(good, ontGood, { deployed: 2, agentsRan: 2, fullChainRan: true, degradedAgents: [], simulated: false }); // 无 fidelityFailures → unknown
    expect(r.report.criteria.find((c) => c.key === "execution_fidelity")!.pass).toBe(false);
    expect(r.pass).toBe(false);
  });
  it("PASSES execution_fidelity when a real run graded clean (fidelityFailures: [])", () => {
    const r = acceptanceGate(good, ontGood, { ...exactRegistration(good), deployed: 2, agentsRan: 2, fullChainRan: true, degradedAgents: [], simulated: false, fidelityFailures: [], functionTester: promotableFunctionTester(good), ...replayEvidence });
    expect(r.report.criteria.find((c) => c.key === "execution_fidelity")!.pass).toBe(true);
    expect(r.pass).toBe(true);
  });

  it("blocks when a real emit payload violated the downstream contract (the output_parse_error class)", () => {
    const r = acceptanceGate(good, ontGood, { deployed: 2, agentsRan: 2, fullChainRan: true, degradedAgents: [], simulated: false, fidelityFailures: ["CreateJD"] });
    expect(r.pass).toBe(false);
    expect(r.failing.map((c) => c.key)).toContain("execution_fidelity");
  });
});

describe("function_tester criterion — exact promotable evidence per spec", () => {
  const specs = [
    spec({ actionName: "createJD", tools: ["x"], inputSchema: okIO }),
    boundRuleSpec(),
  ];
  const ontology = ont(["createJD", "policyEvaluation"]);
  const base = { registeredIds: ["d-createJD", "d-policyEvaluation"], ran: 2, fullChainRan: true, degradedAgents: [], simulated: false, fidelityFailures: [] as string[], toolMode: "live", externalLiveCalls: 0 };
  const crit = (r: ReturnType<typeof acceptanceReport>) => r.criteria.find((c) => c.key === "function_tester")!;
  const entry = (
    short: string,
    overrides: Partial<FunctionTesterEntry> = {},
  ): FunctionTesterEntry => ({
    short,
    pass: true,
    ran: true,
    emitNames: [],
    reasons: [] as string[],
    tier: "external-container",
    qualification: "promotable" as const,
    ...overrides,
  });

  it("rejects a missing field and an explicitly empty array on a real sandbox", () => {
    const missing = acceptanceReport(specs, ontology, { ...base });
    expect(crit(missing)).toMatchObject({ pass: false });
    expect(crit(missing).detail).toContain("缺少 functionTester");

    const empty = acceptanceReport(specs, ontology, { ...base, functionTester: [] });
    expect(crit(empty)).toMatchObject({ pass: false });
    expect(crit(empty).detail).toContain("记录数 0/2");
  });

  it("rejects a missing spec entry and duplicate entries for another spec", () => {
    const missing = acceptanceReport(specs, ontology, {
      ...base,
      functionTester: [entry("createJD")],
    });
    expect(crit(missing).pass).toBe(false);
    expect(crit(missing).detail).toContain("缺记录：policyEvaluation");

    const duplicate = acceptanceReport(specs, ontology, {
      ...base,
      functionTester: [entry("createJD"), entry("createJD")],
    });
    expect(crit(duplicate).pass).toBe(false);
    expect(crit(duplicate).detail).toContain("重复记录：createJD");
  });

  it("rejects pass=true when ran=false and rejects a non-promotable execution tier", () => {
    const notRan = acceptanceReport(specs, ontology, {
      ...base,
      functionTester: [entry("createJD", { ran: false }), entry("policyEvaluation")],
    });
    expect(crit(notRan).pass).toBe(false);
    expect(crit(notRan).detail).toContain("未实际执行：createJD");

    const developmentOnly = acceptanceReport(specs, ontology, {
      ...base,
      functionTester: [entry("createJD", { qualification: "development_only" }), entry("policyEvaluation")],
    });
    expect(crit(developmentOnly).pass).toBe(false);
    expect(crit(developmentOnly).detail).toContain("非 promotable：createJD");
  });

  it("accepts exactly one ran+pass+promotable entry per spec; explicit simulated runs remain diagnostic-only", () => {
    const ok = acceptanceReport(specs, ontology, {
      ...base,
      functionTester: promotableFunctionTester(specs),
    });
    expect(crit(ok)).toMatchObject({ pass: true });
    expect(ok.perAgent.every((agent) => agent.items.find((item) => item.key === "function_tester")?.pass)).toBe(true);

    const sim = acceptanceReport(specs, ontology, { registeredIds: [], ran: 0, fullChainRan: false, degradedAgents: [], simulated: true });
    expect(crit(sim).pass).toBe(true);
    expect(crit(sim).detail).toContain("模拟/dry/test-only");
  });
});
