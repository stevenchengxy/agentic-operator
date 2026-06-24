"use client";

/**
 * Dashboard — control-plane overview, "management overview" redesign
 * (Layout A: health-first vertical narrative).
 *
 * Read order top → bottom by importance:
 *   1. System-health hero    — one-line verdict (green/amber/red) from
 *                              /health + 24h error rate + high-priority tasks,
 *                              with inngest / sqlite / disk status chips.
 *   2. 4 KPI cards           — active runs · throughput · error rate · spend,
 *                              all real data (no estimated cost, no fake buckets).
 *   3. Actionable middle     — left: active runs (cancellable) + pending HITL
 *                              tasks; right: live event stream (pausable).
 *   4. Cost + funnel         — spend-by-model (/v1/usage) + pipeline conversion
 *                              funnel (/v1/funnel, distinct subjects per stage).
 *   5. Agent activity        — collapsed by default; secondary detail.
 *
 * Live data via canonical TanStack hooks. /v1/stream SSE is mounted once at
 * the shell root (useStream) and auto-invalidates every query below; the
 * "pause" control here freezes the event-stream panel's rendered window
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
  eventTone,
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
  useFunnel,
  type AgentListRow,
} from "@/lib/hooks/useAgents";
import { useEvents, type EventRow } from "@/lib/hooks/useEvents";
import { useTasks, type TaskRow } from "@/lib/hooks/useTasks";
import { useRuns, useCancelRun, type RunListRow } from "@/lib/hooks/useRuns";
import { useHealth, fmtBytes } from "@/lib/hooks/useHealth";
import { useUsage, useBudget } from "@/lib/hooks/useUsage";

/**
 * Stage-label catalog — maps the numeric pipeline stage (kebab-id prefix the
 * DAG/funnel derive) to a stable i18n key suffix. The English/中文 strings
 * live in the dictionary at `dashboard.stage.*`; this map only routes the
 * number to a key. Stages without an entry fall back to "Stage N".
 */
const STAGE_LABELS: Record<number, string> = {
  0: "intake",
  1: "analyze",
  2: "jd",
  3: "publish",
  4: "resume",
  5: "matchInterview",
  6: "package",
  7: "submit",
};

/** Narrowed view of an event row for the ticker. */
interface EventItem {
  id: string;
  name: string;
  color: string;
  at: number;
  sourceTitle: string;
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
  return {
    id: e.id,
    name: e.name,
    color: e.color ?? "muted",
    at: e.receivedAt ? Date.parse(e.receivedAt) : 0,
    sourceTitle: e.sourceAgentTitle ?? e.sourceAgentName ?? "External",
    subject: e.subject ?? "",
    consumers: e.consumers ?? [],
  };
}

function fromTaskRow(t: TaskRow): TaskItem {
  return {
    id: t.id,
    title: t.title,
    priority: t.priority ?? "med",
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
  cancelled: "paused",
  paused: "paused",
  idle: "idle",
};

/** Format integer USD cents as a dollar string. */
function usd(cents: number | null | undefined): string {
  return `$${((cents ?? 0) / 100).toFixed(2)}`;
}

// ─── Page (data wiring) ──────────────────────────────────────────────────────

export default function DashboardPage() {
  const countsQuery = useCounts();
  const agentsQuery = useAgents();
  const tasksQuery = useTasks();
  const eventsQuery = useEvents({ limit: 200 });
  const runsQuery = useRuns({ limit: 200 });
  const funnelQuery = useFunnel("24h");
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
    () => (tasksQuery.data ?? []).map(fromTaskRow),
    [tasksQuery.data],
  );
  const liveRuns = runsQuery.data ?? [];

  // First-load gate — keep panels from flashing zero-states before the
  // primary queries resolve.
  const isPrimaryLoading =
    countsQuery.isLoading || runsQuery.isLoading || eventsQuery.isLoading;
  const primaryError =
    countsQuery.error ?? runsQuery.error ?? eventsQuery.error ?? null;

  return (
    <DashboardView
      counts={counts}
      agents={agents}
      tasks={taskItems}
      eventStream={events}
      liveRuns={liveRuns}
      funnel={funnelQuery.data?.stages ?? []}
      usage={usageQuery.data ?? null}
      usageError={Boolean(usageQuery.error)}
      budget={budgetQuery.data ?? null}
      health={healthQuery.data ?? null}
      healthError={Boolean(healthQuery.isError)}
      loading={isPrimaryLoading}
      error={primaryError}
    />
  );
}

