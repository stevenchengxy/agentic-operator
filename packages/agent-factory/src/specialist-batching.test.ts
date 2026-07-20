import { describe, expect, it } from "vitest";
import { packDimensionBatches, SPECIALIST_BATCH_CHARS } from "./specialists";

// #FULL-DIMENSION — the measured defect this fixes: the live Agents-generation ontology fed each
// "四维分治" expert a capJson-truncated slice (actions 16 items → ~2 visible / 71.6% dropped, rules
// 66 → ~25, objects 49 → ~11), SILENTLY. Packing must guarantee: every item is analyzed exactly
// once, no item is ever split, and any lossy path is reported rather than hidden.

const itemOf = (size: number, id: string) => ({ id, body: "x".repeat(size) });

describe("packDimensionBatches — every item analyzed exactly once", () => {
  it("keeps a small dimension in ONE batch (no behaviour change for tiny ontologies)", () => {
    const items = [itemOf(10, "a"), itemOf(10, "b")];
    const out = packDimensionBatches(items, 10_000);
    expect(out.batches).toHaveLength(1);
    expect(out.batches[0]).toHaveLength(2);
    expect(out.oversized).toBe(0);
    expect(out.itemsTotal).toBe(2);
  });

  it("splits a dimension that exceeds the budget WITHOUT dropping or duplicating any item", () => {
    const items = Array.from({ length: 20 }, (_, i) => itemOf(500, `r${i}`));
    const out = packDimensionBatches(items, 2_000);
    expect(out.batches.length).toBeGreaterThan(1);
    const flat = out.batches.flat() as Array<{ id: string }>;
    expect(flat).toHaveLength(20); // nothing dropped
    expect(new Set(flat.map((i) => i.id)).size).toBe(20); // nothing duplicated
    expect(flat.map((i) => i.id)).toEqual(items.map((i) => i.id)); // order preserved
  });

  it("never splits a single item across batches", () => {
    const items = [itemOf(900, "a"), itemOf(900, "b"), itemOf(900, "c")];
    const out = packDimensionBatches(items, 1_500);
    for (const batch of out.batches) expect(batch.length).toBeGreaterThanOrEqual(1);
    expect(out.batches.flat()).toHaveLength(3);
  });

  it("an item larger than the whole budget gets its OWN batch and is counted as oversized (never silent)", () => {
    const items = [itemOf(50, "small"), itemOf(9_000, "huge")];
    const out = packDimensionBatches(items, 1_000);
    expect(out.oversized).toBe(1);
    expect(out.batches.flat()).toHaveLength(2); // still analyzed, just alone in its batch
  });

  it("handles an empty dimension", () => {
    const out = packDimensionBatches([], 1_000);
    expect(out.batches).toHaveLength(0);
    expect(out.itemsTotal).toBe(0);
  });

  it("the default batch budget is large enough that each live dimension needs only a few batches", () => {
    // live measured: rules full JSON ≈ 159838 chars → must be a handful of batches, not 20.
    const items = Array.from({ length: 66 }, (_, i) => itemOf(2_400, `rule${i}`));
    const out = packDimensionBatches(items, SPECIALIST_BATCH_CHARS);
    expect(out.batches.flat()).toHaveLength(66);
    expect(out.batches.length).toBeLessThanOrEqual(4);
  });
});

// ── batch resilience (#FULL-DIMENSION) — caught by the adversarial audit: batching multiplies the
// number of calls, so `Promise.all` made ONE flaky batch discard every sibling batch's work and
// fail the whole dimension. Surviving batches must still yield an analysis, and the lost items must
// be SUBTRACTED from reported coverage rather than counted as analyzed.
import { runSpecialists, buildOntologySpecialistTasks } from "./specialists";
import type { DomainOntology } from "./ontology-types";

const bigOnt = (rules: number): DomainOntology => ({
  domainId: "d", source: "allmeta", workflow: [], objects: [], events: [], actions: [],
  rules: Array.from({ length: rules }, (_, i) => ({ id: `r${i}`, name: `rule${i}`, description: "y".repeat(3_000) })),
} as unknown as DomainOntology);

describe("runSpecialists batch resilience", () => {
  const emit = () => {};

  it("a single failing batch does NOT discard its siblings; coverage reports only what was analyzed", async () => {
    const ont = bigOnt(80); // ≈240k chars of rules → multiple batches
    const task = buildOntologySpecialistTasks(ont).find((t) => t.id === "rules")!;
    expect(task.coverage!.batches).toBeGreaterThan(1); // precondition: really batched
    let call = 0;
    const llm = async () => {
      call += 1;
      if (call === 1) throw new Error("provider 502 on batch 1");
      return JSON.stringify({ keyFindings: ["f"], risks: [], ambiguities: [], crossDimensionNotes: [] });
    };
    const [res] = await runSpecialists({ emit }, [task], { llm });
    expect(res!.ok).toBe(true); // survived — did NOT lose the whole dimension
    expect(res!.coverage!.batchesFailed).toBe(1);
    expect(res!.coverage!.itemsAnalyzed).toBeLessThan(res!.coverage!.itemsTotal); // honest, not rounded up
    expect(res!.summary).toContain("批失败");
  });

  it("only when EVERY batch fails does the dimension report failure", async () => {
    const task = buildOntologySpecialistTasks(bigOnt(80)).find((t) => t.id === "rules")!;
    const llm = async () => { throw new Error("gateway down"); };
    const [res] = await runSpecialists({ emit }, [task], { llm });
    expect(res!.ok).toBe(false);
  });

  it("a fully successful batched dimension reports complete coverage", async () => {
    const task = buildOntologySpecialistTasks(bigOnt(80)).find((t) => t.id === "rules")!;
    const llm = async () => JSON.stringify({ keyFindings: ["f"], risks: [], ambiguities: [], crossDimensionNotes: [] });
    const [res] = await runSpecialists({ emit }, [task], { llm });
    expect(res!.ok).toBe(true);
    expect(res!.coverage!.batchesFailed).toBe(0);
    expect(res!.coverage!.itemsAnalyzed).toBe(80);
    expect(res!.summary).toContain("80 项全量");
  });
});

// #RULE-ENFORCEMENT — measured on the live Agents-generation ontology: `enforcement` 0/66,
// `severity` 0/66, `enforcementLevel` 54/66. The roster only read the first two, so the tag never
// rendered for ANY rule — while the deepen/merge pass is told 「别放过任何强制规则」. The expert had
// no way to tell mandatory from advisory.
import { ruleEnforcementTag } from "./specialists";

describe("ruleEnforcementTag", () => {
  it("renders the live Allmeta spelling `enforcementLevel` (the one that was being ignored)", () => {
    expect(ruleEnforcementTag({ name: "R", enforcementLevel: "MANDATORY" })).toBe("[MANDATORY]");
  });

  it("still honours the legacy spellings, preferring the most explicit", () => {
    expect(ruleEnforcementTag({ enforcement: "强制" })).toBe("[强制]");
    expect(ruleEnforcementTag({ severity: "high" })).toBe("[high]");
    expect(ruleEnforcementTag({ enforcement_level: "advisory" })).toBe("[advisory]");
  });

  it("stays silent only when the rule truly declares no level (never invents one)", () => {
    expect(ruleEnforcementTag({ name: "R" })).toBe("");
    expect(ruleEnforcementTag({ enforcementLevel: "   " })).toBe("");
  });
});
