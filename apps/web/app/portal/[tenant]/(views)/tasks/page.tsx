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
  Panel,
  ViewHeader,
  FilterChip,
} from "@/app/portal/components";
import { fmtAgo } from "@/app/portal/lib/format";
import {
  useResolveTask,
  useTasks,
  type TaskRow as ApiTaskRow,
} from "@/lib/hooks/useTasks";
import { useDag, type DagAgent } from "@/lib/hooks/useAgents";
import { TaskFormFields } from "@/app/portal/components/tasks/TaskFormFields";
import {
  buildTaskFormDefinition,
  buildTaskResolutionPayload,
  initialTaskFormValues,
  type TaskDecisionOption,
  type TaskFormRawValue,
} from "@/app/portal/components/tasks/task-form";

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
  formSchema: unknown;
  preparedContext: unknown;
  description: string | null;
}

const LEGACY_TASK_TYPES = new Set([
  "jdReview",
  "packageReview",
  "resumeFix",
  "requirementReClarification",
  "packageSupplement",
  "manualPublish",
]);

function payloadString(
  payload: Record<string, unknown>,
  key: string,
): string | null {
  const value = payload[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function fromApi(t: ApiTaskRow): TaskItem {
  const createdAt = t.createdAt ? Date.parse(t.createdAt) : null;
  const payload =
    (t.payloadJson as Record<string, unknown> | null | undefined) ?? {};
  const priority = t.priority === "medium" ? "med" : (t.priority ?? "med");
  return {
    id: t.id,
    type: t.type,
    title: t.title,
    priority,
    status: t.status,
    createdAt: Number.isFinite(createdAt) ? createdAt : null,
    // Generated runtime tasks carry this on payloadJson today. Prefer the
    // indexed DB column once populated, but never lose the authored role.
    awaitingFrom: t.awaitingRole ?? payloadString(payload, "awaitingRole"),
    payload,
    formSchema: payload.formSchema ?? null,
    preparedContext: payload.preparedContext ?? null,
    description: payloadString(payload, "description"),
  };
}

export default function TasksPage() {
  // Live tasks + workflow DAG via TanStack Query — kept in sync by useStream
  // cache invalidation. DAG carries triggers/emits per agent so the task
  // detail can render "will emit on approve" / "downstream listeners".
  const tasksQuery = useTasks();
  const dagQuery = useDag();
  const apiTasks = tasksQuery.data ?? [];
  const dagAgents = dagQuery.data?.agents ?? [];

  const tasks = useMemo<TaskItem[]>(
    () => apiTasks.filter((task) => task.status === "open").map(fromApi),
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
    () =>
      tasks.filter((t) => (filter === "all" ? true : t.priority === filter)),
    [tasks, filter],
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <ViewHeader
        title="Human tasks"
        subtitle={`${tasks.length} pending · ${tasks.filter((t) => t.priority === "high").length} high priority`}
        badge={<Badge tone="amber">{tasks.length} OPEN</Badge>}
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
                {p === "all" ? "All" : p.toUpperCase()}
              </FilterChip>
            ))}
          </div>
          <div style={{ flex: 1, overflow: "auto" }}>
            {tasksQuery.isError ? (
              <Empty
                title="Failed to load tasks"
                hint={tasksQuery.error?.message ?? "api unreachable on :3501"}
              />
            ) : tasksQuery.isLoading && tasks.length === 0 ? (
              <Empty title="Loading tasks…" hint="" />
            ) : filtered.length === 0 ? (
              <Empty
                title={
                  tasks.length === 0
                    ? "No human tasks yet"
                    : "No tasks at this priority"
                }
                hint={
                  tasks.length === 0
                    ? "Tasks appear here when an agent emits a HUMAN_TASK event."
                    : ""
                }
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
            <TaskDetail key={selected.id} task={selected} agents={dagAgents} />
          ) : (
            <Empty title="Inbox zero" hint="No pending human tasks" />
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
        borderLeft: active
          ? "2px solid var(--signal)"
          : "2px solid transparent",
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
          Awaiting {task.awaitingFrom}
        </div>
      ) : null}
    </button>
  );
}

