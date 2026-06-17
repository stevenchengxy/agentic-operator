import { describe, it, expect } from "vitest";
import {
  resolveTheme,
  normalizePreferences,
  DEFAULT_PREFERENCES,
} from "./preferences";

describe("resolveTheme", () => {
  it("returns an explicit light/dark choice unchanged", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });
  it("resolves 'system' to dark when the OS prefers dark", () => {
    expect(resolveTheme("system", true)).toBe("dark");
  });
  it("resolves 'system' to light when the OS does not prefer dark", () => {
    expect(resolveTheme("system", false)).toBe("light");
  });
});

describe("normalizePreferences", () => {
  it("returns defaults for null / non-object input", () => {
    expect(normalizePreferences(null)).toEqual(DEFAULT_PREFERENCES);
    expect(normalizePreferences("nonsense")).toEqual(DEFAULT_PREFERENCES);
  });
  it("merges a partial blob over the defaults", () => {
    const p = normalizePreferences({ theme: "light", language: "zh" });
    expect(p.theme).toBe("light");
    expect(p.language).toBe("zh");
    expect(p.density).toBe(DEFAULT_PREFERENCES.density);
  });
  it("accepts legacy theme values (dark / light)", () => {
    expect(normalizePreferences({ theme: "dark" }).theme).toBe("dark");
    expect(normalizePreferences({ theme: "light" }).theme).toBe("light");
  });
  it("accepts the new 'system' theme", () => {
    expect(normalizePreferences({ theme: "system" }).theme).toBe("system");
  });
  it("falls back to the default theme for an unknown value", () => {
    expect(normalizePreferences({ theme: "neon" }).theme).toBe(
      DEFAULT_PREFERENCES.theme,
    );
  });
  it("falls back to the default language for an unknown value", () => {
    expect(normalizePreferences({ language: "fr" }).language).toBe("en");
  });
  it("ignores a non-boolean liveStream", () => {
    expect(normalizePreferences({ liveStream: "yes" }).liveStream).toBe(
      DEFAULT_PREFERENCES.liveStream,
    );
  });
  it("keeps a string accent / tenant when provided", () => {
    const p = normalizePreferences({ accent: "#5deeff", tenant: "acme" });
    expect(p.accent).toBe("#5deeff");
    expect(p.tenant).toBe("acme");
  });
});
