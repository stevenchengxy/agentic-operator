"use client";

/**
 * Dashboard — control plane overview (P2-FE-07).
 *
 * Live data via canonical TanStack hooks:
 *   - useAgents() — workflow agents
 *   - useRuns({ limit: 200 }) — recent runs (active filter + 24h aggregates)
 *   - useEvents({ limit: 200 }) — event ticker + sparkline
 *   - useTasks() — pending human tasks panel
 *   - useDag() — workflow stages for the funnel + agent stage indices
 *   - useHealth() — runtime status footer
 *
 * No bootstrap snapshot — every panel reflects the live tenant.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
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
import {
  useAgents,
  useDag,
  type AgentListRow,
  type DagAgent,
} from "@/lib/hooks/useAgents";
import { useEvents, type EventRow } from "@/lib/hooks/useEvents";
import { useTasks, type TaskRow } from "@/lib/hooks/useTasks";
import { useRuns, useCancelRun, type RunListRow } from "@/lib/hooks/useRuns";
import { useHealth, fmtBytes } from "@/lib/hooks/useHealth";
import { useStartOperatorCheck } from "@/lib/hooks/useOperatorChecks";

/**
 * Stage label catalog — static workflow ontology. The /v1/workflows/dag
 * payload returns numeric `stage` indices for each agent; this map keeps
 * the funnel readable. Tenants without staged pipelines get an empty
 * stages array and the funnel panel hides itself.
 */
const STAGE_LABELS: Record<number, string> = {
  0: "Intake",
  1: "Analyze",
  2: "JD",
  3: "Publish",
  4: "Resume",
  5: "Match & Interview",
  6: "Package",
  7: "Submit",
};

/** Narrowed view of an event row for the ticker. */
interface EventItem {
  id: string;
  name: string;
  color: string;
  category: string;
  at: number;
  source: string;
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
  status: string;
  createdAt: number | null;
  awaitingFrom: string | null;
  type: string;
}

function fromEventRow(e: EventRow): EventItem {
  return {
    id: e.id,
    name: e.name,
    color: e.color ?? "muted",
    category: e.category ?? "agent",
    at: e.receivedAt ? Date.parse(e.receivedAt) : 0,
    source: e.sourceAgentName ?? "external",
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
    status: t.status,
    createdAt: t.createdAt ? Date.parse(t.createdAt) : null,
    awaitingFrom: t.awaitingRole,
    type: t.type,
  };
}

/** v1_1 supports running/ok/failed/waiting/paused/idle. API status → dot. */
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

// ─── Page (live tick state + liveStream wiring) ──────────────────────────────

export default function DashboardPage() {
  const agentsQuery = useAgents();
  const dagQuery = useDag();
  const tasksQuery = useTasks();
  const eventsQuery = useEvents({ limit: 200 });
  const runsQuery = useRuns({ limit: 200 });

  const agents = agentsQuery.data ?? [];
  const dagAgents = dagQuery.data?.agents ?? [];
  // Derive the funnel's stage set from the live DAG: the set of stage
  // indices actually used by this tenant's agents. Tenants without staged
  // pipelines get an empty list and the funnel panel hides itself.
  const stages = useMemo(() => {
    const used = new Set<number>();
    for (const a of dagAgents) used.add(a.stage);
    return Array.from(used)
      .sort((a, b) => a - b)
      .map((id) => ({ id, label: STAGE_LABELS[id] ?? `Stage ${id}` }));
  }, [dagAgents]);

  const events = useMemo(
    () => (eventsQuery.data ?? []).map(fromEventRow),
    [eventsQuery.data],
  );
  const taskItems = useMemo(
    () => (tasksQuery.data ?? []).map(fromTaskRow),
    [tasksQuery.data],
  );
  const liveRuns = runsQuery.data ?? [];

  // Live-stream toggle proxy — Phase 2 will wire this through Tweaks panel.
  // Falls back to true (matching the v1_1 default) until the toggle exists.
  const [liveStream] = useState(true);

  // First-load gate — render a single empty state until the primary queries
  // resolve so panels don't flash zero-state placeholders.
  const isPrimaryLoading =
    agentsQuery.isLoading || runsQuery.isLoading || eventsQuery.isLoading;
  const primaryError =
    agentsQuery.error ?? runsQuery.error ?? eventsQuery.error ?? null;

  return (
    <DashboardView
      agents={agents}
      dagAgents={dagAgents}
      stages={stages}
      tasks={taskItems}
      eventStream={events}
      liveRuns={liveRuns}
      liveStream={liveStream}
      loading={isPrimaryLoading}
      error={primaryError}
    />
  );
}

