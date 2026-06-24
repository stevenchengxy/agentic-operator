"use client";

/**
 * Tasks — human-in-the-loop inbox + per-task review surface (P2-FE-12).
 *
 * Preserves ALL 6 payload renderers (audit 01 §4.6):
 *   - jdReview / packageReview / resumeFix / requirementReClarification
 *     / packageSupplement / manualPublish
 *
 * Live data via canonical TanStack hooks (useTasks + useAgents). No
 * bootstrap snapshot.
 */

import { useMemo, useState } from "react";
import {
  ActorTag,
  Badge,
  Button,
  Empty,
  Icon,
  Kbd,
  Panel,
  ViewHeader,
  FilterChip,
} from "@/app/portal/components";
import { fmtAgo } from "@/app/portal/lib/format";
import { useI18n } from "@/app/portal/lib/preferences-context";
import { useTasks, type TaskRow as ApiTaskRow } from "@/lib/hooks/useTasks";
import { useDag, type DagAgent } from "@/lib/hooks/useAgents";

// Local narrow types for the task records the page renders.
interface TaskItem {
  id: string;
  type: string;
  title: string;
  priority: string;
  status: string;
  createdAt: number | null;
  awaitingFrom: string | null;
  payload: Record<string, unknown>;
}

function fromApi(t: ApiTaskRow): TaskItem {
  const createdAt = t.createdAt ? Date.parse(t.createdAt) : null;
  const payload =
    (t.payloadJson as Record<string, unknown> | null | undefined) ?? {};
  return {
    id: t.id,
    type: t.type,
    title: t.title,
    priority: t.priority ?? "med",
    status: t.status,
    createdAt: Number.isFinite(createdAt) ? createdAt : null,
    awaitingFrom: t.awaitingRole,
    payload,
  };
}

export default function TasksPage() {
  // Live tasks + workflow DAG via TanStack Query — kept in sync by useStream
  // cache invalidation. DAG carries triggers/emits per agent so the task
  // detail can render "will emit on approve" / "downstream listeners".
  const { t } = useI18n();
  const tasksQuery = useTasks();
  const dagQuery = useDag();
  const apiTasks = tasksQuery.data ?? [];
  const dagAgents = dagQuery.data?.agents ?? [];

  const tasks = useMemo<TaskItem[]>(
    () => apiTasks.map(fromApi),
    [apiTasks],
  );

  const [filter, setFilter] = useState<"all" | "high" | "med" | "low">("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedActualId = selectedId ?? tasks[0]?.id ?? null;
  const selected = useMemo(
    () => tasks.find((t) => t.id === selectedActualId) ?? null,
    [tasks, selectedActualId],
  );

  const filtered = useMemo(
    () => tasks.filter((t) => (filter === "all" ? true : t.priority === filter)),
    [tasks, filter],
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <ViewHeader
        title={t("nav.tasks")}
        subtitle={t("tasks.subtitle", {
          pending: tasks.length,
          high: tasks.filter((t) => t.priority === "high").length,
        })}
        badge={<Badge tone="amber">{t("tasks.openBadge", { count: tasks.length })}</Badge>}
      />

      <div
        style={{
          flex: 1,
          display: "grid",
          gridTemplateColumns: "420px 1fr",
          minHeight: 0,
        }}
      >
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
            {(["all", "high", "med", "low"] as const).map((p) => (
              <FilterChip
                key={p}
                active={filter === p}
                onClick={() => setFilter(p)}
              >
                {p === "all" ? t("tasks.filterAll") : p.toUpperCase()}
              </FilterChip>
            ))}
          </div>
          <div style={{ flex: 1, overflow: "auto" }}>
            {tasksQuery.isError ? (
              <Empty
                title={t("tasks.loadErrorTitle")}
                hint={tasksQuery.error?.message ?? t("tasks.apiUnreachable")}
              />
            ) : tasksQuery.isLoading && tasks.length === 0 ? (
              <Empty title={t("tasks.loadingTitle")} hint="" />
            ) : filtered.length === 0 ? (
              <Empty
                title={tasks.length === 0 ? t("tasks.emptyAllTitle") : t("tasks.emptyPriorityTitle")}
                hint={tasks.length === 0 ? t("tasks.emptyAllHint") : ""}
              />
            ) : (
              filtered.map((t) => (
                <TaskRow
                  key={t.id}
                  task={t}
                  active={selectedActualId === t.id}
                  onClick={() => setSelectedId(t.id)}
                />
              ))
            )}
          </div>
        </aside>

        <div style={{ overflow: "auto", minHeight: 0 }}>
          {selected ? (
            <TaskDetail task={selected} agents={dagAgents} />
          ) : (
            <Empty title={t("tasks.inboxZeroTitle")} hint={t("tasks.inboxZeroHint")} />
          )}
        </div>
      </div>
    </div>
  );
}

function TaskRow({
  task,
  active,
  onClick,
}: {
  task: TaskItem;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        display: "block",
        width: "100%",
        textAlign: "left",
        padding: "12px 14px",
        borderBottom: "1px solid var(--border)",
        background: active ? "var(--panel-2)" : "transparent",
        borderLeft: active ? "2px solid var(--signal)" : "2px solid transparent",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 5,
        }}
      >
        <Badge
          tone={
            task.priority === "high"
              ? "amber"
              : task.priority === "med"
                ? "blue"
                : "muted"
          }
          style={{ fontSize: 9.5 }}
        >
          {task.priority.toUpperCase()}
        </Badge>
        <span
          className="mono"
          style={{ fontSize: 10.5, color: "var(--text-3)" }}
        >
          {task.id}
        </span>
        <span
          style={{
            marginLeft: "auto",
            fontSize: 10.5,
            color: "var(--text-3)",
            fontFamily: "var(--mono)",
          }}
        >
          {task.createdAt ? fmtAgo(task.createdAt) : "—"}
        </span>
      </div>
      <div
        style={{
          fontSize: 12.5,
          color: "var(--text)",
          marginBottom: 3,
          fontWeight: 500,
          lineHeight: 1.3,
        }}
      >
        {task.title}
      </div>
      {task.awaitingFrom ? (
        <div style={{ fontSize: 11, color: "var(--text-3)" }}>
          {task.awaitingFrom}
        </div>
      ) : null}
    </button>
  );
}

