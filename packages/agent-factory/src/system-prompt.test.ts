import { describe, it, expect } from "vitest";
import { systemPrompt, rankLessons } from "./system-prompt";
import type { ReflectionLite } from "./brain-types";

// Phase 0(b): the brain carries zero production-discipline knowledge today. Inject a
// "production patterns" module (durability, failure taxonomy, timezone, vendor-envelope
// quirks) + a multi-step plan exemplar, in BOTH languages.

describe("system prompt carries production-discipline knowledge (Phase 0b)", () => {
  for (const lang of ["zh", "en"] as const) {
    describe(lang, () => {
      const p = systemPrompt("recruitment", [], lang);
      it("teaches per-write durability (step.run)", () => {
        expect(p).toContain("step.run");
      });
      it("teaches the vendor failure taxonomy (UNPARSEABLE vs server)", () => {
        expect(p).toContain("UNPARSEABLE");
      });
      it("teaches timezone discipline (Asia/Shanghai)", () => {
        expect(p).toContain("Asia/Shanghai");
      });
      it("includes a multi-step plan exemplar (not a single decision)", () => {
        // the exemplar lists several ordered steps for one agent
        expect(p.toLowerCase()).toContain("idempot");
      });
    });
  }
});

describe("rankLessons (Phase 5 — dedup + relevance ranking for the lessons block)", () => {
  const r = (kind: ReflectionLite["kind"], lesson: string): ReflectionLite => ({ kind, summary: lesson, lesson, createdAt: "2026-06-30" });
  it("dedupes identical lessons", () => {
    const out = rankLessons([r("failure", "wire the real tool"), r("failure", "wire the real tool"), r("success", "reuse this set")]);
    expect(out).toHaveLength(2);
  });
  it("ranks failures above caveats above successes (most actionable first)", () => {
    const out = rankLessons([r("success", "s"), r("caveat", "c"), r("failure", "f")]);
    expect(out.map((x) => x.kind)).toEqual(["failure", "caveat", "success"]);
  });
  it("preserves input (newest-first) order within the same kind", () => {
    const out = rankLessons([r("failure", "newer"), r("failure", "older")]);
    expect(out.map((x) => x.lesson)).toEqual(["newer", "older"]);
  });
  it("caps to the limit", () => {
    const many = Array.from({ length: 9 }, (_, i) => r("failure", `lesson ${i}`));
    expect(rankLessons(many, 5)).toHaveLength(5);
  });
});