interface DashboardViewProps {
  agents: AgentListRow[];
  dagAgents: DagAgent[];
  stages: { id: number; label: string }[];
  tasks: TaskItem[];
  eventStream: EventItem[];
  liveRuns: RunListRow[];
  liveStream: boolean;
  loading: boolean;
  error: Error | null;
}

function DashboardView({
  agents,
  dagAgents,
  stages,
  tasks,
  eventStream,
  liveRuns,
  liveStream,
  loading,
  error,
}: DashboardViewProps) {
  const tenant = useTenant();
  const router = useRouter();
  const startOperatorCheck = useStartOperatorCheck();
  const operatorCheckStartGuard = useRef(false);
  const [operatorCheckLaunching, setOperatorCheckLaunching] = useState(false);

  // Hydration gate. The dashboard is heavily time-dependent (Date.now() in
  // sparkline bucketing, fmtAgo/fmtTime in the ticker, the 1.5s `tickerIdx`
  // interval) and reads react-query state that can differ between SSR and
  // the first client paint. Rather than scatter `suppressHydrationWarning`
  // across every consumer, we render a deterministic skeleton until the
  // component mounts on the client — server HTML and first-client HTML
  // match exactly, then the real dashboard takes over on the next tick.
  const [hasMounted, setHasMounted] = useState(false);
  useEffect(() => setHasMounted(true), []);

  // Live runs (from /v1/runs) auto-invalidate on every SSE event.
  const active = liveRuns.filter((r) => r.status === "running");
  const failed24 = liveRuns.filter((r) => r.status === "failed").length;
  const ok24 = liveRuns.filter((r) => r.status === "ok").length;
  const total24 = liveRuns.length;

  // Throughput sparkline — events / min over last 60 min from the bootstrap
  // snapshot (events are refreshed via context on testAgent push).
  const buckets = useMemo(() => {
    const now = Date.now();
    const bs = new Array(60).fill(0);
    eventStream.forEach((e) => {
      const ago = Math.floor((now - e.at) / 60_000);
      if (ago >= 0 && ago < 60) bs[59 - ago]++;
    });
    return bs;
  }, [eventStream]);

  // Token usage sparkline — sum tokens across runs per 24h bucket.
  const tokSpark = useMemo(() => {
    const arr = new Array(24).fill(0);
    liveRuns.forEach((r, i) => {
      arr[i % 24] += (r.tokensIn || 0) + (r.tokensOut || 0);
    });
    return arr;
  }, [liveRuns]);

  // Per-agent activity over the last hour.
  const agentActivity = useMemo(() => {
    interface Bucket {
      agent: AgentListRow;
      runs: number;
      errors: number;
      lastRun: number;
    }
    const m = new Map<string, Bucket>();
    agents.forEach((a) =>
      m.set(a.name, { agent: a, runs: 0, errors: 0, lastRun: 0 }),
    );
    liveRuns.forEach((r) => {
      const e = m.get(r.agentName);
      if (!e) return;
      e.runs++;
      if (r.status === "failed") e.errors++;
      const t = r.startedAt ? Date.parse(r.startedAt) : 0;
      if (t > e.lastRun) e.lastRun = t;
    });
    return Array.from(m.values()).sort((a, b) => b.runs - a.runs);
  }, [agents, liveRuns]);

  // Newest-first stable window. The previous implementation rotated
  // `tickerIdx` every 1.5s and sliced from there, which made the panel
  // appear to "scroll" even when nothing new was arriving — visually
  // indistinguishable from a fresh event. The list is now sorted by
  // received-at and clamped to 14 distinct rows; new events naturally
  // appear at the top when the underlying query invalidates, and the
  // brand-new row gets the entry animation (see `latestEventId` below).
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

  // Track only the most recently arrived event id so we can animate just
  // that row, not the whole list. Updated when the head of the sorted
  // window changes — i.e. only on a real new arrival, not on every render.
  const [latestEventId, setLatestEventId] = useState<string | null>(null);
  useEffect(() => {
    const head = recentEvents[0]?.id ?? null;
    if (head && head !== latestEventId) setLatestEventId(head);
  }, [recentEvents, latestEventId]);

  const tokensTotal = useMemo(
    () =>
      liveRuns.reduce(
        (sum, r) => sum + (r.tokensIn ?? 0) + (r.tokensOut ?? 0),
        0,
      ),
    [liveRuns],
  );
  const tokensEstCost = (tokensTotal / 1000) * 0.01;

  // Cancel mutation — used by the per-row cancel button and the
  // panel-level "Cancel all". `useCancelRun` already invalidates the runs
  // list + counts on settle, so panels repaint without manual refetch.
  const cancelRun = useCancelRun();
  const toast = useToast();

  async function handleStartOperatorCheck() {
    if (operatorCheckStartGuard.current || startOperatorCheck.isPending) return;
    operatorCheckStartGuard.current = true;
    setOperatorCheckLaunching(true);
    try {
      const result = await startOperatorCheck.mutateAsync();
      router.push(result.detailUrl as never);
    } catch (error) {
      operatorCheckStartGuard.current = false;
      setOperatorCheckLaunching(false);
      toast({
        tone: "red",
        title: "System check could not start",
        description:
          error instanceof Error ? error.message : "Unknown startup error",
      });
    }
  }

  const handleCancel = useCallback(
    (runId: string) => {
      cancelRun.mutate(runId, {
        onSuccess: (data) => {
          toast({
            tone: data.cancelled ? "signal" : "default",
            title: data.cancelled
              ? `Run ${runId} cancelling`
              : `Run ${runId} already ${data.status}`,
            description: data.note,
          });
        },
        onError: (err) => {
          toast({
            tone: "red",
            title: `Cancel failed`,
            description: err instanceof Error ? err.message : String(err),
          });
        },
      });
    },
    [cancelRun, toast],
  );

  const handleCancelAll = useCallback(() => {
    if (active.length === 0) return;
    const ids = active.map((r) => r.id);
    toast({
      tone: "amber",
      title: `Cancelling ${ids.length} active run${ids.length === 1 ? "" : "s"}`,
      description: ids.slice(0, 4).join(", ") + (ids.length > 4 ? "…" : ""),
    });
    for (const id of ids) cancelRun.mutate(id);
  }, [active, cancelRun, toast]);

  // dagAgents is currently only used to derive `stages`. Marking the prop as
  // intentionally unread keeps the contract documented without introducing
  // an unused-variable lint warning.
  void dagAgents;

  // First-paint skeleton — see `hasMounted` comment above. We deliberately
  // mirror the loading branch below so the eventual hydrated paint replaces
  // a friendly empty state rather than a flash of nothing.
  if (!hasMounted) {
    return (
      <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
        <ViewHeader
          title="Dashboard"
          subtitle="Live state of all agent runs, events, and queues across the active tenant."
          badge={
            <Badge tone="signal">
              <span className="live-dot" style={{ width: 5, height: 5 }} /> LIVE
            </Badge>
          }
        />
        <div style={{ padding: 20 }}>
          <Empty title="Loading dashboard…" hint="" />
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <ViewHeader
        title="Dashboard"
        subtitle="Live state of all agent runs, events, and queues across the active tenant."
        badge={
          <Badge tone="signal">
            <span className="live-dot" style={{ width: 5, height: 5 }} /> LIVE
          </Badge>
        }
        action={
          <>
            <Button icon="deploy" small>
              Deploy
            </Button>
            <Button icon="replay" small>
              Replay window
            </Button>
          </>
        }
      />

      {error && (
        <div style={{ padding: 20 }}>
          <Empty
            title="Failed to load dashboard"
            hint={error.message || "api unreachable on :3501"}
          />
        </div>
      )}
      {!error && loading && agents.length === 0 && liveRuns.length === 0 && (
        <div style={{ padding: 20 }}>
          <Empty title="Loading dashboard…" hint="" />
        </div>
      )}

      <div style={{ flex: 1, overflow: "auto", padding: 20 }}>
        {/* Top KPI row */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(5, 1fr)",
            gap: 12,
            marginBottom: 16,
          }}
        >
          <KPICard
            label="Active runs"
            value={active.length}
            sub={`${ok24}/${total24} ok past hour`}
            tone="up"
            accent="var(--signal)"
            spark={buckets.slice(40)}
          />
          <KPICard
            label="Events / hr"
            value={fmtNum(eventStream.length)}
            sub={`${fmtNum(eventStream.length)} in window`}
            tone="up"
            spark={buckets}
          />
          <KPICard
            label="Errors / hr"
            value={failed24}
            sub={
              failed24 > 0 && total24 > 0
                ? `${((failed24 / total24) * 100).toFixed(1)}% failure rate`
                : "all green"
            }
            tone={failed24 > 4 ? "down" : "up"}
            accent={failed24 > 4 ? "var(--red)" : "var(--green)"}
          />
          <KPICard
            label="Pending tasks"
            value={tasks.length}
            sub={`${tasks.filter((t) => t.priority === "high").length} high priority`}
            accent="var(--amber)"
          />
          <KPICard
            label="Tokens / hr"
            value={fmtNum(tokensTotal)}
            sub={`≈ $${tokensEstCost.toFixed(2)}`}
            spark={tokSpark}
          />
        </div>

        {/* Main grid */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1.4fr 1fr",
            gap: 12,
          }}
        >
          {/* LEFT */}
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <Panel
              title="Active runs"
              subtitle={`${active.length} running`}
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
                      Cancel all
                    </Button>
                  )}
                  <Link
                    href={`/portal/${tenant}/runs` as never}
                    style={{ textDecoration: "none" }}
                  >
                    <Button small icon="external" tone="ghost">
                      View all
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
                cancelPendingIds={
                  cancelRun.isPending ? cancelRun.variables : undefined
                }
              />
            </Panel>

            <Panel
              title="Agent activity · past hour"
              action={
                <Link
                  href={`/portal/${tenant}/agents` as never}
                  style={{ textDecoration: "none" }}
                >
                  <Button small icon="external" tone="ghost">
                    All agents
                  </Button>
                </Link>
              }
              padded={false}
            >
              <AgentActivityGrid items={agentActivity} tenant={tenant} />
            </Panel>
          </div>

          {/* RIGHT */}
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <Panel
              title="Event stream"
              subtitle={liveStream ? "auto-updating" : "paused"}
              action={
                <Link
                  href={`/portal/${tenant}/events` as never}
                  style={{ textDecoration: "none" }}
                >
                  <Button small icon="external" tone="ghost">
                    Open
                  </Button>
                </Link>
              }
              padded={false}
              style={{ minHeight: 320 }}
            >
              <EventTicker
                events={recentEvents}
                live={liveStream}
                latestEventId={latestEventId}
              />
            </Panel>

            <Panel
              title="Awaiting humans"
              subtitle={`${tasks.length} tasks`}
              action={
                <Link
                  href={`/portal/${tenant}/tasks` as never}
                  style={{ textDecoration: "none" }}
                >
                  <Button small icon="external" tone="ghost">
                    Inbox
                  </Button>
                </Link>
              }
              padded={false}
            >
              <PendingTasksList tasks={tasks.slice(0, 5)} tenant={tenant} />
            </Panel>

            <Panel
              title="Runtime"
              action={
                <Button
                  small
                  icon="play"
                  onClick={() => void handleStartOperatorCheck()}
                  disabled={
                    startOperatorCheck.isPending || operatorCheckLaunching
                  }
                  ariaLabel="Run two-agent system check"
                >
                  {startOperatorCheck.isPending
                    ? "Starting…"
                    : operatorCheckLaunching
                      ? "Opening check…"
                      : "Run full check"}
                </Button>
              }
              padded
            >
              <SystemHealth />
            </Panel>
          </div>
        </div>

        {/* Bottom: stage funnel — only show if the tenant has stages defined.
            Avoids leaking the RAAS-specific funnel title for tenants that
            don't have a staged pipeline (e.g. northwind, robohire). */}
        {stages.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <Panel title="Stage funnel · last 24h" padded>
              <StageFunnel stages={stages} />
            </Panel>
          </div>
        )}
      </div>
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
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  tone?: "up" | "down";
  accent?: string;
  spark?: number[];
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
          <Sparkline
            values={spark}
            width={70}
            height={26}
            color={accent || "var(--signal)"}
          />
        )}
      </div>
      {sub && (
        <div
          style={{
            marginTop: 4,
            fontSize: 11,
            color:
              tone === "down"
                ? "var(--red)"
                : tone === "up"
                  ? "var(--text-2)"
                  : "var(--text-3)",
          }}
        >
          {sub}
        </div>
      )}
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
  if (rows.length === 0)
    return <Empty title="No active runs" hint="Quiet — system idle" />;
  return (
    <div style={{ maxHeight: 280, overflow: "auto" }}>
      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          fontSize: 12.5,
          tableLayout: "fixed",
        }}
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
            <Th>Run</Th>
            <Th>Agent</Th>
            <Th>Subject</Th>
            <Th>Step</Th>
            <Th style={{ textAlign: "right" }}>Dur</Th>
            {onCancel && <Th style={{ textAlign: "right" }}>Action</Th>}
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
  // Detect a TEST run — RunListRow doesn't surface testRun yet (Phase 2
  // backend wiring lands in Cleanup); falling back to the SPA snapshot row.
  const testRun = (row as { testRun?: boolean }).testRun === true;
  return (
    <tr
      style={{
        borderBottom: "1px solid var(--border)",
      }}
    >
      <Td>
        <StatusDot status={STATUS_TO_DOT[row.status] ?? "idle"} />
      </Td>
      <Td>
        <Link
          href={`/portal/${tenant}/runs/${row.id}` as never}
          style={{ textDecoration: "none" }}
        >
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
            }}
          >
            <span
              className="mono"
              style={{ color: "var(--text-2)", whiteSpace: "nowrap" }}
            >
              {row.id}
            </span>
            {testRun && (
              <Badge tone="signal" style={{ fontSize: 9 }}>
                TEST
              </Badge>
            )}
          </span>
        </Link>
      </Td>
      <Td
        style={{
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        <span style={{ color: "var(--text)" }}>
          {row.agentTitle ?? row.agentName}
        </span>
      </Td>
      <Td>
        <span
          className="mono"
          style={{ color: "var(--text-2)", whiteSpace: "nowrap" }}
        >
          {row.subject ?? "—"}
        </span>
      </Td>
      <Td style={{ overflow: "hidden" }}>
        {row.currentStepName && row.stepCount ? (
          <span
            style={{
              fontSize: 11.5,
              display: "flex",
              gap: 4,
              alignItems: "baseline",
              overflow: "hidden",
            }}
          >
            <span
              className="mono"
              style={{
                color: "var(--signal)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                minWidth: 0,
              }}
            >
              {row.currentStepName}
            </span>
            <span
              style={{
                color: "var(--text-3)",
                whiteSpace: "nowrap",
                flexShrink: 0,
              }}
            >
              {(row.currentStepOrd ?? "?") + "/" + row.stepCount}
            </span>
          </span>
        ) : (
          <span style={{ color: "var(--text-3)" }}>—</span>
        )}
      </Td>
      <Td style={{ textAlign: "right" }}>
        <span
          className="mono"
          style={{ color: "var(--signal)", whiteSpace: "nowrap" }}
        >
          {fmtDur(row.durationMs)}
        </span>
      </Td>
      {onCancel && (
        <Td style={{ textAlign: "right" }}>
          <Button
            small
            icon="x"
            tone="danger"
            onClick={() => onCancel(row.id)}
            disabled={cancelling}
          >
            {cancelling ? "…" : "Cancel"}
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
}: {
  items: AgentActivity[];
  tenant: string;
}) {
  if (items.length === 0) return <Empty title="No agent activity" hint="—" />;
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
                    : `rgba(208,255,0,${0.15 + intensity * 0.6})`,
              }}
            />
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                marginBottom: 4,
              }}
            >
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
            <div
              style={{
                fontSize: 10.5,
                fontFamily: "var(--mono)",
                color: "var(--text-3)",
              }}
            >
              {lastRun > 0 ? fmtAgo(lastRun) : "idle"}
              {errors > 0 && (
                <span style={{ color: "var(--red)", marginLeft: 8 }}>
                  {errors} err
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
            // Animate only the genuinely-new head row, and only when live
            // streaming is enabled. Older rows are static — no idle scroll.
            animation:
              live && e.id === latestEventId ? "tick 0.4s ease-out" : "none",
          }}
        >
          <span
            className="mono"
            style={{ color: "var(--text-3)", fontSize: 10.5, marginTop: 2 }}
          >
            {fmtTime(e.at)}
          </span>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 4,
              minWidth: 0,
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
          <span
            className="mono"
            style={{ color: "var(--text-3)", fontSize: 10.5, marginTop: 2 }}
          >
            {e.subject}
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * Renders the subscriber chips under each event row. Three states:
 *   - no consumers at all  → muted "no subscribers" (event went nowhere)
 *   - some still running   → animated dot per consumer
 *   - all terminal         → "✓ consumed by …" with the final status tone
 *
 * Status mapping mirrors STATUS_TO_DOT at the top of this file.
 */
