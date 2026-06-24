import type { Language } from "@/lib/i18n/types";

/**
 * Pure preferences model — defaults, validation, and theme resolution.
 *
 * Kept free of React/DOM so it can be unit-tested in the node vitest
 * environment (mirrors the `density.ts` pure-helper pattern). The React
 * context, localStorage I/O, and `<html>` side-effects live in
 * `preferences-context.tsx`.
 */

export type Theme = "system" | "light" | "dark";
export type Density = "compact" | "default" | "comfortable";
export type DataSource = "json" | "neo4j";

export interface Preferences {
  theme: Theme;
  language: Language;
  density: Density;
  liveStream: boolean;
  showDebug: boolean;
  tenant: string;
  accent: string;
  /** Latent — the data source is always the real API now. */
  dataSource: DataSource;
}

export const DEFAULT_PREFERENCES: Preferences = {
  theme: "system",
  language: "en",
  density: "default",
  liveStream: true,
  showDebug: false,
  tenant: "raas",
  accent: "#d0ff00",
  dataSource: "json",
};

export const ACCENT_DIMS: Record<string, string> = {
  "#d0ff00": "#5a6e00",
  "#5deeff": "#1a6770",
  "#ffb547": "#7a4f0d",
  "#b594ff": "#553e87",
};

// ─── Accent → legible TEXT color (theme-aware) ──────────────────────────────
//
// The per-tenant accent (`--signal`) is a VIVID brand fill (lime, cyan, …),
// great as text on the near-black dark theme but illegible as text on a white
// light-theme panel (e.g. lime #d0ff00 ≈ 1.1:1). `--accent-text` is the
// companion token used wherever the accent is rendered as TEXT/icon: it equals
// the accent in dark mode and a hue-preserving darkened variant that clears
// WCAG AA in light mode. The tenant accent is free-form (server-stored), so we
// derive the dark variant from any hex rather than hardcoding the presets.
// Kept pure (no DOM/React) so it unit-tests in the node vitest env.

const SAFE_ACCENT_TEXT = "#4d5e00";

