import { describe, expect, it } from "vitest";

import {
  coverageWaiverMatches,
  formatCoverageWaiverTag,
  normalizeCoverageCells,
  parseCoverageWaiverTag,
} from "./coverage-waiver";

describe("coverage waiver protocol", () => {
  const cells = [
    "reject:rule check, candidate",
    "branch:match(ACCEPTED|REJECTED)",
  ];

  it("round-trips ontology-derived cell names without delimiter ambiguity", () => {
    const tag = formatCoverageWaiverTag(cells);
    expect(tag).toContain("%2C");
    expect(tag).toContain("%7C");
    expect(parseCoverageWaiverTag(`operator note ${tag}`)).toEqual(normalizeCoverageCells(cells));
  });

  it("does not interpret ordinary approval as a waiver", () => {
    expect(parseCoverageWaiverTag("执行")).toBeNull();
  });

  it("requires an exact cell set and rejects stale or over-broad receipts", () => {
    const receipt = { cells, confirmedAt: 1 };
    expect(coverageWaiverMatches([...cells].reverse(), receipt)).toBe(true);
    expect(coverageWaiverMatches([...cells, "new:cell"], receipt)).toBe(false);
    expect(coverageWaiverMatches([cells[0]!], receipt)).toBe(false);
    expect(coverageWaiverMatches(cells, undefined)).toBe(false);
    expect(coverageWaiverMatches([], undefined)).toBe(true);
  });
});