function EventConsumerStrip({
  consumers,
}: {
  consumers: EventItem["consumers"];
}) {
  if (!consumers || consumers.length === 0) {
    return (
      <span style={{ fontSize: 10.5, color: "var(--text-4)" }}>
        no subscribers
      </span>
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
      <span>consumed by</span>
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
            {c.agentTitle || c.agentName || "agent"}
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
}: {
  tasks: TaskItem[];
  tenant: string;
}) {
  if (tasks.length === 0)
    return <Empty title="All clear" hint="No pending tasks" />;
  return (
    <div>
      {tasks.map((t) => (
        <Link
          key={t.id}
          href={
            `/portal/${tenant}/tasks?id=${encodeURIComponent(t.id)}` as never
          }
          style={{
            display: "block",
            width: "100%",
            textAlign: "left",
            padding: "10px 14px",
            borderBottom: "1px solid var(--border)",
            textDecoration: "none",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginBottom: 4,
            }}
          >
            <Badge
              tone={
                t.priority === "high"
                  ? "amber"
                  : t.priority === "med"
                    ? "blue"
                    : "muted"
              }
              style={{ fontSize: 9.5 }}
            >
              {t.priority.toUpperCase()}
            </Badge>
            <span
              style={{
                fontSize: 11,
                color: "var(--text-3)",
                fontFamily: "var(--mono)",
              }}
            >
              {t.id}
            </span>
            <span
              style={{
                marginLeft: "auto",
                fontSize: 11,
                color: "var(--text-3)",
              }}
            >
              {t.createdAt ? fmtAgo(t.createdAt) : "—"}
            </span>
          </div>
          <div
            style={{
              fontSize: 12.5,
              color: "var(--text)",
              marginBottom: 2,
            }}
          >
            {t.title}
          </div>
          {t.awaitingFrom ? (
            <div style={{ fontSize: 11, color: "var(--text-3)" }}>
              awaiting · {t.awaitingFrom}
            </div>
          ) : null}
        </Link>
      ))}
    </div>
  );
}

// ─── System health ───────────────────────────────────────────────────────────

function SystemHealth() {
  // FE-P0-4 sub-fix 4b: wired to `/health` (apps/api/src/routes/health.ts)
  // via `useHealth()`. The endpoint exposes three sub-components — inngest,
  // sqlite, disk — and polls every 15s. When the api is unreachable we
  // render fallback rows tagged "fail · unreachable" so the operator still
  // sees a panel rather than a blank.
  const { data: health, isError } = useHealth();
  const items: Array<{
    label: string;
    status: "ok" | "warn" | "fail";
    note: string;
  }> = [];
  if (health) {
    items.push({
      label: "Inngest worker",
      status: health.inngest.ok ? "ok" : "fail",
      note:
        health.inngest.note ??
        (health.inngest.reachable === false
          ? "unreachable"
          : health.inngest.ok
            ? "reachable"
            : "degraded"),
    });
    items.push({
      label: "SQLite",
      status: health.sqlite.ok ? "ok" : "fail",
      note: health.sqlite.ok
        ? `${fmtBytes(health.sqlite.sizeBytes)} · ${health.sqlite.journalMode ?? "—"}`
        : "unreachable",
    });
    items.push({
      label: "Log volume",
      status: health.disk.ok ? "ok" : "fail",
      note: health.disk.ok
        ? `${fmtBytes(health.disk.freeBytes)} free · ${health.disk.logsDir ?? ""}`
        : "stat failed",
    });
  } else if (isError) {
    items.push({
      label: "Inngest worker",
      status: "fail",
      note: "api unreachable",
    });
    items.push({ label: "SQLite", status: "fail", note: "api unreachable" });
    items.push({
      label: "Log volume",
      status: "fail",
      note: "api unreachable",
    });
  } else {
    items.push({ label: "Inngest worker", status: "ok", note: "checking…" });
    items.push({ label: "SQLite", status: "ok", note: "checking…" });
    items.push({ label: "Log volume", status: "ok", note: "checking…" });
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {items.map((i) => (
        <div
          key={i.label}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            fontSize: 12,
          }}
        >
          <StatusDot
            status={
              i.status === "ok"
                ? "ok"
                : i.status === "warn"
                  ? "waiting"
                  : "failed"
            }
          />
          <span style={{ color: "var(--text)" }}>{i.label}</span>
          <span
            style={{
              marginLeft: "auto",
              color: "var(--text-3)",
              fontSize: 11,
              fontFamily: "var(--mono)",
            }}
          >
            {i.note}
          </span>
        </div>
      ))}
    </div>
  );
}

