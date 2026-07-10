"use client";

/**
 * Runs — server-side paginated list with user-controlled delete + recycle bin
 * (W1).
 *
 * Data flows through `useRunsPaged()` (page/pageSize/status/q/deleted all pushed
 * to the server, which returns `{ rows, total, page, pageSize }`). Runs persist
 * forever by default (no auto-GC); operators prune them here:
 *   - per-row soft-delete (🗑, recoverable from the recycle bin)
 *   - bulk: 清理最旧 100 条 / 一键清空 (soft) and 清空回收站 (hard purge)
 *
 * Selecting a row navigates to `/portal/[tenant]/runs/[id]`.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Badge,
  Button,
  Empty,
  Icon,
  StatusDot,
  ViewHeader,
  SearchInput,
  FilterChip,
  type StatusName,
} from "@/app/portal/components";
import { fmtAgo, fmtDur } from "@/app/portal/lib/format";
import { useTenant } from "@/app/portal/lib/use-tenant";
import { useI18n } from "@/app/portal/lib/preferences-context";
import {
  useRunsPaged,
  useDeleteRun,
  useRestoreRun,
  useBulkDeleteRuns,
  type RunListRow,
} from "@/lib/hooks/useRuns";

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

const PAGE_SIZE = 25;

export default function RunsPage() {
  const tenant = useTenant();
  const { t } = useI18n();

  const [statusFilter, setStatusFilter] = useState<
    "all" | "running" | "ok" | "failed"
  >("all");
  const [queryInput, setQueryInput] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [binMode, setBinMode] = useState(false);

  // Debounce the free-text search so we don't refetch on every keystroke.
  useEffect(() => {
    const id = setTimeout(() => setQuery(queryInput.trim()), 300);
    return () => clearTimeout(id);
  }, [queryInput]);

  // Any filter/lens change resets to the first page.
  useEffect(() => {
    setPage(1);
  }, [statusFilter, query, binMode]);

  const { data, isFetching } = useRunsPaged({
    status: binMode ? "all" : statusFilter,
    q: query || undefined,
    page,
    pageSize: PAGE_SIZE,
    deleted: binMode,
  });

  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const activeCount = rows.filter((r) => r.status === "running").length;

  const deleteRun = useDeleteRun();
  const restoreRun = useRestoreRun();
  const bulk = useBulkDeleteRuns();
  const busy = deleteRun.isPending || restoreRun.isPending || bulk.isPending;

  function cleanOldest() {
    if (window.confirm(t("runs.confirmCleanOldest", { n: 100 })))
      bulk.mutate({ scope: "oldest", n: 100 });
  }
  function clearAll() {
    if (window.confirm(t("runs.confirmClearAll"))) bulk.mutate({ scope: "all" });
  }
  function purgeBin() {
    if (window.confirm(t("runs.confirmPurge"))) bulk.mutate({ scope: "purge" });
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <ViewHeader
        title={t("nav.runs")}
        subtitle={t("runs.summary", { count: total, active: activeCount })}
        action={
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            {/* Records ↔ recycle-bin lens toggle */}
            <div style={{ display: "flex", gap: 4 }}>
              <Button
                small
                tone={binMode ? "ghost" : "primary"}
                onClick={() => setBinMode(false)}
              >
                {t("runs.activeRecords")}
              </Button>
              <Button
                small
                icon="trash"
                tone={binMode ? "primary" : "ghost"}
                onClick={() => setBinMode(true)}
              >
                {t("runs.recycleBin")}
              </Button>
            </div>
            <span style={{ width: 1, height: 18, background: "var(--border)" }} />
            {binMode ? (
              <Button small tone="danger" onClick={purgeBin} disabled={busy || total === 0}>
                {t("runs.purgeBin")}
              </Button>
            ) : (
              <>
                <Button small onClick={cleanOldest} disabled={busy}>
                  {t("runs.cleanOldest")}
                </Button>
                <Button small tone="danger" onClick={clearAll} disabled={busy}>
                  {t("runs.clearAll")}
                </Button>
              </>
            )}
          </div>
        }
      />

      <div
        style={{
          flex: 1,
          display: "grid",
          gridTemplateColumns: "440px 1fr",
          minHeight: 0,
        }}
      >
        {/* Runs list */}
        <aside
          style={{
            borderRight: "1px solid var(--border)",
            display: "flex",
            flexDirection: "column",
            minHeight: 0,
          }}
        >
          <div
            style={{
              padding: "10px 14px",
              borderBottom: "1px solid var(--border)",
              display: "flex",
              gap: 6,
            }}
          >
            <SearchInput
              value={queryInput}
              onChange={setQueryInput}
              placeholder={t("runs.searchPlaceholder")}
            />
          </div>
          {!binMode && (
            <div
              style={{
                padding: "8px 14px",
                borderBottom: "1px solid var(--border)",
                display: "flex",
                gap: 6,
                flexWrap: "wrap",
              }}
            >
              {(
                [
                  { id: "all", labelKey: "runs.filterAll" },
                  { id: "running", labelKey: "runs.filterRunning" },
                  { id: "ok", labelKey: "runs.filterOk" },
                  { id: "failed", labelKey: "runs.filterFailed" },
                ] as const
              ).map((chip) => (
                <FilterChip
                  key={chip.id}
                  active={statusFilter === chip.id}
                  onClick={() => setStatusFilter(chip.id)}
                >
                  {t(chip.labelKey)}
                </FilterChip>
              ))}
            </div>
          )}

          <div style={{ flex: 1, overflow: "auto" }}>
            {rows.length === 0 ? (
              <Empty
                title={binMode ? t("runs.binEmptyTitle") : t("runs.emptyTitle")}
                hint={binMode ? t("runs.binEmptyHint") : t("runs.emptyHint")}
              />
            ) : (
              rows.map((r) => (
                <RunListItem
                  key={r.id}
                  row={r}
                  tenant={tenant}
                  binMode={binMode}
                  onDelete={() => deleteRun.mutate(r.id)}
                  onRestore={() => restoreRun.mutate(r.id)}
                />
              ))
            )}
          </div>

          {/* Pagination footer */}
          <div
            style={{
              padding: "8px 14px",
              borderTop: "1px solid var(--border)",
              display: "flex",
              alignItems: "center",
              gap: 8,
              justifyContent: "space-between",
            }}
          >
            <span
              style={{
                fontSize: 11,
                color: "var(--text-3)",
                fontFamily: "var(--mono)",
                opacity: isFetching ? 0.5 : 1,
              }}
            >
              {t("runs.pageOf", { page, pages, total })}
            </span>
            <div style={{ display: "flex", gap: 4 }}>
              <Button
                small
                icon="chevron-left"
                ariaLabel={t("runs.prevPage")}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
              />
              <Button
                small
                icon="chevron-right"
                ariaLabel={t("runs.nextPage")}
                onClick={() => setPage((p) => Math.min(pages, p + 1))}
                disabled={page >= pages}
              />
            </div>
          </div>
        </aside>

        {/* Right pane (selection redirects to detail page) */}
        <div
          style={{
            overflow: "auto",
            minHeight: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Empty title={t("runs.selectTitle")} hint={t("runs.selectHint")} />
        </div>
      </div>
    </div>
  );
}

