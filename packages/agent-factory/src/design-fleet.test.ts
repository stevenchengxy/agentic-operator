import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TurnEvent } from "./stream-gateway";

// #DESIGN-FLEET — fleet members are REAL runBrain sub-brains driven through the mocked streamTurn;
// each ends its (single scripted) turn with a complete design_agent proposal JSON. Landing then goes
// through the REAL design_agent with its full gate suite — nothing about the gates is mocked.
const scriptedTurns: TurnEvent[][] = [];
vi.mock("./stream-gateway", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./stream-gateway")>();
  return {
    ...actual,
    isGatewayConfigured: () => false,
    setLlmCallContext: () => undefined,
    streamTurn: async function* () {
      const events = scriptedTurns.shift() ?? [{ t: "done" as const, content: "{}" }];
      for (const event of events) yield event;
    },
  };
});

import { FACTORY_TOOLS } from "./tools";
import { __designFleetToolForTest as designFleet } from "./conductor";
import type { BrainCtx, BrainEvent } from "./brain-types";
import type { DomainOntology, OntologyAction, OntologyEvent } from "./ontology-types";

const readOntology = FACTORY_TOOLS.find((t) => t.name === "read_ontology")!;

/** doWork-shaped action + its request/done events, cloned per name so each is a clean slice. */
function actionTriplet(n: { action: string; req: string; done: string }): { action: OntologyAction; events: OntologyEvent[] } {
  return {
    action: {
      id: n.action, name: n.action, actor: ["Agent"], trigger: [n.req], triggered_event: [n.done], target_objects: ["Work"],
      tool_use: [], system_prompt: "", user_prompt: "",
      inputs: [{ name: "work_id", type: "String", required: true, binding_kind: "event", event_field: "work_id", source_object: "Work.work_id" }],
      outputs: [{ name: "result", type: "String" }],
      action_steps: [{ id: "fetch", name: "fetch", type: "tool" }],
      integration: { systems: [{ name: "Vendor", kind: "external_api", role: "reads", capability: "GET /lookup", objects: ["Work"] }] },
    } as unknown as OntologyAction,
    events: [
      { name: n.req, payload: { source_action: null, event_data: [{ name: "work_id", type: "String", target_object: "Work" }], state_mutations: [] } },
      { name: n.done, payload: { source_action: n.action, event_data: [{ name: "result", type: "String", target_object: "Work" }], state_mutations: [{ target_object: "Work", mutation_type: "MODIFY", impacted_properties: ["result"] }] } },
    ] as OntologyEvent[],
  };
}

function ontology(): DomainOntology {
  const a = actionTriplet({ action: "doWork", req: "WORK_REQUESTED", done: "WORK_DONE" });
  const b = actionTriplet({ action: "doSecondWork", req: "SECOND_REQUESTED", done: "SECOND_DONE" });
  const c = actionTriplet({ action: "doThirdWork", req: "THIRD_REQUESTED", done: "THIRD_DONE" });
  return {
    domainId: "test", source: "allmeta", workflow: [{ id: "flow" }], rules: [],
    objects: [{ id: "Work", name: "Work", primary_key: "work_id", properties: [{ name: "work_id", type: "String" }, { name: "result", type: "String" }] }],
    actions: [a.action, b.action, c.action],
    events: [...a.events, ...b.events, ...c.events],
  } as unknown as DomainOntology;
}

function context(ont: DomainOntology): BrainCtx & { __events: BrainEvent[] } {
  const events: BrainEvent[] = [];
  return {
    domain: "test", goal: "build", emit: (e: BrainEvent) => events.push(e), specs: [], ontology: null,
    currentPlan: { summary: "s", agents: [], notes: [], version: 1 },
    toolCatalog: [], realTools: [], attemptHistory: {}, createdSkills: [], research: [], priorReflections: [], humanDirectives: [],
    lastSandbox: null, lastValidation: null,
    budget: { maxTokens: null, maxTurns: 20 }, spent: { tokens: 0, turns: 0, sandboxRuns: 0 },
    budgetLedger: { tokens: 0, spawns: 0, maxTokens: null, maxSpawns: 50 },
    ports: {
      ontology: { fetchOntology: async () => ont, listDomains: async () => [], fetchActionRules: async () => [] },
      tools: { list: async () => [{ name: "vendor.lookup", description: "lookup", method: "GET", urlTemplate: "https://api.example.com/{work_id}", sideEffect: "read", operation: "read", effectScope: "external", sandboxPolicy: "live_external", domain: "test", capabilities: [{ systems: ["Vendor"], kinds: ["external_api"], roles: ["reads"], operations: ["lookup"], objectTypes: ["Work"] }], probeStatus: "verified" }], save: async () => {} },
      toolRegistry: { list: async () => [] },
      skills: { list: async () => [], save: async () => {}, bumpUse: async () => {}, recordEval: async () => {} },
      reflection: { list: async () => [], record: async () => undefined },
      sandbox: { deployAndObserve: async () => { throw new Error("not used"); }, teardown: async () => undefined },
      conversation: { has: async () => false, load: async () => null, save: async () => undefined, drainHumanMessages: async () => [] },
    },
    __events: events,
  } as unknown as BrainCtx & { __events: BrainEvent[] };
}

