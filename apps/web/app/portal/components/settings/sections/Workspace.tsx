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
import { useTenant } from "@/app/portal/lib/use-tenant";
import { useTenants, useUpdateTenant } from "@/lib/hooks/useTenants";
import { useWorkspace } from "@/lib/hooks/useWorkspace";

const ACCENTS = [
  { value: "#d0ff00", label: "Lime" },
  { value: "#5deeff", label: "Cyan" },
  { value: "#ffb547", label: "Amber" },
  { value: "#b594ff", label: "Violet" },
];

const DEFAULT_ACCENT = ACCENTS[0]!.value;

export function WorkspaceSection() {
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
      identityDirty ? "workspace name or color" : null,
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
      setError("Display name cannot be blank.");
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
          : "The workspace identity could not be saved.",
      );
    }
  }

  const region =
    (process.env.NEXT_PUBLIC_AGENTIC_REGION ?? "").trim() || "Not configured";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <Panel
        title="Workspace identity"
        subtitle="Name and accent are stored on the active tenant record."
        padded
      >
        {tenantsQuery.isLoading && (
          <div
            style={{ padding: "18px 0", color: "var(--text-3)", fontSize: 12 }}
          >
            Loading the active tenant…
          </div>
        )}
        {tenantsQuery.isError && (
          <Empty
            title="Workspace data is unavailable"
            hint="The tenant API could not be reached, so identity controls are disabled."
          />
        )}
        {activeTenant && (
          <>
            <Field
              label="Workspace ID"
              hint="Used in URLs and API endpoints. The slug is immutable."
              locked
            >
              <ReadOnlyValue value={activeTenant.slug} mono />
            </Field>
            <Field
              label="Display name"
              hint="Shown in the tenant switcher and audit log."
            >
              <TextIn
                value={displayName}
                onChange={(value) => {
                  setDisplayName(value);
                  setSaved(false);
                }}
                ariaLabel="Workspace display name"
              />
            </Field>
            <Field
              label="Accent color"
              hint="Stored on the tenant and used by tenant identity surfaces."
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
                    aria-label={`${option.label} accent`}
                    aria-pressed={accent === option.value}
                    title={option.label}
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
                {error ?? "Workspace identity saved."}
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
                Discard
              </Button>
              <Button
                tone="primary"
                icon="check"
                onClick={() => void saveIdentity()}
                disabled={!identityDirty || update.isPending}
              >
                {update.isPending ? "Saving…" : "Save identity"}
              </Button>
            </div>
          </>
        )}
      </Panel>

      <Panel
        title="Regional preferences"
        subtitle="Timezone and locale are browser preferences and save immediately."
        padded
      >
        <Field
          label="Region"
          hint="Deployment configuration. This UI cannot change worker or storage region."
          locked
        >
          <ReadOnlyValue value={region} mono />
        </Field>
        <Field
          label="Timezone"
          hint="Saved to this browser through /api/prefs."
        >
          <SelectIn
            value={timezone}
            onChange={setTimezone}
            options={TIMEZONES}
            ariaLabel="Workspace timezone"
          />
        </Field>
        <Field label="Locale" hint="Saved to this browser through /api/prefs.">
          <SelectIn
            value={locale}
            onChange={setLocale}
            options={LOCALES}
            ariaLabel="Workspace locale"
          />
        </Field>
      </Panel>

      <Panel
        title="Runtime policy"
        subtitle="Retention, PII masking, and strict schema policy are not configurable from Settings yet."
        padded
      >
        <Field
          label="Retention & privacy"
          hint="No tenant policy API is installed. Runtime defaults remain in effect."
          locked
        >
          <ReadOnlyValue value="Managed by runtime configuration" />
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
