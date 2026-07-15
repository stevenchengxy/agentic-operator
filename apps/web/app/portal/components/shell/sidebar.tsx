"use client";

/**
 * Sidebar — compact 64px icon rail that expands to 232px without reflowing
 * the active portal view.
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

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type PointerEvent,
} from "react";
import { createPortal } from "react-dom";
import { useTenant } from "../../lib/use-tenant";
import { useAgents } from "@/lib/hooks/useAgents";
import { useRuns } from "@/lib/hooks/useRuns";
import { useTasks } from "@/lib/hooks/useTasks";
import { useHealth, fmtBytes } from "@/lib/hooks/useHealth";
import { StatusDot } from "../atoms";
import { Icon } from "../Icon";
import { Logo } from "./logo";
import { NavGroup, NavItem } from "./nav";
import { TenantSwitcher, type TenantOption } from "./tenant-switcher";
import styles from "./sidebar.module.css";

export interface SidebarProps {
  tenants: TenantOption[];
  version?: string;
}

export function Sidebar({ tenants, version = "v0.6.2" }: SidebarProps) {
  const [hoverOpen, setHoverOpen] = useState(false);
  const [focusOpen, setFocusOpen] = useState(false);
  const [pinnedOpen, setPinnedOpen] = useState(false);
  const [tooltip, setTooltip] = useState<{
    text: string;
    top: number;
    left: number;
  } | null>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tenantSlug = useTenant();
  const base = `/portal/${tenantSlug}`;
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
  const expanded = pinnedOpen || hoverOpen || focusOpen;

  function clearTimer(timer: typeof openTimer) {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }

  function handlePointerEnter(event: PointerEvent<HTMLElement>) {
    if (event.pointerType === "touch" || pinnedOpen) return;
    clearTimer(closeTimer);
    clearTimer(openTimer);
    // The brief tooltip gets a moment to orient users before the full rail
    // opens. Moving through the app chrome therefore feels intentional,
    // rather than making the navigation flash on every incidental pass.
    openTimer.current = setTimeout(() => setHoverOpen(true), 420);
  }

  function handlePointerLeave(event: PointerEvent<HTMLElement>) {
    if (event.pointerType === "touch") return;
    clearTimer(openTimer);
    clearTimer(closeTimer);
    setTooltip(null);
    closeTimer.current = setTimeout(() => setHoverOpen(false), 140);
  }

  function handleFocus(event: FocusEvent<HTMLElement>) {
    clearTimer(closeTimer);
    // Keep the pin control stationary until its activation completes. If
    // focus expanded the rail first, the button would jump from the compact
    // rail edge to the expanded edge between pointer-down and click, causing
    // the first click to miss. Keyboard users can still press Enter/Space to
    // pin the rail, after which all labels are visible.
    if (
      event.target instanceof Element &&
      event.target.closest("[data-sidebar-pin]")
    ) {
      return;
    }
    setFocusOpen(true);
    setTooltip(null);
    // Focus is delegated at the aside, so every link expands the rail before
    // its visible focus ring is drawn. This keeps keyboard navigation legible.
  }

  function handleBlur(event: FocusEvent<HTMLElement>) {
    const next = event.relatedTarget;
    if (!next || !event.currentTarget.contains(next as Node)) {
      setFocusOpen(false);
    }
  }

  function handlePointerOver(event: PointerEvent<HTMLElement>) {
    if (expanded || !(event.target instanceof Element)) return;
    const target = event.target.closest<HTMLElement>("[data-sidebar-tooltip]");
    if (!target || !event.currentTarget.contains(target)) return;
    const text = target.dataset.sidebarTooltip;
    if (!text) return;
    const rect = target.getBoundingClientRect();
    setTooltip({
      text,
      top: rect.top + rect.height / 2,
      left: rect.right + 8,
    });
  }

  function handlePointerOut(event: PointerEvent<HTMLElement>) {
    if (!(event.target instanceof Element)) return;
    const target = event.target.closest<HTMLElement>("[data-sidebar-tooltip]");
    if (!target) return;
    if (
      event.relatedTarget instanceof Node &&
      target.contains(event.relatedTarget)
    ) {
      return;
    }
    setTooltip(null);
  }

  useEffect(
    () => () => {
      if (openTimer.current) clearTimeout(openTimer.current);
      if (closeTimer.current) clearTimeout(closeTimer.current);
    },
    [],
  );

  return (
    <>
      <aside
        className={styles.sidebar}
        data-expanded={expanded}
        aria-label="Primary navigation"
        onPointerEnter={handlePointerEnter}
        onPointerLeave={handlePointerLeave}
        onPointerOver={handlePointerOver}
        onPointerOut={handlePointerOut}
        onFocusCapture={handleFocus}
        onBlurCapture={handleBlur}
      >
        {/* Logo block */}
        <div className={styles.header}>
          <span className={styles.brandLogo} aria-hidden="true">
            <Logo />
          </span>
          <div className={styles.brandText}>
            <span className={styles.brandName}>
              Agentic Operator
              {/* Demo is an environment-controlled operating mode. Production
               * never exposes a control that can start synthetic traffic; the
               * badge is read-only and only appears when the API explicitly
               * reports demoMode=true from /health. */}
              {health?.demoMode === true ? <DemoBadge /> : null}
            </span>
            <span className={styles.brandVersion}>{version}</span>
          </div>
          <button
            type="button"
            className={styles.pinButton}
            aria-label={
              pinnedOpen
                ? "Return navigation to automatic collapse"
                : "Keep navigation open"
            }
            aria-pressed={pinnedOpen}
            aria-expanded={expanded}
            data-sidebar-pin
            data-sidebar-tooltip={
              pinnedOpen
                ? "Use automatic collapse"
                : expanded
                  ? "Keep navigation open"
                  : "Open navigation"
            }
            onClick={() => {
              setTooltip(null);
              setPinnedOpen((value) => !value);
              if (pinnedOpen) setHoverOpen(false);
            }}
          >
            <Icon
              name={pinnedOpen ? "chevron-left" : "chevron-right"}
              size={13}
            />
          </button>
        </div>

        <TenantSwitcher
          tenants={tenants}
          expanded={expanded}
          onRequestExpand={() => {
            setTooltip(null);
            setPinnedOpen(true);
          }}
        />

        <nav className={styles.nav} aria-label="Portal sections">
          <NavGroup label="Run">
            <NavItem
              href={`${base}/dashboard`}
              icon="dashboard"
              label="Dashboard"
            />
            <NavItem
              href={`${base}/workflows`}
              icon="workflow"
              label="Workflows"
            />
            <NavItem
              href={`${base}/agents`}
              icon="agent"
              label="Agents"
              count={agents.length || null}
              matchPrefix
            />
            <NavItem
              href={`${base}/runs`}
              icon="run"
              label="Runs"
              liveCount={runningCount}
              matchPrefix
            />
          </NavGroup>
          <NavGroup label="Observe">
            <NavItem
              href={`${base}/events`}
              icon="event"
              label="Events"
              matchPrefix
            />
            <NavItem
              href={`${base}/tasks`}
              icon="task"
              label="Human tasks"
              count={tasks.length || null}
              highlight={tasks.length > 0}
              matchPrefix
            />
            <NavItem href={`${base}/logs`} icon="logs" label="Logs" />
          </NavGroup>
          <NavGroup label="Manage">
            <NavItem
              href={`${base}/deployments`}
              icon="deploy"
              label="Deployments"
            />
            <NavItem
              href={`${base}/system-check`}
              icon="check"
              label="System check"
              matchPrefix
            />
            <NavItem
              href={`${base}/tools`}
              icon="code"
              label="Agentic Tools"
              matchPrefix
            />
            <NavItem
              href={`${base}/tenants`}
              icon="agent"
              label="Tenants"
              matchPrefix
            />
            <NavItem
              href={`${base}/settings`}
              icon="settings"
              label="Settings"
              matchPrefix
            />
          </NavGroup>
        </nav>

        <footer className={styles.footer} aria-label="System status">
          <FooterRow
            status={inngestStatus}
            label="Inngest"
            meta={inngestMeta}
          />
          <FooterRow status={sqliteStatus} label="SQLite" meta={sqliteMeta} />
        </footer>
      </aside>
      {!expanded && tooltip && typeof document !== "undefined"
        ? createPortal(
            <div
              role="tooltip"
              className={styles.sidebarTooltip}
              style={{ top: tooltip.top, left: tooltip.left }}
            >
              {tooltip.text}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

/** Read-only signal for the boot-time AGENTIC_DEMO_MODE setting. */
function DemoBadge() {
  return (
    <span
      title="Demo mode is enabled by the server environment."
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
      }}
    >
      DEMO
    </span>
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
      className={styles.footerRow}
      aria-label={`${label}: ${meta}`}
      data-sidebar-tooltip={`${label}: ${meta}`}
    >
      <StatusDot status={status} size={6} />
      <span className={styles.footerLabel}>{label}</span>
      <span className={styles.footerMeta}>{meta}</span>
    </div>
  );
}
