"use client";

/**
 * Dashboard — control-plane overview, "management overview" redesign
 * (Layout A: health-first vertical narrative) with live motion.
 *
 * Read order top → bottom by importance:
 *   1. System-health hero    — one-line verdict (green/amber/red) from
 *                              /health + 24h error rate + high-priority tasks,
 *                              with a breathing status dot + subsystem chips.
 *   2. 4 KPI cards           — active runs · throughput · error rate · spend,
 *                              all real data; numbers count up, sparklines draw.
 *   3. Actionable middle     — left: active runs (cancellable) + pending HITL
 *                              tasks; right: live event stream (pausable).
 *   4. Cost + throughput     — spend-by-model (/v1/usage) + per-agent
 *                              throughput bars (/v1/throughput).
 *   5. Agent activity        — collapsed by default; secondary detail.
 *
 * Motion (see global.css): staggered card entrance (.rise), hover lift
 * (.dash-card), breathing verdict dot (.health-pulse), sparkline draw
 * (.spark-draw), count-up numbers (<CountUp/>), and grow-in bars (<GrowBar/>).
 *
 * Data fixes vs the first pass:
 *   - spend KPI now reads /v1/usage totals (matches the cost panel exactly —
 *     no more $0.00 vs $0.03 disagreement).
 *   - throughput KPI counts events in the last hour robustly (tolerates clock
 *     skew) instead of the old broken bucket that read 0.
 *   - the stage "funnel" (meaningless for non-linear tenants, rendered
 *     "Stage 9/10/11") is replaced by honest per-agent throughput bars.
 *
 * /v1/stream SSE is mounted once at the shell root and auto-invalidates every
 * query below; the "pause" control freezes the event panel's rendered window
 * without tearing down the global subscription.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ActorTag,
  Badge,
  Button,
  Empty,
  Panel,
  Sparkline,
  StatusDot,
  ViewHeader,
  CountUp,
  GrowBar,
  Th,
  Td,
  useToast,
  type StatusName,
} from "@/app/portal/components";
import { fmtAgo, fmtDur, fmtNum, fmtTime } from "@/app/portal/lib/format";
import { useTenant } from "@/app/portal/lib/use-tenant";
import { useI18n } from "@/app/portal/lib/preferences-context";
import {
  useAgents,
  useCounts,
  useThroughput,
  type AgentListRow,
  type ThroughputAgent,
} from "@/lib/hooks/useAgents";
import { useEvents, type EventRow } from "@/lib/hooks/useEvents";
import { useTasks, type TaskRow } from "@/lib/hooks/useTasks";
import { useRuns, useCancelRun, type RunListRow } from "@/lib/hooks/useRuns";
import { useHealth, fmtBytes } from "@/lib/hooks/useHealth";
import {
  useUsage,
  useBudget,
  type BudgetRow,
  type UsageResponse,
} from "@/lib/hooks/useUsage";

/** Narrowed view of an event row for the ticker. */
interface EventItem {
  id: string;
  name: string;
  color: string;
  at: number | null;
  sourceTitle: string | null;
  subject: string;
  consumers: Array<{
    runId: string;
    agentName: string | null;
    agentTitle: string | null;
    status: string;
  }>;
}

/** Narrowed view of a task row for the pending-tasks panel. */
interface TaskItem {
  id: string;
  title: string;
  priority: string;
  createdAt: number | null;
  awaitingFrom: string | null;
}

function fromEventRow(e: EventRow): EventItem {
  const parsedAt = e.receivedAt ? Date.parse(e.receivedAt) : Number.NaN;
  return {
    id: e.id,
    name: e.name,
    color: e.color ?? "muted",
    at: Number.isFinite(parsedAt) ? parsedAt : null,
    sourceTitle: e.sourceAgentTitle ?? e.sourceAgentName ?? null,
    subject: e.subject ?? "",
    consumers: e.consumers ?? [],
  };
}

function fromTaskRow(t: TaskRow): TaskItem {
  return {
    id: t.id,
    title: t.title,
    priority: t.priority === "medium" ? "med" : (t.priority ?? "unknown"),
    createdAt: t.createdAt ? Date.parse(t.createdAt) : null,
    awaitingFrom: t.awaitingRole,
  };
}

/** API run status → status-dot name. */
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

/** Format integer USD cents as a dollar string. */
function usd(cents: number | null | undefined): string {
  return cents == null ? "—" : `$${(cents / 100).toFixed(2)}`;
}

type DashboardSourceStatus = "loading" | "ready" | "error";

interface DashboardSources {
  counts: DashboardSourceStatus;
  agents: DashboardSourceStatus;
  tasks: DashboardSourceStatus;
  events: DashboardSourceStatus;
  runs: DashboardSourceStatus;
  throughput: DashboardSourceStatus;
  usage: DashboardSourceStatus;
  budget: DashboardSourceStatus;
  health: DashboardSourceStatus;
}

function sourceStatus(
  data: unknown,
  isLoading: boolean,
  isError: boolean,
): DashboardSourceStatus {
  if (isError) return "error";
  if (data !== undefined) return "ready";
  return isLoading ? "loading" : "error";
}

// ─── Page (data wiring) ──────────────────────────────────────────────────────

