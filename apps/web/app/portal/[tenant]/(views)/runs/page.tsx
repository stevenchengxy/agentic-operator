"use client";

/**
 * Runs — list with filters + selectable rows (P2-FE-10).
 *
 * Ported from `apps/web/public/portal/views/runs.jsx` with the Phase 1 delta
 * preserved: data flows through `useRuns()` (replaces window.RAAS_*).
 *
 * Selecting a row navigates to `/portal/[tenant]/runs/[id]`. The "agent" tab
 * inside RunDetail is on a separate page so deep-linking works.
 */

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  Badge,
  Button,
  Empty,
  StatusDot,
  ViewHeader,
  SearchInput,
  FilterChip,
  type StatusName,
} from "@/app/portal/components";
import { fmtAgo, fmtDur } from "@/app/portal/lib/format";
import { useTenant } from "@/app/portal/lib/use-tenant";
import { useI18n } from "@/app/portal/lib/preferences-context";
import { useRuns, type RunListRow } from "@/lib/hooks/useRuns";

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

export default function RunsPage() {
  const tenant = useTenant();
  const { t } = useI18n();
  const { data: allRuns = [] } = useRuns({ limit: 200 });
  const [statusFilter, setStatusFilter] = useState<
    "all" | "running" | "ok" | "failed"
  >("all");
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    return allRuns.filter((r) => {
      if (statusFilter !== "all" && r.status !== statusFilter) return false;
      if (query) {
        const q = query.toLowerCase();
        if (
          !r.id.toLowerCase().includes(q) &&
          !r.agentName.toLowerCase().includes(q) &&
          !(r.subject ?? "").toLowerCase().includes(q)
        )
          return false;
      }
      return true;
    });
  }, [allRuns, statusFilter, query]);

  const activeCount = allRuns.filter((r) => r.status === "running").length;
  const selectedId = filtered[0]?.id ?? null;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <ViewHeader
        title={t("nav.runs")}
        subtitle={t("runs.summary", {
          count: filtered.length,
          active: activeCount,
        })}
        action={
          <Button icon="replay" small>
            {t("runs.replaySelection")}
          </Button>
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
              value={query}
              onChange={setQuery}
              placeholder={t("runs.searchPlaceholder")}
            />
          </div>
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
          <div style={{ flex: 1, overflow: "auto" }}>
            {filtered.length === 0 ? (
              <Empty title={t("runs.emptyTitle")} hint={t("runs.emptyHint")} />
            ) : (
              filtered.map((r) => (
                <RunListItem
                  key={r.id}
                  row={r}
                  tenant={tenant}
                  selected={r.id === selectedId}
                />
              ))
            )}
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
          <Empty
            title={t("runs.selectTitle")}
            hint={t("runs.selectHint")}
          />
        </div>
      </div>
    </div>
  );
}

function RunListItem({
  row,
  tenant,
  selected,
}: {
  row: RunListRow;
  tenant: string;
  selected: boolean;
}) {
  const { t } = useI18n();
  const testRun = (row as { testRun?: boolean }).testRun === true;
  const isReplay = Boolean(row.parentRunId);
  return (
    <Link
      href={`/portal/${tenant}/runs/${row.id}` as never}
      style={{
        display: "block",
        width: "100%",
        textAlign: "left",
        padding: "10px 14px",
        borderBottom: "1px solid var(--border)",
        background: selected ? "var(--panel-2)" : "transparent",
        borderLeft: selected ? "2px solid var(--signal)" : "2px solid transparent",
        transition: "background 0.1s",
        overflow: "hidden",
        textDecoration: "none",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          minWidth: 0,
        }}
      >
        <StatusDot status={STATUS_TO_DOT[row.status] ?? "idle"} />
        <span
          className="mono"
          style={{
            fontSize: 11.5,
            color: "var(--text-2)",
            whiteSpace: "nowrap",
          }}
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
    </Link>
  );
}
