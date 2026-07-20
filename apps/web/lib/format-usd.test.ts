import { describe, expect, it } from "vitest";
import { formatUsdNanos } from "./format-usd";

describe("formatUsdNanos", () => {
  it.each([
    [0, "$0.00"],
    [1_000_000, "$0.001"],
    [10_000_000, "$0.01"],
    [12_345_000, "$0.012345"],
    [1_234_567_890_000, "$1,234.56789"],
  ])("formats %s nanodollars exactly", (nanos, expected) => {
    expect(formatUsdNanos(nanos)).toBe(expected);
  });
});
