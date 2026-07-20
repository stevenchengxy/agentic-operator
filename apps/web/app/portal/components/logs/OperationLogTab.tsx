"use client";

/**
 * 操作日志 — the tenant audit_log (deploys, agent enable/disable, archive,
 * restore, …) read from GET /v1/audit. Read-only; rows are written by the
 * mutating routes via `writeAudit`.
 */

import { Fragment, useMemo, useState } from "react";
import { Badge, Button, Empty, type BadgeTone } from "@/app/portal/components";
import { useI18n } from "@/app/portal/lib/preferences-context";
import { useAuditPages, type AuditRow } from "@/lib/hooks/useAudit";
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

/** A 403 from the admin-only `audit.read` permission, vs a real error. */
function isPermissionError(msg: string | undefined): boolean {
  if (!msg) return false;
  return /forbidden|unauthorized|permission|audit\.read|403/i.test(msg);
}

/** Color the action by its domain prefix + intent. */
function actionTone(action: string): BadgeTone {
  if (/\.(disable|archive|delete|rollback|reject)$/.test(action))
    return "amber";
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
  for (const k of [
    "kebabId",
    "version",
    "slug",
    "diff",
    "kind",
    "note",
    "reason",
  ]) {
    const v = (m as Record<string, unknown>)[k];
    if (v == null) continue;
    parts.push(`${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`);
  }
  return parts.join(" · ").slice(0, 160);
}

export function OperationLogTab() {
  const { t } = useI18n();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const query = useAuditPages({ limit: 300 });
  const rows = useMemo(
    () => query.data?.pages.flatMap((page) => page.items) ?? [],
    [query.data],
  );
  const hasOlder = query.hasNextPage;

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
            {q.trim()
              ? t("logsExplorer.filteredRecentRows", {
                  n: filtered.length,
                  total: rows.length,
                })
              : hasOlder
                ? t("logsExplorer.recentRowCount", { n: rows.length })
                : t("logsExplorer.rowCount", { n: rows.length })}
          </MetaPill>
        </>
      }
    >
      {query.isError ? (
        <Empty
          title={
            isPermissionError(query.error?.message)
              ? t("logsExplorer.opForbidden")
              : t("logsExplorer.loadFailed")
          }
          hint={
            isPermissionError(query.error?.message)
              ? t("logsExplorer.opForbiddenHint")
              : (query.error?.message ?? "")
          }
        />
      ) : rows.length === 0 && !query.isLoading ? (
        <Empty
          title={t("logsExplorer.opEmpty")}
          hint={t("logsExplorer.opEmptyHint")}
        />
      ) : (
        <div>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={{ ...thStyle, width: 28 }} />
                <th style={{ ...thStyle, width: 90 }}>
                  {t("logsExplorer.colTime")}
                </th>
                <th style={thStyle}>{t("logsExplorer.colAction")}</th>
                <th style={thStyle}>{t("logsExplorer.colTarget")}</th>
                <th style={thStyle}>{t("logsExplorer.colActor")}</th>
                <th style={thStyle}>{t("logsExplorer.colDetails")}</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => {
                const isOpen = open.has(r.id);
                return (
                  <Fragment key={r.id}>
                    <tr
                      onClick={() => toggle(r.id)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          toggle(r.id);
                        }
                      }}
                      tabIndex={0}
                      aria-expanded={isOpen}
                      style={{ cursor: "pointer" }}
                      className={isOpen ? undefined : "hover-row"}
                    >
                      <td style={{ ...tdStyle, textAlign: "center" }}>
                        <ExpandCaret open={isOpen} />
                      </td>
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
                          {r.actorUserId
                            ? r.actorUserId.slice(0, 16)
                            : t("logsExplorer.actorSystem")}
                        </span>
                      </td>
                      <td
                        style={{
                          ...tdStyle,
                          color: "var(--text-3)",
                          fontFamily: "var(--mono)",
                          fontSize: 11,
                        }}
                      >
                        {metaSummary(r) || "—"}
                      </td>
                    </tr>
                    {isOpen && (
                      <DetailCell colSpan={6}>
                        <Field label={t("logsExplorer.colAction")}>
                          {r.action}
                        </Field>
                        <Field label={t("logsExplorer.colTime")}>
                          {r.at ? new Date(r.at).toLocaleString() : "—"}
                        </Field>
                        <Field label={t("logsExplorer.colTarget")}>
                          {r.targetType
                            ? `${r.targetType}${r.targetId ? `:${r.targetId}` : ""}`
                            : "—"}
                        </Field>
                        <Field label={t("logsExplorer.colActor")}>
                          {r.actorUserId ?? t("logsExplorer.actorSystem")}
                        </Field>
                        <JsonView
                          label={t("logsExplorer.fullMeta")}
                          value={r.meta}
                        />
                      </DetailCell>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
          {hasOlder && (
            <div
              style={{
                padding: "10px 14px",
                borderTop: "1px solid var(--border)",
                display: "flex",
                justifyContent: "center",
              }}
            >
              <Button
                small
                icon="logs"
                onClick={() => void query.fetchNextPage()}
                disabled={query.isFetchingNextPage}
              >
                {query.isFetchingNextPage
                  ? t("auditSection.loading")
                  : t("auditSection.loadOlder")}
              </Button>
            </div>
          )}
        </div>
      )}
    </LogPane>
  );
}
