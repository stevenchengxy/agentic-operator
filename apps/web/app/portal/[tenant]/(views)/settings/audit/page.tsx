"use client";

/**
 * Settings → Audit deep-link route (P3-FE-05).
 *
 * Renders the same `AuditSection` that lives behind the in-page section
 * switch — but at its own URL so refresh + browser navigation work.
 * Shares a small header with the Usage sub-route for visual consistency.
 */

import Link from "next/link";
import { Button, ViewHeader } from "@/app/portal/components";
import { useI18n } from "@/app/portal/lib/preferences-context";
import { useTenant } from "@/app/portal/lib/use-tenant";
import { AuditSection } from "@/app/portal/components/settings/sections/Audit";

export default function AuditPage() {
  const { t } = useI18n();
  const tenant = useTenant();
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <ViewHeader
        title={t("auditSection.pageTitle")}
        subtitle={t("auditSection.pageSubtitle")}
        action={
          <Link
            href={`/portal/${tenant}/settings` as never}
            style={{ textDecoration: "none" }}
          >
            <Button small icon="chevron-left" tone="ghost">
              {t("auditSection.backSettings")}
            </Button>
          </Link>
        }
      />
      <div style={{ flex: 1, overflow: "auto", minHeight: 0 }}>
        <div style={{ padding: 24, maxWidth: 1180 }}>
          <AuditSection />
        </div>
      </div>
    </div>
  );
}
