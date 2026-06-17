"use client";

/**
 * TweaksPanel (P2-FE-16) — floating power-user control panel.
 *
 * Opened with the cog button or Cmd/Ctrl+Shift+T. State flows through the
 * shared PreferencesProvider (via `useTweaks`), so changes here stay in
 * sync with the top-bar controls and Settings → Appearance.
 *
 * Restyled to theme tokens (was hardcoded light glass, unreadable in dark
 * mode). Controls: Theme (system/light/dark), Language (EN/中), Density,
 * Accent, Live stream, Show debug, Tenant, Data source.
 */

import { useEffect, useState } from "react";
import { Icon } from "../Icon";
import { useTweaks, type Tweaks } from "./use-tweaks";
import { LanguageToggle } from "../shell/appearance-controls";
import { useTenantNavigate } from "../../lib/use-tenant";

const ACCENT_OPTIONS: { value: string; label: string }[] = [
  { value: "#d0ff00", label: "Lime" },
  { value: "#5deeff", label: "Cyan" },
  { value: "#ffb547", label: "Amber" },
  { value: "#b594ff", label: "Violet" },
];

interface TenantOption {
  id: string;
  name: string;
}

export interface TweaksPanelProps {
  tenants?: TenantOption[];
}

export function TweaksPanel({ tenants = [] }: TweaksPanelProps) {
  const [open, setOpen] = useState(false);
  const [tweaks, setTweak] = useTweaks();
  const goTenant = useTenantNavigate();

  // Hotkey: Cmd/Ctrl+Shift+T toggles the panel.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "t") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label="Open tweaks panel"
        title="Tweaks (⌘⇧T)"
        style={{
          position: "fixed",
          right: 16,
          bottom: 16,
          width: 28,
          height: 28,
          borderRadius: 14,
          background: "var(--panel-2)",
          border: "1px solid var(--border-2)",
          color: "var(--text-3)",
          display: open ? "none" : "flex",
          alignItems: "center",
          justifyContent: "center",
          zIndex: "var(--z-overlay)" as unknown as number,
        }}
      >
        <Icon name="settings" size={13} />
      </button>
      {open && (
        <PanelBody
          tweaks={tweaks}
          setTweak={setTweak}
          tenants={tenants}
          onClose={() => setOpen(false)}
          onTenantChange={goTenant}
        />
      )}
    </>
  );
}

function PanelBody({
  tweaks,
  setTweak,
  tenants,
  onClose,
  onTenantChange,
}: {
  tweaks: Tweaks;
  setTweak: ReturnType<typeof useTweaks>[1];
  tenants: TenantOption[];
  onClose: () => void;
  onTenantChange: (next: string) => void;
}) {
  return (
    <div
      role="dialog"
      aria-label="Tweaks panel"
      style={{
        position: "fixed",
        right: 16,
        bottom: 16,
        width: 280,
        maxHeight: "calc(100vh - 32px)",
        display: "flex",
        flexDirection: "column",
        background: "var(--panel)",
        color: "var(--text)",
        border: "1px solid var(--border-2)",
        borderRadius: 12,
        boxShadow: "0 12px 40px rgba(0,0,0,.35)",
        fontFamily: "var(--sans)",
        fontSize: 11.5,
        lineHeight: 1.4,
        overflow: "hidden",
        zIndex: "var(--z-tooltip)" as unknown as number,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "10px 8px 10px 14px",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <strong style={{ fontSize: 12, fontWeight: 600, letterSpacing: ".01em" }}>
          Tweaks
        </strong>
        <button
          onClick={onClose}
          aria-label="Close tweaks"
          style={{
            color: "var(--text-3)",
            width: 22,
            height: 22,
            borderRadius: 6,
            fontSize: 13,
          }}
        >
          ✕
        </button>
      </div>
      <div
        style={{
          padding: "12px 14px 14px",
          display: "flex",
          flexDirection: "column",
          gap: 10,
          overflowY: "auto",
        }}
      >
        <RadioRow
          label="Theme"
          value={tweaks.theme}
          options={["system", "light", "dark"]}
          onChange={(v) => setTweak("theme", v as Tweaks["theme"])}
        />
        <Row label="Language" inline>
          <LanguageToggle />
        </Row>
        <RadioRow
          label="Density"
          value={tweaks.density}
          options={["compact", "default", "comfortable"]}
          onChange={(v) => setTweak("density", v as Tweaks["density"])}
        />
        <ColorRow
          label="Accent"
          value={tweaks.accent}
          options={ACCENT_OPTIONS}
          onChange={(v) => setTweak("accent", v)}
        />
        <ToggleRow
          label="Live event stream"
          value={tweaks.liveStream}
          onChange={(v) => setTweak("liveStream", v)}
        />
        <ToggleRow
          label="Show debug panels"
          value={tweaks.showDebug}
          onChange={(v) => setTweak("showDebug", v)}
        />
        {tenants.length > 0 && (
          <SelectRow
            label="Active tenant"
            value={tweaks.tenant}
            options={tenants.map((t) => ({ value: t.id, label: t.name }))}
            onChange={(v) => {
              setTweak("tenant", v);
              onTenantChange(v);
            }}
          />
        )}
        {tweaks.showDebug && (
          <RadioRow
            label="Data source"
            value={tweaks.dataSource}
            options={["json", "neo4j"]}
            onChange={(v) => setTweak("dataSource", v as Tweaks["dataSource"])}
            note="Latent — real API is always the source."
          />
        )}
      </div>
    </div>
  );
}

// ─── Sub-controls — token-based ─────────────────────────────────────────────

function Row({
  label,
  children,
  note,
  inline,
}: {
  label: string;
  children: React.ReactNode;
  note?: string;
  inline?: boolean;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          color: "var(--text-2)",
        }}
      >
        <span style={{ fontWeight: 500 }}>{label}</span>
        {inline && children}
      </div>
      {!inline && children}
      {note && (
        <div style={{ fontSize: 10, color: "var(--text-3)" }}>{note}</div>
      )}
    </div>
  );
}

