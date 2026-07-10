import { describe, it, expect } from "vitest";
import { armKey, recordOutcome, adjustPolicyWithStats } from "./policy-learning";
import type { ReasoningPolicy } from "./reasoning-policy";

const basePolicy = (over: Partial<ReasoningPolicy> = {}): ReasoningPolicy => ({
  pipeline: "full",
  deepUnderstand: false,
  deepCritique: false,
  tierBias: null,
  reasons: ["r0"],
  ...over,
});

describe("recordOutcome (#POLICY-LEARN)", () => {
  it("accumulates per (pipeline|band) arm, pure (input untouched)", () => {
    const s1 = recordOutcome(null, { pipeline: "full", band: "complex", ok: true, fidelityBad: false });
    const s2 = recordOutcome(s1, { pipeline: "full", band: "complex", ok: false, fidelityBad: true });
    expect(s1[armKey("full", "complex")]).toEqual({ n: 1, ok: 1, fidelityBad: 0 });
    expect(s2[armKey("full", "complex")]).toEqual({ n: 2, ok: 1, fidelityBad: 1 });
    // different band = different arm
    const s3 = recordOutcome(s2, { pipeline: "full", band: "simple", ok: true, fidelityBad: false });
    expect(Object.keys(s3)).toHaveLength(2);
  });
});

describe("adjustPolicyWithStats", () => {
  it("no stats / below MIN_N → unchanged", () => {
    const p = basePolicy();
    expect(adjustPolicyWithStats(p, null, "complex")).toBe(p);
    const few = recordOutcome(null, { pipeline: "full", band: "complex", ok: false, fidelityBad: true });
    expect(adjustPolicyWithStats(p, few, "complex")).toBe(p);
  });

  it("full arm with ≥50% fidelity violations (n≥3) → forces deepCritique with a recorded reason", () => {
    let s = null as ReturnType<typeof recordOutcome> | null;
    for (const bad of [true, true, false]) s = recordOutcome(s, { pipeline: "full", band: "complex", ok: true, fidelityBad: bad });
    const adjusted = adjustPolicyWithStats(basePolicy(), s, "complex");
    expect(adjusted.deepCritique).toBe(true);
    expect(adjusted.reasons.join()).toContain("保真违约");
    // already-deep policies are untouched (只加不减 idempotent)
    const already = basePolicy({ deepCritique: true });
    expect(adjustPolicyWithStats(already, s, "complex")).toBe(already);
  });

  it("analyze arm with <50% success on fast tier → withdraws the fast bias", () => {
    let s = null as ReturnType<typeof recordOutcome> | null;
    for (const ok of [false, false, true]) s = recordOutcome(s, { pipeline: "analyze", band: "simple", ok, fidelityBad: false });
    const adjusted = adjustPolicyWithStats(basePolicy({ pipeline: "analyze", tierBias: "fast" }), s, "simple");
    expect(adjusted.tierBias).toBeNull();
    expect(adjusted.reasons.join()).toContain("撤销降档");
  });
});
