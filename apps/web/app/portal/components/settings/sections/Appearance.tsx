"use client";

/**
 * Settings → Appearance
 *
 * Surfaces the theme, language, density, and accent controls that also live
 * in the top bar and the Tweaks panel. All three read/write the shared
 * PreferencesProvider, so changes here stay in sync everywhere in the tab.
 *
 * Language is the interface locale; all four controls apply immediately and
 * persist through the shared PreferencesProvider.
 */

import type { CSSProperties } from "react";
import { Panel } from "@/app/portal/components";
import { Field } from "@/app/portal/components/settings/atoms";
import { useTweaks } from "@/app/portal/components/tweaks/use-tweaks";
import { useI18n } from "@/app/portal/lib/preferences-context";
import type { Theme, Density } from "@/app/portal/lib/preferences";

const ACCENTS = [
  { value: "#d0ff00", id: "accentLime" },
  { value: "#5deeff", id: "accentCyan" },
  { value: "#ffb547", id: "accentAmber" },
  { value: "#b594ff", id: "accentViolet" },
];

function Segmented<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  ariaLabel: string;
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      style={{
        display: "inline-flex",
        padding: 2,
        gap: 2,
        background: "var(--panel-3)",
        border: "1px solid var(--border)",
        borderRadius: 6,
      }}
    >
      {options.map((o) => {
        const active = o.value === value;
        const style: CSSProperties = {
          padding: "5px 12px",
          borderRadius: 4,
          fontSize: 12,
          background: active ? "var(--panel)" : "transparent",
          color: active ? "var(--text)" : "var(--text-3)",
          fontWeight: active ? 500 : 400,
        };
        return (
          <button
            key={o.value}
            aria-pressed={active}
            onClick={() => onChange(o.value)}
            style={style}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function AppearanceSection() {
  const [tweaks, setTweak] = useTweaks();
  const { t, language, setLanguage } = useI18n();

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <Panel title={t("appearance.theme")} padded>
        <Field label={t("appearance.theme")} hint={t("appearance.themeHelp")}>
          <Segmented<Theme>
            ariaLabel={t("appearance.theme")}
            value={tweaks.theme}
            onChange={(v) => setTweak("theme", v)}
            options={[
              { value: "system", label: t("topbar.themeSystem") },
              { value: "light", label: t("topbar.themeLight") },
              { value: "dark", label: t("topbar.themeDark") },
            ]}
          />
        </Field>

        <Field
          label={t("appearance.language")}
          hint={t("appearance.languageHelp")}
        >
          <Segmented
            ariaLabel={t("appearance.language")}
            value={language}
            onChange={(v) => setLanguage(v)}
            options={[
              { value: "en", label: "English" },
              { value: "zh", label: "中文" },
            ]}
          />
        </Field>

        <Field label={t("appearance.density")}>
          <Segmented<Density>
            ariaLabel={t("appearance.density")}
            value={tweaks.density}
            onChange={(v) => setTweak("density", v)}
            options={[
              { value: "compact", label: t("appearance.densityCompact") },
              { value: "default", label: t("appearance.densityDefault") },
              { value: "comfortable", label: t("appearance.densityComfortable") },
            ]}
          />
        </Field>

        <Field label={t("appearance.accent")} hint={t("appearance.accentHelp")}>
          <div style={{ display: "flex", gap: 6 }}>
            {ACCENTS.map((a) => (
              <button
                key={a.value}
                onClick={() => setTweak("accent", a.value)}
                aria-label={t(`appearanceSection.${a.id}`)}
                title={t(`appearanceSection.${a.id}`)}
                style={{
                  width: 24,
                  height: 24,
                  borderRadius: 4,
                  background: a.value,
                  border: `2px solid ${
                    tweaks.accent === a.value ? "var(--text)" : "transparent"
                  }`,
                  cursor: "pointer",
                }}
              />
            ))}
          </div>
        </Field>
      </Panel>
    </div>
  );
}
