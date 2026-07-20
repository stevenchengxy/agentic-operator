import { describe, expect, it } from "vitest";
import { parseTokenCap, parseUsdCap } from "./values";

describe("settings budget values", () => {
  it("uses blank caps to represent an unlimited budget", () => {
    expect(parseTokenCap("  ")).toBeNull();
    expect(parseUsdCap("")).toBeNull();
  });

  it("preserves whole tokens and converts dollars to integer cents", () => {
    expect(parseTokenCap("250000")).toBe(250_000);
    expect(parseUsdCap("42.19")).toBe(4_219);
  });

  it("rejects negative, non-numeric, and fractional token limits", () => {
    expect(() => parseTokenCap("-1")).toThrow("non-negative");
    expect(() => parseUsdCap("not-a-number")).toThrow("non-negative");
    expect(() => parseTokenCap("1.5")).toThrow("whole number");
  });
});
