import { describe, it, expect } from "vitest";
import {
  resolveTheme,
  normalizePreferences,
  DEFAULT_PREFERENCES,
  darkenToAA,
  accentTextFor,
  onSignalFor,
  accentVarsFor,
} from "./preferences";

// Local WCAG contrast helper so the test is self-contained (mirrors the
// algorithm inside preferences.ts but is written independently here).
function contrastOnWhite(hex: string): number {
  const h = hex.replace("#", "");
  const ch = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255;
  const lin = (c: number) =>
    c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  const L = 0.2126 * lin(ch(0)) + 0.7152 * lin(ch(2)) + 0.0722 * lin(ch(4));
  return (1.0 + 0.05) / (L + 0.05);
}

const PRESET_ACCENTS = ["#d0ff00", "#5deeff", "#ffb547", "#b594ff"];

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
  it("keeps a string accent and ignores obsolete tenant preferences", () => {
    const p = normalizePreferences({ accent: "#5deeff", tenant: "acme" });
    expect(p.accent).toBe("#5deeff");
    expect("tenant" in p).toBe(false);
  });
});

describe("darkenToAA", () => {
  it("darkens every preset accent to clear WCAG AA (>=4.5:1) on white", () => {
    for (const accent of PRESET_ACCENTS) {
      const out = darkenToAA(accent);
      expect(contrastOnWhite(out)).toBeGreaterThanOrEqual(4.5);
    }
  });
  it("clears AA for a fuzz set of arbitrary hex (incl. 3-digit)", () => {
    const fuzz = ["#fff", "#00ffcc", "#ff00ff", "#abcdef", "#123", "#7fff00"];
    for (const c of fuzz) {
      expect(contrastOnWhite(darkenToAA(c))).toBeGreaterThanOrEqual(4.5);
    }
  });
  it("preserves hue roughly (lime stays green-dominant)", () => {
    const out = darkenToAA("#d0ff00").replace("#", "");
    const g = parseInt(out.slice(2, 4), 16);
    const b = parseInt(out.slice(4, 6), 16);
    expect(g).toBeGreaterThan(b); // still a green/lime, not muddied to grey
  });
  it("returns an already-dark color unchanged", () => {
    expect(darkenToAA("#123456")).toBe("#123456");
  });
  it("returns a safe constant for malformed input", () => {
    expect(darkenToAA("not-a-color")).toBe("#4d5e00");
    expect(darkenToAA("#12")).toBe("#4d5e00");
  });
  it("never returns pure black", () => {
    for (const c of [...PRESET_ACCENTS, "#ffffff", "#fefefe"]) {
      expect(darkenToAA(c)).not.toBe("#000000");
    }
  });
});

describe("accentTextFor", () => {
  it("leaves the bright accent untouched in dark mode", () => {
    expect(accentTextFor("#d0ff00", "dark")).toBe("#d0ff00");
  });
  it("darkens the accent to AA in light mode", () => {
    const out = accentTextFor("#d0ff00", "light");
    expect(out).not.toBe("#d0ff00");
    expect(contrastOnWhite(out)).toBeGreaterThanOrEqual(4.5);
  });
});

describe("onSignalFor", () => {
  it("picks black ink for the bright presets", () => {
    for (const accent of PRESET_ACCENTS) {
      expect(onSignalFor(accent)).toBe("#000");
    }
  });
  it("picks white ink for a dark custom accent", () => {
    expect(onSignalFor("#1a1a2e")).toBe("#fff");
  });
  it("falls back to black for malformed input", () => {
    expect(onSignalFor("bogus")).toBe("#000");
  });
});

describe("accentVarsFor", () => {
  it("keeps the vivid accent + black ink in dark mode", () => {
    const v = accentVarsFor("#d0ff00", "dark");
    expect(v.signal).toBe("#d0ff00");
    expect(v.accentText).toBe("#d0ff00");
    expect(v.onSignal).toBe("#000");
  });
  it("darkens the fill + uses white ink in light mode (signal == accentText)", () => {
    const v = accentVarsFor("#d0ff00", "light");
    expect(v.signal).not.toBe("#d0ff00");
    expect(v.signal).toBe(v.accentText); // fill and text converge when darkened
    expect(v.onSignal).toBe("#fff");
    // white ink on the darkened fill must clear AA
    expect(contrastOnWhite(v.signal)).toBeGreaterThanOrEqual(4.5);
  });
});