export default function DashboardPage() {
  const countsQuery = useCounts();
  const agentsQuery = useAgents();
  const tasksQuery = useTasks();
  const eventsQuery = useEvents({ limit: 200 });
  const runsQuery = useRuns({ limit: 200 });
  const throughputQuery = useThroughput("24h");
  const usageQuery = useUsage();
  const budgetQuery = useBudget();
  const healthQuery = useHealth();

  const counts = countsQuery.data ?? null;
  const agents = agentsQuery.data ?? [];
  const events = useMemo(
    () => (eventsQuery.data ?? []).map(fromEventRow),
    [eventsQuery.data],
  );
  const taskItems = useMemo(
    () =>
      (tasksQuery.data ?? [])
        .filter((task) => task.status === "open")
        .map(fromTaskRow),
    [tasksQuery.data],
  );
  const liveRuns = runsQuery.data ?? [];
  const sources: DashboardSources = {
    counts: sourceStatus(countsQuery.data, countsQuery.isLoading, countsQuery.isError),
    agents: sourceStatus(agentsQuery.data, agentsQuery.isLoading, agentsQuery.isError),
    tasks: sourceStatus(tasksQuery.data, tasksQuery.isLoading, tasksQuery.isError),
    events: sourceStatus(eventsQuery.data, eventsQuery.isLoading, eventsQuery.isError),
    runs: sourceStatus(runsQuery.data, runsQuery.isLoading, runsQuery.isError),
    throughput: sourceStatus(
      throughputQuery.data,
      throughputQuery.isLoading,
      throughputQuery.isError,
    ),
    usage: sourceStatus(usageQuery.data, usageQuery.isLoading, usageQuery.isError),
    budget: sourceStatus(budgetQuery.data, budgetQuery.isLoading, budgetQuery.isError),
    health: sourceStatus(healthQuery.data, healthQuery.isLoading, healthQuery.isError),
  };
  const sourceErrors = [
    countsQuery.error,
    agentsQuery.error,
    tasksQuery.error,
    eventsQuery.error,
    runsQuery.error,
    throughputQuery.error,
    usageQuery.error,
    budgetQuery.error,
    healthQuery.error,
  ]
    .filter((error): error is Error => error instanceof Error)
    .map((error) => error.message);

  return (
    <DashboardView
      counts={counts}
      agents={agents}
      tasks={taskItems}
      eventStream={events}
      liveRuns={liveRuns}
      throughput={throughputQuery.data?.agents ?? []}
      usage={usageQuery.data ?? null}
      budget={budgetQuery.data ?? null}
      health={healthQuery.data ?? null}
      sources={sources}
      sourceErrors={sourceErrors}
    />
  );
}

type Verdict = "ok" | "warn" | "down" | "unknown";

interface DashboardViewProps {
  counts: { runningRuns: number; okRuns24h: number; failedRuns24h: number; events24h: number; openTasks: number; totalRuns: number } | null;
  agents: AgentListRow[];
  tasks: TaskItem[];
  eventStream: EventItem[];
  liveRuns: RunListRow[];
  throughput: ThroughputAgent[];
  usage: UsageResponse | null;
  budget: BudgetRow | null;
  health: ReturnType<typeof useHealth>["data"] | null;
  sources: DashboardSources;
  sourceErrors: string[];
}

