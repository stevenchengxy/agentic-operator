"use client";

/**
 * Logs — unified 4-facet logging explorer.
 *
 *   操作日志  Operation  — the tenant audit_log (deploys, enable/disable,
 *                          archive, …) via GET /v1/audit.
 *   事件日志  Event      — the chronological event ledger via GET /v1/events.
 *   运行日志  Agent run  — agent run rows (+ per-run SSE tail link) via
 *                          GET /v1/runs and the run detail page.
 *   实时终端  Terminal   — a live `tail -f`-style console of ALL tenant
 *                          activity over the /v1/stream SSE channel.
 *
 * Each facet is a focused tab component; the shell owns tab state + the live
 * pill. Replaces the previous "Log explorer pending" placeholder.
 */

import { useState } from "react";
import { ViewHeader } from "@/app/portal/components";
import { useI18n } from "@/app/portal/lib/preferences-context";
import { OperationLogTab } from "@/app/portal/components/logs/OperationLogTab";
import { EventLogTab } from "@/app/portal/components/logs/EventLogTab";
import { RunLogTab } from "@/app/portal/components/logs/RunLogTab";
import { TerminalLogTab } from "@/app/portal/components/logs/TerminalLogTab";

type LogTab = "operation" | "event" | "run" | "terminal";

const TABS: Array<{ id: LogTab; labelKey: string }> = [
  { id: "operation", labelKey: "logsExplorer.tabOperation" },
  { id: "event", labelKey: "logsExplorer.tabEvent" },
  { id: "run", labelKey: "logsExplorer.tabRun" },
  { id: "terminal", labelKey: "logsExplorer.tabTerminal" },
];

export default function LogsPage() {
  const { t } = useI18n();
  const [tab, setTab] = useState<LogTab>("operation");

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <ViewHeader title={t("nav.logs")} subtitle={t("logsExplorer.subtitle")} />

      {/* Tab bar */}
      <div
        style={{
          display: "flex",
          gap: 0,
          borderBottom: "1px solid var(--border)",
          padding: "0 24px",
          flexShrink: 0,
        }}
      >
        {TABS.map((tb) => (
          <button
            key={tb.id}
            onClick={() => setTab(tb.id)}
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
            }}
          >
            {t(tb.labelKey)}
          </button>
        ))}
      </div>

      {/* Active facet */}
      <div style={{ flex: 1, minHeight: 0, overflow: "hidden", display: "flex" }}>
        {tab === "operation" && <OperationLogTab />}
        {tab === "event" && <EventLogTab />}
        {tab === "run" && <RunLogTab />}
        {tab === "terminal" && <TerminalLogTab />}
      </div>
    </div>
  );
}
