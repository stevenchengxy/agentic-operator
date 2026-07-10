"use client";

/**
 * EventChain — the cross-run cascade for the Run detail "chain" tab.
 *
 * The zhaopin 6-agent pipeline links runs by re-emitting events sharing a
 * `correlationId` (NOT `parentRunId`), so the parentRunId-based TraceTree shows
 * nothing. This fetches GET /v1/runs/:id/chain and renders the runs in pipeline
 * order as an agent → emittedEvent → agent chain, with the anchor run
 * highlighted and each row deep-linking to its own run detail.
 */

import Link from "next/link";
import { Badge, Empty, Icon, StatusDot, type StatusName } from "@/app/portal/components";
import { fmtDur } from "@/app/portal/lib/format";
import { useI18n } from "@/app/portal/lib/preferences-context";
import type { RunListRow } from "@/lib/hooks/useRuns";
import { useRunChain, type RunChainRow } from "@/lib/hooks/useRuns";

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

function tone(status: string): string {
  if (status === "failed") return "var(--red)";
  if (status === "running") return "var(--signal)";
  if (status === "ok") return "var(--green)";
  return "var(--text-3)";
}

export function EventChain({ run, tenant }: { run: RunListRow; tenant: string }) {
  const { t } = useI18n();
  const { data, isLoading } = useRunChain(run.id);
  const chain = data?.runs ?? [];

  if (isLoading) return <Empty title={t("runDetail.chainLoading")} hint={run.id} />;
  if (chain.length <= 1) {
    return (
      <Empty
        title={t("runDetail.chainEmptyTitle")}
        hint={t("runDetail.chainEmptyHint")}
      />
    );
  }

  return (
    <div>
      {chain.map((r, i) => (
        <div key={r.id}>
          <ChainRunRow row={r} tenant={tenant} isAnchor={r.id === run.id} />
          {i < chain.length - 1 && r.emittedEvent && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: "2px 0 2px 24px",
                fontSize: 11,
                color: "var(--text-3)",
              }}
            >
              <Icon
                name="chevron-right"
                size={11}
                style={{ transform: "rotate(90deg)", color: "var(--text-3)" }}
              />
              <span className="mono">{r.emittedEvent}</span>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function ChainRunRow({
  row,
  tenant,
  isAnchor,
}: {
  row: RunChainRow;
  tenant: string;
  isAnchor: boolean;
}) {
  const { t } = useI18n();
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "16px 1fr auto auto 16px",
        gap: 10,
        alignItems: "center",
        padding: "8px 10px",
        border: "1px solid var(--border)",
        borderLeft: `3px solid ${tone(row.status)}`,
        borderRadius: 4,
        background: isAnchor ? "var(--panel-2)" : "var(--bg-2)",
      }}
    >
      <StatusDot status={STATUS_TO_DOT[row.status] ?? "idle"} size={8} />
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            fontSize: 12.5,
            color: "var(--text)",
            overflow: "hidden",
            whiteSpace: "nowrap",
          }}
          title={row.agentName}
        >
          <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
            {row.agentTitle ?? row.agentName}
          </span>
          {isAnchor && <Badge tone="muted">{t("runDetail.chainThisRun")}</Badge>}
        </div>
        <div className="mono" style={{ fontSize: 10.5, color: "var(--text-3)" }}>
          {row.triggerEvent ?? "—"}
          {row.subject ? ` · ${row.subject}` : ""}
        </div>
      </div>
      <Badge tone="muted">{row.status}</Badge>
      <span
        className="mono"
        style={{ fontSize: 11, color: tone(row.status), textAlign: "right" }}
      >
        {fmtDur(row.durationMs)}
      </span>
      <Link
        href={`/portal/${tenant}/runs/${row.id}` as never}
        title={t("runDetail.chainOpenRun")}
        style={{ textDecoration: "none" }}
      >
        <Icon name="external" size={11} style={{ color: "var(--text-3)" }} />
      </Link>
    </div>
  );
}
