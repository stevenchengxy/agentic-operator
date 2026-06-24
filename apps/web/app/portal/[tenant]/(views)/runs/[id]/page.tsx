"use client";

/**
 * Run detail — 5-tab surface (P2-FE-10).
 *
 * Tabs: timeline | logs | io | events | agent. The "agent" tab is the
 * cross-link to AgentCodeTab (delta D-7 from audit 01 §6). It imports the
 * heavy-views engineer's AgentCodeTab; if that module isn't loaded yet we
 * render an `Empty` fallback so the build still passes.
 *
 * Ported from `apps/web/public/portal/views/runs.jsx:133-219`. Header
 * preserves the "Open agent" jump button + TEST RUN badge for testRun runs.
 */

import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  Badge,
  Button,
  Empty,
  Icon,
  Panel,
  StatusDot,
  CodeBlock,
  useToast,
  type StatusName,
} from "@/app/portal/components";
import { fmtDur, fmtNum, fmtTime } from "@/app/portal/lib/format";
import { useTenant } from "@/app/portal/lib/use-tenant";
import { useI18n } from "@/app/portal/lib/preferences-context";
import {
  useRun,
  useReplayRun,
  useCancelRun,
  type RunListRow,
  type StepRow,
} from "@/lib/hooks/useRuns";
import { useAgents, useAgent, type AgentListRow } from "@/lib/hooks/useAgents";
// AgentCodeTab is owned by the heavy-views engineer (P2-FE-08/09). Imported
// directly here to satisfy delta D-7 (Runs detail "agent" tab).
import { AgentCodeTab } from "@/app/portal/components/agent-code/AgentCodeTab";
import { TraceTree } from "@/app/portal/components/runs/TraceTree";

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

type Tab = "timeline" | "trace" | "logs" | "io" | "events" | "agent";

export default function RunDetailPage() {
  const params = useParams<{ id?: string }>();
  const runId = params?.id ?? null;
  const tenant = useTenant();
  const { data, isLoading } = useRun(runId);
  const [tab, setTab] = useState<Tab>("timeline");
  const { t } = useI18n();

  if (!runId) return <Empty title={t("runDetail.noRunId")} />;
  if (isLoading || !data)
    return <Empty title={t("runDetail.loadingRun")} hint={runId} />;

  const { run, steps } = data;
  return (
    <RunDetail
      run={run}
      steps={steps}
      tab={tab}
      setTab={setTab}
      tenant={tenant}
    />
  );
}

interface RunDetailProps {
  run: RunListRow;
  steps: StepRow[];
  tab: Tab;
  setTab: (t: Tab) => void;
  tenant: string;
}