function TaskDetail({
  task,
  agents,
}: {
  task: TaskItem;
  agents: DagAgent[];
}) {
  const { t } = useI18n();
  // /v1/tasks payload doesn't carry an agent reference today; surface the
  // closest match by `awaitingRole` (if a Human agent with that title
  // exists). Otherwise the panel falls back to the literal role string.
  const agent =
    agents.find(
      (a) =>
        a.actor === "Human" &&
        (a.title === task.awaitingFrom || a.name === task.awaitingFrom),
    ) ?? null;

  return (
    <div style={{ padding: 24, maxWidth: 920 }}>
      <header style={{ marginBottom: 16 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginBottom: 8,
          }}
        >
          <Badge
            tone={
              task.priority === "high"
                ? "amber"
                : task.priority === "med"
                  ? "blue"
                  : "muted"
            }
          >
            {t("tasks.priorityBadge", { priority: task.priority.toUpperCase() })}
          </Badge>
          <Badge tone="muted">{task.id}</Badge>
          <ActorTag actor="Human" />
          <span style={{ fontSize: 11, color: "var(--text-3)" }}>
            {t("tasks.createdAgo", {
              ago: task.createdAt ? fmtAgo(task.createdAt) : "—",
            })}
          </span>
        </div>
        <h2
          style={{
            margin: "6px 0 4px 0",
            fontSize: 24,
            fontFamily: "var(--display)",
            fontWeight: 400,
          }}
        >
          {task.title}
        </h2>
        <div style={{ fontSize: 12.5, color: "var(--text-2)" }}>
          {t("tasks.pendingAwaiting", {
            owner: agent?.title ?? task.awaitingFrom ?? t("tasks.operator"),
          })}{" "}
          <span style={{ color: "var(--text)" }}>
            {task.awaitingFrom ?? t("tasks.operator")}
          </span>
        </div>
      </header>

      {/* Type-specific payload renderers (all 6 per audit §4.6) */}
      {task.type === "jdReview" && <JDReviewPayload payload={task.payload} />}
      {task.type === "packageReview" && (
        <PackagePayload payload={task.payload} />
      )}
      {task.type === "resumeFix" && (
        <ResumeFixPayload payload={task.payload} />
      )}
      {task.type === "requirementReClarification" && (
        <ClarificationPayload payload={task.payload} />
      )}
      {task.type === "packageSupplement" && (
        <SupplementPayload payload={task.payload} />
      )}
      {task.type === "manualPublish" && (
        <ManualPublishPayload payload={task.payload} />
      )}

      {/* Decision actions */}
      <div
        style={{
          marginTop: 20,
          padding: 16,
          background: "var(--panel)",
          border: "1px solid var(--border)",
          borderRadius: 6,
        }}
      >
        <div
          style={{
            fontSize: 10.5,
            fontFamily: "var(--mono)",
            textTransform: "uppercase",
            color: "var(--text-3)",
            letterSpacing: "0.08em",
            marginBottom: 10,
          }}
        >
          {t("tasks.decide")}
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <Button tone="primary" icon="check">
            {decisionLabel(task.type, "primary", t)}
          </Button>
          {decisionLabel(task.type, "secondary", t) && (
            <Button>{decisionLabel(task.type, "secondary", t)}</Button>
          )}
          <Button tone="ghost">{t("tasks.snooze")}</Button>
          <span
            style={{
              marginLeft: "auto",
              fontSize: 11,
              color: "var(--text-3)",
            }}
          >
            <Kbd>⌘</Kbd> <Kbd>↵</Kbd> {t("tasks.approve")} · <Kbd>⌘</Kbd>{" "}
            <Kbd>R</Kbd> {t("tasks.reject")}
          </span>
        </div>
      </div>

      {/* Run context */}
      <Panel title={t("tasks.workflowContext")} padded style={{ marginTop: 16 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            fontSize: 12,
          }}
        >
          <span style={{ color: "var(--text-3)" }}>{t("tasks.willEmitOnApprove")}</span>
          {agent?.emits?.map((e) => (
            <Badge key={e} tone="green">
              {e}
            </Badge>
          )) ?? null}
        </div>
        <div style={{ marginTop: 8, fontSize: 12, color: "var(--text-3)" }}>
          {t("tasks.downstreamListeners")}{" "}
          {(() => {
            const evs = agent?.emits ?? [];
            const listeners = new Set<string>();
            evs.forEach((e) => {
              agents
                .filter((a) => a.triggers?.includes(e))
                .forEach((a) => listeners.add(a.title));
            });
            return Array.from(listeners).join(", ") || "—";
          })()}
        </div>
      </Panel>
    </div>
  );
}