type Verdict = "ok" | "warn" | "down";

interface DashboardViewProps {
  counts: { runningRuns: number; okRuns24h: number; failedRuns24h: number; events24h: number; openTasks: number; totalRuns: number } | null;
  agents: AgentListRow[];
  tasks: TaskItem[];
  eventStream: EventItem[];
  liveRuns: RunListRow[];
  funnel: Array<{ stage: number; count: number }>;
  usage: { totals: { usdCents: number }; byModel: Array<{ key: string; usdCents: number }>; byDay: Array<{ usdCents: number }> } | null;
  usageError: boolean;
  budget: { monthlyUsdCap: number | null; usedUsdMonth: number; periodStart: number } | null;
  health: ReturnType<typeof useHealth>["data"] | null;
  healthError: boolean;
  loading: boolean;
  error: Error | null;
}

function DashboardView({
  counts,
  agents,
  tasks,
  eventStream,
  liveRuns,
  funnel,
  usage,
  usageError,
  budget,
  health,
  healthError,
  loading,
  error,
}: DashboardViewProps) {
  const tenant = useTenant();
  const { t } = useI18n();

  // Hydration gate — the dashboard is time-dependent (Date.now() bucketing,
  // fmtAgo/fmtTime). Render a deterministic skeleton until mounted so SSR and
  // first-client HTML match.
  const [hasMounted, setHasMounted] = useState(false);
  useEffect(() => setHasMounted(true), []);

  // Event-stream pause. The global SSE subscription keeps running; pausing
  // only freezes the rendered window so an operator can read it.
  const [streamLive, setStreamLive] = useState(true);

  // ── Derived metrics (all from authoritative sources) ──────────────────────
  const active = liveRuns.filter((r) => r.status === "running");
  const runningCount = counts?.runningRuns ?? active.length;
  const ok24 = counts?.okRuns24h ?? 0;
  const failed24 = counts?.failedRuns24h ?? 0;
  const completed24 = ok24 + failed24;
  const errorRatePct = completed24 > 0 ? (failed24 / completed24) * 100 : 0;
  const highTasks = tasks.filter((t) => t.priority === "high").length;

  // Throughput — real per-minute buckets over the last 60 minutes.
  const buckets = useMemo(() => {
    const now = Date.now();
    const bs = new Array(60).fill(0);
    eventStream.forEach((e) => {
      const ago = Math.floor((now - e.at) / 60_000);
      if (ago >= 0 && ago < 60) bs[59 - ago]++;
    });
    return bs;
  }, [eventStream]);
  const eventsPerHr = useMemo(() => buckets.reduce((a, b) => a + b, 0), [buckets]);

  // Spend — authoritative monthly figure from the budget row; spark from the
  // per-day usage breakdown when available.
  const spendCents = budget?.usedUsdMonth ?? usage?.totals.usdCents ?? 0;
  const capCents = budget?.monthlyUsdCap ?? null;
  const budgetPct = capCents && capCents > 0 ? (spendCents / capCents) * 100 : null;
  const spendSpark = useMemo(
    () => (usage?.byDay ?? []).map((d) => d.usdCents),
    [usage],
  );

  // ── Health verdict ────────────────────────────────────────────────────────
  const healthFail =
    !!health &&
    (!health.inngest.ok || !health.sqlite.ok || !health.disk.ok);
  const verdict: Verdict = healthFail || healthError
    ? "down"
    : errorRatePct >= 5 || highTasks > 0
      ? "warn"
      : "ok";

  // ── Event window (newest-first, deduped, frozen when paused) ───────────────
  const recentEvents = useMemo(() => {
    if (eventStream.length === 0) return [];
    const sorted = [...eventStream].sort((a, b) => b.at - a.at);
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

  // Snapshot the window when paused so it stops updating visually.
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
    liveRuns.forEach((r) => {
      const e = m.get(r.agentName);
      if (!e) return;
      e.runs++;
      if (r.status === "failed") e.errors++;
      const ts = r.startedAt ? Date.parse(r.startedAt) : 0;
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
  const handleCancelAll = useCallback(() => {
    if (active.length === 0) return;
    const ids = active.map((r) => r.id);
    toast({
      tone: "amber",
      title:
        ids.length === 1
          ? t("dashboard.toastCancellingOne", { count: ids.length })
          : t("dashboard.toastCancellingMany", { count: ids.length }),
      description: ids.slice(0, 4).join(", ") + (ids.length > 4 ? "…" : ""),
    });
    for (const id of ids) cancelRun.mutate(id);
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
          <Badge tone={streamLive ? "signal" : "muted"}>
            {streamLive && (
              <span className="live-dot" style={{ width: 5, height: 5 }} />
            )}{" "}
            {streamLive ? t("topbar.live") : t("dashboard.paused")}
          </Badge>
        }
      />

      {error && (
        <div style={{ padding: 20 }}>
          <Empty
            title={t("dashboard.loadFailed")}
            hint={error.message || t("dashboard.apiUnreachablePort")}
          />
        </div>
      )}
      {!error && loading && !counts && liveRuns.length === 0 && (
        <div style={{ padding: 20 }}>
          <Empty title={t("dashboard.loading")} hint="" />
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
          health={health}
          healthError={healthError}
        />

        {/* ② KPI row */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(4, 1fr)",
            gap: 12,
            margin: "12px 0",
          }}
        >
          <KPICard
            label={t("dashboard.kpiActiveRuns")}
            value={runningCount}
            sub={t("dashboard.kpiActiveSub", { ok: ok24, total: completed24 })}
            accent="var(--signal)"
            spark={buckets.slice(40)}
          />
          <KPICard
            label={t("dashboard.kpiThroughput")}
            value={fmtNum(eventsPerHr)}
            sub={t("dashboard.kpiThroughputSub")}
            spark={buckets}
          />
          <KPICard
            label={t("dashboard.kpiErrorRate")}
            value={`${errorRatePct.toFixed(1)}%`}
            sub={t("dashboard.kpiErrorRateSub", {
              failed: failed24,
              total: completed24,
            })}
            tone={errorRatePct >= 5 ? "down" : "up"}
            accent={errorRatePct >= 5 ? "var(--red)" : "var(--green)"}
          />
          <KPICard
            label={t("dashboard.kpiSpend")}
            value={usd(spendCents)}
            sub={
              budgetPct != null
                ? t("dashboard.kpiBudgetSub", {
                    cap: usd(capCents),
                    pct: budgetPct.toFixed(0),
                  })
                : t("dashboard.kpiNoBudget")
            }
            accent="var(--amber)"
            spark={spendSpark.length > 1 ? spendSpark : undefined}
            sparkColor="var(--amber)"
            footer={
              budgetPct != null ? (
                <div
                  style={{
                    height: 4,
                    background: "var(--panel-3)",
                    borderRadius: 99,
                    marginTop: 8,
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      height: "100%",
                      width: `${Math.min(100, budgetPct)}%`,
                      background:
                        budgetPct >= 90 ? "var(--red)" : "var(--signal)",
                    }}
                  />
                </div>
              ) : undefined
            }
          />
        </div>

        {/* ③ Actionable middle */}
        <div style={{ display: "grid", gridTemplateColumns: "1.45fr 1fr", gap: 12 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <Panel
              title={t("dashboard.panelActiveRuns")}
              subtitle={t("dashboard.runningCount", { count: active.length })}
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
              />
            </Panel>

            <Panel
              title={t("dashboard.panelAwaitingHumans")}
              subtitle={t("dashboard.tasksCount", { count: tasks.length })}
              action={
                <Link href={`/portal/${tenant}/tasks` as never} style={{ textDecoration: "none" }}>
                  <Button small icon="external" tone="ghost">
                    {t("dashboard.inbox")}
                  </Button>
                </Link>
              }
              padded={false}
            >
              <PendingTasksList tasks={tasks.slice(0, 5)} tenant={tenant} />
            </Panel>
          </div>

          <Panel
            title={t("dashboard.panelEventStream")}
            subtitle={streamLive ? t("dashboard.autoUpdating") : t("dashboard.paused")}
            action={
              <div style={{ display: "flex", gap: 6 }}>
                <Button
                  small
                  icon={streamLive ? "pause" : "play"}
                  tone="ghost"
                  onClick={() => setStreamLive((v) => !v)}
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
            style={{ minHeight: 320 }}
          >
            <EventTicker events={shownEvents} live={streamLive} latestEventId={latestEventId} />
          </Panel>
        </div>

        {/* ④ Cost + funnel */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 12 }}>
          <Panel
            title={t("dashboard.panelCost")}
            subtitle={t("dashboard.costTotalLabel", {
              total: usd(usage?.totals.usdCents),
            })}
            action={
              <Link href={`/portal/${tenant}/settings/usage` as never} style={{ textDecoration: "none" }}>
                <Button small icon="external" tone="ghost">
                  {t("dashboard.usage")}
                </Button>
              </Link>
            }
            padded={false}
          >
            <CostByModel rows={usage?.byModel ?? []} unavailable={usageError} />
          </Panel>

          <Panel
            title={t("dashboard.panelFunnel")}
            subtitle={t("dashboard.funnelBySubject", { window: "24h" })}
            padded
          >
            <StageFunnel stages={funnel} />
          </Panel>
        </div>

        {/* ⑤ Agent activity — collapsed by default */}
        <div style={{ marginTop: 12 }}>
          <button
            type="button"
            onClick={() => setShowAgents((v) => !v)}
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
              : t("dashboard.agentActivityShow", { count: agents.length })}
          </button>
          {showAgents && (
            <div style={{ marginTop: 12 }}>
              <Panel title={t("dashboard.panelAgentActivity")} padded={false}>
                <AgentActivityGrid items={agentActivity} tenant={tenant} />
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
  health,
  healthError,
}: {
  verdict: Verdict;
  running: number;
  errorRatePct: number;
  highTasks: number;
  streamLive: boolean;
  health: ReturnType<typeof useHealth>["data"] | null;
  healthError: boolean;
}) {
  const { t } = useI18n();
  const tone =
    verdict === "down" ? "var(--red)" : verdict === "warn" ? "var(--amber)" : "var(--green)";
  const verdictLabel =
    verdict === "down"
      ? t("dashboard.verdictDown")
      : verdict === "warn"
        ? t("dashboard.verdictWarn")
        : t("dashboard.verdictOk");

  const parts = [
    t("dashboard.heroRunning", { count: running }),
    t("dashboard.heroErrorRate", { pct: errorRatePct.toFixed(1) }),
    t("dashboard.heroHighTasks", { count: highTasks }),
    streamLive ? t("dashboard.heroStreamLive") : t("dashboard.heroStreamPaused"),
  ];

  const chips: Array<{ label: string; ok: boolean; note: string }> = [];
  if (health) {
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
  } else if (healthError) {
    for (const label of [t("dashboard.healthInngest"), t("dashboard.healthSqlite"), t("dashboard.healthLogVolume")]) {
      chips.push({ label, ok: false, note: t("dashboard.healthApiUnreachable") });
    }
  }

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 16,
        padding: "16px 18px",
        background: "var(--panel)",
        border: "1px solid var(--border)",
        borderLeft: `3px solid ${tone}`,
        borderRadius: 10,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
        <span
          style={{
            width: 13,
            height: 13,
            borderRadius: 99,
            background: tone,
            boxShadow: `0 0 12px ${tone}`,
            flex: "none",
          }}
        />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 19, fontWeight: 600, color: "var(--text)" }}>{verdictLabel}</div>
          <div
            style={{
              fontSize: 12.5,
              color: "var(--text-2)",
              marginTop: 2,
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
                padding: "7px 11px",
                background: "var(--panel-2)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                minWidth: 92,
              }}
            >
              <span
                style={{
                  fontSize: 9,
                  textTransform: "uppercase",
                  letterSpacing: "0.08em",
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
                  gap: 5,
                }}
              >
                <StatusDot status={c.ok ? "ok" : "failed"} size={7} />
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
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  tone?: "up" | "down";
  accent?: string;
  spark?: number[];
  sparkColor?: string;
  footer?: React.ReactNode;
}) {
  return (
    <div
      style={{
        background: "var(--panel)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        padding: "14px 16px",
      }}
    >
      <div
        style={{
          fontSize: 10.5,
          fontFamily: "var(--mono)",
          textTransform: "uppercase",
          letterSpacing: "0.1em",
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
          marginTop: 6,
        }}
      >
        <div
          style={{
            fontSize: 26,
            fontFamily: "var(--mono)",
            fontWeight: 500,
            letterSpacing: "-0.01em",
            color: accent || "var(--text)",
          }}
        >
          {value}
        </div>
        {spark && spark.length > 0 && (
          <Sparkline values={spark} width={70} height={26} color={sparkColor || accent || "var(--signal)"} />
        )}
      </div>
      {sub && (
        <div
          style={{
            marginTop: 4,
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
}: {
  rows: RunListRow[];
  tenant: string;
  onCancel?: (id: string) => void;
  cancelPendingIds?: string;
}) {
  const { t } = useI18n();
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

function AgentActivityGrid({ items, tenant }: { items: AgentActivity[]; tenant: string }) {
  const { t } = useI18n();
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
              {agent.title}
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
}: {
  events: EventItem[];
  live: boolean;
  latestEventId: string | null;
}) {
  return (
    <div style={{ maxHeight: 380, overflow: "auto" }}>
      {events.map((e) => (
        <div
          key={e.id}
          style={{
            display: "grid",
            gridTemplateColumns: "62px 1fr auto",
            gap: 10,
            alignItems: "start",
            padding: "8px 14px",
            borderBottom: "1px solid var(--border)",
            fontSize: 12,
            animation: live && e.id === latestEventId ? "tick 0.4s ease-out" : "none",
          }}
        >
          <span className="mono" style={{ color: "var(--text-3)", fontSize: 10.5, marginTop: 2 }}>
            {fmtTime(e.at)}
          </span>
          <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
              <Badge tone={eventTone(e.color)} style={{ fontSize: 9.5 }}>
                {e.name}
              </Badge>
              <span style={{ color: "var(--text-3)", fontSize: 11 }}>·</span>
              <span
                style={{
                  color: "var(--text-2)",
                  fontSize: 11,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {e.sourceTitle}
              </span>
            </div>
            <EventConsumerStrip consumers={e.consumers} />
          </div>
          <span className="mono" style={{ color: "var(--text-3)", fontSize: 10.5, marginTop: 2 }}>
            {e.subject}
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
      <span style={{ fontSize: 10.5, color: "var(--text-4)" }}>{t("dashboard.noSubscribers")}</span>
    );
  }
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 6,
        fontSize: 10.5,
        color: "var(--text-3)",
      }}
    >
      <span>{t("dashboard.consumedBy")}</span>
      {consumers.map((c) => (
        <span
          key={c.runId}
          title={`${c.agentName ?? "(unknown agent)"} · run ${c.runId} · ${c.status}`}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            padding: "1px 6px",
            borderRadius: 3,
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

function PendingTasksList({ tasks, tenant }: { tasks: TaskItem[]; tenant: string }) {
  const { t } = useI18n();
  if (tasks.length === 0)
    return <Empty title={t("dashboard.allClear")} hint={t("dashboard.noPendingTasks")} />;
  return (
    <div>
      {tasks.map((task) => (
        <Link
          key={task.id}
          href={`/portal/${tenant}/tasks?id=${encodeURIComponent(task.id)}` as never}
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
  unavailable,
}: {
  rows: Array<{ key: string; usdCents: number }>;
  unavailable: boolean;
}) {
  const { t } = useI18n();
  if (unavailable) return <Empty title={t("dashboard.costUnavailable")} hint="—" />;
  const sorted = [...rows].sort((a, b) => b.usdCents - a.usdCents).slice(0, 6);
  if (sorted.length === 0) return <Empty title={t("dashboard.noCost")} hint="—" />;
  const max = Math.max(...sorted.map((r) => r.usdCents), 1);
  return (
    <div style={{ padding: "8px 0" }}>
      {sorted.map((r) => (
        <div
          key={r.key}
          style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 14px", fontSize: 11.5 }}
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
          <span
            style={{
              flex: 1,
              height: 7,
              background: "var(--panel-3)",
              borderRadius: 99,
              overflow: "hidden",
            }}
          >
            <span
              style={{
                display: "block",
                height: "100%",
                width: `${(r.usdCents / max) * 100}%`,
                background: "var(--signal)",
              }}
            />
          </span>
          <span className="mono" style={{ width: 62, textAlign: "right", color: "var(--text)" }}>
            {usd(r.usdCents)}
          </span>
        </div>
      ))}
    </div>
  );
}

// ─── Stage funnel ────────────────────────────────────────────────────────────

function StageFunnel({ stages }: { stages: Array<{ stage: number; count: number }> }) {
  const { t } = useI18n();
  if (stages.length === 0) {
    return <Empty title={t("dashboard.noStages")} hint={t("dashboard.workflowNotLoaded")} />;
  }
  const max = Math.max(...stages.map((s) => s.count), 1);
  return (
    <div style={{ display: "grid", gridTemplateColumns: `repeat(${stages.length}, 1fr)`, gap: 8 }}>
      {stages.map((s, i) => {
        const pct = s.count / max;
        const prior = stages[i - 1]?.count;
        const drop =
          i > 0 && prior != null && prior > 0
            ? (((prior - s.count) / prior) * 100).toFixed(0)
            : null;
        const labelKey = STAGE_LABELS[s.stage];
        return (
          <div key={s.stage} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <span
                style={{
                  fontSize: 10,
                  fontFamily: "var(--mono)",
                  textTransform: "uppercase",
                  color: "var(--text-3)",
                  letterSpacing: "0.06em",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {labelKey ? t(`dashboard.stage.${labelKey}`) : t("dashboard.stageFallback", { id: s.stage })}
              </span>
              {drop && Number(drop) > 0 && (
                <span style={{ fontSize: 9.5, fontFamily: "var(--mono)", color: "var(--text-3)" }}>
                  −{drop}%
                </span>
              )}
            </div>
            <div
              style={{
                height: 6,
                background: "var(--panel-2)",
                borderRadius: 1,
                position: "relative",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  position: "absolute",
                  left: 0,
                  top: 0,
                  bottom: 0,
                  width: `${pct * 100}%`,
                  background:
                    "linear-gradient(90deg, var(--signal) 0%, var(--signal) 70%, color-mix(in srgb, var(--signal) 50%, transparent) 100%)",
                  opacity: 0.3 + pct * 0.7,
                }}
              />
            </div>
            <div style={{ fontSize: 16, fontFamily: "var(--mono)", color: "var(--text)" }}>
              {fmtNum(s.count)}
            </div>
          </div>
        );
      })}
    </div>
  );
}
