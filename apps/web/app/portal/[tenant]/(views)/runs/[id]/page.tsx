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
import {
  useRun,
  useReplayRun,
  useCancelRun,
  useRunArtifacts,
  type RunListRow,
  type StepRow,
} from "@/lib/hooks/useRuns";
import { useAgents, useAgent, type AgentListRow } from "@/lib/hooks/useAgents";
// AgentCodeTab is owned by the heavy-views engineer (P2-FE-08/09). Imported
// directly here to satisfy delta D-7 (Runs detail "agent" tab).
import { AgentCodeTab } from "@/app/portal/components/agent-code/AgentCodeTab";
import { TraceTree } from "@/app/portal/components/runs/TraceTree";
import { tenantHeader } from "@/lib/hooks/tenant-header";

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

type Tab =
  | "timeline"
  | "trace"
  | "logs"
  | "io"
  | "artifacts"
  | "events"
  | "agent";

export default function RunDetailPage() {
  const params = useParams<{ id?: string }>();
  const runId = params?.id ?? null;
  const tenant = useTenant();
  const { data, isLoading } = useRun(runId);
  const [tab, setTab] = useState<Tab>("timeline");

  if (!runId) return <Empty title="No run id" />;
  if (isLoading || !data) return <Empty title="Loading run…" hint={runId} />;

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
  const { data: artifacts = [] } = useRunArtifacts(run.id);
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
      if ("runId" in data) {
        toast({
          tone: "signal",
          title: "Replay started",
          description: `Opening the new run ${data.runId}.`,
        });
        router.push(
          `/portal/${tenant}/runs/${encodeURIComponent(data.runId)}` as never,
        );
        return;
      }
      toast({
        tone: "signal",
        title: "Replay queued",
        description: `Event ${data.new_event_id} dispatched. Watching for the new run…`,
      });
      // Send the user back to the runs list where the new run will appear at
      // the top with a REPLAY badge.
      router.push(`/portal/${tenant}/runs` as never);
    } catch (err) {
      toast({
        tone: "red",
        title: "Replay failed",
        description: err instanceof Error ? err.message : "Unknown error",
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
          title: "Run cancelled",
          description: data.note,
        });
      } else {
        // Server-side idempotent no-op (run was already terminal). Treat
        // as success, not error — the operator's intent ("stop this run")
        // is already satisfied.
        toast({
          tone: "default",
          title: "Already finished",
          description: data.note,
        });
      }
    } catch (err) {
      toast({
        tone: "red",
        title: "Cancel failed",
        description: err instanceof Error ? err.message : "Unknown error",
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
          <StatusDot status={STATUS_TO_DOT[run.status] ?? "idle"} size={9} />
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
          {run.triggerEvent && <Badge tone="muted">↑ {run.triggerEvent}</Badge>}
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
                    ? "Click again within 3s to cancel this run"
                    : "Stop this in-flight run"
                }
                ariaLabel={confirmStop ? "Confirm stop run" : "Stop run"}
              >
                {cancel.isPending
                  ? "Stopping…"
                  : confirmStop
                    ? "Confirm stop"
                    : "Stop"}
              </Button>
            )}
            <Button
              small
              icon="replay"
              onClick={handleReplay}
              disabled={replay.isPending}
              title="Re-emit this run's trigger event"
            >
              {replay.isPending ? "Replaying…" : "Replay"}
            </Button>
            {agentRow && (
              <Link
                href={`/portal/${tenant}/agents/${agentRow.kebabId}` as never}
                style={{ textDecoration: "none" }}
              >
                <Button small icon="agent" tone="ghost">
                  Open agent
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
          label="Started"
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
          label="Duration"
          value={fmtDur(run.durationMs)}
          accent={run.status === "running" ? "var(--signal)" : undefined}
        />
        <StatCell
          label="Steps"
          value={steps.length > 0 ? String(steps.length) : "—"}
        />
        <StatCell
          label="Tokens in/out"
          value={`${fmtNum(run.tokensIn ?? 0)} · ${fmtNum(run.tokensOut ?? 0)}`}
        />
        <StatCell label="Subject" value={run.subject ?? "—"} mono />
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
        {(
          [
            "timeline",
            "trace",
            "logs",
            "io",
            "artifacts",
            "events",
            "agent",
          ] as const
        ).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              padding: "8px 14px",
              fontSize: 12,
              fontFamily: "var(--mono)",
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              color: tab === t ? "var(--text)" : "var(--text-3)",
              borderBottom: `2px solid ${tab === t ? "var(--signal)" : "transparent"}`,
              marginBottom: -1,
            }}
          >
            {t}
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
            <Empty title="Loading agent…" hint={agentRow?.kebabId ?? ""} />
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
              title="Agent not found"
              hint={`agentName=${run.agentName}`}
            />
          )}
        </div>
      )}

      {tab === "timeline" && <TimelineTab steps={steps} run={run} />}
      {tab === "trace" && (
        <Panel
          title="Trace tree"
          subtitle="Nested LLM calls, tool calls, and subflow runs"
          padded={false}
        >
          <div style={{ padding: "8px 12px" }}>
            <TraceTree node={{ run, steps }} tenant={tenant} />
          </div>
        </Panel>
      )}
      {tab === "logs" && <LogsTab runId={run.id} tenant={tenant} />}
      {tab === "io" && <IOTab run={run} agent={agentRow} tenant={tenant} />}
      {tab === "artifacts" && (
        <ArtifactsTab runId={run.id} artifacts={artifacts} />
      )}
      {tab === "events" && <RunEventsTab run={run} />}

      {/* Failed-run error panel (any tab except agent) */}
      {!isAgentTab && run.status === "failed" && (
        <Panel
          title="Error"
          style={{ borderColor: "rgba(255,100,112,0.3)" }}
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
            {(run as { error?: string }).error ??
              "Run failed — see logs tab for stack trace."}
          </div>
          <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
            <Button icon="replay" small>
              Retry
            </Button>
            <Button icon="external" small tone="ghost">
              View error trace
            </Button>
          </div>
        </Panel>
      )}
    </div>
  );
}

