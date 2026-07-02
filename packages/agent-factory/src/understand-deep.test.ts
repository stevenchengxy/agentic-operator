import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { BrainCtx, BrainEvent } from "./brain-types";
import type { DomainOntology } from "./ontology-types";

// understand_ontology v2 — the DEEP fan-out path (four dimension specialists, 架构书 §4.5).
// The specialists module is mocked so no provider calls happen; we assert the ORCHESTRATION:
// threshold triggering, understanding landing in ctx.ontologyUnderstanding (fold survivor),
// ambiguity aggregation, and the honest degrade when specialists mostly fail.

vi.mock("./specialists", async (importOriginal) => {
  const real = await importOriginal<typeof import("./specialists")>();
  return {
    ...real,
    runSpecialists: vi.fn(),
    synthesizeUnderstanding: vi.fn(),
  };
});

import { FACTORY_TOOLS } from "./tools";
import { runSpecialists, synthesizeUnderstanding } from "./specialists";

const understand = FACTORY_TOOLS.find((t) => t.name === "understand_ontology")!;

function bigOntology(): DomainOntology {
  const rules = Array.from({ length: 80 }, (_, i) => ({ id: `r-${i}`, businessLogicRuleName: `规则${i}`, standardizedLogicRule: `逻辑${i}` }));
  return {
    domainId: "rec",
    objects: [{ id: "Candidate", name: "候选人" }] as DomainOntology["objects"],
    rules: rules as DomainOntology["rules"],
    actions: [
      { id: "a", name: "processResume", actor: ["Agent"], trigger: ["RESUME_DOWNLOADED"], triggered_event: ["RESUME_PROCESSED"], target_objects: [], tool_use: [], system_prompt: "", user_prompt: "" },
    ] as DomainOntology["actions"],
    events: [{ name: "RESUME_PROCESSED", payload: { source_action: "processResume", event_data: [], state_mutations: [] } }] as DomainOntology["events"],
    workflow: [],
    source: "snapshot",
  } as DomainOntology;
}

function ctxWith(ontology: DomainOntology): { ctx: BrainCtx; events: BrainEvent[] } {
  const events: BrainEvent[] = [];
  const ctx = {
    domain: "rec",
    ontology,
    specs: [],
    emit: (e: BrainEvent) => events.push(e),
    toolCatalog: [],
    realTools: [],
    createdSkills: [],
    rulesByAction: {},
    attemptHistory: {},
    humanDirectives: [],
  } as unknown as BrainCtx;
  return { ctx, events };
}

const OK4 = ["objects", "rules", "actions", "events"].map((id) => ({
  id, role: `${id} 专家`, ok: true,
  output: { keyFindings: ["f"], risks: [], ambiguities: id === "rules" ? ["规则9-15未列出"] : [] },
  summary: `${id} 专家：1 项发现`,
}));

beforeEach(() => {
  process.env.CUSTOM_LLM_API_KEY = "test-key"; // make isGatewayConfigured() true → deep path reachable
  vi.mocked(runSpecialists).mockReset();
  vi.mocked(synthesizeUnderstanding).mockReset();
});
afterEach(() => {
  delete process.env.CUSTOM_LLM_API_KEY;
});

describe("understand_ontology v2 — deep fan-out", () => {
  it("large ontology triggers the four-specialist fan-out and lands the synthesis in ctx", async () => {
    vi.mocked(runSpecialists).mockResolvedValue(OK4 as never);
    vi.mocked(synthesizeUnderstanding).mockResolvedValue("整体理解：1 个 agent；主链 RESUME_DOWNLOADED→RESUME_PROCESSED；规则闸=身份去重。");
    const { ctx, events } = ctxWith(bigOntology());
    const r = await understand.execute({}, ctx);
    expect(r.ok).toBe(true);
    expect((r.output as { mode: string }).mode).toBe("deep");
    expect(ctx.ontologyUnderstanding).toContain("整体理解");
    expect(r.summary).toContain("四维分治");
    expect(r.summary).toContain("歧义"); // aggregated from the rules specialist
    expect(events.some((e) => e.t === "message" && String((e as { text: string }).text).includes("认知专家"))).toBe(true);
    expect(vi.mocked(runSpecialists)).toHaveBeenCalledTimes(1);
  });

  it("explicit deep=true forces the fan-out even on a small ontology", async () => {
    vi.mocked(runSpecialists).mockResolvedValue(OK4 as never);
    vi.mocked(synthesizeUnderstanding).mockResolvedValue("理解OK");
    const small = bigOntology();
    small.rules = small.rules.slice(0, 3);
    const { ctx } = ctxWith(small);
    const r = await understand.execute({ deep: true }, ctx);
    expect((r.output as { mode: string }).mode).toBe("deep");
  });

  it("specialists mostly failing degrades HONESTLY to the single-shot/skeleton path", async () => {
    vi.mocked(runSpecialists).mockResolvedValue(OK4.map((r) => ({ ...r, ok: false })) as never);
    const { ctx, events } = ctxWith(bigOntology());
    const r = await understand.execute({}, ctx);
    // v1 single-shot then runs against the fake key → chatJson fails → deterministic skeleton.
    expect(r.ok).toBe(true);
    expect(r.summary).toContain("骨架");
    expect(events.some((e) => e.t === "reflect" && String((e as { lesson: string }).lesson).includes("降级"))).toBe(true);
  });
});
