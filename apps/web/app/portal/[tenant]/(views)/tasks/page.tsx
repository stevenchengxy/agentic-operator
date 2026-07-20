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

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
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
import { useI18n } from "@/app/portal/lib/preferences-context";
import {
  useResolveTask,
  useTasks,
  type TaskRow as ApiTaskRow,
} from "@/lib/hooks/useTasks";
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
  payloadAvailable: boolean;
}

interface HumanInputDescriptor {
  kind: "human_input";
  field: string;
  type: string;
  required: boolean;
  prompt: string;
}

function humanInputDescriptor(payload: Record<string, unknown>): HumanInputDescriptor | null {
  const value = payload.inputBinding;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    row.kind !== "human_input"
    || typeof row.field !== "string"
    || typeof row.type !== "string"
    || typeof row.required !== "boolean"
    || typeof row.prompt !== "string"
  ) return null;
  return row as unknown as HumanInputDescriptor;
}

function humanInputType(type: string): "string" | "number" | "integer" | "boolean" | "json" {
  const normalized = type.trim().toLowerCase().replace(/\s+/g, "");
  if (["number", "float", "double", "decimal", "numeric"].includes(normalized)) return "number";
  if (["integer", "int", "int32", "int64", "long"].includes(normalized)) return "integer";
  if (["boolean", "bool"].includes(normalized)) return "boolean";
  if (/\[\]$/.test(normalized) || /^(array|list|set|object|record|map|json)/.test(normalized)) return "json";
  return "string";
}

function parseHumanInputValue(descriptor: HumanInputDescriptor, raw: string): unknown {
  const kind = humanInputType(descriptor.type);
  if (kind === "boolean") return raw === "true" ? true : raw === "false" ? false : undefined;
  if (kind === "number" || kind === "integer") {
    if (!raw.trim()) return undefined;
    const value = Number(raw);
    if (!Number.isFinite(value) || (kind === "integer" && !Number.isSafeInteger(value))) {
      throw new Error(`「${descriptor.field}」不是有效的 ${descriptor.type}`);
    }
    return value;
  }
  if (kind === "json") {
    if (!raw.trim()) return undefined;
    return JSON.parse(raw) as unknown;
  }
  return raw.trim() ? raw : undefined;
}

function fromApi(t: ApiTaskRow): TaskItem {
  const createdAt = t.createdAt ? Date.parse(t.createdAt) : null;
  const payloadAvailable =
    typeof t.payloadJson === "object" &&
    t.payloadJson !== null &&
    !Array.isArray(t.payloadJson);
  const payload = payloadAvailable
    ? (t.payloadJson as Record<string, unknown>)
    : {};
  return {
    id: t.id,
    type: t.type,
    title: t.title,
    priority: t.priority === "medium" ? "med" : (t.priority ?? "unknown"),
    status: t.status,
    createdAt: Number.isFinite(createdAt) ? createdAt : null,
    awaitingFrom: t.awaitingRole,
    payload,
    payloadAvailable,
  };
}