function TaskDetail({ task, agents }: { task: TaskItem; agents: DagAgent[] }) {
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
            {task.priority.toUpperCase()} PRIORITY
          </Badge>
          <Badge tone="muted">{task.id}</Badge>
          <ActorTag actor="Human" />
          <span style={{ fontSize: 11, color: "var(--text-3)" }}>
            created {task.createdAt ? fmtAgo(task.createdAt) : "—"}
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
          Awaiting{" "}
          <span style={{ color: "var(--text)" }}>
            {task.awaitingFrom ?? "operator"}
          </span>
          {agent && agent.title !== task.awaitingFrom
            ? ` · workflow step ${agent.title}`
            : null}
        </div>
      </header>

      {/* Type-specific payload renderers (all 6 per audit §4.6) */}
      {task.type === "jdReview" && <JDReviewPayload payload={task.payload} />}
      {task.type === "packageReview" && (
        <PackagePayload payload={task.payload} />
      )}
      {task.type === "resumeFix" && <ResumeFixPayload payload={task.payload} />}
      {task.type === "requirementReClarification" && (
        <ClarificationPayload payload={task.payload} />
      )}
      {task.type === "packageSupplement" && (
        <SupplementPayload payload={task.payload} />
      )}
      {task.type === "manualPublish" && (
        <ManualPublishPayload payload={task.payload} />
      )}

      {!LEGACY_TASK_TYPES.has(task.type) || task.formSchema ? (
        <GenericTaskContext task={task} />
      ) : null}

      <TaskDecisionPanel task={task} />

      {/* Run context */}
      <Panel title="Workflow context" padded style={{ marginTop: 16 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            fontSize: 12,
          }}
        >
          <span style={{ color: "var(--text-3)" }}>
            Will emit after resolution:
          </span>
          {agent?.emits?.map((e) => (
            <Badge key={e} tone="green">
              {e}
            </Badge>
          )) ?? null}
        </div>
        <div style={{ marginTop: 8, fontSize: 12, color: "var(--text-3)" }}>
          Downstream listeners:{" "}
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

function GenericTaskContext({ task }: { task: TaskItem }) {
  const agentName = payloadString(task.payload, "agentName");
  const actionName = payloadString(task.payload, "actionName");
  const hasContext =
    task.preparedContext !== null && task.preparedContext !== undefined;
  return (
    <Panel
      title="Decision context"
      subtitle={actionName ?? task.type}
      padded
      style={{ marginTop: 12 }}
    >
      {task.description ? (
        <p
          style={{
            margin: "0 0 12px",
            color: "var(--text-2)",
            fontSize: 12.5,
            lineHeight: 1.55,
          }}
        >
          {task.description}
        </p>
      ) : null}
      {agentName ? (
        <div style={{ marginBottom: 10, fontSize: 11, color: "var(--text-3)" }}>
          Created by <span className="mono">{agentName}</span>
        </div>
      ) : null}
      {hasContext ? (
        <pre
          aria-label="Prepared decision context"
          style={{
            margin: 0,
            maxHeight: 320,
            overflow: "auto",
            padding: 12,
            borderRadius: 4,
            border: "1px solid var(--border)",
            background: "var(--panel-2)",
            color: "var(--text-2)",
            fontFamily: "var(--mono)",
            fontSize: 11.5,
            whiteSpace: "pre-wrap",
          }}
        >
          {typeof task.preparedContext === "string"
            ? task.preparedContext
            : JSON.stringify(task.preparedContext, null, 2)}
        </pre>
      ) : (
        <div style={{ color: "var(--text-3)", fontSize: 12 }}>
          No prepared context was supplied by the preceding step.
        </div>
      )}
    </Panel>
  );
}

function TaskDecisionPanel({ task }: { task: TaskItem }) {
  const definition = useMemo(
    () => buildTaskFormDefinition(task.formSchema),
    [task.formSchema],
  );
  const [values, setValues] = useState<Record<string, TaskFormRawValue>>(() =>
    initialTaskFormValues(definition),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const resolveTask = useResolveTask();

  function changeField(name: string, value: TaskFormRawValue) {
    setValues((current) => ({ ...current, [name]: value }));
    setErrors((current) => {
      if (!current[name]) return current;
      const next = { ...current };
      delete next[name];
      return next;
    });
    if (resolveTask.error) resolveTask.reset();
  }

  async function submit(option: TaskDecisionOption) {
    const result = buildTaskResolutionPayload(definition, values, option);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    try {
      await resolveTask.mutateAsync({
        id: task.id,
        decision: option.decision,
        payload: result.payload,
      });
    } catch {
      // React Query exposes the request error below and retains the form so
      // the operator can correct or retry without re-entering their values.
    }
  }

  return (
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
        Operator decision
      </div>
      <TaskFormFields
        definition={definition}
        values={values}
        errors={errors}
        disabled={resolveTask.isPending}
        onChange={changeField}
      />
      <div
        style={{
          display: "flex",
          gap: 8,
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        {definition.decisions.map((option) => (
          <Button
            key={`${option.decision}:${option.formValue}`}
            tone={
              option.decision === "approve"
                ? "primary"
                : option.decision === "reject"
                  ? "danger"
                  : "default"
            }
            icon={
              option.decision === "approve"
                ? "check"
                : option.decision === "reject"
                  ? "x"
                  : undefined
            }
            disabled={resolveTask.isPending}
            onClick={() => void submit(option)}
          >
            {task.formSchema
              ? option.label
              : option.decision === "approve"
                ? decisionLabel(task.type, "primary")
                : (decisionLabel(task.type, "secondary") ?? option.label)}
          </Button>
        ))}
        <span
          style={{ marginLeft: "auto", fontSize: 11, color: "var(--text-3)" }}
        >
          {resolveTask.isPending
            ? "Submitting decision…"
            : "The submitted form becomes the workflow's manual-step output."}
        </span>
      </div>
      {resolveTask.error ? (
        <div
          role="alert"
          style={{ marginTop: 10, color: "var(--red)", fontSize: 11.5 }}
        >
          {resolveTask.error instanceof Error
            ? resolveTask.error.message
            : "Failed to resolve task."}
        </div>
      ) : null}
    </div>
  );
}

function decisionLabel(
  type: string,
  slot: "primary" | "secondary",
): string | null {
  const map: Record<string, { primary: string; secondary: string | null }> = {
    jdReview: { primary: "Approve JD", secondary: "Reject with notes" },
    packageReview: {
      primary: "Approve & submit",
      secondary: "Send back to recruiter",
    },
    resumeFix: { primary: "Mark fixed", secondary: "Re-upload" },
    requirementReClarification: {
      primary: "Submit answers",
      secondary: null,
    },
    packageSupplement: { primary: "Mark complete", secondary: null },
    manualPublish: { primary: "Confirm published", secondary: null },
  };
  return map[type]?.[slot] ?? (slot === "primary" ? "Approve" : null);
}

// ─── Payload renderers (6 of 6) ──────────────────────────────────────────────

function JDReviewPayload({ payload }: { payload: Record<string, unknown> }) {
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
        title="Generated JD"
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
              Title
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
            <KV label="Level" value={p.level ?? "—"} mono />
            <KV label="City" value={p.city ?? "—"} />
            <KV label="Salary" value={p.salary ?? "—"} />
            <KV label="Status" value={<Badge tone="signal">DRAFT</Badge>} />
          </div>
          <SectionList
            label="Responsibilities"
            items={p.responsibilities ?? []}
          />
          <SectionList label="Requirements" items={p.requirements ?? []} />
        </div>
      </Panel>
      <Panel title="Agent reasoning" padded>
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
            Drafted from{" "}
            <span className="mono" style={{ color: "var(--text)" }}>
              REQ
            </span>{" "}
            after clarification. Template{" "}
            <span className="mono" style={{ color: "var(--text)" }}>
              jd-tencent-wxg-v3
            </span>{" "}
            applied.
          </p>
          <p style={{ margin: 0 }}>
            Top 5 search keywords surfaced:{" "}
            <span className="mono" style={{ color: "var(--signal)" }}>
              backend, java, go, messaging, distributed-systems
            </span>
            .
          </p>
          <p style={{ margin: 0 }}>
            Salary range confirmed within ¥45-65k client cap.
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
            <strong style={{ color: "var(--amber)" }}>Heads up · </strong>
            <span style={{ color: "var(--text-2)" }}>
              This req has been re-opened twice in 2026 Q1. Consider tightening
              &lsquo;distributed systems fundamentals&rsquo; before posting to
              BOSS.
            </span>
          </div>
        </div>
      </Panel>
    </div>
  );
}

function PackagePayload({ payload }: { payload: Record<string, unknown> }) {
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
        title="Candidate package"
        padded
        action={<Badge tone="signal">SCORE {p.matchScore ?? "—"}</Badge>}
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
          <KV label="Match" value={`${p.matchScore ?? "—"}/100`} mono />
          <KV
            label="Missing items"
            value={
              (p.missingItems?.length ?? 0) === 0 ? (
                <Badge tone="green">COMPLETE</Badge>
              ) : (
                (p.missingItems ?? []).join(", ")
              )
            }
          />
          <SectionList label="Highlights" items={p.highlights ?? []} />
        </div>
        <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
          <Button small icon="external">
            Resume.pdf
          </Button>
          <Button small icon="external">
            Interview clip
          </Button>
          <Button small icon="external">
            Eval report
          </Button>
        </div>
      </Panel>
      <Panel title="Submission preview" padded>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 8,
            fontSize: 12,
            color: "var(--text)",
          }}
        >
          <KV label="Target" value="Tencent ATS · WXG queue" />
          <KV label="Method" value="API auto-submit" />
          <KV
            label="Mock dry-run"
            value={<Badge tone="green">OK · req-ack received</Badge>}
          />
          <KV
            label="Will emit"
            value={<Badge tone="green">APPLICATION_SUBMITTED</Badge>}
          />
        </div>
      </Panel>
    </div>
  );
}

