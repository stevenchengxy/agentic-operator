import { describe, it, expect } from "vitest";
import { interpolate, translateWith } from "./index";
import type { Dict, Language } from "./types";

const FIX: Record<Language, Dict> = {
  en: {
    greeting: "Hello {name}",
    nav: { home: "Home" },
    only: { en: "EnglishOnly" },
  },
  zh: {
    greeting: "你好 {name}",
    nav: { home: "首页" },
  },
};

describe("interpolate", () => {
  it("replaces a single {var}", () => {
    expect(interpolate("Hello {name}", { name: "Wei" })).toBe("Hello Wei");
  });
  it("replaces multiple vars and stringifies numbers", () => {
    expect(interpolate("{a} of {b}", { a: 3, b: 10 })).toBe("3 of 10");
  });
  it("leaves an unmatched {var} untouched when no value is supplied", () => {
    expect(interpolate("Hi {name}", {})).toBe("Hi {name}");
  });
  it("returns the template unchanged when no vars arg is given", () => {
    expect(interpolate("plain text")).toBe("plain text");
  });
});

describe("translateWith", () => {
  it("returns the active-language string for a nested dot-path key", () => {
    expect(translateWith(FIX, "zh", "nav.home")).toBe("首页");
    expect(translateWith(FIX, "en", "nav.home")).toBe("Home");
  });
  it("interpolates vars into the resolved string", () => {
    expect(translateWith(FIX, "en", "greeting", { name: "Wei" })).toBe(
      "Hello Wei",
    );
  });
  it("falls back active-language → en when the key is missing in the active language", () => {
    expect(translateWith(FIX, "zh", "only.en")).toBe("EnglishOnly");
  });
  it("falls back to the key itself when missing in every language", () => {
    expect(translateWith(FIX, "en", "does.not.exist")).toBe("does.not.exist");
  });
  it("treats a non-leaf (object) match as a miss, falling back to the key", () => {
    expect(translateWith(FIX, "en", "nav")).toBe("nav");
  });
});