function RunListItem({
  row,
  tenant,
  binMode,
  onDelete,
  onRestore,
}: {
  row: RunListRow;
  tenant: string;
  binMode: boolean;
  onDelete: () => void;
  onRestore: () => void;
}) {
  const { t } = useI18n();
  const testRun = (row as { testRun?: boolean }).testRun === true;
  const isReplay = Boolean(row.parentRunId);

  const body = (
    <>
      <div
        style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}
      >
        <StatusDot status={STATUS_TO_DOT[row.status] ?? "idle"} />
        <span
          className="mono"
          style={{ fontSize: 11.5, color: "var(--text-2)", whiteSpace: "nowrap" }}
        >
          {row.id}
        </span>
        {testRun && (
          <Badge tone="signal" style={{ fontSize: 9 }}>
            {t("runs.badgeTest")}
          </Badge>
        )}
        {isReplay && (
          <Badge tone="amber" style={{ fontSize: 9 }}>
            {t("runs.badgeReplay")}
          </Badge>
        )}
        <span
          style={{
            marginLeft: "auto",
            fontSize: 11,
            color: "var(--text-3)",
            fontFamily: "var(--mono)",
            whiteSpace: "nowrap",
            // leave room for the absolute action button
            paddingRight: 24,
          }}
        >
          {row.status === "running"
            ? fmtDur(row.durationMs)
            : row.startedAt
              ? fmtAgo(Date.parse(row.startedAt))
              : "—"}
        </span>
      </div>
      <div
        style={{
          marginTop: 4,
          fontSize: 12.5,
          color: "var(--text)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {row.agentTitle ?? row.agentName}
      </div>
      <div
        style={{
          marginTop: 2,
          fontSize: 11,
          color: "var(--text-3)",
          display: "flex",
          gap: 6,
          minWidth: 0,
          overflow: "hidden",
        }}
      >
        <span className="mono" style={{ whiteSpace: "nowrap" }}>
          {row.subject ?? "—"}
        </span>
        <span>·</span>
        <span
          className="mono"
          style={{
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {row.triggerEvent ?? ""}
        </span>
      </div>
    </>
  );

  const rowStyle = {
    display: "block",
    width: "100%",
    textAlign: "left" as const,
    padding: "10px 14px",
    borderBottom: "1px solid var(--border)",
    background: "transparent",
    borderLeft: "2px solid transparent",
    transition: "background 0.1s",
    overflow: "hidden",
    textDecoration: "none",
  };

  return (
    <div style={{ position: "relative" }}>
      {binMode ? (
        <div style={{ ...rowStyle, opacity: 0.75 }}>{body}</div>
      ) : (
        <Link href={`/portal/${tenant}/runs/${row.id}` as never} style={rowStyle}>
          {body}
        </Link>
      )}
      {/* Action button, sibling of the Link so it never triggers navigation. */}
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (binMode) onRestore();
          else onDelete();
        }}
        title={binMode ? t("runs.restore") : t("runs.deleteRun")}
        aria-label={binMode ? t("runs.restore") : t("runs.deleteRun")}
        style={{
          position: "absolute",
          top: 8,
          right: 8,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 22,
          height: 22,
          padding: 0,
          borderRadius: 5,
          border: "1px solid transparent",
          background: "transparent",
          color: binMode ? "var(--signal)" : "var(--text-3)",
          cursor: "pointer",
        }}
      >
        <Icon name={binMode ? "replay" : "trash"} size={12} />
      </button>
    </div>
  );
}
