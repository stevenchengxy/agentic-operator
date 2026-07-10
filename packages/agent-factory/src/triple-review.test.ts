import { describe, it, expect } from "vitest";
import { FACTORY_TOOLS } from "./tools";
import type { BrainCtx } from "./brain-types";

// #REVIEW — the generation-time triple-lens review: review_context (透镜②, does each agent read+fit
// its context) + review_completeness (透镜③, metacognition — did we think of everything). Both have a
// deterministic tier that works WITHOUT a gateway; these tests exercise that tier.

const reviewContext = FACTORY_TOOLS.find((t) => t.name === "review_context")!;
const reviewCompleteness = FACTORY_TOOLS.find((t) => t.name === "review_completeness")!;

const ONT = {
  actions: [
    { name: "CreateJD", actor: ["Agent"], trigger: ["JD_REQUESTED"], triggered_event: ["JD_CREATED"] },
    { name: "MatchResume", actor: ["Agent"], trigger: ["RESUME_PROCESSED"], triggered_event: ["MATCH_PASSED", "MATCH_FAILED"] },
  ],
  events: [],
  objects: [],
  rules: [],
};

const mk = (specs: unknown[], ont: unknown = ONT): BrainCtx =>
  ({ specs, ontology: ont, domain: "rec", emit: () => {} }) as unknown as BrainCtx;

const spec = (p: Record<string, unknown>) => ({ tools: [], systemPrompt: "做这件事。", trigger: [], emit: [], ...p });

describe("review_context (透镜② · deterministic tier)", () => {
  it("passes when every agent's trigger/emit events exist in the ontology", async () => {
    const ctx = mk([spec({ actionName: "CreateJD", nameZh: "建JD", trigger: ["JD_REQUESTED"], emit: ["JD_CREATED"], tools: ["x"] })]);
    const r = await reviewContext.execute({}, ctx);
    expect(r.ok).toBe(true);
    expect((r.output as { judge: string[] }).judge).toEqual([]);
  });

  it("flags an agent whose trigger event does NOT exist in the ontology (张冠李戴)", async () => {
    const ctx = mk([spec({ actionName: "CreateJD", nameZh: "建JD", trigger: ["TYPO_EVENT"], emit: ["JD_CREATED"], tools: ["x"] })]);
    const r = await reviewContext.execute({}, ctx);
    expect(r.ok).toBe(false);
    expect((r.output as { deterministic: string[] }).deterministic.some((f) => f.includes("TYPO_EVENT") && f.includes("不存在"))).toBe(true);
  });
});

describe("review_completeness (透镜③ · metacognition deterministic tier)", () => {
  it("flags an uncovered Agent action (思考没想全)", async () => {
    // ontology has CreateJD + MatchResume Agent actions; only CreateJD designed → MatchResume uncovered.
    const ctx = mk([spec({ actionName: "CreateJD", nameZh: "建JD", trigger: ["JD_REQUESTED"], emit: ["JD_CREATED"], tools: ["x"] })]);
    const r = await reviewCompleteness.execute({}, ctx);
    expect(r.ok).toBe(false);
    expect((r.output as { deterministic: string[] }).deterministic.some((g) => g.includes("MatchResume"))).toBe(true);
  });

  it("flags a multi-branch emit that has no condition step (多结果未分流)", async () => {
    const ctx = mk([
      spec({ actionName: "CreateJD", nameZh: "建JD", trigger: ["JD_REQUESTED"], emit: ["JD_CREATED"], tools: ["x"] }),
      spec({ actionName: "MatchResume", nameZh: "匹配", trigger: ["RESUME_PROCESSED"], emit: ["MATCH_PASSED", "MATCH_FAILED"], tools: ["m"] }),
    ]);
    const r = await reviewCompleteness.execute({}, ctx);
    expect((r.output as { deterministic: string[] }).deterministic.some((g) => g.includes("未分流"))).toBe(true);
  });

  it("passes when all actions covered + multi-branch has a condition step", async () => {
    const ctx = mk([
      spec({ actionName: "CreateJD", nameZh: "建JD", trigger: ["JD_REQUESTED"], emit: ["JD_CREATED"], tools: ["x"] }),
      spec({ actionName: "MatchResume", nameZh: "匹配", trigger: ["RESUME_PROCESSED"], emit: ["MATCH_PASSED", "MATCH_FAILED"], tools: ["m"], plan: [{ stepId: "gate", kind: "condition", condition: "lastResult.score > 50" }] }),
    ]);
    const r = await reviewCompleteness.execute({}, ctx);
    expect(r.ok).toBe(true);
  });
});
