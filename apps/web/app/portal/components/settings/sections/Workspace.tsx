"use client";

/** Workspace identity is read from the live tenant API. */

import { Empty, Panel } from "@/app/portal/components";
import { Field } from "@/app/portal/components/settings/atoms";
import { useTenants } from "@/lib/hooks/useTenants";
import { useTenant } from "@/app/portal/lib/use-tenant";
import { useI18n } from "@/app/portal/lib/preferences-context";

export function WorkspaceSection() {
  const { t } = useI18n();
  const tenantsQuery = useTenants();
  const activeSlug = useTenant();
  const activeTenant = tenantsQuery.data?.items.find((tenant) => tenant.slug === activeSlug) ?? null;
  const region = (process.env.NEXT_PUBLIC_AGENTIC_REGION ?? "").trim() || "—";

  if (tenantsQuery.isLoading && !tenantsQuery.data) {
    return <Empty title={t("workspace.loading")} hint="" />;
  }
  if (tenantsQuery.isError) {
    return (
      <Empty
        title={t("workspace.loadFailed")}
        hint={tenantsQuery.error.message}
      />
    );
  }
  if (!activeTenant) {
    return (
      <Empty
        title={t("workspace.notFound")}
        hint={activeSlug}
      />
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <Panel title={t("workspace.panelWorkspace")} padded>
        <Field
          label={t("workspace.workspaceId")}
          hint={t("workspace.workspaceIdHint")}
          locked
        >
          <ReadOnlyValue mono>{activeTenant.slug}</ReadOnlyValue>
        </Field>
        <Field label={t("workspace.displayName")} hint={t("workspace.displayNameHint")}>
          <ReadOnlyValue>{activeTenant.name}</ReadOnlyValue>
        </Field>
        <Field
          label={t("workspace.region")}
          hint={t("workspace.regionHint")}
        >
          <ReadOnlyValue mono>{region}</ReadOnlyValue>
        </Field>
      </Panel>
    </div>
  );
}

function ReadOnlyValue({ children, mono = false }: { children: React.ReactNode; mono?: boolean }) {
  return (
    <div
      className={mono ? "mono" : undefined}
      style={{
        minHeight: 32,
        display: "flex",
        alignItems: "center",
        color: "var(--text)",
        fontSize: 12.5,
      }}
    >
      {children}
    </div>
  );
}
