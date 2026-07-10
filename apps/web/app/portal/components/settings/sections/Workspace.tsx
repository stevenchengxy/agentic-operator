"use client";

/**
 * Settings → Workspace
 *
 * Includes P2-FE-27 timezone picker — backed by useWorkspace() which persists
 * via POST /api/prefs.
 *
 * NOTE: this form is currently view-only — the local useState defaults are
 * seeded from the *active tenant's* live record (via useTenant + useTenants)
 * so it never displays stale RAAS values. There's no POST /v1/tenants/:id
 * editor wired up yet, so "Save changes" is a no-op (the visible accent +
 * region pickers are demo-only).
 */

import { useEffect, useState } from "react";
import { Button, Panel } from "@/app/portal/components";
import {
  Field,
  SelectIn,
  TextIn,
  Toggle,
} from "@/app/portal/components/settings/atoms";
import { LOCALES, TIMEZONES } from "@/app/portal/components/settings/data";
import { useTenants } from "@/lib/hooks/useTenants";
import { useWorkspace } from "@/lib/hooks/useWorkspace";
import { useTenant } from "@/app/portal/lib/use-tenant";
import { useI18n } from "@/app/portal/lib/preferences-context";

const ACCENTS = [
  { value: "#d0ff00", id: "lime", label: "Lime" },
  { value: "#5deeff", id: "cyan", label: "Cyan" },
  { value: "#ffb547", id: "amber", label: "Amber" },
  { value: "#b594ff", id: "violet", label: "Violet" },
];

export function WorkspaceSection() {
  const { t } = useI18n();
  const tenantsQuery = useTenants();
  // Adapt the live tenant rows to the local {id, name, color} shape this
  // form already uses. Filters out archived tenants so they don't show in
  // the "default tenant" picker.
  const tenants =
    tenantsQuery.data?.items
      .filter((t) => t.archivedAt == null)
      .map((t) => ({
        id: t.slug,
        name: t.name,
        color: t.color ?? "#d0ff00",
      })) ?? [];
  const { timezone, locale, setTimezone, setLocale } = useWorkspace();
  const activeSlug = useTenant();
  // Lookup the live tenant row so the form seeds from real data, not the
  // legacy "agentic-operator · RAAS" mock that used to ship in dev.
  const activeTenant =
    tenants.find((t) => t.id === activeSlug) ?? tenants[0] ?? null;
  const [name, setName] = useState(activeTenant?.id ?? activeSlug);
  const [display, setDisplay] = useState(activeTenant?.name ?? activeSlug);
  // Region is a placeholder for the future deploy-region selector — no
  // /v1/region API exists yet. Seed from NEXT_PUBLIC_AGENTIC_REGION if the
  // operator has pinned one, otherwise show "Not configured" so the UI
  // doesn't pretend the workspace is anchored in a specific region.
  const initialRegion =
    (process.env.NEXT_PUBLIC_AGENTIC_REGION ?? "").trim() || "Not configured";
  const [region, setRegion] = useState(initialRegion);
  const [tenant, setTenant] = useState(activeSlug);
  const [accent, setAccent] = useState(activeTenant?.color ?? "#d0ff00");
  const [retention, setRetention] = useState("30");
  const [piiMask, setPiiMask] = useState(true);
  const [strict, setStrict] = useState(false);

  // The tenants list is async — re-seed once it lands so the form shows the
  // resolved active tenant rather than the initial slug fallback.
  useEffect(() => {
    if (!activeTenant) return;
    setName(activeTenant.id);
    setDisplay(activeTenant.name);
    setTenant(activeTenant.id);
    if (activeTenant.color) setAccent(activeTenant.color);
  }, [activeTenant?.id, activeTenant?.name, activeTenant?.color]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <Panel title={t("workspace.panelWorkspace")} padded>
        <Field
          label={t("workspace.workspaceId")}
          hint={t("workspace.workspaceIdHint")}
          locked
        >
          <TextIn value={name} mono onChange={setName} />
        </Field>
        <Field label={t("workspace.displayName")} hint={t("workspace.displayNameHint")}>
          <TextIn value={display} onChange={setDisplay} />
        </Field>
        <Field
          label={t("workspace.region")}
          hint={t("workspace.regionHint")}
        >
          <SelectIn
            value={region}
            onChange={setRegion}
            options={[
              "Not configured",
              "cn-shenzhen-1",
              "cn-shanghai-2",
              "cn-beijing-3",
              "ap-singapore-1",
              "us-east-1",
            ]}
          />
        </Field>
        <Field
          label={t("workspace.timezone")}
          hint={t("workspace.timezoneHint")}
        >
          <SelectIn value={timezone} onChange={setTimezone} options={TIMEZONES} />
        </Field>
        <Field
          label={t("workspace.locale")}
          hint={t("workspace.localeHint")}
        >
          <SelectIn value={locale} onChange={setLocale} options={LOCALES} />
        </Field>
        <Field
          label={t("workspace.defaultTenant")}
          hint={t("workspace.defaultTenantHint")}
        >
          <SelectIn
            value={tenant}
            onChange={setTenant}
            options={tenants.map((t) => ({ value: t.id, label: t.name }))}
          />
        </Field>
        <Field
          label={t("workspace.accentColor")}
          hint={t("workspace.accentColorHint")}
        >
          <div style={{ display: "flex", gap: 6 }}>
            {ACCENTS.map((a) => (
              <button
                key={a.value}
                onClick={() => setAccent(a.value)}
                aria-label={t(`workspace.${a.id}`)}
                style={{
                  width: 24,
                  height: 24,
                  borderRadius: 4,
                  background: a.value,
                  border: `2px solid ${accent === a.value ? "var(--text)" : "transparent"}`,
                  cursor: "pointer",
                }}
              />
            ))}
          </div>
        </Field>
      </Panel>

      <Panel title={t("workspace.panelDataRetention")} padded>
        <Field
          label={t("workspace.runEventRetention")}
          hint={t("workspace.runEventRetentionHint")}
        >
          <div style={{ display: "flex", gap: 8 }}>
            <TextIn value={retention} mono suffix={t("workspace.days")} onChange={setRetention} />
          </div>
        </Field>
        <Field
          label={t("workspace.maskPii")}
          hint={t("workspace.maskPiiHint")}
        >
          <Toggle value={piiMask} onChange={setPiiMask} />
        </Field>
        <Field
          label={t("workspace.strictSchema")}
          hint={t("workspace.strictSchemaHint")}
        >
          <Toggle value={strict} onChange={setStrict} />
        </Field>
      </Panel>

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <Button tone="ghost">{t("workspace.discard")}</Button>
        <Button tone="primary" icon="check">
          {t("workspace.saveChanges")}
        </Button>
      </div>
    </div>
  );
}
