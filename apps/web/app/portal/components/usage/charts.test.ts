import { describe, it, expect } from "vitest";
import { bucketBars, lineChartPoints } from "./charts";

describe("bucketBars", () => {
  it("returns at most `limit` entries", () => {
    const data = [
      { key: "a", value: 5 },
      { key: "b", value: 4 },
      { key: "c", value: 3 },
    ];
    expect(bucketBars(data, 2)).toHaveLength(2);
    expect(bucketBars(data, 10)).toHaveLength(3);
  });

  it("clamps a negative limit to zero", () => {
    expect(bucketBars([{ key: "a", value: 1 }], -1)).toEqual([]);
  });

  it("preserves input order on ties", () => {
    const data = [
      { key: "a", value: 1 },
      { key: "b", value: 1 },
    ];
    expect(bucketBars(data, 2).map((d) => d.key)).toEqual(["a", "b"]);
  });
});

describe("lineChartPoints", () => {
  it("returns empty path for empty input", () => {
    const out = lineChartPoints([], 100, 50);
    expect(out.path).toBe("");
    expect(out.coords).toEqual([]);
  });

  it("scales to maximum value", () => {
    const out = lineChartPoints([0, 50, 100], 100, 100, 0);
    expect(out.max).toBe(100);
    // first point starts at x=0, max value should be at top
    expect(out.coords[0]?.x).toBe(0);
    expect(out.coords[2]?.x).toBe(100);
    // value=100 → y near 0; value=0 → y near height
    expect(out.coords[2]?.y).toBeCloseTo(0);
    expect(out.coords[0]?.y).toBeCloseTo(100);
  });

  it("emits an M then L for each subsequent point", () => {
    const out = lineChartPoints([1, 2], 10, 10, 0);
    expect(out.path.split("M")).toHaveLength(2); // 1 leading + 1 split
    expect(out.path).toContain("L");
  });

  it("centres a single observation without inventing a trend", () => {
    const out = lineChartPoints([42], 100, 50, 0);
    expect(out.coords).toHaveLength(1);
    expect(out.coords[0]?.x).toBe(50);
    expect(out.path).toBe("M 50.0 0.0");
    expect(out.path).not.toContain("L");
  });
});
