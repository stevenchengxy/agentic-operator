import { describe, it, expect } from "vitest";
import { en } from "./en";
import { zh } from "./zh";
import type { Dict } from "./types";

/** Recursively collect every leaf dot-path in a dictionary, sorted. */
function leafPaths(d: Dict, prefix = ""): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(d)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "string") out.push(p);
    else out.push(...leafPaths(v, p));
  }
  return out.sort();
}

describe("i18n dictionary parity", () => {
  it("en and zh expose an identical key set (no missing or extra keys)", () => {
    expect(leafPaths(zh)).toEqual(leafPaths(en));
  });
});
