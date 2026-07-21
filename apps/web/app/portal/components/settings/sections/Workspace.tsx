"use client";

/**
 * Settings → Workspace.
 *
 * Tenant name/color persist through PUT /v1/tenants/:slug. Timezone and
 * locale persist through the existing browser preference endpoint. Fields
 * without a backend contract are rendered as read-only status, never as
 * controls that imply a successful save.
 */

import { useEffect, useMemo, useState } from "react";
import { Button, Empty, Panel } from "@/app/portal/components";
import {
  Field,
  SelectIn,
  TextIn,
} from "@/app/portal/components/settings/atoms";
import { LOCALES, TIMEZONES } from "@/app/portal/components/settings/data";
import { useDirty } from "@/app/portal/lib/dirty-context";
import { useI18n } from "@/app/portal/lib/preferences-context";
import { useTenant } from "@/app/portal/lib/use-tenant";
import { useTenants, useUpdateTenant } from "@/lib/hooks/useTenants";
import { useWorkspace } from "@/lib/hooks/useWorkspace";

const ACCENTS = [
  { value: "#d0ff00", id: "lime" },
  { value: "#5deeff", id: "cyan" },
  { value: "#ffb547", id: "amber" },
  { value: "#b594ff", id: "violet" },
];

const DEFAULT_ACCENT = ACCENTS[0]!.value;

