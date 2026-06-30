"use client";

/**
 * 事件日志 — the chronological event ledger (GET /v1/events). Each row is one
 * fired event: when, what, on which subject, who emitted it (source agent or
 * external), and its category. Complements the richer Events view (this is the
 * flat, filterable log feed).
 */

import { Fragment, useMemo, useState } from "react";
import { Badge, Empty, StatusDot, type BadgeTone, type StatusName } from "@/app/portal/components";
import { useI18n } from "@/app/portal/lib/preferences-context";
import { useEvents, useEvent, type EventRow } from "@/lib/hooks/useEvents";
import {
  LogPane,
  LogSearch,
  MetaPill,
  TimeCell,
  ExpandCaret,
  DetailCell,
  Field,
  JsonView,
  tdStyle,
  thStyle,
  monoStyle,
} from "./shared";

const STATUS_TO_DOT: Record<string, StatusName> = {
  running: "running",
  queued: "waiting",
  waiting: "waiting",
  ok: "ok",
  failed: "failed",
  cancelled: "paused",
  paused: "paused",
  idle: "idle",
};

/** Expanded detail for one event — fetches the REAL payload + consumers. */
function EventDetail({ id, fallback }: { id: string; fallback: EventRow }) {
  const { t } = useI18n();
  const { data, isLoading, isError, error } = useEvent(id);
  const ev = data ?? fallback;
  const consumers = ev.consumers ?? [];
  return (
    <>
      <Field label={t("logsExplorer.colEvent")}>{ev.name}</Field>
      <Field label="ID">{ev.id}</Field>
      <Field label={t("logsExplorer.colSubject")}>{ev.subject ?? "—"}</Field>
      <Field label={t("logsExplorer.colSource")}>
        {ev.sourceAgentTitle || ev.sourceAgentName || t("logsExplorer.sourceExternal")}
      </Field>
      <Field label={t("logsExplorer.colCategory")}>{ev.category ?? "—"}</Field>
      <div>
        <div
          style={{
            fontSize: 9.5,
            fontFamily: "var(--mono)",
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            color: "var(--text-3)",
            marginBottom: 4,
          }}
        >
          {t("logsExplorer.consumers")} ({consumers.length})
        </div>
        {consumers.length === 0 ? (
          <span style={{ ...monoStyle, color: "var(--text-4)" }}>
            {t("logsExplorer.noConsumers")}
          </span>
        ) : (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {consumers.map((c) => (
              <span
                key={c.runId}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 5,
                  padding: "2px 8px",
                  border: "1px solid var(--border)",
                  borderRadius: 5,
                  fontSize: 11,
                  fontFamily: "var(--mono)",
                  color: "var(--text-2)",
                }}
              >
                <StatusDot status={STATUS_TO_DOT[c.status] ?? "idle"} size={6} />
                {c.agentTitle || c.agentName || c.runId}
              </span>
            ))}
          </div>
        )}
      </div>
      {isError ? (
        <span style={{ ...monoStyle, color: "var(--red)" }}>
          {t("logsExplorer.payloadError")}: {error?.message ?? ""}
        </span>
      ) : (
        <JsonView
          label={isLoading ? t("logsExplorer.payloadLoading") : t("logsExplorer.fullPayload")}
          value={ev.payload}
        />
      )}
    </>
  );
}

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
  const [open, setOpen] = useState<Set<string>>(new Set());
  const query = useEvents({ limit: 300 });
  const rows = query.data ?? [];

  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

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
              <th style={{ ...thStyle, width: 28 }} />
              <th style={{ ...thStyle, width: 90 }}>{t("logsExplorer.colTime")}</th>
              <th style={thStyle}>{t("logsExplorer.colEvent")}</th>
              <th style={thStyle}>{t("logsExplorer.colSubject")}</th>
              <th style={thStyle}>{t("logsExplorer.colSource")}</th>
              <th style={{ ...thStyle, width: 110 }}>{t("logsExplorer.colCategory")}</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => {
              const isOpen = open.has(r.id);
              return (
                <Fragment key={r.id}>
                  <tr
                    onClick={() => toggle(r.id)}
                    style={{ cursor: "pointer" }}
                    className={isOpen ? undefined : "hover-row"}
                  >
                    <td style={{ ...tdStyle, textAlign: "center" }}>
                      <ExpandCaret open={isOpen} />
                    </td>
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
                  {isOpen && (
                    <DetailCell colSpan={6}>
                      <EventDetail id={r.id} fallback={r} />
                    </DetailCell>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}
    </LogPane>
  );
}