function RunDetail({ run, steps, tab, setTab, tenant }: RunDetailProps) {
  const { data: agents = [] } = useAgents();
  const router = useRouter();
  const toast = useToast();
  const { t } = useI18n();
  const replay = useReplayRun();
  const cancel = useCancelRun();
  // Inline-confirmation gate for the Stop button (P0 NO-MODAL policy —
  // matches the rest of the portal's "click once to arm, again to fire"
  // pattern). Stays armed for 3s then snaps back to idle so a stray click
  // doesn't accidentally cancel a run after the operator wandered away.
  const [confirmStop, setConfirmStop] = useState(false);
  useEffect(() => {
    if (!confirmStop) return;
    const t = setTimeout(() => setConfirmStop(false), 3000);
    return () => clearTimeout(t);
  }, [confirmStop]);
  // The /v1/runs response keys agents by name; match on name to find the
  // listing row, then fetch full manifest detail for the "agent" code tab.
  const agentRow = useMemo(
    () => agents.find((a) => a.name === run.agentName) ?? null,
    [agents, run.agentName],
  );
  const agentDetailQuery = useAgent(agentRow?.kebabId ?? null);
  const agentDetail = agentDetailQuery.data ?? null;
  const testRun = (run as { testRun?: boolean }).testRun === true;
  const isReplay = Boolean(run.parentRunId);
  // The Stop button is only meaningful for runs that haven't finished. We
  // treat the same set the API treats as cancellable: anything not in
  // {ok, failed, cancelled}. `idle` is included for completeness in case a
  // future code path enqueues a run without flipping straight to running.
  const isActive =
    run.status === "running" ||
    run.status === "waiting" ||
    run.status === "queued" ||
    run.status === "idle";

  async function handleReplay() {
    try {
      const data = await replay.mutateAsync(run.id);
      toast({
        tone: "signal",
        title: t("runDetail.replayQueued"),
        description: t("runDetail.replayQueuedDesc", {
          eventId: data.new_event_id,
        }),
      });
      // Send the user back to the runs list where the new run will appear at
      // the top with a REPLAY badge.
      router.push(`/portal/${tenant}/runs` as never);
    } catch (err) {
      toast({
        tone: "red",
        title: t("runDetail.replayFailed"),
        description: err instanceof Error ? err.message : t("runDetail.unknownError"),
      });
    }
  }

  async function handleStop() {
    // Two-click confirmation gate: first click arms, second click fires.
    // The arm state self-resets after 3s (see useEffect above) so a stray
    // click doesn't cancel a run the operator wandered away from.
    if (!confirmStop) {
      setConfirmStop(true);
      return;
    }
    setConfirmStop(false);
    try {
      const data = await cancel.mutateAsync(run.id);
      if (data.cancelled) {
        toast({
          tone: "amber",
          title: t("runDetail.runCancelled"),
          description: data.note,
        });
      } else {
        // Server-side idempotent no-op (run was already terminal). Treat
        // as success, not error — the operator's intent ("stop this run")
        // is already satisfied.
        toast({
          tone: "default",
          title: t("runDetail.alreadyFinished"),
          description: data.note,
        });
      }
    } catch (err) {
      toast({
        tone: "red",
        title: t("runDetail.cancelFailed"),
        description: err instanceof Error ? err.message : t("runDetail.unknownError"),
      });
    }
  }

  // "agent" tab needs to fill space + own its scroll.
  const isAgentTab = tab === "agent";

  const startedMs = run.startedAt ? Date.parse(run.startedAt) : null;

  return (
    <div
      style={{
        padding: 24,
        display: "flex",
        flexDirection: "column",
        gap: 16,
        height: isAgentTab ? "100%" : "auto",
        minHeight: 0,
      }}
    >
      {/* Header */}
      <header style={{ flexShrink: 0 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginBottom: 6,
            flexWrap: "wrap",
          }}
        >
          <StatusDot
            status={STATUS_TO_DOT[run.status] ?? "idle"}
            size={9}
          />
          <span
            className="mono"
            style={{ fontSize: 13, color: "var(--text-2)" }}
          >
            {run.id}
          </span>
          <Badge
            tone={
              run.status === "running"
                ? "signal"
                : run.status === "failed"
                  ? "red"
                  : "green"
            }
            style={{ marginLeft: 4 }}
          >
            {run.status}
          </Badge>
          {testRun && <Badge tone="signal">TEST RUN</Badge>}
          {isReplay && <Badge tone="amber">REPLAY</Badge>}
          {run.triggerEvent && (
            <Badge tone="muted">↑ {run.triggerEvent}</Badge>
          )}
          <div
            style={{
              marginLeft: "auto",
              display: "flex",
              gap: 6,
              alignItems: "center",
            }}
          >
            {isActive && (
              <Button
                small
                icon="pause"
                tone="danger"
                onClick={handleStop}
                disabled={cancel.isPending}
                title={
                  confirmStop
                    ? t("runDetail.stopConfirmTitle")
                    : t("runDetail.stopTitle")
                }
                ariaLabel={
                  confirmStop
                    ? t("runDetail.stopConfirmAria")
                    : t("runDetail.stopAria")
                }
              >
                {cancel.isPending
                  ? t("runDetail.stopping")
                  : confirmStop
                    ? t("runDetail.confirmStop")
                    : t("runDetail.stop")}
              </Button>
            )}
            <Button
              small
              icon="replay"
              onClick={handleReplay}
              disabled={replay.isPending}
              title={t("runDetail.replayTitle")}
            >
              {replay.isPending ? t("runDetail.replaying") : t("runDetail.replay")}
            </Button>
            {agentRow && (
              <Link
                href={`/portal/${tenant}/agents/${agentRow.kebabId}` as never}
                style={{ textDecoration: "none" }}
              >
                <Button small icon="agent" tone="ghost">
                  {t("runDetail.openAgent")}
                </Button>
              </Link>
            )}
          </div>
        </div>
        <h2
          style={{
            margin: "4px 0 0 0",
            fontSize: 24,
            fontFamily: "var(--display)",
            fontWeight: 400,
            color: "var(--text)",
          }}
        >
          {run.agentTitle ?? run.agentName}
        </h2>
      </header>

      {/* Stats strip */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(5, 1fr)",
          gap: 0,
          border: "1px solid var(--border)",
          borderRadius: 6,
          background: "var(--panel)",
          flexShrink: 0,
        }}
      >
        <StatCell
          label={t("runDetail.statStarted")}
          value={
            startedMs
              ? new Date(startedMs).toLocaleString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                  second: "2-digit",
                })
              : "—"
          }
        />
        <StatCell
          label={t("runDetail.statDuration")}
          value={fmtDur(run.durationMs)}
          accent={run.status === "running" ? "var(--signal)" : undefined}
        />
        <StatCell
          label={t("runDetail.statSteps")}
          value={steps.length > 0 ? String(steps.length) : "—"}
        />
        <StatCell
          label={t("runDetail.statTokens")}
          value={`${fmtNum(run.tokensIn ?? 0)} · ${fmtNum(run.tokensOut ?? 0)}`}
        />
        <StatCell label={t("runDetail.statSubject")} value={run.subject ?? "—"} mono />
      </div>

      {/* Tabs */}
      <div
        style={{
          display: "flex",
          gap: 0,
          borderBottom: "1px solid var(--border)",
          flexShrink: 0,
        }}
      >
        {(["timeline", "trace", "logs", "io", "events", "agent"] as const).map((tabId) => (
          <button
            key={tabId}
            onClick={() => setTab(tabId)}
            style={{
              padding: "8px 14px",
              fontSize: 12,
              fontFamily: "var(--mono)",
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              color: tab === tabId ? "var(--text)" : "var(--text-3)",
              borderBottom: `2px solid ${tab === tabId ? "var(--signal)" : "transparent"}`,
              marginBottom: -1,
            }}
          >
            {t(`runDetail.tab_${tabId}`)}
          </button>
        ))}
      </div>

      {/* Agent tab — full-bleed flex region; embeds the AgentCodeTab from
          heavy-views (delta D-7). The api's AgentDetail contract doesn't
          yet surface typescript_code / tool_use / input_data /
          ontology_instructions — those come back empty. The tab renders
          the "no code recorded" state for manifest agents until the api
          starts shipping those fields. */}
      {isAgentTab && (
        <div style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
          {agentDetailQuery.isLoading && !agentDetail ? (
            <Empty title={t("runDetail.loadingAgent")} hint={agentRow?.kebabId ?? ""} />
          ) : agentRow ? (
            <AgentCodeTab
              agent={{
                actor: agentRow.actor,
                name: agentRow.name,
                typescript_code: "",
                tool_use: undefined,
                input_data: {},
                ontology_instructions: "",
              }}
            />
          ) : (
            <Empty
              title={t("runDetail.agentNotFound")}
              hint={`agentName=${run.agentName}`}
            />
          )}
        </div>
      )}

      {tab === "timeline" && <TimelineTab steps={steps} run={run} />}
      {tab === "trace" && (
        <Panel
          title={t("runDetail.traceTitle")}
          subtitle={t("runDetail.traceSubtitle")}
          padded={false}
        >
          <div style={{ padding: "8px 12px" }}>
            <TraceTree node={{ run, steps }} tenant={tenant} />
          </div>
        </Panel>
      )}
      {tab === "logs" && <LogsTab runId={run.id} tenant={tenant} />}
      {tab === "io" && <IOTab run={run} agent={agentRow} tenant={tenant} />}
      {tab === "events" && <RunEventsTab run={run} />}

      {/* Failed-run error panel (any tab except agent) */}
      {!isAgentTab && run.status === "failed" && (
        <Panel
          title={t("runDetail.errorTitle")}
          style={{ borderColor: "color-mix(in srgb, var(--red) 30%, transparent)" }}
          padded
        >
          <div
            className="mono"
            style={{
              fontSize: 12,
              color: "var(--red)",
              lineHeight: 1.5,
            }}
          >
            {/* RunListRow doesn't surface error message directly; surface
                a placeholder so the audit acceptance still renders. */}
            {(run as { error?: string }).error ?? t("runDetail.runFailedFallback")}
          </div>
          <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
            <Button
              icon="replay"
              small
              onClick={handleReplay}
              disabled={replay.isPending}
            >
              {replay.isPending ? t("runDetail.running") : t("runDetail.retry")}
            </Button>
            <Button icon="logs" small tone="ghost" onClick={() => setTab("logs")}>
              {t("runDetail.viewErrorTrace")}
            </Button>
          </div>
        </Panel>
      )}
    </div>
  );
}