export function WorkspaceSection() {
  const { t } = useI18n();
  const activeSlug = useTenant();
  const tenantsQuery = useTenants();
  const update = useUpdateTenant();
  const dirty = useDirty();
  const { timezone, locale, setTimezone, setLocale } = useWorkspace();
  const activeTenant = useMemo(
    () =>
      tenantsQuery.data?.items.find(
        (tenant) => tenant.slug === activeSlug && tenant.archivedAt == null,
      ) ?? null,
    [activeSlug, tenantsQuery.data?.items],
  );

  const [displayName, setDisplayName] = useState(activeSlug);
  const [accent, setAccent] = useState(DEFAULT_ACCENT);
  const [baseline, setBaseline] = useState({
    slug: activeSlug,
    displayName: activeSlug,
    accent: DEFAULT_ACCENT,
  });
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!activeTenant) return;
    const next = {
      slug: activeTenant.slug,
      displayName: activeTenant.name,
      accent: activeTenant.color ?? DEFAULT_ACCENT,
    };
    setDisplayName(next.displayName);
    setAccent(next.accent);
    setBaseline(next);
    setError(null);
    setSaved(false);
  }, [activeTenant?.slug, activeTenant?.name, activeTenant?.color]);

  const identityDirty =
    baseline.slug === activeSlug &&
    (displayName.trim() !== baseline.displayName || accent !== baseline.accent);

  useEffect(() => {
    dirty.setDirty(
      "workspace-identity",
      identityDirty ? t("workspaceSection.dirtyIdentity") : null,
    );
    return () => dirty.setDirty("workspace-identity", null);
  }, [dirty, identityDirty]);

  function discardIdentity() {
    setDisplayName(baseline.displayName);
    setAccent(baseline.accent);
    setError(null);
    setSaved(false);
  }

  async function saveIdentity() {
    const name = displayName.trim();
    if (!name) {
      setError(t("workspaceSection.nameRequired"));
      return;
    }
    setError(null);
    setSaved(false);
    try {
      const result = await update.mutateAsync({
        slug: activeSlug,
        patch: { name, color: accent },
      });
      const next = {
        slug: result.slug,
        displayName: result.name,
        accent: result.color ?? DEFAULT_ACCENT,
      };
      setDisplayName(next.displayName);
      setAccent(next.accent);
      setBaseline(next);
      setSaved(true);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : t("workspaceSection.saveFailed"),
      );
    }
  }

  const region =
    (process.env.NEXT_PUBLIC_AGENTIC_REGION ?? "").trim() || t("workspaceSection.notConfigured");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <Panel
        title={t("workspaceSection.identityTitle")}
        subtitle={t("workspaceSection.identitySubtitle")}
        padded
      >
        {tenantsQuery.isLoading && (
          <div
            style={{ padding: "18px 0", color: "var(--text-3)", fontSize: 12 }}
          >
            {t("workspaceSection.loadingTenant")}
          </div>
        )}
        {tenantsQuery.isError && (
          <Empty
            title={t("workspaceSection.unavailableTitle")}
            hint={t("workspaceSection.unavailableHint")}
          />
        )}
        {activeTenant && (
          <>
            <Field
              label={t("workspace.workspaceId")}
              hint={t("workspaceSection.workspaceIdHint")}
              locked
            >
              <ReadOnlyValue value={activeTenant.slug} mono />
            </Field>
            <Field
              label={t("workspace.displayName")}
              hint={t("workspaceSection.displayNameHint")}
            >
              <TextIn
                value={displayName}
                onChange={(value) => {
                  setDisplayName(value);
                  setSaved(false);
                }}
                ariaLabel={t("workspaceSection.displayNameAria")}
              />
            </Field>
            <Field
              label={t("workspaceSection.accentLabel")}
              hint={t("workspaceSection.accentHint")}
            >
              <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
                {ACCENTS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => {
                      setAccent(option.value);
                      setSaved(false);
                    }}
                    aria-label={t(`workspaceSection.accent.${option.id}`)}
                    aria-pressed={accent === option.value}
                    title={t(`workspaceSection.accent.${option.id}`)}
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: 5,
                      background: option.value,
                      border: `2px solid ${accent === option.value ? "var(--text)" : "var(--border-2)"}`,
                      cursor: "pointer",
                    }}
                  />
                ))}
              </div>
            </Field>
            {(error || saved) && (
              <div
                role={error ? "alert" : "status"}
                style={{
                  marginTop: 12,
                  color: error ? "var(--red)" : "var(--green)",
                  fontSize: 12,
                }}
              >
                {error ?? t("workspaceSection.saved")}
              </div>
            )}
            <div
              style={{
                display: "flex",
                justifyContent: "flex-end",
                gap: 8,
                marginTop: 14,
              }}
            >
              <Button
                tone="ghost"
                onClick={discardIdentity}
                disabled={!identityDirty}
              >
                {t("common.discard")}
              </Button>
              <Button
                tone="primary"
                icon="check"
                onClick={() => void saveIdentity()}
                disabled={!identityDirty || update.isPending}
              >
                {update.isPending ? t("common.saving") : t("workspaceSection.saveIdentity")}
              </Button>
            </div>
          </>
        )}
      </Panel>

      <Panel
        title={t("workspaceSection.regionalTitle")}
        subtitle={t("workspaceSection.regionalSubtitle")}
        padded
      >
        <Field
          label={t("workspace.region")}
          hint={t("workspaceSection.regionHint")}
          locked
        >
          <ReadOnlyValue value={region} mono />
        </Field>
        <Field
          label={t("workspaceSection.timezone")}
          hint={t("workspaceSection.browserPreferenceHint")}
        >
          <SelectIn
            value={timezone}
            onChange={setTimezone}
            options={TIMEZONES}
            ariaLabel={t("workspaceSection.timezoneAria")}
          />
        </Field>
        <Field label={t("workspaceSection.locale")} hint={t("workspaceSection.browserPreferenceHint")}>
          <SelectIn
            value={locale}
            onChange={setLocale}
            options={LOCALES.map((option) => ({
              ...option,
              label: t(`workspaceSection.localeOption.${option.value}`),
            }))}
            ariaLabel={t("workspaceSection.localeAria")}
          />
        </Field>
      </Panel>

      <Panel
        title={t("workspaceSection.runtimeTitle")}
        subtitle={t("workspaceSection.runtimeSubtitle")}
        padded
      >
        <Field
          label={t("workspaceSection.retentionLabel")}
          hint={t("workspaceSection.retentionHint")}
          locked
        >
          <ReadOnlyValue value={t("workspaceSection.managedByRuntime")} />
        </Field>
      </Panel>
    </div>
  );
}

function ReadOnlyValue({ value, mono }: { value: string; mono?: boolean }) {
  return (
    <div
      aria-readonly="true"
      className={mono ? "mono" : undefined}
      style={{
        padding: "7px 9px",
        border: "1px solid var(--border)",
        borderRadius: 5,
        background: "var(--panel-2)",
        color: "var(--text-2)",
        fontSize: 12.5,
      }}
    >
      {value}
    </div>
  );
}
