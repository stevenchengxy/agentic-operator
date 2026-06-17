"use client";

/**
 * useTweaks — back-compat shim over `PreferencesProvider`.
 *
 * Historically this hook owned its own localStorage-backed `useState`.
 * State now lives in a single `PreferencesProvider` (see
 * `app/portal/lib/preferences-context.tsx`) so the theme/language controls
 * in the top bar, Settings, and this panel stay in sync within a tab. This
 * hook keeps the exact `[tweaks, setTweak]` shape its two callers
 * (`topbar.tsx`, `panel.tsx`) already use, so nothing downstream changes.
 */

import {
  usePreferences,
  type SetPref,
} from "../../lib/preferences-context";
import {
  ACCENT_DIMS,
  DEFAULT_PREFERENCES,
  type Preferences,
} from "../../lib/preferences";

/** Back-compat alias — the preferences shape the panel/topbar consume. */
export type Tweaks = Preferences;
export type SetTweak = SetPref;

export const DEFAULT_TWEAKS: Tweaks = DEFAULT_PREFERENCES;
export { ACCENT_DIMS };

export function useTweaks(): [Tweaks, SetTweak] {
  const { prefs, setPref } = usePreferences();
  return [prefs, setPref];
}
