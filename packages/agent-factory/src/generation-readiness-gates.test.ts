import { describe, expect, it } from "vitest";
import { FACTORY_TOOLS } from "./tools";
import type { BrainCtx } from "./brain-types";
import type { DomainOntology } from "./ontology-types";
import { sanitizeSensitiveInput } from "./sensitive-input";
import {
  catalogToolDefinitionHash,
  declarativeToolDefinitionHash,
} from "./declarative-tool-hash";

const readOntology = FACTORY_TOOLS.find((tool) => tool.name === "read_ontology")!;
const inspectActionReadiness = FACTORY_TOOLS.find((tool) => tool.name === "inspect_action_readiness")!;
const inspectAllActionReadiness = FACTORY_TOOLS.find((tool) => tool.name === "inspect_all_action_readiness")!;
const analyzeWithCode = FACTORY_TOOLS.find((tool) => tool.name === "analyze_with_code")!;
const reviseOntology = FACTORY_TOOLS.find((tool) => tool.name === "revise_ontology")!;
const designAgent = FACTORY_TOOLS.find((tool) => tool.name === "design_agent")!;
const createTool = FACTORY_TOOLS.find((tool) => tool.name === "create_tool")!;

function validOntology(): DomainOntology {
  return {
    domainId: "test",
    source: "allmeta",
    objects: [{ id: "Work", name: "Work", primary_key: "work_id", properties: [{ name: "work_id", type: "String" }, { name: "result", type: "String" }] }],
    rules: [],
    events: [
      { name: "WORK_REQUESTED", payload: { source_action: null, event_data: [{ name: "work_id", type: "String", target_object: "Work" }], state_mutations: [] } },
      { name: "WORK_DONE", payload: { source_action: "doWork", event_data: [{ name: "result", type: "String", target_object: "Work" }], state_mutations: [{ target_object: "Work", mutation_type: "MODIFY", impacted_properties: ["result"] }] } },
    ],
    actions: [{
      id: "a1",
      name: "doWork",
      actor: ["Agent"],
      trigger: ["WORK_REQUESTED"],
      triggered_event: ["WORK_DONE"],
      target_objects: ["Work"],
      tool_use: [],
      system_prompt: "",
      user_prompt: "",
      inputs: [{ name: "work_id", type: "String", required: true, binding_kind: "event", event_field: "work_id", source_object: "Work.work_id" }],
      outputs: [{ name: "result", type: "String" }],
      action_steps: [{ id: "fetch", name: "fetch", type: "tool" }],
      integration: { systems: [{ name: "Vendor", kind: "external_api", role: "reads", capability: "GET /lookup", objects: ["Work"] }] },
    }],
    workflow: [{ id: "flow" }],
  } as unknown as DomainOntology;
}

function context(ontology: DomainOntology): BrainCtx {
  const defaultTool = {
    name: "vendor.lookup",
    description: "lookup",
    method: "GET",
    urlTemplate: "https://api.example.com/{work_id}",
    sideEffect: "read" as const,
    operation: "read" as const,
    effectScope: "external" as const,
    sandboxPolicy: "live_external" as const,
    domain: "test",
    capabilities: [{ systems: ["Vendor"], kinds: ["external_api"], roles: ["reads"], operations: ["lookup"], objectTypes: ["Work"] }],
    probeStatus: "verified" as const,
  };
  const defaultDefinitionHash = declarativeToolDefinitionHash(defaultTool, {}, process.env);
  return {
    domain: "test",
    goal: "build",
    emit: () => {},
    specs: [],
    ontology: null,
    currentPlan: null,
    toolCatalog: [],
    realTools: [],
    attemptHistory: {},
    createdSkills: [],
    research: [],
    priorReflections: [],
    humanDirectives: [],
    lastSandbox: null,
    lastValidation: null,
    budget: { maxTokens: null, maxTurns: 20 },
    spent: { tokens: 0, turns: 0, sandboxRuns: 0 },
    ports: {
      ontology: { fetchOntology: async () => ontology, listDomains: async () => [], fetchActionRules: async () => [] },
      tools: {
        list: async () => [{
          ...defaultTool,
          definitionHash: defaultDefinitionHash,
          verifiedDefinitionHashes: [defaultDefinitionHash],
          productionVerifiedDefinitionHashes: [defaultDefinitionHash],
          probeEvidenceMode: "live-probe" as const,
        }],
        save: async () => {},
      },
      toolRegistry: { list: async () => [] },
      skills: { list: async () => [], save: async () => {}, bumpUse: async () => {}, recordEval: async () => {} },
    },
  } as unknown as BrainCtx;
}

