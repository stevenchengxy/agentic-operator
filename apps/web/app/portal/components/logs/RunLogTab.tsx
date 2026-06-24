"use client";

/**
 * 智能体运行日志 — one row per agent run (GET /v1/runs). Shows when, which
 * agent, status, subject, duration. Clicking a row opens the run detail page
 * where the per-run execution log streams live over SSE
 * (/v1/runs/:id/logs?follow=1) — the deep "this run's steps" log.
 */

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Badge, Empty, StatusDot, type StatusName } from "@/app/portal/components";
import { useI18n } from "@/app/portal/lib/preferences-context";
import { useTenant } from "@/app/portal/lib/use-tenant";
import { useRuns, type RunListRow } from "@/lib/hooks/useRuns";
import { fmtDur } from "@/lib/format";
import { LogPane, LogSearch, MetaPill, TimeCell, tdStyle, thStyle, monoStyle } from "./shared";

const STATUS_SET = new Set<StatusName>(["running", "ok", "failed", "waiting", "paused", "idle"]);
function toStatus(s: string | null | undefined): StatusName {
  if (s === "queued") return "waiting";
  if (s === "cancelled") return "paused";
  return s && STATUS_SET.has(s as StatusName) ? (s as StatusName) : "idle";
}

function startedMs(r: RunListRow): number {
  return r.startedAt ? Date.parse(r.startedAt) : 0;
}

export function RunLogTab() {
  const { t } = useI18n();
  const router = useRouter();
  const tenant = useTenant();
  const [q, setQ] = useState("");
  const query = useRuns({ limit: 300 });
  const rows = query.data ?? [];

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter(
      (r) =>
        (r.agentName ?? "").toLowerCase().includes(needle) ||
        (r.subject ?? "").toLowerCase().includes(needle) ||
        (r.status ?? "").toLowerCase().includes(needle),
    );
  }, [rows, q]);

  return (
    <LogPane
      toolbar={
        <>
          <LogSearch value={q} onChange={setQ} placeholder={t("logsExplorer.runSearch")} />
          <MetaPill>{t("logsExplorer.rowCount", { n: filtered.length })}</MetaPill>
        </>
      }
    >
      {query.isError ? (
        <Empty title={t("logsExplorer.loadFailed")} hint={query.error?.message ?? ""} />
      ) : rows.length === 0 && !query.isLoading ? (
        <Empty title={t("logsExplorer.runEmpty")} hint={t("logsExplorer.runEmptyHint")} />
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={{ ...thStyle, width: 90 }}>{t("logsExplorer.colTime")}</th>
              <th style={thStyle}>{t("logsExplorer.colAgent")}</th>
              <th style={{ ...thStyle, width: 120 }}>{t("logsExplorer.colStatus")}</th>
              <th style={thStyle}>{t("logsExplorer.colSubject")}</th>
              <th style={{ ...thStyle, width: 90 }}>{t("logsExplorer.colDuration")}</th>
              <th style={{ ...thStyle, width: 70 }} />
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <tr
                key={r.id}
                onClick={() => router.push(`/portal/${tenant}/runs/${r.id}` as never)}
                style={{ cursor: "pointer" }}
              >
                <td style={tdStyle}>
                  <TimeCell ms={startedMs(r)} />
                </td>
                <td style={tdStyle}>
                  <span style={{ fontSize: 12, color: "var(--text)" }}>{r.agentName ?? "—"}</span>
                  {r.testRun && (
                    <Badge tone="violet" style={{ marginLeft: 6 }}>
                      {t("logsExplorer.testRun")}
                    </Badge>
                  )}
                </td>
                <td style={tdStyle}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                    <StatusDot status={toStatus(r.status)} size={6} />
                    <span style={monoStyle}>{r.status ?? "—"}</span>
                  </span>
                </td>
                <td style={tdStyle}>
                  <span style={monoStyle}>{r.subject ?? "—"}</span>
                </td>
                <td style={tdStyle}>
                  <span style={monoStyle}>{fmtDur(r.durationMs)}</span>
                </td>
                <td style={{ ...tdStyle, textAlign: "right" }}>
                  <span style={{ ...monoStyle, color: "var(--accent-text)" }}>
                    {t("logsExplorer.openLog")} →
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </LogPane>
  );
}