function DashboardView({
  counts,
  agents,
  tasks,
  eventStream,
  liveRuns,
  throughput,
  usage,
  budget,
  health,
  sources,
  sourceErrors,
}: DashboardViewProps) {
  const tenant = useTenant();
  const { t } = useI18n();

  const [hasMounted, setHasMounted] = useState(false);
  useEffect(() => setHasMounted(true), []);

  const [streamLive, setStreamLive] = useState(true);

  // ── Derived metrics (all from authoritative sources) ──────────────────────
  const countsReady = sources.counts === "ready" && counts != null;
  const runsReady = sources.runs === "ready";
  const tasksReady = sources.tasks === "ready";
  const eventsReady = sources.events === "ready";
  const usageReady = sources.usage === "ready" && usage != null;
  const budgetReady = sources.budget === "ready" && budget != null;
  const active = runsReady
    ? liveRuns.filter((r) => r.status === "running")
    : [];
  const runningCount = countsReady ? counts.runningRuns : null;
  const ok24 = countsReady ? counts.okRuns24h : null;
  const failed24 = countsReady ? counts.failedRuns24h : null;
  const completed24 = ok24 != null && failed24 != null ? ok24 + failed24 : null;
  const errorRatePct =
    completed24 != null && failed24 != null
      ? completed24 > 0
        ? (failed24 / completed24) * 100
        : 0
      : null;
  const highTasks = tasksReady
    ? tasks.filter((task) => task.priority === "high").length
    : null;

  // Throughput — events in the last hour. Tolerate ±1min clock skew between
  // the server-stamped receivedAt and the client clock (the old strict
  // [0,60min) bucket read 0 whenever the two drifted).
  const eventsPerHr = useMemo(() => {
    if (!eventsReady) return null;
    const now = Date.now();
    let n = 0;
    for (const e of eventStream) {
      if (e.at == null) continue;
      const age = now - e.at;
      if (age >= -60_000 && age < 3_600_000) n++;
    }
    return n;
  }, [eventStream, eventsReady]);
  // Per-minute shape for the sparkline.
  const buckets = useMemo(() => {
    if (!eventsReady) return [];
    const now = Date.now();
    const bs = new Array(60).fill(0);
    eventStream.forEach((e) => {
      if (e.at == null) return;
      const ago = Math.floor((now - e.at) / 60_000);
      const idx = ago < 0 ? 59 : ago < 60 ? 59 - ago : -1;
      if (idx >= 0) bs[idx]++;
    });
    return bs;
  }, [eventStream, eventsReady]);

  // Spend — single source of truth: /v1/usage totals (same as the cost panel).
  const spendCents = usageReady ? usage.totals.usdCents : null;
  const costComplete = usageReady ? usage.coverage.costComplete : null;
  const unpricedTokens = usageReady ? usage.coverage.unpricedTokens : null;
  const capCents = budgetReady ? budget.monthlyUsdCap : null;
  const budgetPct =
    spendCents != null && capCents != null && capCents > 0
      ? (spendCents / capCents) * 100
      : null;
  const spendSpark = useMemo(
    () => (usageReady ? usage.byDay.map((d) => d.usdCents) : []),
    [usage, usageReady],
  );

  // ── Health verdict ────────────────────────────────────────────────────────
  // `/health.ok` already folds every configured subsystem (including newer
  // runtime backends the UI may not render as individual chips). Checking
  // only the original three fields could display a green verdict while a
  // configured provider or fanout backend was down.
  const healthFail = sources.health === "ready" && !!health && !health.ok;
  const observabilityError = Object.values(sources).some(
    (status) => status === "error",
  );
  const verdict: Verdict = sources.health === "loading"
    ? "unknown"
    : healthFail || sources.health === "error"
    ? "down"
    : observabilityError || (errorRatePct != null && errorRatePct >= 5) || (highTasks != null && highTasks > 0)
      ? "warn"
      : "ok";

  // ── Event window (newest-first, deduped, frozen when paused) ───────────────
  const recentEvents = useMemo(() => {
    if (eventStream.length === 0) return [];
    const sorted = [...eventStream].sort(
      (a, b) => (b.at ?? Number.NEGATIVE_INFINITY) - (a.at ?? Number.NEGATIVE_INFINITY),
    );
    const out: EventItem[] = [];
    const seen = new Set<string>();
    for (const e of sorted) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      out.push(e);
      if (out.length >= 14) break;
    }
    return out;
  }, [eventStream]);

  const [frozen, setFrozen] = useState<EventItem[] | null>(null);
  useEffect(() => {
    if (!streamLive && frozen === null) setFrozen(recentEvents);
    if (streamLive && frozen !== null) setFrozen(null);
  }, [streamLive, frozen, recentEvents]);
  const shownEvents = streamLive ? recentEvents : (frozen ?? recentEvents);

  const [latestEventId, setLatestEventId] = useState<string | null>(null);
  useEffect(() => {
    const head = recentEvents[0]?.id ?? null;
    if (streamLive && head && head !== latestEventId) setLatestEventId(head);
  }, [recentEvents, latestEventId, streamLive]);

  // Per-agent activity (collapsible bottom section).
  const agentActivity = useMemo(() => {
    const m = new Map<
      string,
      { agent: AgentListRow; runs: number; errors: number; lastRun: number }
    >();
    agents.forEach((a) =>
      m.set(a.name, { agent: a, runs: 0, errors: 0, lastRun: 0 }),
    );
    const cutoff = Date.now() - 3_600_000;
    liveRuns.forEach((r) => {
      const ts = r.startedAt ? Date.parse(r.startedAt) : Number.NaN;
      if (!Number.isFinite(ts) || ts < cutoff) return;
      const e = m.get(r.agentName);
      if (!e) return;
      e.runs++;
      if (r.status === "failed") e.errors++;
      if (ts > e.lastRun) e.lastRun = ts;
    });
    return Array.from(m.values()).sort((a, b) => b.runs - a.runs);
  }, [agents, liveRuns]);
  const [showAgents, setShowAgents] = useState(false);

  // Cancel mutation.
  const cancelRun = useCancelRun();
  const toast = useToast();
  const handleCancel = useCallback(
    (runId: string) => {
      cancelRun.mutate(runId, {
        onSuccess: (data) => {
          toast({
            tone: data.cancelled ? "signal" : "default",
            title: data.cancelled
              ? t("dashboard.toastRunCancelling", { runId })
              : t("dashboard.toastRunAlready", { runId, status: data.status }),
            description: data.note,
          });
        },
        onError: (err) => {
          toast({
            tone: "red",
            title: t("dashboard.toastCancelFailed"),
            description: err instanceof Error ? err.message : String(err),
          });
        },
      });
    },
    [cancelRun, toast, t],
  );
  const handleCancelAll = useCallback(async () => {
    if (active.length === 0) return;
    const ids = active.map((r) => r.id);
    if (!window.confirm(t("dashboard.cancelAllConfirm", { count: ids.length }))) return;
    let cancelled = 0;
    const failures: string[] = [];
    for (const id of ids) {
      try {
        const result = await cancelRun.mutateAsync(id);
        if (result.cancelled) cancelled += 1;
        else failures.push(`${id}: ${result.status}`);
      } catch (error) {
        failures.push(`${id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    toast({
      tone: failures.length === 0 ? "signal" : cancelled > 0 ? "amber" : "red",
      title: t("dashboard.cancelAllResult", {
        cancelled,
        failed: failures.length,
      }),
      description: failures.length > 0 ? failures.slice(0, 3).join(" · ") : undefined,
    });
  }, [active, cancelRun, toast, t]);

  if (!hasMounted) {
    return (
      <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
        <ViewHeader title={t("nav.dashboard")} subtitle={t("dashboard.subtitle")} />
        <div style={{ padding: 20 }}>
          <Empty title={t("dashboard.loading")} hint="" />
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <ViewHeader
        title={t("nav.dashboard")}
        subtitle={t("dashboard.subtitle")}
        badge={
          <Badge
            tone={
              sources.events === "error"
                ? "red"
                : sources.events === "ready" && streamLive
                  ? "signal"
                  : "muted"
            }
          >
            {sources.events === "error"
              ? t("dashboard.unavailable")
              : sources.events === "loading"
                ? t("common.loading")
                : streamLive
                  ? t("dashboard.autoUpdating")
                  : t("dashboard.paused")}
          </Badge>
        }
      />

      {sourceErrors.length > 0 && (
        <div
          role="alert"
          style={{
            padding: "9px 16px",
            borderBottom: "1px solid var(--border)",
            color: "var(--amber)",
            fontSize: 12,
          }}
        >
          {t("dashboard.partialUnavailable")}: {[...new Set(sourceErrors)].join(" · ")}
        </div>
      )}

      <div style={{ flex: 1, overflow: "auto", padding: 20 }}>
        {/* ① Health hero */}
        <HealthHero
          verdict={verdict}
          running={runningCount}
          errorRatePct={errorRatePct}
          highTasks={highTasks}
          streamLive={streamLive}
          streamStatus={sources.events}
          health={health}
          healthStatus={sources.health}
        />

        {/* ② KPI row */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(4, 1fr)",
            gap: 14,
            margin: "14px 0",
          }}
        >
          <KPICard
            delay={0.06}
            label={t("dashboard.kpiActiveRuns")}
            value={runningCount == null ? "—" : <CountUp value={runningCount} />}
            sub={
              countsReady
                ? t("dashboard.kpiActiveSub", {
                    ok: ok24 ?? "—",
                    total: completed24 ?? "—",
                  })
                : t("dashboard.metricsUnavailable")
            }
            accent="var(--signal)"
          />
          <KPICard
            delay={0.1}
            label={t("dashboard.kpiThroughput")}
            value={
              eventsPerHr == null ? (
                "—"
              ) : (
                <>
                  <CountUp value={eventsPerHr} />
                  <span style={{ fontSize: 14, color: "var(--text-3)" }}> /h</span>
                </>
              )
            }
            sub={
              eventsReady
                ? t("dashboard.kpiThroughputSub")
                : t("dashboard.metricsUnavailable")
            }
            spark={buckets}
            sparkColor="var(--blue)"
          />
          <KPICard
            delay={0.14}
            label={t("dashboard.kpiErrorRate")}
            value={
              errorRatePct == null ? (
                "—"
              ) : (
                <CountUp value={errorRatePct} format={(n) => `${n.toFixed(1)}%`} />
              )
            }
            sub={
              countsReady
                ? t("dashboard.kpiErrorRateSub", {
                    failed: failed24 ?? "—",
                    total: completed24 ?? "—",
                  })
                : t("dashboard.metricsUnavailable")
            }
            tone={errorRatePct == null ? undefined : errorRatePct >= 5 ? "down" : "up"}
            accent={
              errorRatePct == null
                ? "var(--text-3)"
                : errorRatePct >= 5
                  ? "var(--red)"
                  : "var(--green)"
            }
          />
          <KPICard
            delay={0.18}
            label={t("dashboard.kpiSpend")}
            value={
              spendCents == null ? (
                "—"
              ) : (
                <CountUp
                  value={spendCents}
                  format={(n) => `${costComplete === false ? "≥" : ""}${usd(n)}`}
                />
              )
            }
            sub={
              !usageReady
                ? t("dashboard.costUnavailable")
                : (
                    <>
                      {costComplete === false ? (
                        <span
                          style={{ display: "block", color: "var(--amber)" }}
                        >
                          {t("dashboard.costIncompleteBrief", {
                            unpriced: fmtNum(unpricedTokens ?? 0),
                          })}
                        </span>
                      ) : null}
                      <span style={{ display: "block" }}>
                        {sources.budget === "error"
                          ? t("dashboard.budgetUnavailable")
                          : sources.budget === "loading"
                            ? t("common.loading")
                            : budgetPct != null
                              ? t(
                                  costComplete === false
                                    ? "dashboard.kpiBudgetSubMinimum"
                                    : "dashboard.kpiBudgetSub",
                                  {
                                    cap: usd(capCents),
                                    pct: budgetPct.toFixed(1),
                                  },
                                )
                              : t("dashboard.kpiNoBudget")}
                      </span>
                    </>
                  )
            }
            accent="var(--amber)"
            spark={spendSpark.length > 1 ? spendSpark : undefined}
            sparkColor="var(--amber)"
            footer={
              budgetPct != null ? (
                <div
                  style={{ marginTop: 10 }}
                  title={
                    costComplete === false
                      ? t("dashboard.budgetMinimumHint")
                      : undefined
                  }
                >
                  <GrowBar
                    pct={budgetPct}
                    height={5}
                    color={budgetPct >= 90 ? "var(--red)" : "var(--signal)"}
                  />
                </div>
              ) : undefined
            }
          />
        </div>

        {/* ③ Actionable middle */}
        <div style={{ display: "grid", gridTemplateColumns: "1.45fr 1fr", gap: 14 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <Panel
              className="rise dash-card"
              style={{ animationDelay: "0.22s" }}
              title={t("dashboard.panelActiveRuns")}
              subtitle={
                sources.runs === "ready"
                  ? t("dashboard.runningCount", { count: active.length })
                  : sources.runs === "loading"
                    ? t("common.loading")
                    : t("dashboard.unavailable")
              }
              action={
                <div style={{ display: "flex", gap: 6 }}>
                  {active.length > 0 && (
                    <Button
                      small
                      icon="x"
                      tone="danger"
                      onClick={handleCancelAll}
                      disabled={cancelRun.isPending}
                    >
                      {t("dashboard.cancelAll")}
                    </Button>
                  )}
                  <Link href={`/portal/${tenant}/runs` as never} style={{ textDecoration: "none" }}>
                    <Button small icon="external" tone="ghost">
                      {t("dashboard.viewAll")}
                    </Button>
                  </Link>
                </div>
              }
              padded={false}
            >
              <RunTable
                rows={active}
                tenant={tenant}
                onCancel={handleCancel}
                cancelPendingIds={cancelRun.isPending ? cancelRun.variables : undefined}
                status={sources.runs}
              />
            </Panel>

            <Panel
              className="rise dash-card"
              style={{ animationDelay: "0.26s" }}
              title={t("dashboard.panelAwaitingHumans")}
              subtitle={
                sources.tasks === "ready"
                  ? t("dashboard.tasksCount", { count: tasks.length })
                  : sources.tasks === "loading"
                    ? t("common.loading")
                    : t("dashboard.unavailable")
              }
              action={
                <Link href={`/portal/${tenant}/tasks` as never} style={{ textDecoration: "none" }}>
                  <Button small icon="external" tone="ghost">
                    {t("dashboard.inbox")}
                  </Button>
                </Link>
              }
              padded={false}
            >
              <PendingTasksList
                tasks={tasks.slice(0, 5)}
                tenant={tenant}
                status={sources.tasks}
              />
            </Panel>
          </div>

          <Panel
            className="rise dash-card"
            title={t("dashboard.panelEventStream")}
            subtitle={
              sources.events === "ready"
                ? streamLive
                  ? t("dashboard.autoUpdating")
                  : t("dashboard.paused")
                : sources.events === "loading"
                  ? t("common.loading")
                  : t("dashboard.unavailable")
            }
            action={
              <div style={{ display: "flex", gap: 6 }}>
                <Button
                  small
                  icon={streamLive ? "pause" : "play"}
                  tone="ghost"
                  onClick={() => setStreamLive((v) => !v)}
                  disabled={sources.events !== "ready"}
                >
                  {streamLive ? t("dashboard.streamPause") : t("dashboard.streamResume")}
                </Button>
                <Link href={`/portal/${tenant}/events` as never} style={{ textDecoration: "none" }}>
                  <Button small icon="external" tone="ghost">
                    {t("dashboard.open")}
                  </Button>
                </Link>
              </div>
            }
            padded={false}
            style={{ minHeight: 320, animationDelay: "0.3s" }}
          >
            <EventTicker
              events={shownEvents}
              live={streamLive}
              latestEventId={latestEventId}
              status={sources.events}
            />
          </Panel>
        </div>

        {/* ④ Cost + per-agent throughput */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginTop: 14 }}>
          <Panel
            className="rise dash-card"
            style={{ animationDelay: "0.34s" }}
            title={t("dashboard.panelCost")}
            subtitle={
              costComplete === false
                ? t("dashboard.costTotalIncompleteLabel", {
                    total: `≥${usd(spendCents)}`,
                    unpriced: fmtNum(unpricedTokens ?? 0),
                  })
                : t("dashboard.costTotalLabel", { total: usd(spendCents) })
            }
            action={
              <Link href={`/portal/${tenant}/settings/usage` as never} style={{ textDecoration: "none" }}>
                <Button small icon="external" tone="ghost">
                  {t("dashboard.usage")}
                </Button>
              </Link>
            }
            padded={false}
          >
            <CostByModel
              rows={usageReady ? usage.byModel : []}
              status={sources.usage}
            />
          </Panel>

          <Panel
            className="rise dash-card"
            style={{ animationDelay: "0.38s" }}
            title={t("dashboard.panelThroughput")}
            subtitle={t("dashboard.throughputBy", { window: "24h" })}
            padded={false}
          >
            <ThroughputByAgent
              agents={throughput}
              tenant={tenant}
              status={sources.throughput}
            />
          </Panel>
        </div>

        {/* ⑤ Agent activity — collapsed by default */}
        <div style={{ marginTop: 14 }}>
          <button
            type="button"
            onClick={() => setShowAgents((v) => !v)}
            className="dash-card"
            style={{
              width: "100%",
              textAlign: "left",
              padding: "10px 14px",
              background: "var(--panel)",
              border: "1px solid var(--border)",
              borderRadius: 8,
              color: "var(--text-2)",
              fontSize: 12,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <span style={{ color: "var(--text-3)" }}>{showAgents ? "▾" : "▸"}</span>
            {showAgents
              ? t("dashboard.agentActivityHide")
              : sources.agents === "ready"
                ? t("dashboard.agentActivityShow", { count: agents.length })
                : t("dashboard.agentActivityShowUnknown")}
          </button>
          {showAgents && (
            <div className="rise" style={{ marginTop: 12 }}>
              <Panel title={t("dashboard.panelAgentActivity")} padded={false}>
                <AgentActivityGrid
                  items={agentActivity}
                  tenant={tenant}
                  status={
                    sources.agents === "error" || sources.runs === "error"
                      ? "error"
                      : sources.agents === "loading" || sources.runs === "loading"
                        ? "loading"
                        : "ready"
                  }
                />
              </Panel>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Health hero ─────────────────────────────────────────────────────────────

function HealthHero({
  verdict,
  running,
  errorRatePct,
  highTasks,
  streamLive,
  streamStatus,
  health,
  healthStatus,
}: {
  verdict: Verdict;
  running: number | null;
  errorRatePct: number | null;
  highTasks: number | null;
  streamLive: boolean;
  streamStatus: DashboardSourceStatus;
  health: ReturnType<typeof useHealth>["data"] | null;
  healthStatus: DashboardSourceStatus;
}) {
  const { t } = useI18n();
  const tone =
    verdict === "down"
      ? "var(--red)"
      : verdict === "warn"
        ? "var(--amber)"
        : verdict === "unknown"
          ? "var(--text-3)"
          : "var(--green)";
  const verdictLabel =
    verdict === "down"
      ? t("dashboard.verdictDown")
      : verdict === "warn"
        ? t("dashboard.verdictWarn")
        : verdict === "unknown"
          ? t("dashboard.verdictUnknown")
          : t("dashboard.verdictOk");

  const parts = [
    running == null
      ? t("dashboard.heroRunningUnavailable")
      : t("dashboard.heroRunning", { count: running }),
    errorRatePct == null
      ? t("dashboard.heroErrorRateUnavailable")
      : t("dashboard.heroErrorRate", { pct: errorRatePct.toFixed(1) }),
    highTasks == null
      ? t("dashboard.heroTasksUnavailable")
      : t("dashboard.heroHighTasks", { count: highTasks }),
    streamStatus === "error"
      ? t("dashboard.heroStreamUnavailable")
      : streamStatus === "loading"
        ? t("dashboard.heroStreamChecking")
        : streamLive
          ? t("dashboard.heroStreamLive")
          : t("dashboard.heroStreamPaused"),
  ];

  const chips: Array<{ label: string; ok: boolean | null; note: string }> = [];
  if (healthStatus === "ready" && health) {
    chips.push({
      label: t("dashboard.healthInngest"),
      ok: health.inngest.ok,
      note: health.inngest.ok ? t("dashboard.healthReachable") : t("dashboard.healthUnreachable"),
    });
    chips.push({
      label: t("dashboard.healthSqlite"),
      ok: health.sqlite.ok,
      note: health.sqlite.ok
        ? `${fmtBytes(health.sqlite.sizeBytes)} · ${health.sqlite.journalMode ?? "—"}`
        : t("dashboard.healthUnreachable"),
    });
    chips.push({
      label: t("dashboard.healthLogVolume"),
      ok: health.disk.ok,
      note: health.disk.ok ? fmtBytes(health.disk.freeBytes) : t("dashboard.healthStatFailed"),
    });
    if (health.schedules) {
      chips.push({
        label: t("dashboard.healthSchedules"),
        ok: health.schedules.ok,
        note: health.schedules.unconfigured > 0
          ? t("dashboard.healthSchedulesUnconfigured", {
              count: health.schedules.unconfigured,
            })
          : health.schedules.configured > 0
            ? t("dashboard.healthSchedulesConfigured", {
                count: health.schedules.configured,
              })
            : t("dashboard.healthSchedulesDisabled", {
                count: health.schedules.disabled,
              }),
      });
    }
  } else if (healthStatus === "error") {
    for (const label of [t("dashboard.healthInngest"), t("dashboard.healthSqlite"), t("dashboard.healthLogVolume"), t("dashboard.healthSchedules")]) {
      chips.push({ label, ok: false, note: t("dashboard.healthApiUnreachable") });
    }
  } else {
    for (const label of [t("dashboard.healthInngest"), t("dashboard.healthSqlite"), t("dashboard.healthLogVolume"), t("dashboard.healthSchedules")]) {
      chips.push({ label, ok: null, note: t("dashboard.healthChecking") });
    }
  }

  return (
    <div
      className="rise dash-card"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 16,
        padding: "18px 20px",
        background: "var(--panel)",
        border: "1px solid var(--border)",
        borderLeft: `3px solid ${tone}`,
        borderRadius: 12,
        animationDelay: "0.02s",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 13, minWidth: 0 }}>
        <span
          className="health-pulse"
          style={{ color: tone, boxShadow: `0 0 12px ${tone}` }}
        />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 21, fontWeight: 650, color: "var(--text)", letterSpacing: "0.01em" }}>
            {verdictLabel}
          </div>
          <div
            style={{
              fontSize: 12.5,
              color: "var(--text-2)",
              marginTop: 3,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {parts.join(" · ")}
          </div>
        </div>
      </div>
      {chips.length > 0 && (
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, flexWrap: "wrap" }}>
          {chips.map((c) => (
            <div
              key={c.label}
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 3,
                padding: "8px 12px",
                background: "var(--panel-2)",
                border: "1px solid var(--border)",
                borderRadius: 10,
                minWidth: 96,
              }}
            >
              <span
                style={{
                  fontSize: 8.5,
                  textTransform: "uppercase",
                  letterSpacing: "0.1em",
                  color: "var(--text-3)",
                  fontFamily: "var(--mono)",
                }}
              >
                {c.label}
              </span>
              <span
                style={{
                  fontSize: 11.5,
                  fontFamily: "var(--mono)",
                  color: "var(--text-2)",
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                <StatusDot status={c.ok == null ? "idle" : c.ok ? "ok" : "failed"} size={7} />
                {c.note}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── KPI card ────────────────────────────────────────────────────────────────

function KPICard({
  label,
  value,
  sub,
  tone,
  accent,
  spark,
  sparkColor,
  footer,
  delay = 0,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  tone?: "up" | "down";
  accent?: string;
  spark?: number[];
  sparkColor?: string;
  footer?: React.ReactNode;
  delay?: number;
}) {
  return (
    <div
      className="rise dash-card"
      style={{
        background: "var(--panel)",
        border: "1px solid var(--border)",
        borderRadius: 10,
        padding: "15px 17px",
        animationDelay: `${delay}s`,
      }}
    >
      <div
        style={{
          fontSize: 10,
          fontFamily: "var(--mono)",
          textTransform: "uppercase",
          letterSpacing: "0.11em",
          color: "var(--text-3)",
        }}
      >
        {label}
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "flex-end",
          justifyContent: "space-between",
          marginTop: 9,
        }}
      >
        <div
          style={{
            fontSize: 30,
            fontFamily: "var(--mono)",
            fontWeight: 550,
            letterSpacing: "-0.02em",
            lineHeight: 1,
            color: accent || "var(--text)",
          }}
        >
          {value}
        </div>
        {spark && spark.length > 0 && (
          <Sparkline
            values={spark}
            width={76}
            height={28}
            color={sparkColor || accent || "var(--signal)"}
            animate
          />
        )}
      </div>
      {sub && (
        <div
          style={{
            marginTop: 7,
            fontSize: 11,
            color: tone === "down" ? "var(--red)" : tone === "up" ? "var(--text-2)" : "var(--text-3)",
          }}
        >
          {sub}
        </div>
      )}
      {footer}
    </div>
  );
}

// ─── Active runs table ───────────────────────────────────────────────────────

function RunTable({
  rows,
  tenant,
  onCancel,
  cancelPendingIds,
  status,
}: {
  rows: RunListRow[];
  tenant: string;
  onCancel?: (id: string) => void;
  cancelPendingIds?: string;
  status: DashboardSourceStatus;
}) {
  const { t } = useI18n();
  if (status === "loading")
    return <Empty title={t("dashboard.loadingRuns")} hint="" />;
  if (status === "error")
    return <Empty title={t("dashboard.runsUnavailable")} hint="—" />;
  if (rows.length === 0)
    return <Empty title={t("dashboard.noActiveRuns")} hint={t("dashboard.systemIdle")} />;
  return (
    <div style={{ maxHeight: 280, overflow: "auto" }}>
      <table
        style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5, tableLayout: "fixed" }}
      >
        <colgroup>
          <col style={{ width: 28 }} />
          <col style={{ width: 110 }} />
          <col />
          <col style={{ width: 88 }} />
          <col style={{ width: 150 }} />
          <col style={{ width: 60 }} />
          {onCancel && <col style={{ width: 78 }} />}
        </colgroup>
        <thead>
          <tr
            style={{
              position: "sticky",
              top: 0,
              background: "var(--panel)",
              borderBottom: "1px solid var(--border)",
            }}
          >
            <Th />
            <Th>{t("dashboard.colRun")}</Th>
            <Th>{t("dashboard.colAgent")}</Th>
            <Th>{t("dashboard.colSubject")}</Th>
            <Th>{t("dashboard.colStep")}</Th>
            <Th style={{ textAlign: "right" }}>{t("dashboard.colDur")}</Th>
            {onCancel && <Th style={{ textAlign: "right" }}>{t("dashboard.colAction")}</Th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <RunTableRow
              key={r.id}
              row={r}
              tenant={tenant}
              onCancel={onCancel}
              cancelling={cancelPendingIds === r.id}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RunTableRow({
  row,
  tenant,
  onCancel,
  cancelling,
}: {
  row: RunListRow;
  tenant: string;
  onCancel?: (id: string) => void;
  cancelling?: boolean;
}) {
  const { t } = useI18n();
  return (
    <tr style={{ borderBottom: "1px solid var(--border)" }}>
      <Td>
        <StatusDot status={STATUS_TO_DOT[row.status] ?? "idle"} />
      </Td>
      <Td>
        <Link href={`/portal/${tenant}/runs/${row.id}` as never} style={{ textDecoration: "none" }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
            <span className="mono" style={{ color: "var(--text-2)", whiteSpace: "nowrap" }}>
              {row.id}
            </span>
            {row.testRun && (
              <Badge tone="signal" style={{ fontSize: 9 }}>
                TEST
              </Badge>
            )}
          </span>
        </Link>
      </Td>
      <Td style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        <span style={{ color: "var(--text)" }}>{row.agentTitle ?? row.agentName}</span>
      </Td>
      <Td>
        <span className="mono" style={{ color: "var(--text-2)", whiteSpace: "nowrap" }}>
          {row.subject ?? "—"}
        </span>
      </Td>
      <Td style={{ overflow: "hidden" }}>
        {row.currentStepName && row.stepCount ? (
          <span
            style={{ fontSize: 11.5, display: "flex", gap: 4, alignItems: "baseline", overflow: "hidden" }}
          >
            <span
              className="mono"
              style={{
                color: "var(--accent-text)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                minWidth: 0,
              }}
            >
              {row.currentStepName}
            </span>
            <span style={{ color: "var(--text-3)", whiteSpace: "nowrap", flexShrink: 0 }}>
              {(row.currentStepOrd ?? "?") + "/" + row.stepCount}
            </span>
          </span>
        ) : (
          <span style={{ color: "var(--text-3)" }}>—</span>
        )}
      </Td>
      <Td style={{ textAlign: "right" }}>
        <span className="mono" style={{ color: "var(--accent-text)", whiteSpace: "nowrap" }}>
          {fmtDur(row.durationMs)}
        </span>
      </Td>
      {onCancel && (
        <Td style={{ textAlign: "right" }}>
          <Button small icon="x" tone="danger" onClick={() => onCancel(row.id)} disabled={cancelling}>
            {cancelling ? "…" : t("dashboard.cancel")}
          </Button>
        </Td>
      )}
    </tr>
  );
}

// ─── Agent activity ──────────────────────────────────────────────────────────

interface AgentActivity {
  agent: AgentListRow;
  runs: number;
  errors: number;
  lastRun: number;
}

function AgentActivityGrid({
  items,
  tenant,
  status,
}: {
  items: AgentActivity[];
  tenant: string;
  status: DashboardSourceStatus;
}) {
  const { t } = useI18n();
  if (status === "loading")
    return <Empty title={t("dashboard.loadingAgents")} hint="" />;
  if (status === "error")
    return <Empty title={t("dashboard.agentActivityUnavailable")} hint="—" />;
  if (items.length === 0) return <Empty title={t("dashboard.noAgentActivity")} hint="—" />;
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(4, 1fr)",
        gap: 1,
        background: "var(--border)",
      }}
    >
      {items.map(({ agent, runs, errors, lastRun }) => {
        const intensity = Math.min(1, runs / 20);
        return (
          <Link
            key={agent.id}
            href={`/portal/${tenant}/agents/${agent.kebabId}` as never}
            style={{
              padding: "10px 12px",
              background: "var(--panel)",
              textAlign: "left",
              position: "relative",
              display: "block",
              minHeight: 78,
              textDecoration: "none",
            }}
          >
            <div
              style={{
                position: "absolute",
                left: 0,
                top: 0,
                bottom: 0,
                width: 2,
                background:
                  errors > 0
                    ? "var(--red)"
                    : `color-mix(in srgb, var(--signal) ${(0.15 + intensity * 0.6) * 100}%, transparent)`,
              }}
            />
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
              <ActorTag actor={agent.actor} />
              <span
                style={{
                  marginLeft: "auto",
                  fontSize: 11,
                  fontFamily: "var(--mono)",
                  color: errors > 0 ? "var(--red)" : "var(--text)",
                }}
              >
                {runs}
              </span>
            </div>
            <div
              style={{
                fontSize: 12.5,
                color: "var(--text)",
                fontWeight: 500,
                marginBottom: 2,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {agent.title ?? agent.name}
            </div>
            <div style={{ fontSize: 10.5, fontFamily: "var(--mono)", color: "var(--text-3)" }}>
              {lastRun > 0 ? fmtAgo(lastRun) : t("dashboard.idle")}
              {errors > 0 && (
                <span style={{ color: "var(--red)", marginLeft: 8 }}>
                  {t("dashboard.errCount", { count: errors })}
                </span>
              )}
            </div>
          </Link>
        );
      })}
    </div>
  );
}

// ─── Event ticker ────────────────────────────────────────────────────────────

function EventTicker({
  events,
  live,
  latestEventId,
  status,
}: {
  events: EventItem[];
  live: boolean;
  latestEventId: string | null;
  status: DashboardSourceStatus;
}) {
  const { t } = useI18n();
  if (status === "loading")
    return <Empty title={t("dashboard.loadingEvents")} hint="" />;
  if (status === "error")
    return <Empty title={t("dashboard.eventsUnavailable")} hint="—" />;
  if (events.length === 0)
    return <Empty title={t("dashboard.noEvents")} hint="—" />;
  return (
    <div style={{ maxHeight: 380, overflow: "auto" }}>
      {events.map((e) => (
        <div
          key={e.id}
          style={{
            display: "grid",
            gridTemplateColumns: "14px 1fr auto",
            gap: 10,
            alignItems: "start",
            padding: "9px 14px",
            borderBottom: "1px solid var(--border)",
            fontSize: 12,
            animation: live && e.id === latestEventId ? "tick 0.45s ease-out" : "none",
          }}
        >
          <span
            style={{
              width: 8,
              height: 8,
              marginTop: 4,
              borderRadius: 99,
              background: `var(--${e.color === "muted" ? "text-3" : e.color})`,
              boxShadow: `0 0 7px var(--${e.color === "muted" ? "text-3" : e.color})`,
            }}
          />
          <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, minWidth: 0 }}>
              <span style={{ color: "var(--text)", fontSize: 12 }}>{e.name}</span>
              <span
                style={{
                  color: "var(--text-3)",
                  fontSize: 10.5,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {e.sourceTitle ?? t("dashboard.sourceExternal")}
              </span>
            </div>
            <EventConsumerStrip consumers={e.consumers} />
          </div>
          <span
            className="mono"
            style={{ color: "var(--text-4)", fontSize: 9.5, marginTop: 2, textAlign: "right" }}
          >
            <span style={{ color: "var(--text-3)" }}>
              {e.at == null ? "—" : fmtTime(e.at)}
            </span>
            {e.subject ? <div>{e.subject}</div> : null}
          </span>
        </div>
      ))}
    </div>
  );
}

function EventConsumerStrip({ consumers }: { consumers: EventItem["consumers"] }) {
  const { t } = useI18n();
  if (!consumers || consumers.length === 0) {
    return (
      <span style={{ fontSize: 10, color: "var(--text-4)" }}>{t("dashboard.noSubscribers")}</span>
    );
  }
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 5,
        fontSize: 10,
        color: "var(--text-3)",
      }}
    >
      {consumers.map((c) => (
        <span
          key={c.runId}
          title={`${c.agentName ?? "(unknown agent)"} · run ${c.runId} · ${c.status}`}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            padding: "1px 6px",
            borderRadius: 5,
            border: "1px solid var(--border)",
            background: "var(--panel-2)",
          }}
        >
          <StatusDot status={STATUS_TO_DOT[c.status] ?? "idle"} size={6} />
          <span style={{ color: "var(--text-2)" }}>
            {c.agentTitle || c.agentName || t("dashboard.agentFallback")}
          </span>
        </span>
      ))}
    </div>
  );
}

// ─── Pending tasks ───────────────────────────────────────────────────────────

function PendingTasksList({
  tasks,
  tenant,
  status,
}: {
  tasks: TaskItem[];
  tenant: string;
  status: DashboardSourceStatus;
}) {
  const { t } = useI18n();
  if (status === "loading")
    return <Empty title={t("dashboard.loadingTasks")} hint="" />;
  if (status === "error")
    return <Empty title={t("dashboard.tasksUnavailable")} hint="—" />;
  if (tasks.length === 0)
    return <Empty title={t("dashboard.allClear")} hint={t("dashboard.noPendingTasks")} />;
  return (
    <div>
      {tasks.map((task) => (
        <Link
          key={task.id}
          href={`/portal/${tenant}/tasks?selected=${encodeURIComponent(task.id)}` as never}
          style={{
            display: "block",
            width: "100%",
            textAlign: "left",
            padding: "10px 14px",
            borderBottom: "1px solid var(--border)",
            textDecoration: "none",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
            <Badge
              tone={task.priority === "high" ? "amber" : task.priority === "med" ? "blue" : "muted"}
              style={{ fontSize: 9.5 }}
            >
              {task.priority.toUpperCase()}
            </Badge>
            <span style={{ fontSize: 11, color: "var(--text-3)", fontFamily: "var(--mono)" }}>
              {task.id}
            </span>
            <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--text-3)" }}>
              {task.createdAt ? fmtAgo(task.createdAt) : "—"}
            </span>
          </div>
          <div style={{ fontSize: 12.5, color: "var(--text)", marginBottom: 2 }}>{task.title}</div>
          {task.awaitingFrom ? (
            <div style={{ fontSize: 11, color: "var(--text-3)" }}>
              {t("dashboard.awaiting", { role: task.awaitingFrom })}
            </div>
          ) : null}
        </Link>
      ))}
    </div>
  );
}

// ─── Cost by model ───────────────────────────────────────────────────────────

function CostByModel({
  rows,
  status,
}: {
  rows: Array<{
    key: string;
    usdCents: number;
    unpricedTokens: number;
    costComplete: boolean;
  }>;
  status: DashboardSourceStatus;
}) {
  const { t } = useI18n();
  if (status === "loading")
    return <Empty title={t("dashboard.loadingUsage")} hint="" />;
  if (status === "error")
    return <Empty title={t("dashboard.costUnavailable")} hint="—" />;
  const sorted = [...rows].sort((a, b) => b.usdCents - a.usdCents).slice(0, 6);
  if (sorted.length === 0) return <Empty title={t("dashboard.noCost")} hint="—" />;
  const max = Math.max(...sorted.map((r) => r.usdCents), 1);
  return (
    <div style={{ padding: "8px 0" }}>
      {sorted.map((r) => (
        <div
          key={r.key}
          style={{ display: "flex", alignItems: "center", gap: 12, padding: "9px 16px", fontSize: 11.5 }}
        >
          <span
            className="mono"
            style={{
              width: 150,
              color: "var(--text-2)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {r.key || "—"}
          </span>
          <div style={{ flex: 1 }}>
            <GrowBar pct={(r.usdCents / max) * 100} />
          </div>
          <span
            className="mono"
            title={
              r.costComplete
                ? undefined
                : t("dashboard.modelCostIncompleteTitle", {
                    unpriced: fmtNum(r.unpricedTokens),
                  })
            }
            style={{
              width: 60,
              textAlign: "right",
              color: r.costComplete ? "var(--text)" : "var(--amber)",
            }}
          >
            {r.costComplete ? "" : "≥"}
            {usd(r.usdCents)}
          </span>
        </div>
      ))}
    </div>
  );
}

// ─── Per-agent throughput ────────────────────────────────────────────────────

function ThroughputByAgent({
  agents,
  tenant,
  status,
}: {
  agents: ThroughputAgent[];
  tenant: string;
  status: DashboardSourceStatus;
}) {
  const { t } = useI18n();
  if (status === "loading")
    return <Empty title={t("dashboard.loadingThroughput")} hint="" />;
  if (status === "error")
    return <Empty title={t("dashboard.throughputUnavailable")} hint="—" />;
  const top = agents.slice(0, 8);
  if (top.length === 0)
    return <Empty title={t("dashboard.noThroughput")} hint={t("dashboard.workflowNotLoaded")} />;
  const max = Math.max(...top.map((a) => a.subjects), 1);
  return (
    <div style={{ padding: "8px 0" }}>
      {top.map((a) => (
        <Link
          key={a.kebabId}
          href={`/portal/${tenant}/agents/${a.kebabId}` as never}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "9px 16px",
            fontSize: 11.5,
            textDecoration: "none",
          }}
        >
          <span
            style={{
              width: 150,
              color: "var(--text-2)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {a.title}
          </span>
          <div style={{ flex: 1 }}>
            <GrowBar pct={(a.subjects / max) * 100} />
          </div>
          <span
            className="mono"
            style={{ width: 78, textAlign: "right", color: "var(--text)", whiteSpace: "nowrap" }}
          >
            {fmtNum(a.subjects)}
            <span style={{ color: "var(--text-4)", fontSize: 10 }}>
              {" "}
              · {fmtNum(a.runs)}
            </span>
          </span>
        </Link>
      ))}
    </div>
  );
}
