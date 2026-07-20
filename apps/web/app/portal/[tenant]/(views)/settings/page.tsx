"use client";

/**
 * Settings view — tenant administration and capability status.
 *
 * Sections:
 *   1. Workspace (name, slug, timezone, locale, accent)
 *   2. People & roles
 *   3. AI & models (routing, gateway connections, catalog, test lab)
 *   4. Channels
 *   5. Integrations
 *   6. Notifications
 *   7. API tokens
 *   8. Billing / Cost caps
 *   9. Usage & cost (routed view)
 *  10. Audit log (reads `/v1/audit`)
 *
 * Ported from `apps/web/public/portal/views/settings.jsx` (2303 LOC) with
 * timezone wired through to the new `useWorkspace()` hook (P2-FE-27).
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Badge, Icon, ViewHeader } from "@/app/portal/components";
import { useTenant } from "@/app/portal/lib/use-tenant";
import { useDirty } from "@/app/portal/lib/dirty-context";
import { useSession } from "@/app/portal/lib/session-context";
import {
  SETTINGS_SECTIONS,
  type SettingsSectionId,
} from "@/app/portal/components/settings/data";
import { WorkspaceSection } from "@/app/portal/components/settings/sections/Workspace";
import { PeopleSection } from "@/app/portal/components/settings/sections/People";
import { AISection } from "@/app/portal/components/settings/sections/AI";
import { ChannelsSection } from "@/app/portal/components/settings/sections/Channels";
import { IntegrationsSection } from "@/app/portal/components/settings/sections/Integrations";
import { NotificationsSection } from "@/app/portal/components/settings/sections/Notifications";
import { TokensSection } from "@/app/portal/components/settings/sections/Tokens";
import { BillingSection } from "@/app/portal/components/settings/sections/Billing";
import { AuditSection } from "@/app/portal/components/settings/sections/Audit";

// P3-FE-03 / P3-FE-05 — these section ids deep-link to their own sub-routes
// instead of being rendered inline (the views are too heavy to live in the
// 9-section switch). Clicking the sidebar entry pushes the URL; refresh +
// browser back/forward work.
const ROUTED_SECTIONS: Record<string, string> = {
  usage: "usage",
  audit: "audit",
};

// Region label for the workspace subtitle. Comes from
// `NEXT_PUBLIC_AGENTIC_REGION` so prod/staging can differ. **No fake
// fallback** — if the env var isn't set we show "—" so the operator
// doesn't read a region they didn't deploy to (the prior default was
// "cn-shenzhen-1", which actively misled non-China deployments).
const REGION = (process.env.NEXT_PUBLIC_AGENTIC_REGION ?? "").trim() || "—";

export default function SettingsPage() {
  const [section, setSection] = useState<SettingsSectionId>("workspace");
  const sec =
    SETTINGS_SECTIONS.find((s) => s.id === section) ?? SETTINGS_SECTIONS[0];
  const router = useRouter();
  const tenant = useTenant();
  const dirty = useDirty();
  const session = useSession();
  const operatorName = session?.name ?? "—";

  function pick(id: SettingsSectionId) {
    if (id === section) return;
    if (dirty.isDirty()) {
      const detail = dirty.describe();
      const confirmed = window.confirm(
        `You have unsaved changes${detail ? ` (${detail})` : ""}. Leave this settings section anyway? Your draft will be lost.`,
      );
      if (!confirmed) return;
    }
    const sub = ROUTED_SECTIONS[id];
    if (sub) {
      router.push(`/portal/${tenant}/settings/${sub}` as never);
      return;
    }
    setSection(id);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <ViewHeader
        title="Settings"
        subtitle={
          <>
            Workspace{" "}
            <span className="mono" style={{ color: "var(--text)" }}>
              {tenant}
            </span>{" "}
            · region{" "}
            <span className="mono" style={{ color: "var(--text)" }}>
              {REGION}
            </span>{" "}
            · operator{" "}
            <span style={{ color: "var(--text)" }}>{operatorName}</span>
          </>
        }
        badge={<Badge tone="muted">v0.6.2</Badge>}
      />

      <div
        className="settings-layout"
        style={{
          flex: 1,
          display: "grid",
          gridTemplateColumns: "232px 1fr",
          minHeight: 0,
        }}
      >
        <aside
          className="settings-sidebar"
          style={{
            borderRight: "1px solid var(--border)",
            overflow: "auto",
            padding: "14px 10px",
            background: "var(--bg-2)",
          }}
        >
          {SETTINGS_SECTIONS.map((s) => (
            <SectionNavItem
              key={s.id}
              section={s}
              active={s.id === section}
              onClick={() => pick(s.id)}
            />
          ))}
        </aside>

        <div
          className="settings-content"
          style={{ overflow: "auto", minHeight: 0 }}
        >
          <div
            style={{ padding: 24, maxWidth: section === "ai" ? 1320 : 1080 }}
          >
            <SectionHeader section={sec} />
            {section === "workspace" && <WorkspaceSection />}
            {section === "people" && <PeopleSection />}
            {section === "ai" && <AISection />}
            {section === "channels" && <ChannelsSection />}
            {section === "integrations" && <IntegrationsSection />}
            {section === "notifications" && <NotificationsSection />}
            {section === "tokens" && <TokensSection />}
            {section === "billing" && <BillingSection />}
            {section === "audit" && <AuditSection />}
          </div>
        </div>
      </div>
    </div>
  );
}

function SectionNavItem({
  section,
  active,
  onClick,
}: {
  section: (typeof SETTINGS_SECTIONS)[number];
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className="settings-nav-item"
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        width: "100%",
        padding: "8px 10px",
        marginBottom: 2,
        background: active ? "var(--panel-2)" : "transparent",
        borderLeft: `2px solid ${active ? "var(--signal)" : "transparent"}`,
        borderRadius: 4,
        textAlign: "left",
        cursor: "pointer",
        transition: "background 0.1s",
      }}
    >
      <Icon
        name={section.icon}
        size={13}
        style={{ color: active ? "var(--text)" : "var(--text-3)" }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 12.5,
            color: active ? "var(--text)" : "var(--text-2)",
            fontWeight: active ? 500 : 400,
          }}
        >
          {section.label}
        </div>
        <div
          style={{
            fontSize: 10,
            color: "var(--text-3)",
            marginTop: 1,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {section.hint}
        </div>
      </div>
    </button>
  );
}

function SectionHeader({
  section,
}: {
  section: (typeof SETTINGS_SECTIONS)[number];
}) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 4,
        }}
      >
        <Icon
          name={section.icon}
          size={14}
          style={{ color: "var(--signal)" }}
        />
        <span
          style={{
            fontSize: 11,
            fontFamily: "var(--mono)",
            textTransform: "uppercase",
            letterSpacing: "0.1em",
            color: "var(--text-3)",
          }}
        >
          Settings · {section.label}
        </span>
      </div>
      <h2
        style={{
          margin: 0,
          fontSize: 26,
          fontFamily: "var(--display)",
          fontWeight: 400,
          letterSpacing: "-0.01em",
          color: "var(--text)",
        }}
      >
        {section.label}
      </h2>
      <div style={{ marginTop: 4, fontSize: 12.5, color: "var(--text-2)" }}>
        {section.hint}
      </div>
    </div>
  );
}
