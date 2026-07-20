"use client";

/**
 * Sidebar — fixed-width left rail (232px). v1_1 app.jsx:108-164.
 *
 * Top to bottom: Logo + version, TenantSwitcher, 3 nav groups (Run / Observe
 * / Manage), footer status dots (Inngest + SQLite).
 *
 * Live + count pills come from GET /v1/counts. Unlike list-query lengths,
 * these tenant-wide totals are not truncated by pagination and `openTasks`
 * excludes resolved work.
 *
 * The host layout passes in the resolved tenant list so we don't refetch.
 */

import { useMemo } from "react";
import { useTenant } from "../../lib/use-tenant";
import { useCounts } from "@/lib/hooks/useAgents";
import { useHealth, fmtBytes } from "@/lib/hooks/useHealth";
import { useCan } from "@/lib/hooks/useMe";
import { StatusDot } from "../atoms";
import { Logo } from "./logo";
import { NavGroup, NavItem } from "./nav";
import { TenantSwitcher, type TenantOption } from "./tenant-switcher";
import { useI18n } from "../../lib/preferences-context";
import { reasoningAgentHref } from "@/lib/reasoning-workspace";

export interface SidebarProps {
  tenants: TenantOption[];
  version?: string;
}

export function Sidebar({
  tenants,
  version = (process.env.NEXT_PUBLIC_APP_VERSION ?? "").trim(),
}: SidebarProps) {
  const tenantSlug = useTenant();
  const base = `/portal/${tenantSlug}`;
  const { t } = useI18n();
  const can = useCan();
  const { data: counts } = useCounts();
  // Live health from /health — replaces the previously hardcoded
  // "3w · 0 lag" Inngest meta and "8.4 MB" SQLite meta in the footer so
  // both rows reflect real runtime status.
  const { data: health } = useHealth();

  const inngestMeta = useMemo(() => {
    if (!health?.inngest) return "checking…";
    if (health.inngest.note) return health.inngest.note;
    return health.inngest.reachable ? "reachable" : "unreachable";
  }, [health?.inngest]);
  const inngestStatus: "ok" | "failed" = health?.inngest?.ok ? "ok" : "failed";
  const sqliteMeta = useMemo(() => {
    if (!health?.sqlite) return "checking…";
    return fmtBytes(health.sqlite.sizeBytes);
  }, [health?.sqlite]);
  const sqliteStatus: "ok" | "failed" = health?.sqlite?.ok ? "ok" : "failed";

  return (
    <aside
      style={{
        background: "var(--bg-2)",
        borderRight: "1px solid var(--border)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        gridArea: "side",
      }}
    >
      {/* Logo block */}
      <div
        style={{
          padding: "16px 18px 14px 18px",
          display: "flex",
          alignItems: "center",
          gap: 10,
          borderBottom: "1px solid var(--border)",
        }}
      >
        <Logo />
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            lineHeight: 1.15,
            minWidth: 0,
            flex: 1,
          }}
        >
          <span
            style={{
              fontSize: 13,
              color: "var(--text)",
              fontWeight: 600,
              letterSpacing: "-0.01em",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            Agentic Operator
          </span>
          {version && (
            <span
              style={{
                fontSize: 10,
                color: "var(--text-3)",
                fontFamily: "var(--mono)",
                letterSpacing: "0.06em",
                marginTop: 2,
              }}
            >
              {version}
            </span>
          )}
        </div>
      </div>

      <TenantSwitcher tenants={tenants} />

      <nav style={{ padding: "10px 8px", flex: 1, overflow: "auto" }}>
        <NavGroup label={t("nav.group.run")}>
          <NavItem
            href={`${base}/dashboard`}
            icon="dashboard"
            label={t("nav.dashboard")}
          />
          <NavItem
            href={`${base}/workflows`}
            icon="workflow"
            label={t("nav.workflows")}
          />
          <NavItem
            href={reasoningAgentHref(tenantSlug)}
            icon="spark"
            label={t("nav.reasoningAgent")}
            matchPrefix
          />
          <NavItem
            href={`${base}/agents`}
            icon="agent"
            label={t("nav.agents")}
            count={counts?.agents || null}
            matchPrefix
          />
          <NavItem
            href={`${base}/runs`}
            icon="run"
            label={t("nav.runs")}
            liveCount={counts?.runningRuns ?? 0}
            matchPrefix
          />
        </NavGroup>
        <NavGroup label={t("nav.group.observe")}>
          <NavItem
            href={`${base}/events`}
            icon="event"
            label={t("nav.events")}
            matchPrefix
          />
          <NavItem
            href={`${base}/tasks`}
            icon="task"
            label={t("nav.tasks")}
            count={counts?.openTasks || null}
            highlight={(counts?.openTasks ?? 0) > 0}
            matchPrefix
          />
          <NavItem href={`${base}/logs`} icon="logs" label={t("nav.logs")} />
          <NavItem
            href={`${base}/reasoning`}
            icon="spark"
            label={t("nav.reasoning")}
            matchPrefix
          />
        </NavGroup>
        <NavGroup label={t("nav.group.manage")}>
          <NavItem
            href={`${base}/factory`}
            icon="spark"
            label={t("nav.factory")}
            matchPrefix
          />
          <NavItem
            href={`${base}/deployments`}
            icon="deploy"
            label={t("nav.deployments")}
          />
          <NavItem
            href={`${base}/tools`}
            icon="library"
            label={t("nav.toolLibrary")}
            matchPrefix
          />
          <NavItem
            href={`${base}/tenants`}
            icon="agent"
            label={t("nav.tenants")}
            matchPrefix
          />
          {/* P6-AUTH — Access & roles. Shown only to tenant admins (members.read)
           * and platform superadmins; viewers/operators never see it. */}
          {can("members.read") ? (
            <NavItem
              href={`${base}/access`}
              icon="human"
              label={t("nav.access")}
              matchPrefix
            />
          ) : null}
          <NavItem
            href={`${base}/settings`}
            icon="settings"
            label={t("nav.settings")}
            matchPrefix
          />
        </NavGroup>
      </nav>

      <footer
        style={{
          padding: "12px 16px",
          borderTop: "1px solid var(--border)",
          display: "flex",
          flexDirection: "column",
          gap: 6,
        }}
      >
        <FooterRow status={inngestStatus} label="Inngest" meta={inngestMeta} />
        <FooterRow status={sqliteStatus} label="SQLite" meta={sqliteMeta} />
      </footer>
    </aside>
  );
}

function FooterRow({
  status,
  label,
  meta,
}: {
  status: "ok" | "failed";
  label: string;
  meta: string;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        fontSize: 11,
        minWidth: 0,
      }}
    >
      <StatusDot status={status} size={6} />
      <span
        style={{
          color: "var(--text-2)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          minWidth: 0,
          flex: 1,
        }}
      >
        {label}
      </span>
      <span
        style={{
          color: "var(--text-3)",
          fontFamily: "var(--mono)",
          whiteSpace: "nowrap",
          fontSize: 10,
        }}
      >
        {meta}
      </span>
    </div>
  );
}