// ─── Stage funnel ────────────────────────────────────────────────────────────

function StageFunnel({ stages }: { stages: { id: number; label: string }[] }) {
  // Render 0 per stage until the forthcoming /v1/funnel endpoint ships.
  // None of the live hooks expose per-stage funnel counts today.
  const counts = stages.map(() => 0);
  const max = 1;
  if (stages.length === 0) {
    return <Empty title="No stages defined" hint="Workflow not yet loaded" />;
  }
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(${stages.length}, 1fr)`,
        gap: 8,
      }}
    >
      {stages.map((s, i) => {
        const c = counts[i] ?? 0;
        const pct = c / max;
        const prior = counts[i - 1];
        const drop =
          i > 0 && prior != null && prior > 0
            ? (((prior - c) / prior) * 100).toFixed(1)
            : null;
        return (
          <div
            key={s.id}
            style={{ display: "flex", flexDirection: "column", gap: 6 }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "baseline",
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
                {s.label}
              </span>
              {drop && (
                <span
                  style={{
                    fontSize: 9.5,
                    fontFamily: "var(--mono)",
                    color: "var(--text-3)",
                  }}
                >
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
                    "linear-gradient(90deg, var(--signal) 0%, var(--signal) 70%, rgba(208,255,0,0.5) 100%)",
                  opacity: 0.3 + pct * 0.7,
                }}
              />
            </div>
            <div
              style={{
                fontSize: 16,
                fontFamily: "var(--mono)",
                color: "var(--text)",
              }}
            >
              {fmtNum(c)}
            </div>
          </div>
        );
      })}
    </div>
  );
}
