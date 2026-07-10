import { describe, it, expect } from "vitest";
import { anchorDue, buildOntologyAnchor } from "./ontology-anchor";
import type { BrainCtx } from "./brain-types";

const ont = {
  domainId: "rec",
  actions: [
    { id: "a1", name: "processResume", actor: ["Agent"], trigger: [], triggered_event: [], target_objects: [], tool_use: [], system_prompt: "", user_prompt: "" },
    { id: "a2", name: "matchResume", actor: ["Agent"], trigger: [], triggered_event: [], target_objects: [], tool_use: [], system_prompt: "", user_prompt: "" },
    { id: "a3", name: "jdReview", actor: ["Human"], trigger: [], triggered_event: [], target_objects: [], tool_use: [], system_prompt: "", user_prompt: "" },
  ],
  events: [{ name: "E1" }, { name: "E2" }],
  rules: [{ id: "r1" }],
  objects: [],
  workflow: [],
  source: "snapshot",
} as unknown as BrainCtx["ontology"];

describe("anchorDue (#ANCHOR)", () => {
  it("fires on the beat, never on turn 0, disabled by everyN<=0", () => {
    expect(anchorDue(0, 8)).toBe(false);
    expect(anchorDue(8, 8)).toBe(true);
    expect(anchorDue(9, 8)).toBe(false);
    expect(anchorDue(16, 8)).toBe(true);
    expect(anchorDue(8, 0)).toBe(false);
  });
});

describe("buildOntologyAnchor", () => {
  it("null without an ontology (nothing to anchor)", () => {
    expect(buildOntologyAnchor({ ontology: null, ontologyUnderstanding: undefined, specs: [], policy: undefined } as unknown as BrainCtx, 8)).toBeNull();
  });

  it("states the facts + owed coverage + digested understanding + route", () => {
    const txt = buildOntologyAnchor(
      {
        ontology: ont,
        ontologyUnderstanding: "两个规则闸；RESUME_PROCESSED 是主链枢纽",
        specs: [{ actionName: "processResume" }] as BrainCtx["specs"],
        policy: { pipeline: "full", deepUnderstand: true, deepCritique: true, tierBias: null, reasons: [] },
      } as unknown as BrainCtx,
      8,
    )!;
    expect(txt).toContain("[本体锚点·第8轮]");
    expect(txt).toContain("2 个 Agent 动作"); // Human 动作不算欠
    expect(txt).toContain("还欠覆盖的动作(1)：matchResume");
    expect(txt).toContain("消化结论");
    expect(txt).toContain("RESUME_PROCESSED 是主链枢纽");
    expect(txt).toContain("推理路线：full");
  });

  it("when coverage is complete it says so instead of listing owed work", () => {
    const txt = buildOntologyAnchor(
      { ontology: ont, ontologyUnderstanding: "x", specs: [{ actionName: "processResume" }, { actionName: "matchResume" }] as BrainCtx["specs"], policy: undefined } as unknown as BrainCtx,
      16,
    )!;
    expect(txt).toContain("已全部有 spec 覆盖");
    expect(txt).not.toContain("还欠覆盖");
  });

  it("nudges to understand first when no digestion has happened yet", () => {
    const txt = buildOntologyAnchor({ ontology: ont, ontologyUnderstanding: undefined, specs: [], policy: undefined } as unknown as BrainCtx, 8)!;
    expect(txt).toContain("尚未做过 understand_ontology");
  });
});