function ResumeFixPayload({ payload }: { payload: Record<string, unknown> }) {
  const p = payload as { file?: string; error?: string };
  return (
    <Panel
      title="Parse error"
      padded
      action={<Badge tone="red">PARSE FAIL</Badge>}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <KV
          label="File"
          value={<span className="mono">{p.file ?? "—"}</span>}
        />
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
            Error
          </div>
          <div
            style={{
              fontSize: 12.5,
              color: "var(--red)",
              padding: 10,
              background: "rgba(255,100,112,0.06)",
              border: "1px solid rgba(255,100,112,0.25)",
              borderRadius: 4,
            }}
          >
            {p.error ?? "Unknown error"}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
          <Button small icon="upload">
            Re-upload PDF
          </Button>
          <Button small>Edit parsed fields</Button>
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
  const p = payload as { questions?: string[] };
  return (
    <Panel title="Open questions for client" padded>
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
              placeholder="answer…"
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

function SupplementPayload({ payload }: { payload: Record<string, unknown> }) {
  const p = payload as { missing?: string[] };
  return (
    <Panel title="Items requested" padded>
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
            <Icon name="upload" size={12} style={{ color: "var(--text-3)" }} />
            <span
              className="mono"
              style={{ fontSize: 12, color: "var(--text)" }}
            >
              {m}
            </span>
            <Button small style={{ marginLeft: "auto" }}>
              Attach
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
  const p = payload as { channel?: string; reason?: string };
  return (
    <Panel title="Manual publish required" padded>
      <KV
        label="Channel"
        value={<Badge tone="amber">{p.channel ?? "—"}</Badge>}
      />
      <KV label="Reason" value={p.reason ?? "—"} />
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
        Open the generated helper page → copy each field into the
        channel&rsquo;s post composer → return here and confirm.
      </div>
      <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
        <Button small icon="external" tone="primary">
          Open helper page
        </Button>
      </div>
    </Panel>
  );
}

// ─── shared bits ─────────────────────────────────────────────────────────────

function SectionList({ label, items }: { label: string; items: string[] }) {
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
