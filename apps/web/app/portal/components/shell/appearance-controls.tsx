"use client";

/**
 * Top-bar appearance controls: a theme toggle (System/Light/Dark popover)
 * and a language pill (EN / 中). Both read/write the shared
 * PreferencesProvider so they stay in sync with Settings and the Tweaks
 * panel within a tab.
 *
 * The theme button's icon reflects the *resolved* palette, read from the
 * live `data-theme` attribute via a MutationObserver.
 * Starting from "dark" matches the server-rendered `<html data-theme="dark">`
 * so there is no hydration mismatch; it then tracks explicit toggles and OS
 * `system`-mode flips.
 */

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Icon, type IconName } from "../Icon";
import { useTweaks } from "../tweaks/use-tweaks";
import { useI18n } from "../../lib/preferences-context";
import type { Theme } from "../../lib/preferences";

const ctrlBtn: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: 28,
  height: 26,
  borderRadius: 5,
  border: "1px solid var(--border-2)",
  background: "var(--panel)",
  color: "var(--text-3)",
};

export function ThemeToggle() {
  const [tweaks, setTweak] = useTweaks();
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [resolved, setResolved] = useState<"light" | "dark">("dark");
  const ref = useRef<HTMLDivElement>(null);

  // Track the actually-applied palette from <html data-theme>.
  useEffect(() => {
    const read = () =>
      setResolved(
        document.documentElement.dataset.theme === "light" ? "light" : "dark",
      );
    read();
    const mo = new MutationObserver(read);
    mo.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => mo.disconnect();
  }, []);

  // Close the popover on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const options: { value: Theme; label: string; icon: IconName }[] = [
    { value: "system", label: t("topbar.themeSystem"), icon: "settings" },
    { value: "light", label: t("topbar.themeLight"), icon: "sun" },
    { value: "dark", label: t("topbar.themeDark"), icon: "moon" },
  ];

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label={t("topbar.theme")}
        title={t("topbar.theme")}
        aria-haspopup="menu"
        aria-expanded={open}
        style={ctrlBtn}
      >
        <Icon name={resolved === "dark" ? "moon" : "sun"} size={13} />
      </button>
      {open && (
        <div
          role="menu"
          aria-label={t("topbar.theme")}
          style={{
            position: "absolute",
            top: 32,
            right: 0,
            minWidth: 132,
            padding: 4,
            display: "flex",
            flexDirection: "column",
            gap: 2,
            background: "var(--panel-2)",
            border: "1px solid var(--border-2)",
            borderRadius: 7,
            boxShadow: "0 8px 24px rgba(0,0,0,.32)",
            zIndex: "var(--z-tooltip)" as unknown as number,
          }}
        >
          {options.map((o) => {
            const active = o.value === tweaks.theme;
            return (
              <button
                key={o.value}
                role="menuitemradio"
                aria-checked={active}
                onClick={() => {
                  setTweak("theme", o.value);
                  setOpen(false);
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "6px 8px",
                  borderRadius: 5,
                  fontSize: 12,
                  textAlign: "left",
                  background: active ? "var(--panel-3)" : "transparent",
                  color: active ? "var(--accent-text)" : "var(--text-2)",
                }}
              >
                <Icon name={o.icon} size={12} />
                <span>{o.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function LanguageToggle() {
  const { language, setLanguage, t } = useI18n();
  const options: { value: "en" | "zh"; label: string }[] = [
    { value: "en", label: "EN" },
    { value: "zh", label: "中" },
  ];
  return (
    <div
      role="group"
      aria-label={t("topbar.language")}
      style={{
        display: "flex",
        height: 26,
        border: "1px solid var(--border-2)",
        borderRadius: 5,
        overflow: "hidden",
      }}
    >
      {options.map((o) => {
        const active = o.value === language;
        return (
          <button
            key={o.value}
            aria-pressed={active}
            onClick={() => setLanguage(o.value)}
            style={{
              padding: "0 9px",
              fontSize: 11.5,
              fontFamily: "var(--mono)",
              background: active ? "var(--panel-3)" : "transparent",
              color: active ? "var(--text)" : "var(--text-3)",
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
