"use client";

/**
 * 事件日志 — the chronological event ledger (GET /v1/events). Each row is one
 * fired event: when, what, on which subject, who emitted it (source agent or
 * external), and its category. Complements the richer Events view (this is the
 * flat, filterable log feed).
 */

import { useMemo, useState } from "react";
import { Badge, Empty, type BadgeTone } from "@/app/portal/components";
import { useI18n } from "@/app/portal/lib/preferences-context";
import { useEvents, type EventRow } from "@/lib/hooks/useEvents";
import { LogPane, LogSearch, MetaPill, TimeCell, tdStyle, thStyle, monoStyle } from "./shared";

const COLOR_TONE: Record<string, BadgeTone> = {
  green: "green",
  blue: "blue",
  amber: "amber",
  red: "red",
  violet: "violet",
  signal: "signal",
  muted: "muted",
};

function eventTone(c: string | null): BadgeTone {
  return COLOR_TONE[c ?? ""] ?? "muted";
}

function rowMs(r: EventRow): number {
  return r.receivedAt ? Date.parse(r.receivedAt) : 0;
}

export function EventLogTab() {
  const { t } = useI18n();
  const [q, setQ] = useState("");
  const query = useEvents({ limit: 300 });
  const rows = query.data ?? [];

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter(
      (r) =>
        r.name.toLowerCase().includes(needle) ||
        (r.subject ?? "").toLowerCase().includes(needle) ||
        (r.sourceAgentName ?? "").toLowerCase().includes(needle),
    );
  }, [rows, q]);

  return (
    <LogPane
      toolbar={
        <>
          <LogSearch value={q} onChange={setQ} placeholder={t("logsExplorer.evSearch")} />
          <MetaPill>{t("logsExplorer.rowCount", { n: filtered.length })}</MetaPill>
        </>
      }
    >
      {query.isError ? (
        <Empty title={t("logsExplorer.loadFailed")} hint={query.error?.message ?? ""} />
      ) : rows.length === 0 && !query.isLoading ? (
        <Empty title={t("logsExplorer.evEmpty")} hint={t("logsExplorer.evEmptyHint")} />
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={{ ...thStyle, width: 90 }}>{t("logsExplorer.colTime")}</th>
              <th style={thStyle}>{t("logsExplorer.colEvent")}</th>
              <th style={thStyle}>{t("logsExplorer.colSubject")}</th>
              <th style={thStyle}>{t("logsExplorer.colSource")}</th>
              <th style={{ ...thStyle, width: 110 }}>{t("logsExplorer.colCategory")}</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <tr key={r.id}>
                <td style={tdStyle}>
                  <TimeCell ms={rowMs(r)} />
                </td>
                <td style={tdStyle}>
                  <Badge tone={eventTone(r.color)}>{r.name}</Badge>
                </td>
                <td style={tdStyle}>
                  <span style={monoStyle}>{r.subject ?? "—"}</span>
                </td>
                <td style={tdStyle}>
                  {r.sourceAgentName ? (
                    <span style={{ fontSize: 12, color: "var(--text-2)" }}>
                      {r.sourceAgentTitle || r.sourceAgentName}
                    </span>
                  ) : (
                    <span style={monoStyle}>{t("logsExplorer.sourceExternal")}</span>
                  )}
                </td>
                <td style={tdStyle}>
                  <span style={monoStyle}>{r.category ?? "—"}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </LogPane>
  );
}
