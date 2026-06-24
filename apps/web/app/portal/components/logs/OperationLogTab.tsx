"use client";

/**
 * 操作日志 — the tenant audit_log (deploys, agent enable/disable, archive,
 * restore, …) read from GET /v1/audit. Read-only; rows are written by the
 * mutating routes via `writeAudit`.
 */

import { useMemo, useState } from "react";
import { Badge, Empty, type BadgeTone } from "@/app/portal/components";
import { useI18n } from "@/app/portal/lib/preferences-context";
import { useAudit, type AuditRow } from "@/lib/hooks/useAudit";
import {
  LogPane,
  LogSearch,
  MetaPill,
  TimeCell,
  tdStyle,
  thStyle,
  monoStyle,
} from "./shared";

/** Color the action by its domain prefix + intent. */
function actionTone(action: string): BadgeTone {
  if (/\.(disable|archive|delete|rollback|reject)$/.test(action)) return "amber";
  if (/\.(enable|restore|deploy|create|approve)$/.test(action)) return "green";
  if (action.startsWith("tenant.")) return "blue";
  if (action.startsWith("manifest.") || action.startsWith("deployment."))
    return "signal";
  return "muted";
}

/** Compact one-line summary of the audit meta JSON. */
function metaSummary(row: AuditRow): string {
  const m = row.meta ?? {};
  const parts: string[] = [];
  for (const k of ["kebabId", "version", "slug", "diff", "kind", "note", "reason"]) {
    const v = (m as Record<string, unknown>)[k];
    if (v == null) continue;
    parts.push(`${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`);
  }
  return parts.join(" · ").slice(0, 160);
}

export function OperationLogTab() {
  const { t } = useI18n();
  const [q, setQ] = useState("");
  const query = useAudit({ limit: 300 });
  const rows = query.data?.items ?? [];

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter(
      (r) =>
        r.action.toLowerCase().includes(needle) ||
        (r.targetId ?? "").toLowerCase().includes(needle) ||
        (r.targetType ?? "").toLowerCase().includes(needle) ||
        metaSummary(r).toLowerCase().includes(needle),
    );
  }, [rows, q]);

  return (
    <LogPane
      toolbar={
        <>
          <LogSearch
            value={q}
            onChange={setQ}
            placeholder={t("logsExplorer.opSearch")}
          />
          <MetaPill>
            {t("logsExplorer.rowCount", { n: filtered.length })}
          </MetaPill>
        </>
      }
    >
      {query.isError ? (
        <Empty title={t("logsExplorer.loadFailed")} hint={query.error?.message ?? ""} />
      ) : rows.length === 0 && !query.isLoading ? (
        <Empty title={t("logsExplorer.opEmpty")} hint={t("logsExplorer.opEmptyHint")} />
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={{ ...thStyle, width: 90 }}>{t("logsExplorer.colTime")}</th>
              <th style={thStyle}>{t("logsExplorer.colAction")}</th>
              <th style={thStyle}>{t("logsExplorer.colTarget")}</th>
              <th style={thStyle}>{t("logsExplorer.colActor")}</th>
              <th style={thStyle}>{t("logsExplorer.colDetails")}</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <tr key={r.id}>
                <td style={tdStyle}>
                  <TimeCell ms={r.at} />
                </td>
                <td style={tdStyle}>
                  <Badge tone={actionTone(r.action)}>{r.action}</Badge>
                </td>
                <td style={tdStyle}>
                  {r.targetType ? (
                    <span style={monoStyle}>
                      {r.targetType}
                      {r.targetId ? `:${r.targetId.slice(0, 18)}` : ""}
                    </span>
                  ) : (
                    <span style={monoStyle}>—</span>
                  )}
                </td>
                <td style={tdStyle}>
                  <span style={monoStyle}>
                    {r.actorUserId ? r.actorUserId.slice(0, 16) : t("logsExplorer.actorSystem")}
                  </span>
                </td>
                <td style={{ ...tdStyle, color: "var(--text-3)", fontFamily: "var(--mono)", fontSize: 11 }}>
                  {metaSummary(r) || "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </LogPane>
  );
}
