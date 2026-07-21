import { describe, it, expect } from "vitest";
import { translate } from "@/lib/i18n";
import { derivePhaseTimeline } from "./phase-timeline";
import type { BrainEvent } from "@/lib/hooks/useBrainStream";

const ev = (o: Record<string, unknown>): BrainEvent => o as unknown as BrainEvent;
const t = (key: string, vars?: Record<string, string | number>) => translate("zh", key, vars);

// #OBSERVABILITY — lock the Workflow→Phase→Agent projection: phases from stage events, REAL rolled-up
// tokens (budget delta) / tools (tool.call count) / time (server ts), sub-agents per phase with real
// start→done durations. Pure over BrainEvent[] (replay-safe).

describe("derivePhaseTimeline (#OBSERVABILITY)", () => {
  it("does not paint a waiting-human suspension as an execution error", () => {
    const timeline = derivePhaseTimeline(t, [
      ev({ t: "stage", stage: "validate", status: "active", ts: 100 }),
      ev({ t: "done", status: "waiting_human", completionKind: "incomplete", ts: 200 }),
    ]);
    expect(timeline.phases.find((phase) => phase.stage === "validate")?.status).toBe("active");
  });

  it("groups by stage; per-phase tokens=budget delta, tools=count, time=ts span", () => {
    const tl = derivePhaseTimeline(t, [
      ev({ t: "budget", tokens: 100, ts: 1000 }),
      ev({ t: "stage", stage: "read", status: "active", ts: 1000 }),
      ev({ t: "tool.call", id: "a", name: "read_ontology", ts: 1100 }),
      ev({ t: "budget", tokens: 400, ts: 1500 }), // +300 in read
      ev({ t: "stage", stage: "read", status: "ok", ts: 1600 }),
      ev({ t: "stage", stage: "design", status: "active", ts: 1600 }),
      ev({ t: "tool.call", id: "b", name: "design_agent", ts: 1700 }),
      ev({ t: "tool.call", id: "c", name: "codegen_agent", ts: 1900 }),
      ev({ t: "budget", tokens: 900, ts: 2000 }), // +500 in design
      ev({ t: "stage", stage: "design", status: "ok", ts: 2000 }),
    ]);
    const read = tl.phases.find((p) => p.stage === "read")!;
    const design = tl.phases.find((p) => p.stage === "design")!;
    expect(read.label).toBe("读业务");
    expect(read.tools).toBe(1);
    expect(read.tokens).toBe(300); // 400-100
    expect(read.durationMs).toBe(600); // 1600-1000
    expect(read.status).toBe("ok");
    expect(design.tools).toBe(2);
    expect(design.tokens).toBe(500); // 900-400
  });

  it("attaches sub-agents to their phase with REAL start→done durations", () => {
    const tl = derivePhaseTimeline(t, [
      ev({ t: "stage", stage: "read", status: "active", ts: 1000 }),
      ev({ t: "subagent.start", role: "objects 专家", task: "读对象", ts: 1000 }),
      ev({ t: "subagent.start", role: "rules 专家", task: "读规则", ts: 1000 }),
      ev({ t: "subagent.done", summary: "6 发现", ts: 3000 }), // closes rules (last opened)
      ev({ t: "subagent.done", summary: "3 发现", ts: 3500 }), // closes objects
    ]);
    const read = tl.phases.find((p) => p.stage === "read")!;
    expect(read.agents).toHaveLength(2);
    expect(read.agents.map((a) => a.name).sort()).toEqual(["objects 专家", "rules 专家"]);
    expect(read.agents.every((a) => a.status === "ok")).toBe(true);
    expect(read.agents.every((a) => (a.durationMs ?? 0) > 0)).toBe(true);
  });

  it("events before the first stage land in an intake phase", () => {
    const tl = derivePhaseTimeline(t, [
      ev({ t: "policy", pipeline: "full", strategy: "react", ts: 1000 }),
      ev({ t: "tool.call", id: "x", name: "read_ontology", ts: 1100 }),
    ]);
    expect(tl.phases[0]!.stage).toBe("intake");
    expect(tl.phases[0]!.tools).toBe(1);
  });

  it("totals roll up across phases; deterministic (same events → same output)", () => {
    const events = [
      ev({ t: "stage", stage: "read", status: "active", ts: 0 }),
      ev({ t: "budget", tokens: 200, ts: 100 }),
      ev({ t: "tool.call", id: "a", name: "x", ts: 100 }),
      ev({ t: "stage", stage: "sandbox", status: "active", ts: 200 }),
      ev({ t: "tool.call", id: "b", name: "sandbox_run", ts: 300 }),
      ev({ t: "budget", tokens: 800, ts: 400 }),
    ];
    const a = derivePhaseTimeline(t, events);
    const b = derivePhaseTimeline(t, events);
    expect(a).toEqual(b);
    expect(a.totalTools).toBe(2);
    expect(a.totalTokens).toBeGreaterThanOrEqual(600);
  });

  it("no ts (older/replayed w/o stamp) → durations 0, still groups", () => {
    const tl = derivePhaseTimeline(t, [
      ev({ t: "stage", stage: "design", status: "active" }),
      ev({ t: "tool.call", id: "a", name: "design_agent" }),
    ]);
    const design = tl.phases.find((p) => p.stage === "design")!;
    expect(design.tools).toBe(1);
    expect(design.durationMs).toBe(0);
  });

  it("projects answer completion as its own successful phase, never as delivery", () => {
    const tl = derivePhaseTimeline(t, [
      ev({ t: "message", text: "answer", ts: 1000 }),
      ev({ t: "done", status: "incomplete", completionKind: "answer", ts: 1100 }),
    ]);
    expect(tl.phases.at(-1)).toMatchObject({ stage: "answer", label: "回答", status: "ok" });
    expect(tl.phases.some((phase) => phase.stage === "deliver")).toBe(false);
  });

  it("keeps old terminal frames without completionKind unknown", () => {
    const tl = derivePhaseTimeline(t, [
      ev({ t: "done", status: "finished", ts: 1000 }),
    ]);
    expect(tl.phases.at(-1)).toMatchObject({
      stage: "completion_unknown",
      label: "结束（类型未知）",
      status: "error",
    });
  });
});
