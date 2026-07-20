"use client";

/**
 * TraceTree — nested run tree for the Run detail "trace" tab (P3-FE-04).
 *
 * Composition: the parent run's steps surface inline; any child run (rows
 * with `parentRunId === root.id`) renders as a collapsible block beneath
 * the step list. Expanding a child fetches its own steps + grand-children
 * on demand, so the read cost is paid lazily by depth.
 *
 * Pure presentation — the data fetching happens via `useRun()` and
 * `useRuns({ parentRunId })` for each level. Hard depth-cap at 6 prevents
 * accidental cycle blowups; the user can click "Open run" to drill down
 * past the cap.
 */

import { useState } from "react";
import Link from "next/link";
import {
  Badge,
  Empty,
  Icon,
  StatusDot,
  type StatusName,
} from "@/app/portal/components";
import { fmtDur, fmtNum } from "@/app/portal/lib/format";
import { useI18n } from "@/app/portal/lib/preferences-context";
import type { RunListRow, StepRow } from "@/lib/hooks/useRuns";
import { useRun, useRuns } from "@/lib/hooks/useRuns";

const STATUS_TO_DOT: Record<string, StatusName> = {
  running: "running",
  queued: "waiting",
  waiting: "waiting",
  ok: "ok",
  failed: "failed",
  cancelled: "cancelled",
  paused: "paused",
  idle: "idle",
};

interface TraceNode {
  run: RunListRow;
  steps: StepRow[];
}

/**
 * `composeTrace` — pure helper. Given a set of steps and child runs, produce
 * an interleaved entry list in stable order. Exposed for unit testing.
 *
 * Mixing rule: walk steps in `ord` order; children are appended after the
 * steps. (The backend doesn't yet surface which subflow step spawned a
 * child run; once it does, we'll interleave on `subflowStepOrd`.)
 */
export interface TraceEntry {
  kind: "step" | "child";
  step?: StepRow;
  child?: RunListRow;
}

export function composeTrace(
  steps: StepRow[],
  children: RunListRow[],
): TraceEntry[] {
  const out: TraceEntry[] = [];
  for (const s of [...steps].sort((a, b) => a.ord - b.ord)) {
    out.push({ kind: "step", step: s });
  }
  for (const c of children) {
    out.push({ kind: "child", child: c });
  }
  return out;
}

const MAX_DEPTH = 6;

interface TraceTreeProps {
  node: TraceNode;
  depth?: number;
  tenant: string;
}

export function TraceTree({ node, depth = 0, tenant }: TraceTreeProps) {
  const { t } = useI18n();
  // Fetch direct children for this run (one query per visible level).
  const childrenQuery = useRuns({
    parentRunId: node.run.id,
    limit: 50,
  });
  const children = childrenQuery.data ?? [];

  const entries = composeTrace(node.steps, children);
  if (childrenQuery.isError) {
    return (
      <Empty
        title={t("traceTree.loadFailed")}
        hint={childrenQuery.error.message}
      />
    );
  }
  if (childrenQuery.isLoading && !childrenQuery.data && node.steps.length === 0) {
    return <Empty title={t("traceTree.loading")} hint={node.run.id} />;
  }
  if (entries.length === 0) {
    return (
      <Empty
        title={t("traceTree.emptyTitle")}
        hint={t("traceTree.emptyHint")}
      />
    );
  }

  return (
    <div
      style={{
        borderLeft: depth > 0 ? "1px dashed var(--border-2)" : "none",
        marginLeft: depth > 0 ? 12 : 0,
        paddingLeft: depth > 0 ? 12 : 0,
      }}
    >
      {childrenQuery.isLoading && !childrenQuery.data ? (
        <div role="status" style={{ padding: "6px 8px", color: "var(--text-3)", fontSize: 11 }}>
          {t("traceTree.loadingChildren")}
        </div>
      ) : null}
      {entries.map((e, i) => {
        if (e.kind === "step" && e.step) {
          return <StepRowItem key={`s-${e.step.id}-${i}`} step={e.step} />;
        }
        if (e.kind === "child" && e.child) {
          return (
            <ChildRunBlock
              key={`c-${e.child.id}`}
              child={e.child}
              depth={depth + 1}
              tenant={tenant}
            />
          );
        }
        return null;
      })}
    </div>
  );
}

