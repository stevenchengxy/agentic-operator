"use client";

/**
 * 智能体运行日志 — one row per agent run (GET /v1/runs). Shows when, which
 * agent, status, subject, duration. Clicking a row opens the run detail page
 * where the per-run execution log streams live over SSE
 * (/v1/runs/:id/logs?follow=1) — the deep "this run's steps" log.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Badge,
  Button,
  Empty,
  StatusDot,
  type StatusName,
} from "@/app/portal/components";
import { useI18n } from "@/app/portal/lib/preferences-context";
import { useTenant } from "@/app/portal/lib/use-tenant";
import { useRunsPaged, type RunListRow } from "@/lib/hooks/useRuns";
import { fmtDur, fmtNum } from "@/lib/format";
import {
  LogPane,
  LogSearch,
  MetaPill,
  TimeCell,
  tdStyle,
  thStyle,
  monoStyle,
} from "./shared";

const STATUS_SET = new Set<StatusName>([
  "running",
  "ok",
  "failed",
  "waiting",
  "cancelled",
  "paused",
  "idle",
]);
function toStatus(s: string | null | undefined): StatusName {
  if (s === "queued") return "waiting";
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
  const [page, setPage] = useState(1);
  const pageSize = 100;
  const query = useRunsPaged({ page, pageSize, q: q.trim() || undefined });
  const rows = query.data?.rows ?? [];
  const total = query.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <LogPane
      toolbar={
        <>
          <LogSearch
            value={q}
            onChange={(value) => {
              setQ(value);
              setPage(1);
            }}
            placeholder={t("logsExplorer.runSearch")}
          />
          <MetaPill>{t("runs.pageOf", { page, pages, total })}</MetaPill>
        </>
      }
    >
      {query.isError ? (
        <Empty
          title={t("logsExplorer.loadFailed")}
          hint={query.error?.message ?? ""}
        />
      ) : rows.length === 0 && !query.isLoading ? (
        <Empty
          title={t("logsExplorer.runEmpty")}
          hint={t("logsExplorer.runEmptyHint")}
        />
      ) : (
        <div>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={{ ...thStyle, width: 90 }}>
                  {t("logsExplorer.colTime")}
                </th>
                <th style={thStyle}>{t("logsExplorer.colAgent")}</th>
                <th style={{ ...thStyle, width: 120 }}>
                  {t("logsExplorer.colStatus")}
                </th>
                <th style={thStyle}>{t("logsExplorer.colSubject")}</th>
                <th style={{ ...thStyle, width: 90 }}>
                  {t("logsExplorer.colDuration")}
                </th>
                <th style={{ ...thStyle, width: 100 }}>
                  {t("logsExplorer.totalTokens")}
                </th>
                <th style={{ ...thStyle, width: 70 }} />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.id}
                  onClick={() =>
                    router.push(`/portal/${tenant}/runs/${r.id}` as never)
                  }
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      router.push(`/portal/${tenant}/runs/${r.id}` as never);
                    }
                  }}
                  tabIndex={0}
                  style={{ cursor: "pointer" }}
                >
                  <td style={tdStyle}>
                    <TimeCell ms={startedMs(r)} />
                  </td>
                  <td style={tdStyle}>
                    <span style={{ fontSize: 12, color: "var(--text)" }}>
                      {r.agentName ?? "—"}
                    </span>
                    {r.testRun && (
                      <Badge tone="violet" style={{ marginLeft: 6 }}>
                        {t("logsExplorer.testRun")}
                      </Badge>
                    )}
                  </td>
                  <td style={tdStyle}>
                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 6,
                      }}
                    >
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
                  <td style={tdStyle}>
                    <span style={monoStyle}>
                      {r.tokensIn == null && r.tokensOut == null
                        ? "—"
                        : fmtNum((r.tokensIn ?? 0) + (r.tokensOut ?? 0))}
                    </span>
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
          {total > pageSize && (
            <div
              style={{
                padding: "10px 14px",
                borderTop: "1px solid var(--border)",
                display: "flex",
                justifyContent: "flex-end",
                alignItems: "center",
                gap: 8,
              }}
            >
              <Button
                small
                disabled={page <= 1 || query.isFetching}
                onClick={() => setPage((value) => Math.max(1, value - 1))}
              >
                {t("runs.prevPage")}
              </Button>
              <Button
                small
                disabled={page >= pages || query.isFetching}
                onClick={() => setPage((value) => Math.min(pages, value + 1))}
              >
                {t("runs.nextPage")}
              </Button>
            </div>
          )}
        </div>
      )}
    </LogPane>
  );
}
