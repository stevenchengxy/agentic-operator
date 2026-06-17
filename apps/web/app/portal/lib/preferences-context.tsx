"use client";

/**
 * PreferencesProvider — the single in-tab source of truth for runtime
 * preferences (theme, language, density, accent, …).
 *
 * Replaces the per-component `useState` in the old `useTweaks` hook: the
 * theme/language controls now live in three places (top bar, Settings,
 * Tweaks panel) that must stay in sync within a tab — which a per-instance
 * hook cannot do (the `storage` event only fires in *other* tabs).
 *
 * Responsibilities: hold state, persist to localStorage (`agentic.tweaks`),
 * apply `data-theme`/`data-density`/`lang`/`--signal` to `<html>`, follow
 * the OS color scheme while in `system` mode, and sync across tabs. The
 * pure model (defaults, validation, theme resolution) lives in
 * `preferences.ts`; translation lookup lives in `lib/i18n`.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { Language } from "@/lib/i18n/types";
import { translate } from "@/lib/i18n";
import {
  ACCENT_DIMS,
  DEFAULT_PREFERENCES,
  normalizePreferences,
  resolveTheme,
  type Preferences,
} from "./preferences";

const STORAGE_KEY = "agentic.tweaks";

export type SetPref = <K extends keyof Preferences>(
  keyOrEdits: K | Partial<Preferences>,
  val?: Preferences[K],
) => void;

interface PreferencesContextValue {
  prefs: Preferences;
  setPref: SetPref;
  t: (key: string, vars?: Record<string, string | number>) => string;
}

const PreferencesContext = createContext<PreferencesContextValue | null>(null);

function readStored(): Preferences {
  if (typeof window === "undefined") return DEFAULT_PREFERENCES;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return normalizePreferences(raw ? JSON.parse(raw) : {});
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

function writeStored(p: Preferences): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
  } catch {
    // quota / private mode — ignore.
  }
}

function osPrefersDark(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );
}

export function PreferencesProvider({ children }: { children: ReactNode }) {
  const [prefs, setPrefs] = useState<Preferences>(DEFAULT_PREFERENCES);
  // `loaded` gates the apply-effect so we never paint the DEFAULT theme over
  // the correct value the inline FOUC script already set (would flash).
  const [loaded, setLoaded] = useState(false);

  // Hydrate from localStorage after mount (SSR renders DEFAULT; the inline
  // <head> script has already set the real <html> attributes pre-paint).
  useEffect(() => {
    setPrefs(readStored());
    setLoaded(true);
  }, []);

  // Cross-tab sync.
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key === STORAGE_KEY) setPrefs(readStored());
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // Apply preferences to <html>, and (in system mode) re-resolve when the
  // OS color scheme flips. Gated on `loaded` to avoid a DEFAULT-over-FOUC
  // flash on first paint.
  useEffect(() => {
    if (!loaded || typeof document === "undefined") return;
    const html = document.documentElement;
    html.dataset.theme = resolveTheme(prefs.theme, osPrefersDark());
    html.dataset.density = prefs.density;
    html.lang = prefs.language;
    html.style.setProperty("--signal", prefs.accent);
    html.style.setProperty("--signal-dim", ACCENT_DIMS[prefs.accent] ?? "#5a6e00");

    if (prefs.theme !== "system" || typeof window.matchMedia !== "function") {
      return;
    }
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      html.dataset.theme = resolveTheme(prefs.theme, mq.matches);
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [loaded, prefs.theme, prefs.density, prefs.language, prefs.accent]);

  const setPref = useCallback<SetPref>((keyOrEdits, val) => {
    setPrefs((prev) => {
      const edits =
        typeof keyOrEdits === "object" && keyOrEdits !== null
          ? (keyOrEdits as Partial<Preferences>)
          : ({ [keyOrEdits as string]: val } as Partial<Preferences>);
      const next = { ...prev, ...edits };
      writeStored(next);
      return next;
    });
  }, []);

  const t = useCallback(
    (key: string, vars?: Record<string, string | number>) =>
      translate(prefs.language, key, vars),
    [prefs.language],
  );

  const value = useMemo<PreferencesContextValue>(
    () => ({ prefs, setPref, t }),
    [prefs, setPref, t],
  );

  return (
    <PreferencesContext.Provider value={value}>
      {children}
    </PreferencesContext.Provider>
  );
}

function usePreferencesContext(): PreferencesContextValue {
  const ctx = useContext(PreferencesContext);
  if (!ctx) {
    throw new Error("usePreferences must be used within <PreferencesProvider>");
  }
  return ctx;
}

/** Full preferences access: `{ prefs, setPref, t }`. */
export function usePreferences(): PreferencesContextValue {
  return usePreferencesContext();
}

/** Language-focused slice for components that only translate. */
export function useI18n(): {
  language: Language;
  setLanguage: (language: Language) => void;
  t: PreferencesContextValue["t"];
} {
  const { prefs, setPref, t } = usePreferencesContext();
  const setLanguage = useCallback(
    (language: Language) => setPref("language", language),
    [setPref],
  );
  return { language: prefs.language, setLanguage, t };
}