function decisionLabel(
  type: string,
  slot: "primary" | "secondary",
  t: (key: string, vars?: Record<string, string | number>) => string,
): string | null {
  // Keys are stable per task-type + slot; resolve to translated labels at the
  // render site (the map is a structural lookup, not a string table).
  const map: Record<
    string,
    { primary: string; secondary: string | null }
  > = {
    jdReview: {
      primary: t("tasks.decision.jdReview.primary"),
      secondary: t("tasks.decision.jdReview.secondary"),
    },
    packageReview: {
      primary: t("tasks.decision.packageReview.primary"),
      secondary: t("tasks.decision.packageReview.secondary"),
    },
    resumeFix: {
      primary: t("tasks.decision.resumeFix.primary"),
      secondary: t("tasks.decision.resumeFix.secondary"),
    },
    requirementReClarification: {
      primary: t("tasks.decision.requirementReClarification.primary"),
      secondary: null,
    },
    packageSupplement: {
      primary: t("tasks.decision.packageSupplement.primary"),
      secondary: null,
    },
    manualPublish: {
      primary: t("tasks.decision.manualPublish.primary"),
      secondary: null,
    },
  };
  return (
    map[type]?.[slot] ??
    (slot === "primary" ? t("tasks.decision.default.primary") : null)
  );
}

// ─── Payload renderers (6 of 6) ──────────────────────────────────────────────

