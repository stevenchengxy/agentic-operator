import { describe, expect, it } from "vitest";
import {
  COL_W,
  NODE_H,
  NODE_W,
  PAD_X,
  PAD_Y,
  ROW_H,
  colorVar,
  topoLayout,
} from "./layout";

describe("workflows/live DAG layout", () => {
  it("keeps canvas geometry stable", () => {
    expect({ NODE_W, NODE_H, COL_W, ROW_H, PAD_X, PAD_Y }).toEqual({
      NODE_W: 184,
      NODE_H: 64,
      COL_W: 220,
      ROW_H: 90,
      PAD_X: 30,
      PAD_Y: 30,
    });
  });

  it("derives downstream columns from actual event edges", () => {
    const result = topoLayout([
      {
        id: "invite",
        triggers: ["MATCH_COMPLETED"],
        emits: ["INVITE_GENERATED"],
      },
      {
        id: "match",
        triggers: ["MATCH_REQUESTED"],
        emits: ["MATCH_COMPLETED"],
      },
    ]);
    expect(result.match).toEqual({ stage: 0, lane: 0 });
    expect(result.invite).toEqual({ stage: 1, lane: 0 });
  });

  it("is deterministic and assigns lanes without tenant-specific ids", () => {
    const input = [
      { id: "gamma", triggers: [], emits: [] },
      { id: "alpha", triggers: [], emits: [] },
      { id: "beta", triggers: [], emits: [] },
    ];
    expect(topoLayout(input)).toEqual(topoLayout([...input].reverse()));
    expect(topoLayout(input)).toEqual({
      alpha: { stage: 0, lane: 0 },
      beta: { stage: 0, lane: 1 },
      gamma: { stage: 0, lane: 2 },
    });
  });

  it("breaks cycles without hanging", () => {
    const result = topoLayout([
      { id: "a", triggers: ["FROM_B"], emits: ["FROM_A"] },
      { id: "b", triggers: ["FROM_A"], emits: ["FROM_B"] },
    ]);
    expect(Object.keys(result).sort()).toEqual(["a", "b"]);
    expect(result.a?.stage).toBeLessThanOrEqual(2);
    expect(result.b?.stage).toBeLessThanOrEqual(2);
  });

  it("maps event colors to theme tokens", () => {
    expect(colorVar("green")).toBe("var(--green)");
    expect(colorVar("blue")).toBe("var(--blue)");
    expect(colorVar("amber")).toBe("var(--amber)");
    expect(colorVar("red")).toBe("var(--red)");
    expect(colorVar("muted")).toBe("var(--text-3)");
    expect(colorVar(undefined)).toBe("var(--text-3)");
  });
});