function StatCell({
  label,
  value,
  mono,
  accent,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
  accent?: string;
}) {
  return (
    <div
      style={{
        padding: "10px 14px",
        borderRight: "1px solid var(--border)",
      }}
    >
      <div
        style={{
          fontSize: 10,
          fontFamily: "var(--mono)",
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          color: "var(--text-3)",
        }}
      >
        {label}
      </div>
      <div
        style={{
          marginTop: 3,
          fontSize: 14,
          fontFamily: mono ? "var(--mono)" : "var(--sans)",
          color: accent ?? "var(--text)",
        }}
      >
        {value}
      </div>
    </div>
  );
}

// ─── Timeline tab ────────────────────────────────────────────────────────────

function TimelineTab({ steps, run }: { steps: StepRow[]; run: RunListRow }) {
  const { t } = useI18n();
  const [open, setOpen] = useState<Set<string>>(new Set());
  if (steps.length === 0) {
    return (
      <Empty title={t("runDetail.noSteps")} hint={t("runDetail.noStepsHint")} />
    );
  }
  const startedMs = run.startedAt ? Date.parse(run.startedAt) : Date.now();
  const total = run.durationMs ?? Date.now() - startedMs;
  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  return (
    <Panel title={t("runDetail.stepTimeline")} padded={false}>
      <div style={{ padding: "8px 16px" }}>
        {steps.map((s, i) => {
          const stepStartedMs = s.startedAt ? Date.parse(s.startedAt) : startedMs;
          const startPct = total > 0 ? ((stepStartedMs - startedMs) / total) * 100 : 0;
          const durPct =
            total > 0
              ? ((s.durationMs ?? total - (stepStartedMs - startedMs)) / total) * 100
              : 1;
          const color =
            s.status === "failed"
              ? "var(--red)"
              : s.status === "running"
                ? "var(--signal)"
                : "var(--green)";
          const isOpen = open.has(s.id);
          const stepIn = (s as { input?: unknown }).input;
          const stepOut = (s as { output?: unknown }).output;
          const hasIO = stepIn != null || stepOut != null || s.error;
          return (
            <div
              key={`${s.id}-${i}`}
              style={{ borderBottom: i < steps.length - 1 ? "1px solid var(--border)" : "none" }}
            >
              <div
                onClick={() => hasIO && toggle(s.id)}
                style={{
                  display: "grid",
                  gridTemplateColumns: "20px 26px 220px 1fr 80px",
                  gap: 10,
                  alignItems: "center",
                  padding: "8px 0",
                  cursor: hasIO ? "pointer" : "default",
                }}
              >
                <Icon
                  name={isOpen ? "chevron-down" : "chevron-right"}
                  size={11}
                  style={{ color: hasIO ? "var(--text-3)" : "transparent" }}
                />
                <div style={{ display: "flex", justifyContent: "center" }}>
                  <StatusDot status={STATUS_TO_DOT[s.status] ?? "idle"} />
                </div>
                <div>
                  <div className="mono" style={{ fontSize: 12, color: "var(--text)" }}>
                    {s.name}
                  </div>
                  <div style={{ fontSize: 10.5, color: "var(--text-3)" }}>
                    {t("runDetail.stepN", { n: i + 1 })} · {s.type}
                    {s.model ? ` · ${s.model}` : ""}
                  </div>
                </div>
                <div
                  style={{
                    position: "relative",
                    height: 16,
                    background: "var(--bg-2)",
                    borderRadius: 2,
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      position: "absolute",
                      left: `${Math.min(99, startPct)}%`,
                      width: `${Math.max(1, durPct)}%`,
                      top: 0,
                      bottom: 0,
                      background: color,
                      opacity: s.status === "running" ? 0.85 : 0.45,
                      borderLeft: `2px solid ${color}`,
                    }}
                  >
                    {s.status === "running" && (
                      <div
                        style={{
                          position: "absolute",
                          inset: 0,
                          background:
                            "linear-gradient(90deg, transparent, rgba(255,255,255,0.18), transparent)",
                          backgroundSize: "200px 100%",
                          animation: "shimmer 1.5s linear infinite",
                        }}
                      />
                    )}
                  </div>
                </div>
                <div
                  className="mono"
                  style={{
                    fontSize: 11.5,
                    color: s.status === "running" ? "var(--accent-text)" : "var(--text-2)",
                    textAlign: "right",
                  }}
                >
                  {fmtDur(s.durationMs)}
                </div>
              </div>
              {isOpen && (
                <div style={{ padding: "0 0 12px 56px", display: "flex", flexDirection: "column", gap: 8 }}>
                  {s.error && (
                    <div
                      className="mono"
                      style={{
                        fontSize: 11,
                        color: "var(--red)",
                        padding: "6px 8px",
                        background: "color-mix(in srgb, var(--red) 7%, transparent)",
                        borderRadius: 4,
                      }}
                    >
                      {s.error}
                    </div>
                  )}
                  <StepIO label={t("runDetail.stepInput")} value={stepIn} />
                  <StepIO label={t("runDetail.stepOutput")} value={stepOut} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

/** A labeled per-step input/output payload block (Inngest-style 📥/📤). */
function StepIO({ label, value }: { label: string; value: unknown }) {
  if (value == null) return null;
  return (
    <div>
      <div
        style={{
          fontSize: 9.5,
          fontFamily: "var(--mono)",
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          color: "var(--text-3)",
          marginBottom: 3,
        }}
      >
        {label}
      </div>
      <CodeBlock>
        {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
      </CodeBlock>
    </div>
  );
}

// ─── Logs tab ────────────────────────────────────────────────────────────────

function LogsTab({ runId, tenant }: { runId: string; tenant: string }) {
  // Real per-run log content via `/v1/runs/:runId/logs`. Previously this
  // rendered a RAAS-specific sample log (matchResume/CAN-88412) regardless
  // of which run the user opened.
  const { t } = useI18n();
  const [lines, setLines] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setLines([]);
    // The api streams logs as SSE text/event-stream. Without ?follow=1 it
    // sends the existing file content then closes the connection — perfect
    // for a one-shot "show me the log" panel. We parse SSE frames so the
    // operator sees the same lines that the server-side tail would emit.
    fetch(`/v1/runs/${encodeURIComponent(runId)}/logs`, {
      credentials: "same-origin",
      headers: { Accept: "text/event-stream", "x-agentic-tenant": tenant },
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`/v1/runs/${runId}/logs: HTTP ${res.status}`);
        const text = await res.text();
        if (cancelled) return;
        const out: string[] = [];
        // Frames look like:
        //   event: log\n
        //   data: <line>\n
        //   \n
        // Pull just the data lines from `event: log` frames.
        let currentEvent: string | null = null;
        for (const raw of text.split("\n")) {
          if (raw.startsWith("event:")) currentEvent = raw.slice(6).trim();
          else if (raw.startsWith("data:")) {
            if (currentEvent === "log") out.push(raw.slice(5).trim());
            else if (currentEvent === "info") out.push(`# ${raw.slice(5).trim()}`);
          } else if (raw === "") currentEvent = null;
        }
        setLines(out);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [runId, tenant]);

  return (
    <Panel
      title={`logs/runs/${runId}.log`}
      subtitle={
        loading
          ? t("runDetail.logsLoading")
          : error
            ? t("runDetail.logsError")
            : t("runDetail.logsFileBacked")
      }
      padded={false}
      action={
        <Button small icon="external" tone="ghost">
          {t("runDetail.openFile")}
        </Button>
      }
    >
      <pre
        style={{
          margin: 0,
          padding: 16,
          background: "var(--bg-2)",
          fontFamily: "var(--mono)",
          fontSize: 11.5,
          lineHeight: 1.65,
          color: "var(--text-2)",
          whiteSpace: "pre-wrap",
          wordBreak: "break-all",
          maxHeight: 420,
          overflow: "auto",
        }}
      >
        {error && (
          <div style={{ color: "var(--red)" }}>
            {t("runDetail.logsFailedPrefix")} {error}
          </div>
        )}
        {!error && lines.length === 0 && !loading && (
          <div style={{ color: "var(--text-3)" }}>{t("runDetail.logsEmpty")}</div>
        )}
        {lines.map((line, i) => {
          let color = "var(--text-2)";
          if (line.includes("ERROR")) color = "var(--red)";
          else if (line.includes(" WARN ")) color = "var(--amber)";
          else if (line.includes("DEBUG")) color = "var(--text-3)";
          else if (line.includes("emit") || line.includes("run.end"))
            color = "var(--signal)";
          return (
            <div key={i} style={{ color }}>
              {line}
            </div>
          );
        })}
      </pre>
    </Panel>
  );
}

// ─── IO tab ──────────────────────────────────────────────────────────────────

function IOTab({
  run,
  agent,
  tenant,
}: {
  run: RunListRow;
  agent: AgentListRow | null;
  tenant: string;
}) {
  const { t } = useI18n();
  void agent;
  void tenant;
  const input = (run as { inputPayload?: unknown }).inputPayload;
  const output = (run as { outputPayload?: unknown }).outputPayload;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
      {/* INPUT — the real trigger-event payload that started the run */}
      <Panel
        title={t("runDetail.inputTitle")}
        subtitle={
          run.triggerEvent
            ? t("runDetail.inputSubtitle", {
                event: run.triggerEvent,
                subject: run.subject ?? "—",
              })
            : t("runDetail.inputNoTrigger")
        }
        padded
      >
        {input == null ? (
          <Empty title={t("runDetail.ioNoInput")} hint={t("runDetail.ioNoInputHint")} />
        ) : (
          <CodeBlock>{JSON.stringify(input, null, 2)}</CodeBlock>
        )}
      </Panel>

      {/* OUTPUT — the real emitted-event payload + run result summary */}
      <Panel
        title={t("runDetail.outputTitle")}
        subtitle={
          run.emittedEvent
            ? t("runDetail.outputSubtitle", { event: run.emittedEvent })
            : t("runDetail.outputNoEmit")
        }
        padded
      >
        <div
          style={{
            display: "flex",
            gap: 14,
            marginBottom: 10,
            fontSize: 11,
            fontFamily: "var(--mono)",
            color: "var(--text-3)",
          }}
        >
          <span>{t("runDetail.ioStatus")}: {run.status}</span>
          <span>{fmtDur(run.durationMs)}</span>
          {(run.tokensIn != null || run.tokensOut != null) && (
            <span>
              {(run.tokensIn ?? 0) + (run.tokensOut ?? 0)} tok
              {run.model ? ` · ${run.model}` : ""}
            </span>
          )}
        </div>
        {output == null ? (
          <Empty title={t("runDetail.ioNoOutput")} hint={t("runDetail.ioNoOutputHint")} />
        ) : (
          <CodeBlock>{JSON.stringify(output, null, 2)}</CodeBlock>
        )}
      </Panel>
    </div>
  );
}

// ─── Events tab ──────────────────────────────────────────────────────────────

function RunEventsTab({ run }: { run: RunListRow }) {
  const { t } = useI18n();
  const startedMs = run.startedAt ? Date.parse(run.startedAt) : Date.now();
  const endedMs = run.endedAt ? Date.parse(run.endedAt) : Date.now();
  const emittedEvent = (run as { emittedEvent?: string }).emittedEvent ?? null;
  const events: {
    name: string;
    kind: "trigger" | "emit";
    at: number;
    payload: unknown;
  }[] = [];
  if (run.triggerEvent)
    events.push({
      name: run.triggerEvent,
      kind: "trigger",
      at: startedMs,
      payload: (run as { inputPayload?: unknown }).inputPayload,
    });
  if (emittedEvent)
    events.push({
      name: emittedEvent,
      kind: "emit",
      at: endedMs,
      payload: (run as { outputPayload?: unknown }).outputPayload,
    });

  if (events.length === 0) {
    return <Empty title={t("runDetail.noEvents")} hint={t("runDetail.noEventsHint")} />;
  }
  return (
    <Panel title={t("runDetail.eventFlowTitle")} subtitle={t("runDetail.eventFlowSubtitle")} padded={false}>
      <div style={{ display: "flex", flexDirection: "column" }}>
        {events.map((e, i) => (
          <RunEventRow key={i} event={e} last={i === events.length - 1} />
        ))}
      </div>
    </Panel>
  );
}

/** One event (trigger / emitted) with an expandable real payload — Inngest-style. */
function RunEventRow({
  event,
  last,
}: {
  event: { name: string; kind: "trigger" | "emit"; at: number; payload: unknown };
  last: boolean;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(event.kind === "trigger");
  const hasPayload = event.payload != null;
  return (
    <div style={{ borderBottom: last ? "none" : "1px solid var(--border)" }}>
      <div
        onClick={() => hasPayload && setOpen((o) => !o)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "10px 14px",
          cursor: hasPayload ? "pointer" : "default",
        }}
      >
        <Icon
          name={open ? "chevron-down" : "chevron-right"}
          size={11}
          style={{ color: hasPayload ? "var(--text-3)" : "transparent" }}
        />
        <span
          style={{
            fontSize: 10,
            fontFamily: "var(--mono)",
            textTransform: "uppercase",
            letterSpacing: "0.06em",
            color: event.kind === "trigger" ? "var(--blue)" : "var(--green)",
            width: 64,
          }}
        >
          {event.kind === "trigger" ? t("runDetail.eventInbound") : t("runDetail.eventOutbound")}
        </span>
        <Badge tone={event.kind === "trigger" ? "blue" : "green"}>{event.name}</Badge>
        <span
          style={{
            marginLeft: "auto",
            fontSize: 11,
            color: "var(--text-3)",
            fontFamily: "var(--mono)",
          }}
        >
          {fmtTime(event.at)}
        </span>
      </div>
      {open && hasPayload && (
        <div style={{ padding: "0 14px 12px 36px" }}>
          <CodeBlock>{JSON.stringify(event.payload, null, 2)}</CodeBlock>
        </div>
      )}
    </div>
  );
}