function JDReviewPayload({
  payload,
}: {
  payload: Record<string, unknown>;
}) {
  const { t } = useI18n();
  const p = payload as {
    title?: string;
    level?: string;
    city?: string;
    salary?: string;
    responsibilities?: string[];
    requirements?: string[];
  };
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gap: 12,
      }}
    >
      <Panel
        title={t("tasks.generatedJd")}
        padded
        action={<Badge tone="muted">draft v3</Badge>}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 14,
            fontSize: 13,
            color: "var(--text)",
          }}
        >
          <div>
            <div
              className="mono"
              style={{
                fontSize: 10.5,
                color: "var(--text-3)",
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                marginBottom: 4,
              }}
            >
              {t("tasks.title")}
            </div>
            <div style={{ fontSize: 14, fontWeight: 500 }}>
              {p.title ?? "—"}
            </div>
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 12,
            }}
          >
            <KV label={t("tasks.level")} value={p.level ?? "—"} mono />
            <KV label={t("tasks.city")} value={p.city ?? "—"} />
            <KV label={t("tasks.salary")} value={p.salary ?? "—"} />
            <KV label={t("tasks.status")} value={<Badge tone="signal">DRAFT</Badge>} />
          </div>
          <SectionList
            label={t("tasks.responsibilities")}
            items={p.responsibilities ?? []}
          />
          <SectionList label={t("tasks.requirements")} items={p.requirements ?? []} />
        </div>
      </Panel>
      <Panel title={t("tasks.agentReasoning")} padded>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 10,
            fontSize: 12,
            color: "var(--text-2)",
            lineHeight: 1.6,
          }}
        >
          <p style={{ margin: 0 }}>
            {t("tasks.draftedFrom")}{" "}
            <span className="mono" style={{ color: "var(--text)" }}>
              REQ
            </span>{" "}
            {t("tasks.afterClarificationTemplate")}{" "}
            <span className="mono" style={{ color: "var(--text)" }}>
              jd-tencent-wxg-v3
            </span>{" "}
            {t("tasks.applied")}
          </p>
          <p style={{ margin: 0 }}>
            {t("tasks.topKeywords")}{" "}
            <span className="mono" style={{ color: "var(--accent-text)" }}>
              backend, java, go, messaging, distributed-systems
            </span>
            .
          </p>
          <p style={{ margin: 0 }}>
            {t("tasks.salaryConfirmed")}
          </p>
          <div
            style={{
              marginTop: 6,
              padding: 10,
              background: "var(--panel-2)",
              border: "1px dashed var(--border-2)",
              borderRadius: 4,
              fontSize: 11.5,
            }}
          >
            <strong style={{ color: "var(--amber)" }}>{t("tasks.headsUp")}</strong>
            <span style={{ color: "var(--text-2)" }}>
              {t("tasks.reqReopenedWarning")}
            </span>
          </div>
        </div>
      </Panel>
    </div>
  );
}

function PackagePayload({
  payload,
}: {
  payload: Record<string, unknown>;
}) {
  const { t } = useI18n();
  const p = payload as {
    candidate?: string;
    matchScore?: number;
    missingItems?: string[];
    highlights?: string[];
  };
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1.4fr 1fr",
        gap: 12,
      }}
    >
      <Panel
        title={t("tasks.candidatePackage")}
        padded
        action={
          <Badge tone="signal">{t("tasks.scoreBadge", { score: p.matchScore ?? "—" })}</Badge>
        }
      >
        <div
          style={{
            fontSize: 18,
            fontFamily: "var(--display)",
            marginBottom: 12,
          }}
        >
          {p.candidate ?? "—"}
        </div>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          <KV label={t("tasks.match")} value={`${p.matchScore ?? "—"}/100`} mono />
          <KV
            label={t("tasks.missingItems")}
            value={
              (p.missingItems?.length ?? 0) === 0 ? (
                <Badge tone="green">COMPLETE</Badge>
              ) : (
                (p.missingItems ?? []).join(", ")
              )
            }
          />
          <SectionList label={t("tasks.highlights")} items={p.highlights ?? []} />
        </div>
        <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
          <Button small icon="external">
            Resume.pdf
          </Button>
          <Button small icon="external">
            {t("tasks.interviewClip")}
          </Button>
          <Button small icon="external">
            {t("tasks.evalReport")}
          </Button>
        </div>
      </Panel>
      <Panel title={t("tasks.submissionPreview")} padded>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 8,
            fontSize: 12,
            color: "var(--text)",
          }}
        >
          <KV label={t("tasks.target")} value="Tencent ATS · WXG queue" />
          <KV label={t("tasks.method")} value={t("tasks.apiAutoSubmit")} />
          <KV
            label={t("tasks.mockDryRun")}
            value={<Badge tone="green">{t("tasks.dryRunOk")}</Badge>}
          />
          <KV
            label={t("tasks.willEmit")}
            value={<Badge tone="green">APPLICATION_SUBMITTED</Badge>}
          />
        </div>
      </Panel>
    </div>
  );
}

function ResumeFixPayload({
  payload,
}: {
  payload: Record<string, unknown>;
}) {
  const { t } = useI18n();
  const p = payload as { file?: string; error?: string };
  return (
    <Panel
      title={t("tasks.parseError")}
      padded
      action={<Badge tone="red">PARSE FAIL</Badge>}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <KV label={t("tasks.file")} value={<span className="mono">{p.file ?? "—"}</span>} />
        <div>
          <div
            className="mono"
            style={{
              fontSize: 10.5,
              color: "var(--text-3)",
              textTransform: "uppercase",
              marginBottom: 4,
            }}
          >
            {t("tasks.error")}
          </div>
          <div
            style={{
              fontSize: 12.5,
              color: "var(--red)",
              padding: 10,
              background: "color-mix(in srgb, var(--red) 6%, transparent)",
              border: "1px solid color-mix(in srgb, var(--red) 25%, transparent)",
              borderRadius: 4,
            }}
          >
            {p.error ?? t("tasks.unknownError")}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
          <Button small icon="upload">
            {t("tasks.reuploadPdf")}
          </Button>
          <Button small>{t("tasks.editParsedFields")}</Button>
        </div>
      </div>
    </Panel>
  );
}