describe("generation readiness gates", () => {
  it("gives analyze_with_code an exact derived agentActions alias and fails plainly before Ontology is loaded", async () => {
    const ctx = context(validOntology());
    const missing = await analyzeWithCode.execute({
      purpose: "count agent actions",
      code: "return input.ontology.agentActions.length;",
    }, ctx);
    expect(missing.ok).toBe(false);
    expect(missing.summary).toContain("read_ontology");

    await readOntology.execute({}, ctx);
    const analyzed = await analyzeWithCode.execute({
      purpose: "verify aliases",
      code: "return {all: input.ontology.actions.length, agents: input.ontology.agentActions.map(function (a) { return a.name; })};",
    }, ctx);
    expect(analyzed.ok).toBe(true);
    expect(analyzed.output).toMatchObject({ result: { all: 1, agents: ["doWork"] } });
  });

  it("inspects one action without requiring or creating a plan/spec", async () => {
    const ctx = context(validOntology());
    await readOntology.execute({}, ctx);
    expect(ctx.currentPlan).toBeNull();
    expect(ctx.specs).toHaveLength(0);

    const inspected = await inspectActionReadiness.execute({ action: "doWork" }, ctx);

    expect(inspected.ok).toBe(true);
    expect(inspected.output).toMatchObject({
      action: "doWork",
      ready: true,
      readOnly: true,
      ontology: { ready: true, blockers: [] },
      rules: { unresolved: [], needsUserInput: false },
      integration: { ready: true },
      profiles: { ready: true },
      probes: { ready: true },
    });
    expect(ctx.currentPlan).toBeNull();
    expect(ctx.specs).toHaveLength(0);
  });

  it("parks read_ontology when the execution-resource catalog is unavailable", async () => {
    const ctx = context(validOntology());
    ctx.ports.toolRegistry = { list: async () => { throw new Error("catalog offline"); } };

    const result = await readOntology.execute({}, ctx);

    expect(result).toMatchObject({
      ok: false,
      output: {
        next: "ask_user",
        reason: "execution_resources_unavailable",
        missing: ["execution_resources_snapshot"],
      },
    });
    expect(result.summary).toContain("没有可靠清单时不会生成、修改或部署代码");
    expect(ctx.currentPlan).toBeNull();
    expect(ctx.specs).toHaveLength(0);
  });

  it("parks both readiness inspection and design when a fresh resource read fails", async () => {
    const ctx = context(validOntology());
    await readOntology.execute({}, ctx);
    ctx.ports.toolRegistry = { list: async () => { throw new Error("catalog offline"); } };

    const one = await inspectActionReadiness.execute({ action: "doWork" }, ctx);
    const all = await inspectAllActionReadiness.execute({}, ctx);
    const designed = await designAgent.execute({
      action: "doWork",
      system_prompt: "按契约处理输入。",
      decision_logic: "成功后发出 WORK_DONE。",
    }, ctx);

    expect(one).toMatchObject({
      ok: false,
      output: { next: "ask_user", reason: "execution_resources_unavailable" },
    });
    expect(all).toMatchObject({
      ok: false,
      output: { next: "ask_user", reason: "execution_resources_unavailable" },
    });
    expect(designed).toMatchObject({
      ok: false,
      output: { next: "ask_user", reason: "execution_resources_unavailable" },
    });
    expect(ctx.currentPlan).toBeNull();
    expect(ctx.specs).toHaveLength(0);
  });

  it("turns authoritative readiness gaps into enforced ask_user control flow", async () => {
    const ontology = validOntology();
    // A same-name, type-compatible Event field is now normalized
    // deterministically. Keep this fixture genuinely unresolved so the test
    // continues to exercise the ask_user branch rather than an old false
    // blocker.
    ontology.actions[0]!.inputs = [{ name: "request_key", type: "String", required: true }];
    const ctx = context(ontology);
    await readOntology.execute({}, ctx);

    const inspected = await inspectActionReadiness.execute({ action: "doWork" }, ctx);

    expect(inspected).toMatchObject({
      ok: true,
      output: {
        ready: false,
        next: "ask_user",
        reason: "action_readiness_requires_authoritative_input",
        missing: expect.arrayContaining(["authoritative_ontology_corrections"]),
      },
    });
    expect((inspected.output as { question: string }).question).toContain("不会自行补路由、字段、规则或凭证");
    expect(ctx.currentPlan).toBeNull();
    expect(ctx.specs).toHaveLength(0);
  });

  it("derives and inspects the complete Agent action set from Ontology with one read-only snapshot", async () => {
    const ontology = validOntology();
    const second = structuredClone(ontology.actions[0]!);
    Object.assign(second, {
      id: "a2",
      name: "doSecondWork",
      trigger: ["SECOND_WORK_REQUESTED"],
      triggered_event: ["SECOND_WORK_DONE"],
    });
    ontology.actions.push(second, {
      id: "human-1",
      name: "manualReview",
      actor: ["Human"],
      trigger: [],
      triggered_event: [],
      target_objects: ["Work"],
      tool_use: [],
      system_prompt: "",
      user_prompt: "",
      inputs: [],
      outputs: [],
      action_steps: [],
      integration: { systems: [] },
    });
    ontology.events.push(
      {
        name: "SECOND_WORK_REQUESTED",
        payload: {
          source_action: null,
          event_data: [{ name: "work_id", type: "String", target_object: "Work" }],
          state_mutations: [],
        },
      },
      {
        name: "SECOND_WORK_DONE",
        payload: {
          source_action: "doSecondWork",
          event_data: [{ name: "result", type: "String", target_object: "Work" }],
          state_mutations: [{ target_object: "Work", mutation_type: "MODIFY", impacted_properties: ["result"] }],
        },
      },
    );
    const ctx = context(ontology);
    await readOntology.execute({}, ctx);

    let registryReads = 0;
    let declarativeReads = 0;
    let capabilityReads = 0;
    let writesOrRuns = 0;
    const registeredTools = await ctx.ports.toolRegistry!.list();
    const declarativeTools = await ctx.ports.tools!.list(ctx.domain);
    ctx.ports.toolRegistry = {
      list: async () => { registryReads += 1; return registeredTools; },
    };
    ctx.ports.tools = {
      list: async () => { declarativeReads += 1; return declarativeTools; },
      save: async () => { writesOrRuns += 1; },
      probe: async () => {
        writesOrRuns += 1;
        return {
          verified: false,
          classification: "must_not_probe",
          definitionHash: "unused",
          schemaHash: "unused",
          durationMs: 0,
        };
      },
    };
    ctx.ports.integrationCapabilities = {
      list: async () => { capabilityReads += 1; return []; },
    };
    ctx.ports.integrationProfiles = {
      save: async () => { writesOrRuns += 1; throw new Error("must not save"); },
    };
    ctx.ports.sandbox = {
      deployAndObserve: async () => { writesOrRuns += 1; throw new Error("must not deploy"); },
      teardown: async () => { writesOrRuns += 1; },
    };
    const emitted: unknown[] = [];
    ctx.emit = (event) => { emitted.push(event); };
    const stateBefore = JSON.stringify({
      ontology: ctx.ontology,
      readiness: ctx.ontologyReadiness,
      plan: ctx.currentPlan,
      specs: ctx.specs,
      testCases: ctx.testCases,
      lastSandbox: ctx.lastSandbox,
    });

    const schema = inspectAllActionReadiness.parameters as {
      additionalProperties?: boolean;
      properties?: Record<string, unknown>;
    };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties).not.toHaveProperty("actions");
    expect(schema.properties).not.toHaveProperty("action");

    // Even a direct executor call that bypasses JSON-schema validation cannot
    // replace the Ontology-derived catalog with a hallucinated list.
    const result = await inspectAllActionReadiness.execute({
      reasoning: "check every real action",
      actions: ["ghostAction"],
    }, ctx);
    expect(result.ok).toBe(true);
    expect(result.output).toMatchObject({
      readOnly: true,
      source: "ontology.agent_actions",
      actionNames: ["doWork", "doSecondWork"],
      totals: {
        total: 2,
        ready: 2,
        blocked: 0,
        readyActions: ["doWork", "doSecondWork"],
        blockedActions: [],
      },
    });
    const reports = (result.output as { actions: Array<Record<string, unknown>> }).actions;
    expect(reports.map((report) => report.action)).toEqual(["doWork", "doSecondWork"]);
    expect(reports).toHaveLength(2);
    for (const report of reports) {
      expect(report).toMatchObject({
        ready: true,
        readOnly: true,
        blockers: { categories: [] },
        rules: { unresolved: [] },
        integration: { ready: true },
        profiles: { ready: true },
        probes: { ready: true },
      });
    }
    expect(JSON.stringify(sanitizeSensitiveInput(result.output, "aggregate-readiness").sanitized))
      .not.toContain("[REDACTED_CIRCULAR]");
    expect(registryReads).toBe(1);
    expect(declarativeReads).toBe(1);
    expect(capabilityReads).toBe(1);
    expect(writesOrRuns).toBe(0);
    expect(emitted).toEqual([]);
    expect(JSON.stringify({
      ontology: ctx.ontology,
      readiness: ctx.ontologyReadiness,
      plan: ctx.currentPlan,
      specs: ctx.specs,
      testCases: ctx.testCases,
      lastSandbox: ctx.lastSandbox,
    })).toBe(stateBefore);
  });

  it("refuses to turn a Human action into a generated function", async () => {
    const ontology = validOntology();
    ontology.actions[0]!.name = "manualApproval";
    ontology.actions[0]!.actor = ["Human"];
    ontology.actions[0]!.action_steps = [];
    ontology.actions[0]!.integration = { systems: [] };
    ontology.events[1]!.payload.source_action = "manualApproval";
    const ctx = context(ontology);

    const read = await readOntology.execute({}, ctx);
    expect((read.output as { agentActions: unknown[] }).agentActions).toEqual([]);

    const result = await designAgent.execute({
      action: "manualApproval",
      system_prompt: "执行人工审批。",
      decision_logic: "审批后完成。",
    }, ctx);

    expect(result).toMatchObject({
      ok: false,
      output: {
        next: "ask_user",
        reason: "action_actor_not_agent",
        action: "manualApproval",
        actor: ["Human"],
      },
    });
    expect(result.summary).toContain("不会把人工/平台操作伪装成 Agent");
    expect(ctx.specs).toHaveLength(0);
  });

  it("honors Ontology action.tool_use during readiness instead of inventing an ambiguous tool choice", async () => {
    const ontology = validOntology();
    ontology.actions[0]!.tool_use = ["vendor.alpha"];
    const ctx = context(ontology);
    ctx.ports.tools!.list = async () => [];
    const capability = {
      systems: ["Vendor"],
      kinds: ["external_api"],
      roles: ["reads"],
      operations: ["lookup"],
      objectTypes: ["Work"],
    };
    ctx.ports.toolRegistry = {
      list: async () => [
        { name: "vendor.alpha", operation: "read", effectScope: "external", sandboxPolicy: "live_external", capabilities: [capability] },
        { name: "vendor.beta", operation: "read", effectScope: "external", sandboxPolicy: "live_external", capabilities: [capability] },
      ],
    };
    await readOntology.execute({}, ctx);

    const result = await inspectAllActionReadiness.execute({}, ctx);

    expect(result).toMatchObject({
      ok: true,
      output: {
        totals: { total: 1, ready: 1, blocked: 0 },
        actions: [{
          integrationGate: {
            ready: true,
            declaredTools: ["vendor.alpha"],
            report: {
              bindings: [{ toolName: "vendor.alpha", status: "resolved" }],
            },
          },
        }],
      },
    });
    expect(JSON.stringify(result.output)).not.toContain("vendor.beta");
  });

  it("merges persisted adapters and carries exact integration evidence into the spec", async () => {
    const ctx = context(validOntology());
    const read = await readOntology.execute({}, ctx);
    expect(read.ok).toBe(true);
    expect(ctx.ontologyReadiness?.ready).toBe(true);
    expect(ctx.realTools?.map((tool) => tool.name)).toContain("vendor.lookup");
    const action = (read.output as { agentActions: Array<{ integration_binding: { ready: boolean } }> }).agentActions[0]!;
    expect(action.integration_binding.ready).toBe(true);

    const designed = await designAgent.execute({
      action: "doWork",
      system_prompt: "按契约读取真实 Vendor 数据，并只输出本体声明字段。",
      decision_logic: "读取成功 emit WORK_DONE；失败按错误策略终止或重试。",
      tools: ["vendor.lookup"],
      plan: [{ stepId: "fetch", kind: "tool", tool: "vendor.lookup", idempotencyKeyFrom: "work_id", onError: "terminal" }],
    }, ctx);
    expect(designed.ok).toBe(true);
    expect(ctx.specs[0]?.integrationBindings?.[0]).toMatchObject({ status: "resolved", toolName: "vendor.lookup" });
  });

  it("authors a pure logic function without inventing a tool or provisioning gap", async () => {
    const ontology = validOntology();
    const action = ontology.actions[0]!;
    action.action_steps = [];
    delete action.integration;
    action.tool_use = [];
    const ctx = context(ontology);
    await readOntology.execute({}, ctx);

    const result = await designAgent.execute({
      action: "doWork",
      system_prompt: "只按输入契约做确定性字段归一化，不访问外部系统。",
      decision_logic: "输入有效时把归一化结果写入 payload 并 emit WORK_DONE；输入无效时终止。",
    }, ctx);

    expect(result).toMatchObject({
      ok: true,
      output: {
        tools: [],
        provisioning: { needed: false },
      },
    });
    expect(result.summary).not.toContain("没绑到任何工具");
    expect(result.summary).not.toContain("先 ask_user");
    expect(ctx.specs[0]).toMatchObject({ tools: [], integrationRequirements: [], integrationBindings: [] });
  });

  it("allows authoring but reports a sandbox blocker when a selected integration lacks probe evidence", async () => {
    const ontology = validOntology();
    ontology.actions[0]!.tool_use = ["vendor.unprobed"];
    const ctx = context(ontology);
    ctx.ports.tools!.list = async () => [];
    ctx.ports.toolRegistry = {
      list: async () => [{
        name: "vendor.unprobed",
        operation: "read",
        effectScope: "external",
        sandboxPolicy: "live_external",
        capabilities: [{
          systems: ["Vendor"],
          kinds: ["external_api"],
          roles: ["reads"],
          operations: ["lookup"],
          objectTypes: ["Work"],
          probeRequired: true,
        }],
        probeStatus: "required",
        definitionHash: "sha256:unverified",
        verifiedDefinitionHashes: [],
      }],
    };
    await readOntology.execute({}, ctx);

    const readiness = await inspectActionReadiness.execute({ action: "doWork" }, ctx);
    expect(readiness.output).toMatchObject({
      authoringReady: true,
      sandboxReady: false,
      promotionReady: false,
    });
    expect((readiness.output as { next?: string }).next).toBeUndefined();

    const result = await designAgent.execute({
      action: "doWork",
      system_prompt: "按契约读取真实 Vendor 数据。",
      decision_logic: "成功 emit WORK_DONE；失败终止。",
      plan: [{ stepId: "fetch", kind: "tool", tool: "vendor.unprobed", idempotencyKeyFrom: "work_id", onError: "terminal" }],
    }, ctx);

    expect(result).toMatchObject({
      ok: true,
      output: {
        readiness: {
          authoringReady: true,
          sandboxReady: false,
          promotionReady: false,
          probeGaps: [{ tool: "vendor.unprobed" }],
        },
      },
    });
    expect(result.summary).toContain("草稿已生成");
    expect(ctx.specs).toHaveLength(1);
    expect(ctx.specs[0]?.integrationBindings?.[0]).toMatchObject({
      toolName: "vendor.unprobed",
      status: "needs_probe",
    });
  });

  it("reports signed-fixture as sandbox-ready but never promotion-ready without an exact live probe", async () => {
    const ontology = validOntology();
    ontology.actions[0]!.tool_use = ["vendor.fixture"];
    const catalogDefinition = {
      name: "vendor.fixture",
      category: "vendor",
      sourcePath: "test/vendor-fixture.ts",
      sideEffect: "read" as const,
      operation: "read" as const,
      effectScope: "external" as const,
      sandboxPolicy: "live_external" as const,
      argsSchema: { work_id: { type: "string", required: true } },
      returnsSchema: { result: { type: "string", required: true } },
      capabilities: [{
        systems: ["Vendor"],
        kinds: ["external_api"],
        roles: ["reads"],
        operations: ["lookup"],
        objectTypes: ["Work"],
        probeRequired: true,
      }],
    };
    const definitionHash = catalogToolDefinitionHash(catalogDefinition, {}, process.env);
    const realTool = {
      name: "vendor.fixture",
      sideEffect: "read" as const,
      operation: "read" as const,
      effectScope: "external" as const,
      sandboxPolicy: "live_external" as const,
      capabilities: catalogDefinition.capabilities,
      probeStatus: "verified" as const,
      definitionHash,
      verifiedDefinitionHashes: [definitionHash],
      productionVerifiedDefinitionHashes: [] as string[],
      probeEvidenceMode: "signed-fixture" as const,
      catalogDefinition,
    };
    const ctx = context(ontology);
    ctx.ports.tools!.list = async () => [];
    ctx.ports.toolRegistry = { list: async () => [realTool] };
    await readOntology.execute({}, ctx);

    const sandboxOnly = await inspectActionReadiness.execute({ action: "doWork" }, ctx);
    expect(sandboxOnly.output).toMatchObject({
      authoringReady: true,
      sandboxReady: true,
      promotionReady: false,
      probeGate: {
        sandboxReady: true,
        promotionReady: false,
        tools: [{
          tool: "vendor.fixture",
          evidenceMode: "signed-fixture",
          sandboxReady: true,
          promotionReady: false,
        }],
      },
    });

    realTool.productionVerifiedDefinitionHashes.push(definitionHash);
    realTool.probeEvidenceMode = "live-probe" as never;
    const liveReady = await inspectActionReadiness.execute({ action: "doWork" }, ctx);
    expect(liveReady.output).toMatchObject({
      sandboxReady: true,
      promotionReady: true,
      probeGate: { sandboxReady: true, promotionReady: true },
    });
  });

  it("auto-selects the only exact capability candidate when both explicit tool selections are empty", async () => {
    const ctx = context(validOntology());
    await readOntology.execute({}, ctx);
    const result = await designAgent.execute({
      action: "doWork",
      system_prompt: "按契约读取真实 Vendor 数据。",
      decision_logic: "成功 emit WORK_DONE；失败终止。",
      plan: [{ stepId: "fetch", kind: "tool", tool: "vendor.lookup", idempotencyKeyFrom: "work_id", onError: "terminal" }],
    }, ctx);
    expect(result).toMatchObject({
      ok: true,
      output: {
        tools: ["vendor.lookup"],
        toolSelectionSource: "unique_capability_binding",
      },
    });
    expect(ctx.specs).toHaveLength(1);
  });

  it("uses Ontology action.tool_use, and only that declaration, when design tools are empty", async () => {
    const ontology = validOntology();
    ontology.actions[0]!.tool_use = ["vendor.lookup"];
    const ctx = context(ontology);
    await readOntology.execute({}, ctx);
    const result = await designAgent.execute({
      action: "doWork",
      system_prompt: "按契约读取真实 Vendor 数据。",
      decision_logic: "成功 emit WORK_DONE；失败终止。",
      plan: [{ stepId: "fetch", kind: "tool", tool: "vendor.lookup", idempotencyKeyFrom: "work_id", onError: "terminal" }],
    }, ctx);
    expect(result.ok).toBe(true);
    expect(result.output).toMatchObject({
      tools: ["vendor.lookup"],
      toolSelectionSource: "ontology.action.tool_use",
    });
    expect(ctx.specs[0]?.tools).toEqual(["vendor.lookup"]);
  });

  // #TOOLUSE-AS-SUGGESTION — an ontology that names a tool this tenant does NOT grant must not hard
  // block: tool_use is a suggestion, integration.systems[] is authoritative, and discovery binds the
  // granted transport for the requirement. This is what makes the factory adapt to any ontology
  // (e.g. Agents-generation naming legacy RAAS tools that resolve to facts.query/entities.write).
  it("substitutes the discovered granted transport when tool_use names an UNGRANTED tool, and reports the drop", async () => {
    const ontology = validOntology();
    // The author suggested a tool that doesn't exist in this tenant's registry; the action's real
    // requirement (Vendor/read) IS covered by the granted vendor.lookup.
    ontology.actions[0]!.tool_use = ["legacyVendorReader"];
    const ctx = context(ontology);
    await readOntology.execute({}, ctx);
    const result = await designAgent.execute({
      action: "doWork",
      system_prompt: "按契约读取真实 Vendor 数据。",
      decision_logic: "成功 emit WORK_DONE；失败终止。",
      plan: [{ stepId: "fetch", kind: "tool", tool: "vendor.lookup", idempotencyKeyFrom: "work_id", onError: "terminal" }],
    }, ctx);
    expect(result.ok).toBe(true); // NOT tool_execution_policy_missing
    // the executable set is the discovered granted transport, not the ungranted suggestion
    expect(ctx.specs[0]?.tools).toEqual(["vendor.lookup"]);
    // the ungranted suggestion is surfaced honestly, never silently swallowed
    expect(ctx.specs[0]?.unresolvedTools).toContain("legacyVendorReader");
    expect(String((result.output as { toolSelectionSource?: string }).toolSelectionSource)).toContain("integration_binding");
  });

  // #TOOLUSE-ECHO — a model that COPIES the ontology's tool_use into design_agent.tools has not made
  // a deliberate novel choice; the ungranted names substitute exactly like ontology suggestions.
  // (Live regression: fleet members echoed tool_use every run → the same templated
  // tool_execution_policy_missing ask re-parked every run.) A name the model invents BEYOND the
  // ontology still hard-asks.
  it("explicit tools ECHOING ungranted tool_use names substitute instead of hard-asking; a novel invented name still asks", async () => {
    const ontology = validOntology();
    ontology.actions[0]!.tool_use = ["legacyVendorReader"];
    const ctx = context(ontology);
    await readOntology.execute({}, ctx);
    const echoed = await designAgent.execute({
      action: "doWork",
      system_prompt: "按契约读取真实 Vendor 数据。",
      decision_logic: "成功 emit WORK_DONE；失败终止。",
      tools: ["legacyVendorReader"], // echo of tool_use, NOT a novel invention
      plan: [{ stepId: "fetch", kind: "tool", tool: "vendor.lookup", idempotencyKeyFrom: "work_id", onError: "terminal" }],
    }, ctx);
    expect(echoed.ok).toBe(true);
    expect((echoed.output as { reason?: string }).reason).not.toBe("tool_execution_policy_missing");
    expect(ctx.specs[0]?.tools).toEqual(["vendor.lookup"]); // substituted granted transport
    expect(ctx.specs[0]?.unresolvedTools).toContain("legacyVendorReader");

    const invented = await designAgent.execute({
      action: "doWork",
      system_prompt: "按契约读取真实 Vendor 数据。",
      decision_logic: "成功 emit WORK_DONE；失败终止。",
      // MIXED pick: an echoed ontology name AND a novel invention — the ask must name ONLY the invention.
      tools: ["legacyVendorReader", "magicDataFetcher9000"],
    }, ctx);
    expect(invented.ok).toBe(false);
    expect((invented.output as { reason?: string }).reason).toBe("tool_execution_policy_missing");
    expect(String(invented.summary)).toContain("magicDataFetcher9000");
    expect(String(invented.summary)).not.toContain("legacyVendorReader"); // asks ONLY about the novel name
  });

  // #TOOLUSE-AS-SUGGESTION coherence — the READINESS INSPECTOR must agree with design_agent on the
  // same fixture: an ungranted tool_use name whose requirement IS covered by a granted transport is
  // a reported substitution, NOT an authoring blocker. (The live regression: the inspector said
  // "0 个可生成草稿、缺工具 <legacy names>" and force-parked the run while design_agent would accept.)
  it("readiness inspector agrees with design_agent: ungranted tool_use suggestion → substituted, authoring stays ready", async () => {
    const ontology = validOntology();
    ontology.actions[0]!.tool_use = ["legacyVendorReader"];
    const ctx = context(ontology);
    await readOntology.execute({}, ctx);
    const result = await inspectActionReadiness.execute({ action: "doWork" }, ctx);
    expect(result.ok).toBe(true);
    const report = (result.output as { report?: Record<string, unknown> }).report
      ?? (result.output as Record<string, unknown>);
    const gate = (report as { integrationGate?: Record<string, unknown> }).integrationGate ?? {};
    // authoring is NOT blocked by the ungranted suggestion…
    expect((report as { authoringReady?: boolean }).authoringReady).toBe(true);
    // …the substitution is reported honestly…
    expect(gate.missingDeclaredTools).toContain("legacyVendorReader");
    // …and the effective executable set is the discovered granted transport.
    expect(gate.effectiveTools).toContain("vendor.lookup");
    // No ask_user park for a substitutable suggestion.
    expect((result.output as { next?: string }).next).not.toBe("ask_user");
  });

  // #ASK-PARK dedup — a missing rule-tool SELECTION is design_agent's own ask surface; the
  // readiness inspector must report it as designer guidance, NOT force another ask_user park
  // (live regression: the run re-parked on a question the operator had just answered).
  it("rule-tool-only gap: inspector reports not-ready WITHOUT force-parking on ask_user", async () => {
    const ontology = validOntology();
    // Step-level rule reference makes the action a rule gate; its integration requirement is
    // still fully covered by the granted vendor.lookup, and NO granted tool reads a rulebase.
    // The rule itself RESOLVES (canonical id exists) — the only gap left is the tool selection.
    (ontology as { rules: unknown[] }).rules = [{ id: "r-1", name: "工作校验规则", description: "结果必须非空" }];
    ontology.actions[0]!.action_steps = [{ id: "fetch", name: "fetch", type: "tool", rules: [{ id: "r-1" }] }] as never;
    const ctx = context(ontology);
    await readOntology.execute({}, ctx);
    const result = await inspectActionReadiness.execute({ action: "doWork" }, ctx);
    expect(result.ok).toBe(true);
    const out = result.output as { authoringReady?: boolean; next?: string; integrationGate?: { ruleToolSatisfied?: boolean } };
    expect(out.authoringReady).toBe(false); // a bare design_agent call would still ask — honest
    expect(out.integrationGate?.ruleToolSatisfied).toBe(false);
    expect(out.next).toBeUndefined(); // but the INSPECTOR must not park the run itself
    expect(String(result.summary)).toContain("design_agent");
  });

  it("does not treat a rule-looking action name as structural rule evidence", async () => {
    const ontology = validOntology();
    const action = ontology.actions[0]!;
    action.id = "rule-check-work";
    action.name = "ruleCheckWork";
    action.action_steps = [];
    action.integration = { systems: [] };
    ontology.events[1]!.payload.source_action = "ruleCheckWork";
    const ctx = context(ontology);
    await readOntology.execute({}, ctx);
    const result = await designAgent.execute({
      action: "ruleCheckWork",
      system_prompt: "根据运行时规则判断是否通过。",
      decision_logic: "通过 emit WORK_DONE；资料不足则终止。",
    }, ctx);
    expect(result.ok).toBe(true);
    expect(result.output).toMatchObject({ tools: [], toolSelectionSource: "none" });
    expect(ctx.specs).toHaveLength(1);
    expect(ctx.specs[0]?.ruleRefs).toEqual([]);
  });

  it("grounds a structured rule action through exact action_steps references and custom capability metadata", async () => {
    const ontology = validOntology();
    const action = ontology.actions[0]!;
    const readerName = "policy.current.read";
    ontology.rules = [{ id: "policy-1", name: "Current submission policy", description: "evaluate current submission" }];
    action.action_steps = [{ id: "fetch", name: "fetch", type: "tool", rules: [{ rule_id: "policy-1" }] }];
    action.integration = { systems: [{ name: "Policy Store", kind: "rulebase", role: "reads" }] };
    action.tool_use = [readerName];
    const ctx = context(ontology);
    ctx.ports.tools!.list = async () => [];
    ctx.ports.toolRegistry = { list: async () => [{
      name: readerName,
      operation: "read",
      effectScope: "external",
      sandboxPolicy: "live_external",
      capabilities: [{ systems: ["Policy Store"], kinds: ["rulebase"], roles: ["reads"] }],
    }] };

    const read = await readOntology.execute({}, ctx);
    const readAction = (read.output as { agentActions: Array<Record<string, unknown>> }).agentActions[0]!;
    expect(readAction).toMatchObject({
      is_rule_check: true,
      relevant_rules: [{ id: "policy-1", name: "Current submission policy" }],
      rule_resolution: { unresolved: [], needs_user_input: false },
    });

    const result = await designAgent.execute({
      action: "doWork",
      system_prompt: "运行时读取当前规则，并依据规则生成结构化结果。",
      decision_logic: "成功 emit WORK_DONE；读取失败则终止。",
      plan: [{ stepId: "fetch", kind: "tool", tool: readerName, idempotencyKeyFrom: "work_id", onError: "terminal" }],
    }, ctx);
    expect(result.ok).toBe(true);
    expect(ctx.specs[0]?.tools).toEqual([readerName]);
    expect(ctx.specs[0]?.ruleRefs).toEqual(["policy-1"]);
  });

  it("surfaces ambiguous action-step rule references and blocks design with ask_user", async () => {
    const ontology = validOntology();
    const action = ontology.actions[0]!;
    action.action_steps = [{ id: "fetch", name: "fetch", type: "tool", rules: ["Duplicate policy"] }];
    action.integration = { systems: [] };
    ontology.rules = [
      { id: "policy-a", name: "Duplicate policy" },
      { id: "policy-b", businessLogicRuleName: "Duplicate policy" },
    ];
    const ctx = context(ontology);

    const read = await readOntology.execute({}, ctx);
    const readAction = (read.output as { agentActions: Array<Record<string, unknown>> }).agentActions[0]!;
    expect(readAction).toMatchObject({
      is_rule_check: true,
      relevant_rules: [],
      rule_resolution: {
        needs_user_input: true,
        next: "ask_user",
        unresolved: [{ reason: "ambiguous" }],
      },
    });
    expect(read.summary).toContain("无法唯一解析");

    const result = await designAgent.execute({
      action: "doWork",
      system_prompt: "读取明确规则后执行。",
      decision_logic: "成功 emit WORK_DONE；失败终止。",
    }, ctx);
    expect(result).toMatchObject({
      ok: false,
      output: { next: "ask_user", reason: "unresolved_ontology_rule_references" },
    });
    expect(ctx.specs).toHaveLength(0);
  });

  it("asks the user when explicitly selected tools have the same top integration score", async () => {
    const ontology = validOntology();
    const ctx = context(ontology);
    const capabilities = [{
      systems: ["Vendor"],
      kinds: ["external_api"],
      roles: ["reads"],
      operations: ["lookup"],
      objectTypes: ["Work"],
    }];
    ctx.ports.tools!.list = async () => [];
    ctx.ports.toolRegistry = {
      list: async () => [
        { name: "vendor.alpha", operation: "read", effectScope: "external", sandboxPolicy: "live_external", capabilities },
        { name: "vendor.beta", operation: "read", effectScope: "external", sandboxPolicy: "live_external", capabilities },
      ],
    };
    await readOntology.execute({}, ctx);
    const result = await designAgent.execute({
      action: "doWork",
      system_prompt: "按契约读取 Vendor 数据。",
      decision_logic: "成功 emit WORK_DONE；失败终止。",
      tools: ["vendor.alpha", "vendor.beta"],
      plan: [{ stepId: "fetch", kind: "tool", tool: "vendor.alpha", idempotencyKeyFrom: "work_id", onError: "terminal" }],
    }, ctx);
    expect(result).toMatchObject({
      ok: false,
      output: {
        next: "ask_user",
        reason: "ambiguous_integration_binding",
        candidates: [
          { kind: "tool", id: "vendor.alpha" },
          { kind: "tool", id: "vendor.beta" },
        ],
      },
    });
    expect(ctx.specs).toHaveLength(0);
  });

  it("blocks design and asks the user after a successfully fetched but referentially broken Ontology", async () => {
    const ontology = validOntology();
    ontology.actions[0]!.triggered_event = ["MISSING_EVENT"];
    const ctx = context(ontology);
    const read = await readOntology.execute({}, ctx);
    expect(read.ok).toBe(true);
    expect(ctx.ontologyReadiness?.ready).toBe(false);
    const result = await designAgent.execute({ action: "doWork", system_prompt: "x", decision_logic: "x" }, ctx);
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({
      output: {
        next: "ask_user",
        reason: "authoritative_ontology_contract_unresolved",
        missing: expect.arrayContaining(["authoritative_ontology_corrections"]),
      },
    });
    expect(result.summary).toContain("AllmetaOntology");
    expect(ctx.specs).toHaveLength(0);
  });

  it("revise_ontology produces an authoritative correction proposal without reopening the working-copy gate", async () => {
    const ontology = validOntology();
    // Use a field that cannot be proven from the Event by name. A same-name
    // Event field is intentionally normalized without asking the user.
    ontology.actions[0]!.inputs = [{ name: "request_key", type: "String", required: true }];
    const ctx = context(ontology);
    await readOntology.execute({}, ctx);
    expect(ctx.ontologyReadiness?.ready).toBe(false);
    expect(ctx.ontologyReadiness!.blocking.map((i) => i.code)).toContain("action_input_binding_kind_missing");
    const before = ctx.ontologyReadiness!.blocking.length;
    const beforeOntology = JSON.stringify(ctx.ontology);
    const beforeReadiness = ctx.ontologyReadiness;
    const emitted: unknown[] = [];
    ctx.emit = (event) => { emitted.push(event); };

    const revised = await reviseOntology.execute({ inputs: [{ action: "doWork", field: "request_key", set: { binding_kind: "event", event_field: "work_id" } }] }, ctx);

    expect(revised.ok).toBe(false);
    expect(revised).toMatchObject({
      output: {
        next: "ask_user",
        reason: "authoritative_ontology_update_required",
        committed: false,
        proposalReady: true,
        applied: [],
      },
    });
    expect(revised.summary).toContain("Allmeta");
    expect((revised.output as { blockingAfter: number }).blockingAfter).toBe(before);
    expect((revised.output as { proposedBlockingAfter: number }).proposedBlockingAfter).toBeLessThan(before);
    expect((revised.output as { candidateChanges: unknown[] }).candidateChanges.length).toBeGreaterThan(0);
    expect((revised.output as { newBlocking: unknown[] }).newBlocking).toHaveLength(0);
    expect((revised.output as { removedBlocking: Array<{ key: string }> }).removedBlocking[0]?.key).toContain("ontology-readiness/v1");
    expect(JSON.stringify(ctx.ontology)).toBe(beforeOntology);
    expect(ctx.ontologyReadiness).toBe(beforeReadiness);
    expect(ctx.ontologyReadiness!.blocking.map((i) => i.code)).toContain("action_input_binding_kind_missing");
    expect(emitted.some((event) => (event as { t?: string }).t === "ontology.heal")).toBe(false);
    // a patch that references a non-existent action is rejected, never invented
    const rejectedRun = await reviseOntology.execute({ inputs: [{ action: "ghostAction", field: "x", set: { binding_kind: "event" } }] }, ctx);
    expect(rejectedRun.ok).toBe(false);
    expect((rejectedRun.output as { rejected: unknown[] }).rejected).toHaveLength(1);
  });

  it("treats an equal primary-key patch as a keyed no-op, not an applied repair", async () => {
    const ctx = context(validOntology());
    await readOntology.execute({}, ctx);
    const beforeOntology = JSON.stringify(ctx.ontology);
    const beforeReadiness = ctx.ontologyReadiness;

    const result = await reviseOntology.execute({
      objects: [{ object: "Work", primary_key: "work_id" }],
    }, ctx);

    expect(result.ok).toBe(false);
    expect(result.output).toMatchObject({ committed: false, applied: [], candidateChanges: [] });
    const noops = (result.output as { noops: Array<{ key: string; target: string }> }).noops;
    expect(noops).toHaveLength(1);
    expect(noops[0]?.key).toContain("ontology-revision/v1");
    expect(noops[0]?.target).toBe("object Work.primary_key");
    expect(JSON.stringify(ctx.ontology)).toBe(beforeOntology);
    expect(ctx.ontologyReadiness).toBe(beforeReadiness);
  });

  it("rolls back a bad event binding that would add a new blocker", async () => {
    const ontology = validOntology();
    ontology.actions[0]!.inputs!.push({
      name: "result",
      type: "String",
      required: true,
      binding_kind: "object_lookup",
      source_object: "Work.result",
      lookup_args: { work_id: "input.work_id" },
      result_path: "result",
      integration_ref: "Vendor",
    });
    const ctx = context(ontology);
    const emitted: unknown[] = [];
    ctx.emit = (event) => { emitted.push(event); };
    await readOntology.execute({}, ctx);
    expect(ctx.ontologyReadiness?.ready).toBe(true);
    emitted.length = 0;
    const beforeOntology = JSON.stringify(ctx.ontology);
    const beforeReadiness = ctx.ontologyReadiness;

    const result = await reviseOntology.execute({
      inputs: [{ action: "doWork", field: "result", set: { binding_kind: "event" } }],
    }, ctx);

    expect(result.ok).toBe(false);
    expect(result.output).toMatchObject({ committed: false, applied: [] });
    expect((result.output as { newBlocking: Array<{ code: string; key: string }> }).newBlocking).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "action_required_input_unbound" })]),
    );
    expect((result.output as { newBlocking: Array<{ key: string }> }).newBlocking[0]?.key).toContain("ontology-readiness/v1");
    expect(JSON.stringify(ctx.ontology)).toBe(beforeOntology);
    expect(ctx.ontologyReadiness).toBe(beforeReadiness);
    expect(emitted.some((event) => (event as { t?: string }).t === "ontology.heal")).toBe(false);
  });

  it("checks every trigger event and rolls back when one trigger cannot supply the required input", async () => {
    const ontology = validOntology();
    ontology.events.push({
      name: "WORK_REQUESTED_ALTERNATE",
      payload: {
        source_action: null,
        event_data: [{ name: "tenant_id", type: "String", target_object: "Work" }],
        state_mutations: [],
      },
    });
    ontology.actions[0]!.trigger.push("WORK_REQUESTED_ALTERNATE");
    ontology.actions[0]!.inputs = [{ name: "work_id", type: "String", required: true }];
    const ctx = context(ontology);
    await readOntology.execute({}, ctx);
    const beforeOntology = JSON.stringify(ctx.ontology);
    const result = await reviseOntology.execute({
      inputs: [{ action: "doWork", field: "work_id", set: { binding_kind: "event", event_field: "work_id" } }],
    }, ctx);

    expect(result.ok).toBe(false);
    expect((result.output as { removedBlocking: unknown[] }).removedBlocking.length).toBeGreaterThan(0);
    expect((result.output as { newBlocking: Array<{ code: string; event?: string }> }).newBlocking).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "action_required_input_unbound", event: "WORK_REQUESTED_ALTERNATE" }),
      ]),
    );
    expect(JSON.stringify(ctx.ontology)).toBe(beforeOntology);
  });

  it("atomically rolls back mixed repairs when one good change removes blockers but another creates one", async () => {
    const ontology = validOntology();
    ontology.actions[0]!.inputs = [
      { name: "request_key", type: "String", required: true },
      {
        name: "result",
        type: "String",
        required: true,
        binding_kind: "object_lookup",
        source_object: "Work.result",
        lookup_args: { work_id: "input.request_key" },
        result_path: "result",
        integration_ref: "Vendor",
      },
    ];
    const ctx = context(ontology);
    const emitted: unknown[] = [];
    ctx.emit = (event) => { emitted.push(event); };
    await readOntology.execute({}, ctx);
    emitted.length = 0;
    const beforeOntology = JSON.stringify(ctx.ontology);
    const beforeReadiness = ctx.ontologyReadiness;

    const result = await reviseOntology.execute({
      inputs: [
        { action: "doWork", field: "request_key", set: { binding_kind: "event", event_field: "work_id" } },
        { action: "doWork", field: "result", set: { binding_kind: "event" } },
      ],
    }, ctx);

    expect(result.ok).toBe(false);
    expect((result.output as { candidateChanges: unknown[] }).candidateChanges.length).toBeGreaterThan(0);
    expect((result.output as { removedBlocking: unknown[] }).removedBlocking.length).toBeGreaterThan(0);
    expect((result.output as { newBlocking: unknown[] }).newBlocking.length).toBeGreaterThan(0);
    expect((result.output as { applied: unknown[] }).applied).toHaveLength(0);
    expect(JSON.stringify(ctx.ontology)).toBe(beforeOntology);
    expect(ctx.ontologyReadiness).toBe(beforeReadiness);
    expect(emitted.some((event) => (event as { t?: string }).t === "ontology.heal")).toBe(false);
  });

  it("rejects Event producer/consumer edits and rolls back otherwise valid mixed repairs", async () => {
    const ontology = validOntology();
    ontology.actions[0]!.inputs = [{ name: "work_id", type: "String", required: true }];
    const ctx = context(ontology);
    const emitted: unknown[] = [];
    ctx.emit = (event) => { emitted.push(event); };
    await readOntology.execute({}, ctx);
    emitted.length = 0;
    const beforeOntology = JSON.stringify(ctx.ontology);
    const beforeReadiness = ctx.ontologyReadiness;

    // Direct execute deliberately bypasses JSON-schema validation. The server
    // still must not let a model smuggle a business-route edit into the patch.
    const result = await reviseOntology.execute({
      inputs: [{ action: "doWork", field: "work_id", set: { binding_kind: "event", event_field: "work_id" } }],
      events: [{ event: "WORK_REQUESTED", add_consumers: ["doWork"] }],
    }, ctx);

    expect(result.ok).toBe(false);
    expect(result.output).toMatchObject({ committed: false, applied: [] });
    expect((result.output as { candidateChanges: unknown[] }).candidateChanges.length).toBeGreaterThan(0);
    expect((result.output as { rejected: Array<{ reason: string }> }).rejected[0]?.reason).toContain("ask_user");
    expect((result.output as { rejected: Array<{ reason: string }> }).rejected[0]?.reason).toContain("AllmetaOntology API");
    expect(JSON.stringify(ctx.ontology)).toBe(beforeOntology);
    expect(ctx.ontologyReadiness).toBe(beforeReadiness);
    expect(emitted.some((event) => (event as { t?: string }).t === "ontology.heal")).toBe(false);

    const reviseSchema = reviseOntology.parameters as {
      properties: { events: { items: { properties: Record<string, unknown> } } };
    };
    expect(reviseSchema.properties.events.items.properties).not.toHaveProperty("add_producers");
    expect(reviseSchema.properties.events.items.properties).not.toHaveProperty("add_consumers");
  });

  it("exposes foreach/emit to the model and rejects literal secrets in tool definitions", async () => {
    const schema = designAgent.parameters as { properties: { plan: { items: { properties: Record<string, unknown> } } } };
    const kinds = (schema.properties.plan.items.properties.kind as { enum: string[] }).enum;
    expect(kinds).toEqual(expect.arrayContaining(["foreach", "invoke", "emit"]));
    expect(schema.properties.plan.items.properties).toHaveProperty("body");
    expect(schema.properties.plan.items.properties).toHaveProperty("emitEvent");
    expect(schema.properties.plan.items.properties).toHaveProperty("errorPolicy");
    expect((schema.properties.plan.items.properties.body as { items: { $ref: string } }).items.$ref).toBe("#/$defs/planStep");
    const errorPolicy = schema.properties.plan.items.properties.errorPolicy as {
      items: { properties: { do: { enum: string[] }; suppressEmit: { type: string } } };
    };
    expect(errorPolicy.items.properties.do.enum).toEqual(expect.arrayContaining(["retry", "terminal", "continue"]));
    expect(errorPolicy.items.properties.suppressEmit.type).toBe("boolean");

    const ctx = context(validOntology());
    const unsafe = await createTool.execute({
      name: "vendor.secret",
      description: "bad",
      method: "GET",
      url_template: "https://api.example.com",
      side_effect: "read",
      headers: { authorization: "Bearer literal-secret" },
    }, ctx);
    expect(unsafe.ok).toBe(false);
    expect(unsafe.summary).toContain("字面值");
  });
});