function RadioRow({
  label,
  value,
  options,
  onChange,
  note,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (v: string) => void;
  note?: string;
}) {
  return (
    <Row label={label} note={note}>
      <div
        style={{
          display: "flex",
          padding: 2,
          background: "var(--panel-3)",
          border: "1px solid var(--border)",
          borderRadius: 8,
          gap: 2,
        }}
      >
        {options.map((o) => {
          const active = o === value;
          return (
            <button
              key={o}
              onClick={() => onChange(o)}
              style={{
                flex: 1,
                padding: "4px 6px",
                borderRadius: 6,
                background: active ? "var(--panel)" : "transparent",
                boxShadow: active ? "0 1px 2px rgba(0,0,0,.25)" : "none",
                color: active ? "var(--text)" : "var(--text-3)",
                fontWeight: active ? 500 : 400,
                fontSize: 11.5,
                minHeight: 22,
              }}
            >
              {o}
            </button>
          );
        })}
      </div>
    </Row>
  );
}

function ToggleRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <Row label={label} inline>
      <button
        role="switch"
        aria-checked={value}
        onClick={() => onChange(!value)}
        style={{
          position: "relative",
          width: 32,
          height: 18,
          borderRadius: 999,
          background: value ? "var(--green)" : "var(--border-2)",
          transition: "background .15s",
        }}
      >
        <span
          style={{
            position: "absolute",
            top: 2,
            left: 2,
            width: 14,
            height: 14,
            borderRadius: "50%",
            background: "#fff",
            boxShadow: "0 1px 2px rgba(0,0,0,.25)",
            transform: value ? "translateX(14px)" : "translateX(0)",
            transition: "transform .15s",
          }}
        />
      </button>
    </Row>
  );
}

function SelectRow({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
}) {
  return (
    <Row label={label}>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{
          width: "100%",
          height: 26,
          padding: "0 8px",
          border: "1px solid var(--border)",
          borderRadius: 7,
          background: "var(--panel-2)",
          color: "var(--text)",
          font: "inherit",
        }}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </Row>
  );
}

function ColorRow({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
}) {
  return (
    <Row label={label}>
      <div style={{ display: "flex", gap: 6 }}>
        {options.map((o) => {
          const on = o.value.toLowerCase() === value.toLowerCase();
          return (
            <button
              key={o.value}
              onClick={() => onChange(o.value)}
              aria-label={o.label}
              title={o.label}
              style={{
                flex: 1,
                height: 28,
                borderRadius: 6,
                background: o.value,
                boxShadow: on
                  ? "0 0 0 2px var(--text), 0 2px 6px rgba(0,0,0,.25)"
                  : "0 0 0 1px var(--border-2)",
                cursor: "pointer",
              }}
            />
          );
        })}
      </div>
    </Row>
  );
}
