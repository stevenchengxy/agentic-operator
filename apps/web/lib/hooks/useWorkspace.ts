"use client";

/**
 * useWorkspace — exposes workspace-scoped preferences (timezone, locale).
 *
 * Phase 2 P2-FE-27. Backs onto the same `/api/prefs` cookie store that powers
 * the tweaks panel (theme/density/accent/tenant/liveStream). Reads via
 * `document.cookie` on the client and writes back through POST `/api/prefs`.
 *
 * The Settings Workspace section uses this for the timezone picker. Future
 * formatters (`fmtTime`, `fmtAgo`) should also consume this so cross-timezone
 * teams see consistent timestamps (audit 01 §R-10).
 */

import { useCallback, useEffect, useState } from "react";

export interface WorkspacePrefs {
  timezone: string;
  locale: string;
}

const DEFAULTS: WorkspacePrefs = {
  timezone: "Asia/Shanghai",
  locale: "en-US",
};

const COOKIE = "agentic_prefs";

function readCookiePrefs(): WorkspacePrefs {
  if (typeof document === "undefined") return DEFAULTS;
  const raw = document.cookie
    .split("; ")
    .find((c) => c.startsWith(`${COOKIE}=`));
  if (!raw) return DEFAULTS;
  try {
    const json = JSON.parse(decodeURIComponent(raw.split("=")[1] ?? ""));
    return {
      timezone: typeof json.timezone === "string" ? json.timezone : DEFAULTS.timezone,
      locale: typeof json.locale === "string" ? json.locale : DEFAULTS.locale,
    };
  } catch {
    return DEFAULTS;
  }
}

export function useWorkspace() {
  const [prefs, setPrefs] = useState<WorkspacePrefs>(DEFAULTS);

  useEffect(() => {
    setPrefs(readCookiePrefs());
  }, []);

  const persist = useCallback(async (next: Partial<WorkspacePrefs>) => {
    const merged = { ...prefs, ...next };
    setPrefs(merged);
    try {
      await fetch("/api/prefs", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      });
    } catch {
      // Persistence failure shouldn't break the UI — state already updated.
    }
  }, [prefs]);

  const setTimezone = useCallback(
    (tz: string) => persist({ timezone: tz }),
    [persist],
  );

  const setLocale = useCallback(
    (loc: string) => persist({ locale: loc }),
    [persist],
  );

  return {
    timezone: prefs.timezone,
    locale: prefs.locale,
    setTimezone,
    setLocale,
  };
}
