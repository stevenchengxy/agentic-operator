"use client";

/**
 * Sidebar — fixed-width left rail (232px). v1_1 app.jsx:108-164.
 *
 * Top to bottom: Logo + version, TenantSwitcher, 3 nav groups (Run / Observe
 * / Manage), footer status dots (Inngest + SQLite).
 *
 * Live + count pills are derived from canonical TanStack Query hooks:
 *   - Agents nav count: `useAgents().length`
 *   - Runs nav liveCount: `useRuns` filtered to running
 *   - Tasks nav count: `useTasks().length`
 *
 * The host layout passes in the resolved tenant list so we don't refetch.
 */

import { useMemo } from "react";
import { useTenant } from "../../lib/use-tenant";
import { useAgents } from "@/lib/hooks/useAgents";
import { useRuns } from "@/lib/hooks/useRuns";
import { useTasks } from "@/lib/hooks/useTasks";
import { useHealth, fmtBytes } from "@/lib/hooks/useHealth";
import {
  useDemoStatus,
  useStartDemo,
  useStopDemo,
} from "@/lib/hooks/useDemoMode";
import { StatusDot } from "../atoms";
import { Logo } from "./logo";
import { NavGroup, NavItem } from "./nav";
import { TenantSwitcher, type TenantOption } from "./tenant-switcher";
import { useI18n } from "../../lib/preferences-context";

export interface SidebarProps {
  tenants: TenantOption[];
  version?: string;
}

export function Sidebar({ tenants, version = "v0.6.2" }: SidebarProps) {
  const tenantSlug = useTenant();
  const base = `/portal/${tenantSlug}`;
  const { t } = useI18n();
  const { data: agents = [] } = useAgents();
  const { data: runs = [] } = useRuns({ limit: 200 });
  const { data: tasks = [] } = useTasks();
  // Live health from /health — replaces the previously hardcoded
  // "3w · 0 lag" Inngest meta and "8.4 MB" SQLite meta in the footer so
  // both rows reflect real runtime status.
  const { data: health } = useHealth();

  const runningCount = useMemo(
    () => runs.filter((r) => r.status === "running").length,
    [runs],
  );

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
            {/* 2026-05-26 — clickable demo toggle. Reads runtime state from
              * `/v1/demo/status` (NOT just the env flag in /health) so the
              * pill reflects what's actually running in-process. Click flips
              * via `/v1/demo/{start,stop}`. Production stays clean when
              * demo is OFF: the muted "Demo" outline only appears on
              * hover; the lime DEMO pill is only shown when actively
              * running. */}
            <DemoToggle />
          </span>
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
            href={`${base}/agents`}
            icon="agent"
            label={t("nav.agents")}
            count={agents.length || null}
            matchPrefix
          />
          <NavItem
            href={`${base}/runs`}
            icon="run"
            label={t("nav.runs")}
            liveCount={runningCount}
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
            count={tasks.length || null}
            highlight={tasks.length > 0}
            matchPrefix
          />
          <NavItem href={`${base}/logs`} icon="logs" label={t("nav.logs")} />
        </NavGroup>
        <NavGroup label={t("nav.group.manage")}>
          <NavItem
            href={`${base}/deployments`}
            icon="deploy"
            label={t("nav.deployments")}
          />
          <NavItem
            href={`${base}/tools`}
            icon="code"
            label={t("nav.tools")}
            matchPrefix
          />
          <NavItem
            href={`${base}/tenants`}
            icon="agent"
            label={t("nav.tenants")}
            matchPrefix
          />
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

/**
 * Demo toggle — clickable pill that starts or stops the synthetic-traffic
 * loop. Reads runtime state from `/v1/demo/status` (so it reflects what
 * actually IS running, not just the boot-time env flag).
 *
 *   - Idle    → small muted "Demo" outline. Click starts demo.
 *   - Running → lime DEMO pill. Click stops demo.
 *   - Pending → faded mid-action.
 *
 * Token-burn safety: the backend swaps `LLM_DEFAULT_PROVIDER` to `mock`
 * inside `POST /v1/demo/start` and restores it on stop — see
 * `apps/api/src/routes/v1/demo.ts`. So clicking Start NEVER burns real
 * tokens via the demo loop, regardless of how `.env` is configured.
 */
function DemoToggle() {
  const { data: status } = useDemoStatus();
  const start = useStartDemo();
  const stop = useStopDemo();
  const running = status?.running ?? false;
  const pending = start.isPending || stop.isPending;

  const onClick = () => {
    if (pending) return;
    if (running) stop.mutate();
    else start.mutate();
  };

  const stats = status?.stats;
  const title = running
    ? `Demo ON — provider=${status?.llmProvider ?? "?"}, events fired=${stats?.eventsFired ?? 0}. Click to stop.`
    : `Demo OFF. Click to start the synthetic-traffic loop (LLM auto-swapped to mock; no real tokens spent).`;

  if (running) {
    return (
      <button
        type="button"
        onClick={onClick}
        disabled={pending}
        title={title}
        style={{
          display: "inline-flex",
          alignItems: "center",
          background: "#d0ff00",
          color: "#0b0b0c",
          fontSize: 9,
          fontWeight: 700,
          letterSpacing: "0.08em",
          padding: "2px 6px",
          borderRadius: 4,
          fontFamily: "var(--mono)",
          textTransform: "uppercase",
          lineHeight: 1,
          border: "none",
          cursor: pending ? "wait" : "pointer",
          opacity: pending ? 0.6 : 1,
        }}
      >
        {pending ? "…" : "DEMO ON"}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={pending}
      title={title}
      style={{
        display: "inline-flex",
        alignItems: "center",
        background: "transparent",
        color: "var(--text-3)",
        fontSize: 9,
        fontWeight: 600,
        letterSpacing: "0.08em",
        padding: "2px 6px",
        borderRadius: 4,
        fontFamily: "var(--mono)",
        textTransform: "uppercase",
        lineHeight: 1,
        border: "1px solid var(--border)",
        cursor: pending ? "wait" : "pointer",
        opacity: pending ? 0.6 : 1,
      }}
    >
      {pending ? "…" : "DEMO"}
    </button>
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