const proposal = (extra: Record<string, unknown> = {}) => JSON.stringify({
  system_prompt: "你负责按契约读取真实 Vendor 数据，只输出本体声明字段，失败按错误策略处理。",
  decision_logic: "读取成功 emit 完成事件；失败按错误策略终止。",
  tools: ["vendor.lookup"],
  plan: [{ stepId: "fetch", kind: "tool", tool: "vendor.lookup", idempotencyKeyFrom: "work_id", onError: "terminal" }],
  role_name: "数据读取员",
  ...extra,
});

describe("design_fleet — parallel design proposals, serial gated landing", () => {
  beforeEach(() => {
    vi.stubEnv("FACTORY_AI_MODEL", "test/fleet-model");
    vi.stubEnv("FACTORY_GROUP_CONCURRENCY", "1"); // deterministic member→scripted-turn pairing
    scriptedTurns.splice(0);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("designs 2 actions in parallel and lands BOTH through the real design_agent gates", async () => {
    const ctx = context(ontology());
    await readOntology.execute({}, ctx);
    scriptedTurns.push(
      [{ t: "done", content: proposal() }],
      [{ t: "done", content: proposal() }],
    );

    const res = await designFleet.execute({ reasoning: "两个动作可并行", actions: ["doWork", "doSecondWork"] }, ctx);

    expect(res.ok).toBe(true);
    const out = res.output as { landed: string[]; rejected: unknown[]; needsUser: unknown[] };
    expect(out.landed).toEqual(["doWork", "doSecondWork"]);
    expect(out.rejected).toEqual([]);
    expect(out.needsUser).toEqual([]);
    // specs REALLY landed (design_agent's gates ran — real code rendered, tools bound)
    const specs = ctx.specs.filter((s) => !s.isSubAgent);
    expect(specs.map((s) => s.actionName).sort()).toEqual(["doSecondWork", "doWork"]);
    expect(specs.every((s) => s.tools.includes("vendor.lookup"))).toBe(true);
    // group tree events emitted with the design mode
    const events = (ctx as unknown as { __events: BrainEvent[] }).__events;
    const start = events.find((e): e is Extract<BrainEvent, { t: "group.start" }> => e.t === "group.start");
    expect(start?.mode).toBe("design");
    const done = events.find((e): e is Extract<BrainEvent, { t: "group.done" }> => e.t === "group.done");
    expect(done).toMatchObject({ ok: 2, total: 2 });
    // budget charged for the fleet
    expect(ctx.budgetLedger!.spawns).toBe(2);
  });

  it("auto-selects a unique exact integration candidate for a fleet member", async () => {
    const ctx = context(ontology());
    await readOntology.execute({}, ctx);
    scriptedTurns.push(
      [{ t: "done", content: proposal() }],
      // second member leaves tools EMPTY → the single exact capability match is deterministic
      [{ t: "done", content: proposal({ tools: [] }) }],
    );

    const res = await designFleet.execute({ reasoning: "并行", actions: ["doWork", "doSecondWork"] }, ctx);

    expect(res.ok).toBe(true);
    const out = res.output as { landed: string[]; needsUser: Array<{ action: string; question: string }>; next?: string; reason?: string; question?: string };
    expect(out.landed).toEqual(["doWork", "doSecondWork"]);
    expect(out.needsUser).toEqual([]);
    expect(out.next).toBeUndefined();
    expect(ctx.specs.filter((s) => !s.isSubAgent)).toHaveLength(2);
  });

  it("rejects a member whose conclusion has no parseable proposal — with the reason, without blocking the rest", async () => {
    const ctx = context(ontology());
    await readOntology.execute({}, ctx);
    scriptedTurns.push(
      [{ t: "done", content: "我研究了一下，这个动作挺复杂的。" }], // no JSON
      [{ t: "done", content: proposal() }],
    );

    const res = await designFleet.execute({ reasoning: "并行", actions: ["doWork", "doSecondWork"] }, ctx);

    expect(res.ok).toBe(true);
    const out = res.output as { landed: string[]; rejected: Array<{ action: string; reason: string }> };
    expect(out.landed).toEqual(["doSecondWork"]);
    expect(out.rejected[0]).toMatchObject({ action: "doWork" });
    expect(out.rejected[0]!.reason).toContain("JSON");
  });

  it("guards: skips already-designed actions, refuses unknown actions and sub-brain callers", async () => {
    const ctx = context(ontology());
    await readOntology.execute({}, ctx);

    const unknown = await designFleet.execute({ reasoning: "x", actions: ["ghostAction", "doWork"] }, ctx);
    expect(unknown.ok).toBe(false);
    expect(unknown.summary).toContain("ghostAction");

    // land doWork first, then a fleet over [doWork, doSecondWork] must skip doWork
    scriptedTurns.push([{ t: "done", content: proposal() }]);
    const first = await designFleet.execute({ reasoning: "x", actions: ["doWork", "doWork"] }, ctx);
    expect(first.ok).toBe(true);
    scriptedTurns.push([{ t: "done", content: proposal() }]);
    const second = await designFleet.execute({ reasoning: "x", actions: ["doWork", "doSecondWork"] }, ctx);
    expect(second.ok).toBe(true);
    const out = second.output as { landed: string[]; skipped: string[] };
    expect(out.skipped).toEqual(["doWork"]);
    expect(out.landed).toEqual(["doSecondWork"]);

    ctx.subagentDepth = 1;
    const nested = await designFleet.execute({ reasoning: "x", actions: ["doThirdWork", "doSecondWork"] }, ctx);
    expect(nested.ok).toBe(false);
    expect(nested.summary).toContain("子脑内不能用 design_fleet");
  });
});
