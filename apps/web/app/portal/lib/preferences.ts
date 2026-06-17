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