function StepRowItem({ step }: { step: StepRow }) {
  const { t } = useI18n();
  const tone = stepTone(step);
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "20px 1fr 110px 80px",
        gap: 10,
        alignItems: "center",
        padding: "6px 8px",
        borderBottom: "1px solid var(--border)",
        fontSize: 12,
      }}
    >
      <StatusDot status={STATUS_TO_DOT[step.status] ?? "idle"} />
      <div style={{ minWidth: 0 }}>
        <div
          className="mono"
          style={{
            fontSize: 12,
            color: "var(--text)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={step.name}
        >
          {step.name}
        </div>
        <div style={{ fontSize: 10.5, color: "var(--text-3)" }}>
          {t("traceTree.stepLabel")} {step.ord} · {step.type}
          {step.model ? ` · ${step.model}` : ""}
        </div>
      </div>
      <div
        style={{
          fontSize: 11,
          color: "var(--text-3)",
          fontFamily: "var(--mono)",
          textAlign: "right",
        }}
      >
        {step.tokensIn != null && step.tokensOut != null
          ? `${fmtNum(step.tokensIn)} · ${fmtNum(step.tokensOut)}`
          : "—"}
      </div>
      <div
        style={{
          fontSize: 11,
          color: tone,
          fontFamily: "var(--mono)",
          textAlign: "right",
        }}
      >
        {fmtDur(step.durationMs)}
      </div>
    </div>
  );
}

function ChildRunBlock({
  child,
  depth,
  tenant,
}: {
  child: RunListRow;
  depth: number;
  tenant: string;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(depth <= 1);

  // Lazy load this child's steps when expanded.
  const childQuery = useRun(open ? child.id : null);
  const childDetail = childQuery.data;
  const childSteps = childDetail?.steps ?? [];

  const tone =
    child.status === "failed"
      ? "var(--red)"
      : child.status === "running"
        ? "var(--signal)"
        : child.status === "ok"
          ? "var(--green)"
          : child.status === "queued" || child.status === "waiting"
            ? "var(--amber)"
            : "var(--text-3)";

  return (
    <div
      style={{
        margin: "6px 0",
        border: "1px solid var(--border)",
        borderLeft: `3px solid ${tone}`,
        borderRadius: 4,
        background: "var(--bg-2)",
      }}
    >
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: "100%",
          padding: "8px 10px",
          background: "transparent",
          borderBottom: open ? "1px solid var(--border)" : "none",
          cursor: "pointer",
          textAlign: "left",
        }}
      >
        <Icon
          name="chevron-right"
          size={11}
          style={{
            color: "var(--text-3)",
            transform: open ? "rotate(90deg)" : "none",
            transition: "transform 0.12s",
          }}
        />
        <StatusDot status={STATUS_TO_DOT[child.status] ?? "idle"} size={7} />
        <span className="mono" style={{ fontSize: 11, color: "var(--text-2)" }}>
          {child.id}
        </span>
        <Badge tone="muted">{t("traceTree.subflow")}</Badge>
        <span
          style={{
            fontSize: 12,
            color: "var(--text)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            minWidth: 0,
            flex: 1,
          }}
        >
          {child.agentTitle ?? child.agentName}
        </span>
        <span
          className="mono"
          style={{
            fontSize: 11,
            color: tone,
            marginLeft: "auto",
          }}
        >
          {fmtDur(child.durationMs)}
        </span>
        <Link
          href={`/portal/${tenant}/runs/${child.id}` as never}
          onClick={(e) => e.stopPropagation()}
          style={{ textDecoration: "none", marginLeft: 6 }}
          title={t("traceTree.openChildRun")}
        >
          <Icon name="external" size={11} style={{ color: "var(--text-3)" }} />
        </Link>
      </button>

      {open && depth < MAX_DEPTH && (
        <div style={{ padding: "6px 10px" }}>
          {childQuery.isError ? (
            <Empty title={t("traceTree.loadFailed")} hint={childQuery.error.message} />
          ) : childQuery.isLoading && !childDetail ? (
            <Empty title={t("traceTree.loading")} hint={child.id} />
          ) : (
            <TraceTree
              node={{ run: child, steps: childSteps }}
              depth={depth}
              tenant={tenant}
            />
          )}
        </div>
      )}
      {open && depth >= MAX_DEPTH && (
        <DepthCap childId={child.id} tenant={tenant} />
      )}
    </div>
  );
}

function DepthCap({ childId, tenant }: { childId: string; tenant: string }) {
  const { t } = useI18n();
  return (
    <div style={{ padding: "8px 10px", fontSize: 11.5, color: "var(--text-3)" }}>
      {t("traceTree.depthCapPrefix")}{" "}
      <Link
        href={`/portal/${tenant}/runs/${childId}` as never}
        style={{ color: "var(--accent-text)", textDecoration: "underline" }}
      >
        {t("traceTree.depthCapLink")}
      </Link>{" "}
      {t("traceTree.depthCapSuffix")}
    </div>
  );
}

function stepTone(step: StepRow): string {
  if (step.status === "failed") return "var(--red)";
  if (step.status === "running") return "var(--signal)";
  if (step.status === "ok") return "var(--green)";
  return "var(--text-3)";
}

export type { TraceNode };