export default function TasksPage() {
  // Live tasks + workflow DAG via TanStack Query — kept in sync by useStream
  // cache invalidation. DAG carries triggers/emits per agent so the task
  // detail can render "will emit on approve" / "downstream listeners".
  const { t } = useI18n();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const tasksQuery = useTasks();
  const dagQuery = useDag();
  const apiTasks = tasksQuery.data ?? [];
  const dagAgents = dagQuery.data?.agents ?? [];

  const tasks = useMemo<TaskItem[]>(
    // This route is an inbox, not task history. Resolved/snoozed rows remain
    // available through the API, but must not continue to count as pending or
    // remain actionable after a decision succeeds.
    () => apiTasks.filter((task) => task.status === "open").map(fromApi),
    [apiTasks],
  );
  const tasksReady = tasksQuery.data !== undefined && !tasksQuery.isError;
  const countValue: string | number = tasksReady
    ? tasks.length
    : tasksQuery.isLoading
      ? "…"
      : "—";
  const highValue: string | number = tasksReady
    ? tasks.filter((task) => task.priority === "high").length
    : countValue;

  const [filter, setFilter] = useState<"all" | "high" | "med" | "low">("all");

  const filtered = useMemo(
    () => tasks.filter((t) => (filter === "all" ? true : t.priority === filter)),
    [tasks, filter],
  );
  const requestedId = searchParams.get("selected");
  const selectedActualId =
    (requestedId && filtered.some((task) => task.id === requestedId)
      ? requestedId
      : filtered[0]?.id) ?? null;
  const selected = useMemo(
    () => filtered.find((task) => task.id === selectedActualId) ?? null,
    [filtered, selectedActualId],
  );

  const selectTask = useCallback(
    (id: string) => {
      const next = new URLSearchParams(searchParams.toString());
      next.set("selected", id);
      router.replace(`${pathname}?${next.toString()}` as never, { scroll: false });
    },
    [pathname, router, searchParams],
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <ViewHeader
        title={t("nav.tasks")}
        subtitle={t("tasks.subtitle", {
          pending: countValue,
          high: highValue,
        })}
        badge={
          <Badge tone={tasksQuery.isError ? "red" : tasksReady ? "amber" : "muted"}>
            {t("tasks.openBadge", { count: countValue })}
          </Badge>
        }
      />

      {dagQuery.isError ? (
        <div
          role="alert"
          style={{
            padding: "9px 16px",
            borderBottom: "1px solid var(--border)",
            color: "var(--amber)",
            fontSize: 12,
          }}
        >
          {t("tasks.workflowContextUnavailable")}: {dagQuery.error.message}
        </div>
      ) : null}

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
                  onClick={() => selectTask(t.id)}
                />
              ))
            )}
          </div>
        </aside>

          <div style={{ overflow: "auto", minHeight: 0 }}>
          {tasksQuery.isError ? (
            <Empty
              title={t("tasks.loadErrorTitle")}
              hint={tasksQuery.error.message}
            />
          ) : tasksQuery.isLoading && !tasksQuery.data ? (
            <Empty title={t("tasks.loadingTitle")} hint="" />
          ) : selected ? (
            <TaskDetail
              task={selected}
              agents={dagAgents}
              workflowStatus={
                dagQuery.isError
                  ? "error"
                  : dagQuery.isLoading && !dagQuery.data
                    ? "loading"
                    : "ready"
              }
            />
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
  workflowStatus,
}: {
  task: TaskItem;
  agents: DagAgent[];
  workflowStatus: "loading" | "ready" | "error";
}) {
  const { t } = useI18n();
  const resolveTask = useResolveTask();
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [clarificationAnswers, setClarificationAnswers] = useState<string[]>([]);
  const [humanInputAnswer, setHumanInputAnswer] = useState("");
  const inputDescriptor = humanInputDescriptor(task.payload);
  // /v1/tasks payload doesn't carry an agent reference today; surface the
  // closest match by `awaitingRole` (if a Human agent with that title
  // exists). Otherwise the panel falls back to the literal role string.
  const taskAgentName =
    typeof task.payload.agentName === "string" ? task.payload.agentName : null;
  const agent =
    agents.find(
      (a) =>
        a.name === taskAgentName ||
        a.title === taskAgentName ||
        a.title === task.awaitingFrom ||
        a.name === task.awaitingFrom,
    ) ?? null;

  useEffect(() => {
    setDecisionError(null);
    setClarificationAnswers([]);
    setHumanInputAnswer("");
  }, [task.id]);

  const resolve = useCallback(
    async (decision: "approve" | "reject") => {
      setDecisionError(null);
      try {
        const questions = Array.isArray(task.payload.questions)
          ? task.payload.questions.filter(
              (question): question is string => typeof question === "string",
            )
          : [];
        let payload: unknown =
          decision === "approve" && task.type === "requirementReClarification"
            ? {
                answers: questions.map((question, index) => ({
                  question,
                  answer: clarificationAnswers[index]?.trim() ?? "",
                })),
              }
            : undefined;
        if (decision === "approve" && inputDescriptor) {
          const value = parseHumanInputValue(inputDescriptor, humanInputAnswer);
          if (inputDescriptor.required && value === undefined) {
            throw new Error(t("tasks.humanInputRequired"));
          }
          payload = { value };
        }
        await resolveTask.mutateAsync({ id: task.id, decision, payload });
      } catch (error) {
        setDecisionError(
          error instanceof Error ? error.message : t("tasks.resolveFailed"),
        );
      }
    },
    [clarificationAnswers, humanInputAnswer, inputDescriptor, resolveTask, task.id, task.payload.questions, task.type, t],
  );

  const clarificationQuestions = Array.isArray(task.payload.questions)
    ? task.payload.questions.filter(
        (question): question is string => typeof question === "string",
      )
    : [];
  const clarificationIncomplete =
    task.type === "requirementReClarification" &&
    (clarificationQuestions.length === 0 ||
      clarificationQuestions.some(
        (_question, index) => !clarificationAnswers[index]?.trim(),
      ));
  const humanInputIncomplete = Boolean(
    inputDescriptor?.required && !humanInputAnswer.trim(),
  );

  if (!task.payloadAvailable) {
    return (
      <Empty
        title={t("tasks.payloadUnavailable")}
        hint={t("tasks.payloadUnavailableHint", { id: task.id })}
      />
    );
  }

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
        <ClarificationPayload
          payload={task.payload}
          answers={clarificationAnswers}
          onAnswer={(index, answer) =>
            setClarificationAnswers((current) => {
              const next = [...current];
              next[index] = answer;
              return next;
            })
          }
        />
      )}
      {task.type === "packageSupplement" && (
        <SupplementPayload payload={task.payload} />
      )}
      {task.type === "manualPublish" && (
        <ManualPublishPayload payload={task.payload} />
      )}
      {inputDescriptor && (
        <HumanInputPayload
          descriptor={inputDescriptor}
          value={humanInputAnswer}
          onChange={setHumanInputAnswer}
        />
      )}
      {![
        "jdReview",
        "packageReview",
        "resumeFix",
        "requirementReClarification",
        "packageSupplement",
        "manualPublish",
      ].includes(task.type) && !inputDescriptor && <GenericTaskPayload payload={task.payload} />}

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
          <Button
            tone="primary"
            icon="check"
            onClick={() => void resolve("approve")}
            disabled={resolveTask.isPending || clarificationIncomplete || humanInputIncomplete}
            title={clarificationIncomplete ? t("tasks.answerRequired") : humanInputIncomplete ? t("tasks.humanInputRequired") : undefined}
          >
            {decisionLabel(task.type, "primary", t)}
          </Button>
          {decisionLabel(task.type, "secondary", t) && (
            <Button
              tone="danger"
              onClick={() => void resolve("reject")}
              disabled={resolveTask.isPending}
            >
              {decisionLabel(task.type, "secondary", t)}
            </Button>
          )}
        </div>
        {decisionError ? (
          <div
            role="alert"
            style={{ marginTop: 10, fontSize: 11.5, color: "var(--red)" }}
          >
            {decisionError}
          </div>
        ) : null}
      </div>

      {/* Run context */}
      <Panel title={t("tasks.workflowContext")} padded style={{ marginTop: 16 }}>
        {workflowStatus !== "ready" ? (
          <Empty
            title={
              workflowStatus === "loading"
                ? t("tasks.workflowContextLoading")
                : t("tasks.workflowContextUnavailable")
            }
            hint=""
          />
        ) : (
          <>
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
          </>
        )}
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
      secondary: null,
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
    agentInput: {
      primary: t("tasks.decision.agentInput.primary"),
      secondary: t("tasks.decision.agentInput.secondary"),
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
    version?: string;
    agentName?: string;
    actionName?: string;
    description?: string;
    subject?: string;
    condition?: string;
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
        action={p.version ? <Badge tone="muted">{p.version}</Badge> : undefined}
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
            <KV label={t("tasks.status")} value={<Badge tone="signal">OPEN</Badge>} />
          </div>
          <SectionList
            label={t("tasks.responsibilities")}
            items={p.responsibilities ?? []}
          />
          <SectionList label={t("tasks.requirements")} items={p.requirements ?? []} />
        </div>
      </Panel>
      <Panel title={t("tasks.agentReasoning")} padded>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <KV label={t("tasks.agent")} value={p.agentName ?? "—"} mono />
          <KV label={t("tasks.action")} value={p.actionName ?? "—"} mono />
          <KV label={t("tasks.subject")} value={p.subject ?? "—"} mono />
          <KV label={t("tasks.reason")} value={p.description ?? p.condition ?? "—"} />
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
    target?: string;
    method?: string;
    dryRun?: boolean;
    willEmit?: string;
    attachments?: string[];
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
        {(p.attachments?.length ?? 0) > 0 ? (
          <SectionList label={t("tasks.attachments")} items={p.attachments ?? []} />
        ) : null}
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
          <KV label={t("tasks.target")} value={p.target ?? "—"} />
          <KV label={t("tasks.method")} value={p.method ?? "—"} />
          <KV
            label={t("tasks.preflightCheck")}
            value={
              p.dryRun == null ? "—" : (
                <Badge tone={p.dryRun ? "green" : "muted"}>
                  {p.dryRun ? t("tasks.preflightPassed") : t("tasks.preflightNotPassed")}
                </Badge>
              )
            }
          />
          <KV
            label={t("tasks.willEmit")}
            value={p.willEmit ? <Badge tone="green">{p.willEmit}</Badge> : "—"}
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
      </div>
    </Panel>
  );
}