function ArtifactsTab({
  runId,
  artifacts,
}: {
  runId: string;
  artifacts: Array<{
    id: string;
    kind: string;
    size: number;
    createdAt: string;
    downloadPath: string;
  }>;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [content, setContent] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const selected = artifacts.find(
    (artifact) => artifact.id === (selectedId ?? artifacts[0]?.id),
  );

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    setError(null);
    setContent("");
    void fetch(selected.downloadPath, {
      credentials: "same-origin",
      headers: { Accept: "application/json", ...tenantHeader() },
    })
      .then(async (response) => {
        if (!response.ok)
          throw new Error(`artifact request failed (${response.status})`);
        return response.text();
      })
      .then((text) => {
        if (!cancelled) setContent(text);
      })
      .catch((err) => {
        if (!cancelled)
          setError(
            err instanceof Error ? err.message : "Could not load artifact",
          );
      });
    return () => {
      cancelled = true;
    };
  }, [selected?.id, selected?.downloadPath]);

  if (artifacts.length === 0) {
    return (
      <Empty
        title="No JSON artifacts yet"
        hint={`Run ${runId} has not produced a persisted output file.`}
      />
    );
  }
  return (
    <Panel
      title="Persisted run artifacts"
      subtitle="Local JSON output captured by the runtime"
      padded={false}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "220px 1fr",
          minHeight: 340,
        }}
      >
        <div style={{ borderRight: "1px solid var(--border)", padding: 10 }}>
          {artifacts.map((artifact) => (
            <button
              key={artifact.id}
              onClick={() => setSelectedId(artifact.id)}
              style={{
                display: "block",
                width: "100%",
                textAlign: "left",
                padding: "9px 10px",
                borderRadius: 4,
                background:
                  selected?.id === artifact.id
                    ? "var(--panel-3)"
                    : "transparent",
                color: "var(--text)",
              }}
            >
              <div className="mono" style={{ fontSize: 11 }}>
                {artifact.kind}
              </div>
              <div
                style={{ marginTop: 3, fontSize: 10.5, color: "var(--text-3)" }}
              >
                {Math.round((artifact.size / 1024) * 10) / 10} KB
              </div>
            </button>
          ))}
        </div>
        <div style={{ padding: 14, overflow: "auto" }}>
          {error && <div style={{ color: "var(--red)" }}>{error}</div>}
          {!error && !content && (
            <div style={{ color: "var(--text-3)" }}>Loading JSON…</div>
          )}
          {content && <CodeBlock>{content}</CodeBlock>}
        </div>
      </div>
    </Panel>
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
  if (steps.length === 0) {
    return (
      <Empty
        title="No steps recorded"
        hint="Manual / human task — see Events tab"
      />
    );
  }
  const startedMs = run.startedAt ? Date.parse(run.startedAt) : Date.now();
  const total = run.durationMs ?? Date.now() - startedMs;
  return (
    <Panel title="Step timeline" padded={false}>
      <div style={{ padding: 16 }}>
        {steps.map((s, i) => {
          const stepStartedMs = s.startedAt
            ? Date.parse(s.startedAt)
            : startedMs;
          const startPct =
            total > 0 ? ((stepStartedMs - startedMs) / total) * 100 : 0;
          const durPct =
            total > 0
              ? ((s.durationMs ?? total - (stepStartedMs - startedMs)) /
                  total) *
                100
              : 1;
          return (
            <div
              key={`${s.id}-${i}`}
              style={{
                display: "grid",
                gridTemplateColumns: "26px 220px 1fr 80px",
                gap: 12,
                alignItems: "center",
                padding: "8px 0",
                borderBottom:
                  i < steps.length - 1 ? "1px solid var(--border)" : "none",
              }}
            >
              <div style={{ display: "flex", justifyContent: "center" }}>
                <StatusDot status={STATUS_TO_DOT[s.status] ?? "idle"} />
              </div>
              <div>
                <div
                  className="mono"
                  style={{ fontSize: 12, color: "var(--text)" }}
                >
                  {s.name}
                </div>
                <div style={{ fontSize: 10.5, color: "var(--text-3)" }}>
                  step {i + 1}
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
                    background:
                      s.status === "failed"
                        ? "var(--red)"
                        : s.status === "running"
                          ? "var(--signal)"
                          : "var(--green)",
                    opacity: s.status === "running" ? 0.85 : 0.45,
                    borderLeft: `2px solid ${
                      s.status === "failed"
                        ? "var(--red)"
                        : s.status === "running"
                          ? "var(--signal)"
                          : "var(--green)"
                    }`,
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
                  color:
                    s.status === "running" ? "var(--signal)" : "var(--text-2)",
                  textAlign: "right",
                }}
              >
                {fmtDur(s.durationMs)}
              </div>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

// ─── Logs tab ────────────────────────────────────────────────────────────────

function LogsTab({ runId, tenant }: { runId: string; tenant: string }) {
  // Real per-run log content via `/v1/runs/:runId/logs`. Previously this
  // rendered a RAAS-specific sample log (matchResume/CAN-88412) regardless
  // of which run the user opened.
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
        if (!res.ok)
          throw new Error(`/v1/runs/${runId}/logs: HTTP ${res.status}`);
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
            else if (currentEvent === "info")
              out.push(`# ${raw.slice(5).trim()}`);
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
      subtitle={loading ? "loading…" : error ? "error" : "file-backed"}
      padded={false}
      action={
        <Button small icon="external" tone="ghost">
          Open file
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
            Failed to load logs: {error}
          </div>
        )}
        {!error && lines.length === 0 && !loading && (
          <div style={{ color: "var(--text-3)" }}>
            (no log lines recorded for this run)
          </div>
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
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gap: 12,
      }}
    >
      <Panel title="Input" padded>
        <CodeBlock>
          {JSON.stringify(
            {
              event: run.triggerEvent,
              subject: run.subject,
              context: {
                // Reconstruct the trigger envelope from real run fields —
                // tenant comes from the URL, agent + correlation from the
                // run row. Previously this hardcoded "raas" and a fixed
                // "raas@2026.05.16-a" version that misrepresented runs
                // from every other tenant.
                tenant,
                agent: agent?.name ?? run.agentName,
                correlation_id: run.correlationId ?? null,
              },
              payload: {
                run_id: run.id,
                subject: run.subject,
              },
            },
            null,
            2,
          )}
        </CodeBlock>
      </Panel>
      <Panel title="Output" padded>
        <CodeBlock>
          {JSON.stringify(
            {
              status: run.status,
              duration_ms: run.durationMs,
              tokens: {
                in: run.tokensIn,
                out: run.tokensOut,
                model: run.model,
              },
            },
            null,
            2,
          )}
        </CodeBlock>
      </Panel>
    </div>
  );
}

// ─── Events tab ──────────────────────────────────────────────────────────────

function RunEventsTab({ run }: { run: RunListRow }) {
  const startedMs = run.startedAt ? Date.parse(run.startedAt) : Date.now();
  const endedMs = run.endedAt ? Date.parse(run.endedAt) : Date.now();
  const emittedEvent = (run as { emittedEvent?: string }).emittedEvent ?? null;
  const events: { name: string; kind: "trigger" | "emit"; at: number }[] = [];
  if (run.triggerEvent)
    events.push({ name: run.triggerEvent, kind: "trigger", at: startedMs });
  if (emittedEvent)
    events.push({ name: emittedEvent, kind: "emit", at: endedMs });

  return (
    <Panel title="Event flow for this run" padded>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {events.length === 0 && (
          <Empty title="No events" hint="No trigger or emit recorded" />
        )}
        {events.map((e, i) => (
          <div
            key={i}
            style={{ display: "flex", alignItems: "center", gap: 10 }}
          >
            <span
              style={{
                fontSize: 11,
                fontFamily: "var(--mono)",
                color: "var(--text-3)",
                width: 60,
              }}
            >
              {e.kind}
            </span>
            <Icon
              name="chevron-right"
              size={12}
              style={{ color: "var(--text-3)" }}
            />
            <Badge tone={e.kind === "trigger" ? "blue" : "green"}>
              {e.name}
            </Badge>
            <span
              style={{
                marginLeft: "auto",
                fontSize: 11,
                color: "var(--text-3)",
                fontFamily: "var(--mono)",
              }}
            >
              {fmtTime(e.at)}
            </span>
          </div>
        ))}
      </div>
    </Panel>
  );
}
