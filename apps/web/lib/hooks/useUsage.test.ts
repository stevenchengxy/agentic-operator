import { describe, expect, it } from "vitest";
import { usageQueryKey, usageRequestPath } from "./useUsage";

describe("rolling usage queries", () => {
  it("keeps a stable cache key while the rolling window advances", () => {
    const options = { rollingWindowMs: 60_000 } as const;

    expect(usageQueryKey(options)).toEqual(["usage", "rolling", 60_000]);
    expect(usageQueryKey(options)).toEqual(usageQueryKey(options));
  });

  it("calculates fresh concrete bounds for each network request", () => {
    const options = { rollingWindowMs: 60_000 } as const;

    expect(usageRequestPath(options, 100_000)).toBe(
      "/v1/usage?since=40000&until=100000",
    );
    expect(usageRequestPath(options, 130_000)).toBe(
      "/v1/usage?since=70000&until=130000",
    );
  });

  it("preserves exact-range queries for non-rolling consumers", () => {
    expect(usageQueryKey({ since: 10, until: 20 })).toEqual([
      "usage",
      10,
      20,
    ]);
    expect(usageRequestPath({ since: 10, until: 20 }, 999)).toBe(
      "/v1/usage?since=10&until=20",
    );
  });
});