function ClarificationPayload({
  payload,
}: {
  payload: Record<string, unknown>;
}) {
  const { t } = useI18n();
  const p = payload as { questions?: string[] };
  return (
    <Panel title={t("tasks.openQuestions")} padded>
      <ol
        style={{
          margin: 0,
          paddingLeft: 18,
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}
      >
        {(p.questions ?? []).map((q, i) => (
          <li
            key={i}
            style={{
              fontSize: 13,
              color: "var(--text)",
              lineHeight: 1.5,
            }}
          >
            {q}
            <input
              placeholder={t("tasks.answerPlaceholder")}
              style={{
                display: "block",
                marginTop: 6,
                width: "100%",
                padding: "6px 10px",
                fontSize: 12,
                background: "var(--panel-2)",
                border: "1px solid var(--border)",
                borderRadius: 4,
                color: "var(--text)",
                fontFamily: "var(--sans)",
              }}
            />
          </li>
        ))}
      </ol>
    </Panel>
  );
}

function SupplementPayload({
  payload,
}: {
  payload: Record<string, unknown>;
}) {
  const { t } = useI18n();
  const p = payload as { missing?: string[] };
  return (
    <Panel title={t("tasks.itemsRequested")} padded>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {(p.missing ?? []).map((m) => (
          <div
            key={m}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "8px 10px",
              background: "var(--panel-2)",
              border: "1px dashed var(--border-2)",
              borderRadius: 4,
            }}
          >
            <Icon
              name="upload"
              size={12}
              style={{ color: "var(--text-3)" }}
            />
            <span
              className="mono"
              style={{ fontSize: 12, color: "var(--text)" }}
            >
              {m}
            </span>
            <Button small style={{ marginLeft: "auto" }}>
              {t("tasks.attach")}
            </Button>
          </div>
        ))}
      </div>
    </Panel>
  );
}

function ManualPublishPayload({
  payload,
}: {
  payload: Record<string, unknown>;
}) {
  const { t } = useI18n();
  const p = payload as { channel?: string; reason?: string };
  return (
    <Panel title={t("tasks.manualPublishRequired")} padded>
      <KV
        label={t("tasks.channel")}
        value={<Badge tone="amber">{p.channel ?? "—"}</Badge>}
      />
      <KV label={t("tasks.reason")} value={p.reason ?? "—"} />
      <div
        style={{
          marginTop: 10,
          padding: 12,
          background: "var(--panel-2)",
          border: "1px dashed var(--border-2)",
          borderRadius: 4,
          fontSize: 12,
          color: "var(--text-2)",
        }}
      >
        {t("tasks.manualPublishInstructions")}
      </div>
      <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
        <Button small icon="external" tone="primary">
          {t("tasks.openHelperPage")}
        </Button>
      </div>
    </Panel>
  );
}

// ─── shared bits ─────────────────────────────────────────────────────────────

function SectionList({
  label,
  items,
}: {
  label: string;
  items: string[];
}) {
  return (
    <div>
      <div
        className="mono"
        style={{
          fontSize: 10.5,
          color: "var(--text-3)",
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          marginBottom: 6,
        }}
      >
        {label}
      </div>
      <ul
        style={{
          margin: 0,
          paddingLeft: 18,
          fontSize: 12.5,
          lineHeight: 1.55,
          color: "var(--text)",
          display: "flex",
          flexDirection: "column",
          gap: 6,
        }}
      >
        {items.map((r, i) => (
          <li key={i}>{r}</li>
        ))}
      </ul>
    </div>
  );
}

/** Local KV — Foundation Engineer may relocate to the primitives barrel. */
function KV({
  label,
  value,
  mono,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "120px 1fr",
        gap: 8,
        fontSize: 12.5,
        alignItems: "center",
      }}
    >
      <span
        style={{
          fontSize: 10.5,
          fontFamily: "var(--mono)",
          textTransform: "uppercase",
          color: "var(--text-3)",
          letterSpacing: "0.06em",
        }}
      >
        {label}
      </span>
      <span
        style={{
          color: "var(--text)",
          fontFamily: mono ? "var(--mono)" : "var(--sans)",
        }}
      >
        {value}
      </span>
    </div>
  );
}
