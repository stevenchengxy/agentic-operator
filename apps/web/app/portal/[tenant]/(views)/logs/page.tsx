"use client";

/**
 * Logs — unified logging + observability explorer.
 *
 *   操作日志  Operation  — the tenant audit_log (deploys, enable/disable,
 *                          archive, …) via GET /v1/audit.
 *   事件日志  Event      — the chronological event ledger via GET /v1/events.
 *   运行日志  Agent run  — agent run rows (+ per-run SSE tail link) via
 *                          GET /v1/runs and the run detail page.
 *   实时终端  Terminal   — a live `tail -f`-style console of ALL tenant
 *                          activity over the /v1/stream SSE channel.
 *   Token 消耗 Usage     — persisted token/cost totals, trends and run rows.
 *   智能体调用 Calls     — verified parent/event-driven agent call edges.
 *   统计分析  Analytics  — reliability, latency, throughput and anomalies.
 *
 * Each facet is a focused tab component; the shell owns tab state + the live
 * pill. Replaces the previous "Log explorer pending" placeholder.
 */

import type { KeyboardEvent } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ViewHeader } from "@/app/portal/components";
import { useI18n } from "@/app/portal/lib/preferences-context";
import { OperationLogTab } from "@/app/portal/components/logs/OperationLogTab";
import { EventLogTab } from "@/app/portal/components/logs/EventLogTab";
import { RunLogTab } from "@/app/portal/components/logs/RunLogTab";
import { TerminalLogTab } from "@/app/portal/components/logs/TerminalLogTab";
import { TokenUsageLogTab } from "@/app/portal/components/logs/TokenUsageLogTab";
import { AgentCallsLogTab } from "@/app/portal/components/logs/AgentCallsLogTab";
import { AnalyticsLogTab } from "@/app/portal/components/logs/AnalyticsLogTab";

type LogTab = "operation" | "event" | "run" | "terminal" | "tokens" | "calls" | "analytics";

const TABS: Array<{ id: LogTab; labelKey: string }> = [
  { id: "operation", labelKey: "logsExplorer.tabOperation" },
  { id: "event", labelKey: "logsExplorer.tabEvent" },
  { id: "run", labelKey: "logsExplorer.tabRun" },
  { id: "terminal", labelKey: "logsExplorer.tabTerminal" },
  { id: "tokens", labelKey: "logsExplorer.tabTokens" },
  { id: "calls", labelKey: "logsExplorer.tabCalls" },
  { id: "analytics", labelKey: "logsExplorer.tabAnalytics" },
];

export default function LogsPage() {
  const { t } = useI18n();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const requestedTab = searchParams.get("tab");
  const tab: LogTab = TABS.some((item) => item.id === requestedTab)
    ? (requestedTab as LogTab)
    : "operation";

  function selectTab(next: LogTab) {
    const params = new URLSearchParams(searchParams.toString());
    if (next === "operation") params.delete("tab");
    else params.set("tab", next);
    const query = params.toString();
    router.replace(`${pathname}${query ? `?${query}` : ""}` as never, {
      scroll: false,
    });
  }

  function onTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, current: LogTab) {
    const index = TABS.findIndex((item) => item.id === current);
    let nextIndex = index;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % TABS.length;
    else if (event.key === "ArrowLeft") nextIndex = (index - 1 + TABS.length) % TABS.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = TABS.length - 1;
    else return;
    event.preventDefault();
    const next = TABS[nextIndex]!.id;
    selectTab(next);
    requestAnimationFrame(() => document.getElementById(`logs-tab-${next}`)?.focus());
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <ViewHeader title={t("nav.logs")} subtitle={t("logsExplorer.subtitle")} />

      {/* Tab bar */}
      <div
        role="tablist"
        aria-label={t("logsExplorer.tabListLabel")}
        style={{
          display: "flex",
          gap: 0,
          borderBottom: "1px solid var(--border)",
          padding: "0 24px",
          flexShrink: 0,
          overflowX: "auto",
          overflowY: "hidden",
        }}
      >
        {TABS.map((tb) => (
          <button
            key={tb.id}
            id={`logs-tab-${tb.id}`}
            role="tab"
            type="button"
            aria-selected={tab === tb.id}
            aria-controls="logs-active-panel"
            tabIndex={tab === tb.id ? 0 : -1}
            onClick={() => selectTab(tb.id)}
            onKeyDown={(event) => onTabKeyDown(event, tb.id)}
            style={{
              padding: "10px 16px",
              fontSize: 12,
              fontFamily: "var(--mono)",
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              color: tab === tb.id ? "var(--text)" : "var(--text-3)",
              borderBottom: `2px solid ${tab === tb.id ? "var(--signal)" : "transparent"}`,
              marginBottom: -1,
              cursor: "pointer",
              background: "none",
              whiteSpace: "nowrap",
              flexShrink: 0,
            }}
          >
            {t(tb.labelKey)}
          </button>
        ))}
      </div>

      {/* Active facet */}
      <div
        id="logs-active-panel"
        role="tabpanel"
        aria-labelledby={`logs-tab-${tab}`}
        style={{ flex: 1, minHeight: 0, overflow: "hidden", display: "flex" }}
      >
        {tab === "operation" && <OperationLogTab />}
        {tab === "event" && <EventLogTab />}
        {tab === "run" && <RunLogTab />}
        {tab === "terminal" && <TerminalLogTab />}
        {tab === "tokens" && <TokenUsageLogTab />}
        {tab === "calls" && <AgentCallsLogTab />}
        {tab === "analytics" && <AnalyticsLogTab />}
      </div>
    </div>
  );
}