/** sRGB relative luminance (WCAG 2.x). */
function relLuminance(r: number, g: number, b: number): number {
  const lin = (c: number) => {
    const cs = c / 255;
    return cs <= 0.03928 ? cs / 12.92 : Math.pow((cs + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrastRatio(l1: number, l2: number): number {
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

/** Parse #rgb / #rrggbb → [r,g,b] in 0–255, or null if malformed. */
function parseHex(hex: string): [number, number, number] | null {
  if (typeof hex !== "string") return null;
  let h = hex.trim().replace(/^#/, "");
  if (h.length === 3) {
    h = h
      .split("")
      .map((c) => c + c)
      .join("");
  }
  if (h.length !== 6 || /[^0-9a-fA-F]/.test(h)) return null;
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h / 6, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const hue2rgb = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [
    Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
    Math.round(hue2rgb(p, q, h) * 255),
    Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
  ];
}

function toHex(r: number, g: number, b: number): string {
  const c = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

const _darkenCache = new Map<string, string>();

/**
 * Darken `hex` (preserving hue via HSL) until its TEXT contrast on `bg` clears
 * WCAG AA. Returns the input unchanged if it already passes; floors lightness
 * at 0.18 so the hue never collapses to black; returns a safe constant for
 * malformed input. Targets 4.6:1 (not 4.5) to absorb antialiasing rounding.
 * Memoized — accent changes are rare.
 */
export function darkenToAA(hex: string, bg = "#ffffff"): string {
  const cacheKey = `${hex}|${bg}`;
  const cached = _darkenCache.get(cacheKey);
  if (cached) return cached;

  const rgb = parseHex(hex);
  const bgRgb = parseHex(bg);
  if (!rgb || !bgRgb) {
    _darkenCache.set(cacheKey, SAFE_ACCENT_TEXT);
    return SAFE_ACCENT_TEXT;
  }
  const lBg = relLuminance(bgRgb[0], bgRgb[1], bgRgb[2]);
  const passes = (c: [number, number, number]) =>
    contrastRatio(relLuminance(c[0], c[1], c[2]), lBg) >= 4.6;

  let out: string;
  if (passes(rgb)) {
    out = toHex(rgb[0], rgb[1], rgb[2]);
  } else {
    // Per-channel scaling shifts hue; reduce HSL lightness instead. Nudge
    // saturation up slightly so the darkened color stays vivid, not muddy.
    const [h, s0, l0] = rgbToHsl(rgb[0], rgb[1], rgb[2]);
    const s = Math.min(1, s0 * 1.1);
    const FLOOR = 0.18;
    let lo = FLOOR;
    let hi = l0;
    let best = hslToRgb(h, s, FLOOR); // fallback if even the floor fails
    for (let i = 0; i < 16; i++) {
      const mid = (lo + hi) / 2;
      const cand = hslToRgb(h, s, mid);
      if (passes(cand)) {
        best = cand; // legible — keep as much lightness as possible
        lo = mid;
      } else {
        hi = mid; // still too light — darken further
      }
    }
    out = toHex(best[0], best[1], best[2]);
  }
  _darkenCache.set(cacheKey, out);
  return out;
}

/** Theme-aware accent TEXT color: the bright accent reads on the dark theme;
 *  darken it to AA for the light theme. */
export function accentTextFor(accent: string, theme: "light" | "dark"): string {
  return theme === "dark" ? accent : darkenToAA(accent, "#ffffff");
}

/**
 * Ink (#000 / #fff) that reads best when placed ON a solid `--signal` fill of
 * this accent (chip, stepper circle, the DEMO pill, ::selection). `--signal`
 * stays the VIVID accent in BOTH themes, so unlike `--on-accent` this is
 * theme-independent — it depends only on the accent's own luminance (the four
 * presets are bright → black ink; a dark custom accent → white ink).
 */
export function onSignalFor(accent: string): string {
  const rgb = parseHex(accent);
  if (!rgb) return "#000";
  const l = relLuminance(rgb[0], rgb[1], rgb[2]);
  // contrast vs black (lum 0) vs white (lum 1); pick the higher.
  return contrastRatio(l, 0) >= contrastRatio(l, 1) ? "#000" : "#fff";
}

/**
 * The full set of accent-derived CSS variables for a theme.
 *
 * The electric accent (lime, …) is a DARK-theme color: vivid on near-black it
 * reads as both fill and text, but as a FILL on a white light-theme panel it's
 * garish and low-contrast (cheap-looking chips/buttons/bars). So in light mode
 * we darken the accent for fills AND text alike — `--signal` becomes a deep,
 * intentional accent that white ink (`--on-signal`) sits on cleanly, and is
 * still legible as text. Dark mode is unchanged (vivid accent, black ink).
 * Because `darkenToAA` lands the accent at ~4.6:1 vs white, white ink on the
 * darkened fill is guaranteed to clear AA.
 */
export function accentVarsFor(
  accent: string,
  theme: "light" | "dark",
): { signal: string; signalDim: string; accentText: string; onSignal: string } {
  const signalDim = ACCENT_DIMS[accent] ?? "#5a6e00";
  if (theme === "dark") {
    return { signal: accent, signalDim, accentText: accent, onSignal: onSignalFor(accent) };
  }
  const deep = darkenToAA(accent, "#ffffff");
  return { signal: deep, signalDim, accentText: deep, onSignal: "#fff" };
}

/** Collapse a stored theme + the OS preference into a concrete palette. */
export function resolveTheme(theme: Theme, prefersDark: boolean): "light" | "dark" {
  if (theme === "light" || theme === "dark") return theme;
  return prefersDark ? "dark" : "light";
}

const THEMES: readonly Theme[] = ["system", "light", "dark"];
const LANGUAGES: readonly Language[] = ["en", "zh"];
const DENSITIES: readonly Density[] = ["compact", "default", "comfortable"];
const DATA_SOURCES: readonly DataSource[] = ["json", "neo4j"];

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

/** Coerce an untrusted blob (localStorage / legacy shape) into a valid
 *  `Preferences`, validating each field and falling back per-field. */
export function normalizePreferences(raw: unknown): Preferences {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_PREFERENCES };
  const r = raw as Record<string, unknown>;
  return {
    theme: oneOf(r.theme, THEMES, DEFAULT_PREFERENCES.theme),
    language: oneOf(r.language, LANGUAGES, DEFAULT_PREFERENCES.language),
    density: oneOf(r.density, DENSITIES, DEFAULT_PREFERENCES.density),
    liveStream:
      typeof r.liveStream === "boolean"
        ? r.liveStream
        : DEFAULT_PREFERENCES.liveStream,
    showDebug:
      typeof r.showDebug === "boolean"
        ? r.showDebug
        : DEFAULT_PREFERENCES.showDebug,
    tenant:
      typeof r.tenant === "string" && r.tenant.length > 0
        ? r.tenant
        : DEFAULT_PREFERENCES.tenant,
    accent:
      typeof r.accent === "string" ? r.accent : DEFAULT_PREFERENCES.accent,
    dataSource: oneOf(r.dataSource, DATA_SOURCES, DEFAULT_PREFERENCES.dataSource),
  };
}