function ClarificationPayload({
  payload,
  answers,
  onAnswer,
}: {
  payload: Record<string, unknown>;
  answers: string[];
  onAnswer: (index: number, answer: string) => void;
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
              value={answers[i] ?? ""}
              onChange={(event) => onAnswer(i, event.target.value)}
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
    </Panel>
  );
}

function HumanInputPayload({
  descriptor,
  value,
  onChange,
}: {
  descriptor: HumanInputDescriptor;
  value: string;
  onChange: (value: string) => void;
}) {
  const { t } = useI18n();
  const kind = humanInputType(descriptor.type);
  const sharedStyle = {
    width: "100%",
    boxSizing: "border-box" as const,
    padding: "9px 10px",
    border: "1px solid var(--border-2)",
    borderRadius: 5,
    background: "var(--bg-2)",
    color: "var(--text)",
    fontFamily: kind === "json" ? "var(--mono)" : "inherit",
    fontSize: 13,
  };
  return (
    <Panel title={t("tasks.humanInputTitle")} padded>
      <label htmlFor={`human-input-${descriptor.field}`} style={{ display: "block" }}>
        <div style={{ fontSize: 13, lineHeight: 1.5, color: "var(--text)", marginBottom: 8 }}>
          {descriptor.prompt}
        </div>
        <div className="mono" style={{ fontSize: 10.5, color: "var(--text-3)", marginBottom: 6 }}>
          {descriptor.field} · {descriptor.type}{descriptor.required ? ` · ${t("tasks.humanInputRequiredBadge")}` : ""}
        </div>
        {kind === "boolean" ? (
          <select
            id={`human-input-${descriptor.field}`}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            style={sharedStyle}
          >
            <option value="">{t("tasks.humanInputChoose")}</option>
            <option value="true">{t("tasks.humanInputYes")}</option>
            <option value="false">{t("tasks.humanInputNo")}</option>
          </select>
        ) : kind === "number" || kind === "integer" ? (
          <input
            id={`human-input-${descriptor.field}`}
            type="number"
            step={kind === "integer" ? 1 : "any"}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            placeholder={t("tasks.humanInputPlaceholder")}
            style={sharedStyle}
          />
        ) : (
          <textarea
            id={`human-input-${descriptor.field}`}
            rows={kind === "json" ? 7 : 3}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            placeholder={kind === "json" ? t("tasks.humanInputJsonPlaceholder") : t("tasks.humanInputPlaceholder")}
            style={{ ...sharedStyle, resize: "vertical" }}
          />
        )}
      </label>
    </Panel>
  );
}

function GenericTaskPayload({ payload }: { payload: Record<string, unknown> }) {
  const { t } = useI18n();
  return (
    <Panel title={t("tasks.taskPayload")} padded>
      <pre
        style={{
          margin: 0,
          padding: 12,
          maxHeight: 360,
          overflow: "auto",
          borderRadius: 5,
          background: "var(--bg-2)",
          color: "var(--text-2)",
          fontFamily: "var(--mono)",
          fontSize: 11.5,
          lineHeight: 1.6,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {JSON.stringify(payload, null, 2)}
      </pre>
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
