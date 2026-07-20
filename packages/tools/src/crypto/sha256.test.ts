import { describe, expect, it } from "vitest";
import { computeSha256 } from "./sha256";

describe("crypto.sha256", () => {
  it("hashes utf8 and strict base64 bytes deterministically", () => {
    const expected =
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
    expect(computeSha256({ text: "hello" })).toEqual({
      sha256: expected,
      bytes: 5,
      input_type: "text",
    });
    expect(computeSha256({ base64: "aGVsbG8=" }).sha256).toBe(expected);
    expect(computeSha256({ hex: "68656c6c6f" }).sha256).toBe(expected);
  });

  it("canonicalizes JSON object keys recursively", () => {
    expect(computeSha256({ json: { b: 2, a: { d: 4, c: 3 } } })).toEqual(
      computeSha256({ json: { a: { c: 3, d: 4 }, b: 2 } }),
    );
  });

  it("requires exactly one representation and enforces strict encodings/size", () => {
    expect(() => computeSha256({})).toThrow(/exactly one/);
    expect(() => computeSha256({ text: "a", hex: "61" })).toThrow(
      /exactly one/,
    );
    expect(() => computeSha256({ base64: "not base64" })).toThrow(
      /canonical padded/,
    );
    expect(() => computeSha256({ hex: "abc" })).toThrow(/even number/);
    expect(() => computeSha256({ text: "hello" }, { max_bytes: 4 })).toThrow(
      /exceeds/,
    );
  });
});
