"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import type {
  OperatorCheckAssertion,
  OperatorCheckScenarioResult,
  OperatorCheckStage,
  OperatorCheckStatus,
} from "@agentic/contracts";
import {
  Badge,
  Button,
  Empty,
  Icon,
  Panel,
  StatusDot,
  ViewHeader,
  type BadgeTone,
  type StatusName,
} from "@/app/portal/components";
import { useTenant } from "@/app/portal/lib/use-tenant";
import {
  useOperatorCheck,
  useOperatorCheckHistory,
  useStartOperatorCheck,
} from "@/lib/hooks/useOperatorChecks";
import {
  OPERATOR_CHECK_SCENARIOS,
  isOperatorCheckTerminal,
  operatorCheckProgress,
  operatorCheckStatusLabel,
} from "@/app/portal/components/operator-check/model";

const STATUS_DOT: Record<OperatorCheckStatus, StatusName> = {
  queued: "waiting",
  running: "running",
  passed: "ok",
  failed: "failed",
};

function statusTone(status: OperatorCheckStatus): BadgeTone {
  if (status === "passed") return "green";
  if (status === "failed") return "red";
  if (status === "running") return "signal";
  return "amber";
}

function formatTime(value: Date | null | undefined): string {
  if (!value) return "—";
  return Number.isNaN(value.getTime()) ? "—" : value.toLocaleString();
}

function formatDuration(value: number | null | undefined): string {
  if (value == null) return "—";
  if (value < 1_000) return `${value} ms`;
  if (value < 60_000) return `${(value / 1_000).toFixed(1)} s`;
  return `${Math.floor(value / 60_000)}m ${Math.round((value % 60_000) / 1_000)}s`;
}

function pretty(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export default function SystemCheckPage() {
  return (
    <Suspense fallback={<SystemCheckLoading />}>
      <SystemCheckContent />
    </Suspense>
  );
}

function SystemCheckLoading() {
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <ViewHeader
        title="Agent system check"
        subtitle="Loading saved reliability checks…"
      />
      <Empty title="Loading system check…" />
    </div>
  );
}

function SystemCheckContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const tenant = useTenant();
  const routeCheckId = searchParams.get("check");
  const [startedCheckId, setStartedCheckId] = useState<string | null>(null);
  const selectedCheckId = startedCheckId ?? routeCheckId;
  const start = useStartOperatorCheck();
  const detail = useOperatorCheck(selectedCheckId);
  const history = useOperatorCheckHistory({ limit: 20 });
  const startGuard = useRef(false);
  const resultHeading = useRef<HTMLHeadingElement | null>(null);
  const check = detail.data?.check ?? null;
  const active = Boolean(check && !isOperatorCheckTerminal(check.status));
  const startingOrActive = Boolean(
    start.isPending || active || (selectedCheckId && detail.isLoading),
  );
  const progress = check ? operatorCheckProgress(check) : 0;

  useEffect(() => {
    if (routeCheckId && routeCheckId === startedCheckId) {
      setStartedCheckId(null);
    }
  }, [routeCheckId, startedCheckId]);

  useEffect(() => {
    if (!selectedCheckId) return;
    resultHeading.current?.focus();
  }, [selectedCheckId]);

  const currentStageLabel = useMemo(() => {
    if (!check?.currentStage) return null;
    return (
      check.stages.find((stage) => stage.id === check.currentStage)?.label ??
      check.currentStage
    );
  }, [check]);

  async function runCheck() {
    if (startGuard.current || startingOrActive) return;
    startGuard.current = true;
    try {
      const result = await start.mutateAsync();
      setStartedCheckId(result.checkId);
      router.push(result.detailUrl as never);
    } catch {
      // The mutation's error is rendered as an accessible alert below.
    } finally {
      startGuard.current = false;
    }
  }

  function selectHistory(checkId: string) {
    setStartedCheckId(checkId);
    router.push(
      `/portal/${tenant}/system-check?check=${encodeURIComponent(checkId)}` as never,
    );
  }

  const headerBadge = check ? (
    <Badge tone={statusTone(check.status)}>
      {operatorCheckStatusLabel(check.status)}
    </Badge>
  ) : (
    <Badge tone="muted">Ready</Badge>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <ViewHeader
        title="Agent system check"
        subtitle="One click builds, publishes, deploys, runs, and verifies two different agents using the production operator."
        badge={headerBadge}
        action={
          <Button
            tone="primary"
            icon="play"
            disabled={startingOrActive}
            onClick={() => void runCheck()}
            ariaLabel="Run two-agent system check"
          >
            {start.isPending
              ? "Starting check…"
              : active
                ? "Check running…"
                : "Run two-agent check"}
          </Button>
        }
      />

      <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: 20 }}>
        <section
          aria-label="What this check does"
          style={{
            display: "grid",
            gap: 8,
            marginBottom: 16,
            padding: 14,
            border: "1px solid rgba(132,169,255,0.28)",
            borderRadius: 8,
            background: "rgba(132,169,255,0.06)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Icon name="check" size={14} style={{ color: "var(--blue)" }} />
            <strong style={{ color: "var(--text)", fontSize: 12.5 }}>
              A safe, visible production check
            </strong>
          </div>
          <div
            style={{ color: "var(--text-2)", fontSize: 11.5, lineHeight: 1.6 }}
          >
            The check creates or updates two reserved test agents, writes their
            manifests, publishes and deploys them, sends generated test events,
            and checks the resulting JSON, trace, logs, and artifacts. It does
            not turn on demo mode or replace your business agents. Test
            deployments, events, and runs remain in history as evidence.
          </div>
        </section>

        {start.isError && (
          <div
            role="alert"
            style={{
              marginBottom: 14,
              padding: 12,
              border: "1px solid rgba(255,100,112,0.35)",
              borderRadius: 6,
              color: "var(--red)",
              background: "rgba(255,100,112,0.07)",
              fontSize: 11.5,
            }}
          >
            Could not start the check: {start.error.message}
          </div>
        )}

        <div
          className="operator-check-main-grid"
          style={{ display: "grid", gap: 14, alignItems: "start" }}
        >
          <div style={{ display: "grid", gap: 14, minWidth: 0 }}>
            <section
              aria-labelledby="operator-check-result-title"
              aria-busy={active || detail.isLoading}
            >
              <Panel
                title="Current check"
                subtitle={selectedCheckId ?? "not started"}
                action={
                  check ? (
                    <Badge tone={statusTone(check.status)}>
                      <StatusDot status={STATUS_DOT[check.status]} size={6} />
                      {operatorCheckStatusLabel(check.status)}
                    </Badge>
                  ) : undefined
                }
              >
                <h2
                  id="operator-check-result-title"
                  ref={resultHeading}
                  tabIndex={-1}
                  style={{
                    margin: 0,
                    color: "var(--text)",
                    fontFamily: "var(--display)",
                    fontSize: 22,
                    fontWeight: 400,
                  }}
                >
                  {check
                    ? (check.summary ?? "Two-agent reliability check")
                    : "Ready to verify the agent operator"}
                </h2>

                {!selectedCheckId ? (
                  <div
                    style={{
                      marginTop: 8,
                      color: "var(--text-2)",
                      fontSize: 12,
                      lineHeight: 1.6,
                    }}
                  >
                    Select <strong>Run two-agent check</strong>. This screen
                    will update automatically as every build and run completes.
                  </div>
                ) : detail.isLoading && !check ? (
                  <div
                    role="status"
                    aria-live="polite"
                    style={{
                      marginTop: 10,
                      color: "var(--text-2)",
                      fontSize: 12,
                    }}
                  >
                    Loading check {selectedCheckId}…
                  </div>
                ) : detail.isError ? (
                  <div
                    role="alert"
                    style={{ marginTop: 10, color: "var(--red)", fontSize: 12 }}
                  >
                    Check details are unavailable: {detail.error.message}
                  </div>
                ) : check ? (
                  <div style={{ display: "grid", gap: 12, marginTop: 12 }}>
                    <div aria-live="polite" aria-atomic="true">
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          gap: 12,
                          color: "var(--text-2)",
                          fontSize: 11.5,
                        }}
                      >
                        <span>
                          {isOperatorCheckTerminal(check.status)
                            ? (check.summary ??
                              operatorCheckStatusLabel(check.status))
                            : currentStageLabel
                              ? `Now: ${currentStageLabel}`
                              : operatorCheckStatusLabel(check.status)}
                        </span>
                        <span className="mono">{progress}%</span>
                      </div>
                      <div
                        role="progressbar"
                        aria-label="Two-agent check progress"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={progress}
                        style={{
                          height: 7,
                          marginTop: 7,
                          overflow: "hidden",
                          borderRadius: 999,
                          background: "var(--panel-3)",
                        }}
                      >
                        <div
                          className="operator-check-progress-fill"
                          style={{
                            height: "100%",
                            width: `${progress}%`,
                            borderRadius: 999,
                            background:
                              check.status === "failed"
                                ? "var(--red)"
                                : check.status === "passed"
                                  ? "var(--green)"
                                  : "var(--signal)",
                            transition: "width 0.25s ease",
                          }}
                        />
                      </div>
                    </div>
                    <div
                      className="mono"
                      style={{
                        display: "flex",
                        gap: 14,
                        flexWrap: "wrap",
                        color: "var(--text-3)",
                        fontSize: 10,
                      }}
                    >
                      <span>Started {formatTime(check.startedAt)}</span>
                      <span>Duration {formatDuration(check.durationMs)}</span>
                      <span>{check.id}</span>
                    </div>
                    {check.status === "failed" && (
                      <div
                        role="alert"
                        style={{
                          padding: 10,
                          borderRadius: 5,
                          color: "var(--red)",
                          background: "rgba(255,100,112,0.07)",
                          border: "1px solid rgba(255,100,112,0.3)",
                          fontSize: 11.5,
                        }}
                      >
                        The check stopped at{" "}
                        {currentStageLabel ?? "a verification stage"}. Review
                        the failed step below, then run the check again after
                        correcting the issue.
                      </div>
                    )}
                  </div>
                ) : null}
              </Panel>
            </section>

            <section aria-labelledby="operator-check-scenarios-title">
              <h2
                id="operator-check-scenarios-title"
                style={{
                  margin: "0 0 9px",
                  color: "var(--text)",
                  fontSize: 14,
                  fontWeight: 600,
                }}
              >
                Two independent agent scenarios
              </h2>
              <div
                className="operator-check-scenario-grid"
                style={{ display: "grid", gap: 12 }}
              >
                {OPERATOR_CHECK_SCENARIOS.map((definition) => (
                  <ScenarioCard
                    key={definition.id}
                    definition={definition}
                    result={
                      check?.scenarios.find(
                        (scenario) => scenario.id === definition.id,
                      ) ?? null
                    }
                    checkStatus={check?.status ?? null}
                    tenant={tenant}
                  />
                ))}
              </div>
            </section>

            <Panel
              title="Build and run sequence"
              subtitle="updates automatically"
              padded={false}
            >
              <StageTimeline
                stages={check?.stages ?? []}
                loading={Boolean(selectedCheckId && !check && detail.isLoading)}
              />
            </Panel>
          </div>

          <aside aria-label="System check history" style={{ minWidth: 0 }}>
            <Panel title="Check history" subtitle="latest 20" padded={false}>
              {history.isLoading ? (
                <Empty title="Loading history…" />
              ) : history.isError ? (
                <div
                  role="alert"
                  style={{ padding: 14, color: "var(--red)", fontSize: 11.5 }}
                >
                  History unavailable: {history.error.message}
                </div>
              ) : history.data?.checks.length ? (
                <div style={{ display: "grid" }}>
                  {history.data.checks.map((item) => {
                    const selected = item.id === selectedCheckId;
                    return (
                      <button
                        type="button"
                        key={item.id}
                        onClick={() => selectHistory(item.id)}
                        aria-current={selected ? "true" : undefined}
                        aria-label={`View ${operatorCheckStatusLabel(item.status).toLowerCase()} check started ${formatTime(item.startedAt)}`}
                        style={{
                          display: "grid",
                          gap: 6,
                          width: "100%",
                          padding: "11px 12px",
                          textAlign: "left",
                          borderBottom: "1px solid var(--border)",
                          borderLeft: `2px solid ${selected ? "var(--signal)" : "transparent"}`,
                          background: selected
                            ? "rgba(208,255,0,0.045)"
                            : "transparent",
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 7,
                          }}
                        >
                          <StatusDot
                            status={STATUS_DOT[item.status]}
                            size={7}
                          />
                          <Badge tone={statusTone(item.status)}>
                            {operatorCheckStatusLabel(item.status)}
                          </Badge>
                          <span
                            className="mono"
                            style={{
                              marginLeft: "auto",
                              color: "var(--text-3)",
                              fontSize: 9.5,
                            }}
                          >
                            {formatDuration(item.durationMs)}
                          </span>
                        </div>
                        <span
                          style={{
                            color: "var(--text-2)",
                            fontSize: 10.5,
                            lineHeight: 1.45,
                          }}
                        >
                          {item.summary ??
                            item.currentStage ??
                            "Two-agent reliability check"}
                        </span>
                        <span
                          className="mono"
                          style={{ color: "var(--text-3)", fontSize: 9.5 }}
                        >
                          {formatTime(item.startedAt)}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <Empty
                  title="No checks yet"
                  hint="Your first completed check will be saved here."
                />
              )}
            </Panel>
          </aside>
        </div>
      </div>
    </div>
  );
}

function ScenarioCard({
  definition,
  result,
  checkStatus,
  tenant,
}: {
  definition: (typeof OPERATOR_CHECK_SCENARIOS)[number];
  result: OperatorCheckScenarioResult | null;
  checkStatus: OperatorCheckStatus | null;
  tenant: string;
}) {
  const status = result?.status ?? (checkStatus ? "queued" : null);
  const evidenceRows = result
    ? [
        ["Agent", result.agentId],
        ["Draft", result.draftId],
        ["Deployment", result.deploymentId],
        ["Workflow version", result.workflowVersionId],
        ["Agent version", result.agentVersionId],
        ["Trigger event", result.eventId],
        ["Run", result.runId],
      ].filter((row): row is [string, string] => Boolean(row[1]))
    : [];

  return (
    <article
      style={{
        minWidth: 0,
        overflow: "hidden",
        border: "1px solid var(--border)",
        borderRadius: 8,
        background: "var(--panel)",
      }}
    >
      <header
        style={{
          padding: 13,
          borderBottom: "1px solid var(--border)",
          background: "var(--panel-2)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Icon
            name={definition.id === "support-triage" ? "task" : "code"}
            size={13}
            style={{ color: "var(--signal)" }}
          />
          <h3
            style={{
              margin: 0,
              minWidth: 0,
              flex: 1,
              color: "var(--text)",
              fontSize: 13,
              fontWeight: 600,
            }}
          >
            {result?.title ?? definition.title}
          </h3>
          {status ? (
            <Badge tone={statusTone(status)}>
              {operatorCheckStatusLabel(status)}
            </Badge>
          ) : (
            <Badge tone="muted">Not started</Badge>
          )}
        </div>
        <div
          style={{
            marginTop: 7,
            color: "var(--text-2)",
            fontSize: 11,
            lineHeight: 1.55,
          }}
        >
          {result?.description ?? definition.description}
        </div>
        <div
          style={{
            marginTop: 6,
            color: "var(--text-3)",
            fontSize: 10.5,
            lineHeight: 1.5,
          }}
        >
          {definition.purpose}
        </div>
      </header>

      <div style={{ display: "grid", gap: 12, padding: 13 }}>
        <div>
          <div
            className="mono"
            style={{
              marginBottom: 6,
              color: "var(--text-3)",
              fontSize: 9.5,
              textTransform: "uppercase",
              letterSpacing: "0.08em",
            }}
          >
            Scenario sequence
          </div>
          <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
            {result?.stages.length ? (
              result.stages.map((stage) => (
                <Badge key={stage.id} tone={statusTone(stage.status)}>
                  {stage.label}
                </Badge>
              ))
            ) : (
              <span style={{ color: "var(--text-3)", fontSize: 10.5 }}>
                Waiting to build this agent.
              </span>
            )}
          </div>
        </div>

        <div>
          <div
            className="mono"
            style={{
              marginBottom: 6,
              color: "var(--text-3)",
              fontSize: 9.5,
              textTransform: "uppercase",
              letterSpacing: "0.08em",
            }}
          >
            Verification assertions
          </div>
          {result?.assertions.length ? (
            <ul
              style={{
                display: "grid",
                gap: 6,
                margin: 0,
                padding: 0,
                listStyle: "none",
              }}
            >
              {result.assertions.map((assertion, index) => (
                <AssertionRow
                  key={`${assertion.name}-${index}`}
                  assertion={assertion}
                />
              ))}
            </ul>
          ) : (
            <div style={{ color: "var(--text-3)", fontSize: 10.5 }}>
              Assertions will appear after the run produces evidence.
            </div>
          )}
        </div>

        {result?.output != null && (
          <details>
            <summary
              className="mono"
              style={{
                cursor: "pointer",
                color: "var(--text-2)",
                fontSize: 10.5,
              }}
            >
              Validated output JSON
            </summary>
            <pre
              aria-label={`${definition.title} output JSON`}
              style={{
                maxHeight: 260,
                margin: "8px 0 0",
                padding: 10,
                overflow: "auto",
                border: "1px solid var(--border)",
                borderRadius: 5,
                color: "var(--text-2)",
                background: "var(--bg-2)",
                fontFamily: "var(--mono)",
                fontSize: 10,
                lineHeight: 1.55,
              }}
            >
              {pretty(result.output)}
            </pre>
          </details>
        )}

        {evidenceRows.length > 0 && (
          <details>
            <summary
              className="mono"
              style={{
                cursor: "pointer",
                color: "var(--text-2)",
                fontSize: 10.5,
              }}
            >
              Manifest, deployment, and run evidence
            </summary>
            <dl style={{ display: "grid", gap: 6, margin: "9px 0 0" }}>
              {evidenceRows.map(([label, value]) => (
                <div
                  key={label}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "105px minmax(0, 1fr)",
                    gap: 8,
                  }}
                >
                  <dt style={{ color: "var(--text-3)", fontSize: 10 }}>
                    {label}
                  </dt>
                  <dd
                    className="mono"
                    style={{
                      minWidth: 0,
                      margin: 0,
                      overflowWrap: "anywhere",
                      color: "var(--text-2)",
                      fontSize: 10,
                    }}
                  >
                    {value}
                  </dd>
                </div>
              ))}
            </dl>
          </details>
        )}

        {result?.runId && (
          <Link
            href={
              `/portal/${tenant}/runs/${encodeURIComponent(result.runId)}` as never
            }
            style={{ justifySelf: "start" }}
          >
            <Button small icon="external" tone="ghost">
              Open full run, trace, and logs
            </Button>
          </Link>
        )}
      </div>
    </article>
  );
}

function AssertionRow({ assertion }: { assertion: OperatorCheckAssertion }) {
  const hasComparison =
    assertion.expected !== undefined || assertion.actual !== undefined;
  return (
    <li
      style={{
        padding: 8,
        border: "1px solid var(--border)",
        borderRadius: 5,
        background: "var(--panel-2)",
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 7 }}>
        <Icon
          name={assertion.passed ? "check" : "x"}
          size={12}
          style={{
            marginTop: 1,
            flexShrink: 0,
            color: assertion.passed ? "var(--green)" : "var(--red)",
          }}
        />
        <div style={{ minWidth: 0 }}>
          <div
            style={{ color: "var(--text)", fontSize: 10.5, fontWeight: 600 }}
          >
            {assertion.name}
          </div>
          <div
            style={{
              marginTop: 2,
              color: assertion.passed ? "var(--text-2)" : "var(--red)",
              fontSize: 10.5,
              lineHeight: 1.45,
            }}
          >
            {assertion.message}
          </div>
        </div>
      </div>
      {hasComparison && (
        <details style={{ marginTop: 6 }}>
          <summary
            className="mono"
            style={{ cursor: "pointer", color: "var(--text-3)", fontSize: 9.5 }}
          >
            Expected and actual values
          </summary>
          <div style={{ display: "grid", gap: 6, marginTop: 6 }}>
            {assertion.expected !== undefined && (
              <EvidenceValue label="Expected" value={assertion.expected} />
            )}
            {assertion.actual !== undefined && (
              <EvidenceValue label="Actual" value={assertion.actual} />
            )}
          </div>
        </details>
      )}
    </li>
  );
}

function EvidenceValue({ label, value }: { label: string; value: unknown }) {
  return (
    <div>
      <div className="mono" style={{ color: "var(--text-3)", fontSize: 9 }}>
        {label}
      </div>
      <pre
        aria-label={`${label} assertion value`}
        style={{
          maxHeight: 160,
          margin: "3px 0 0",
          padding: 7,
          overflow: "auto",
          borderRadius: 4,
          color: "var(--text-2)",
          background: "var(--bg-2)",
          fontFamily: "var(--mono)",
          fontSize: 9.5,
          lineHeight: 1.5,
        }}
      >
        {pretty(value)}
      </pre>
    </div>
  );
}

function StageTimeline({
  stages,
  loading,
}: {
  stages: OperatorCheckStage[];
  loading: boolean;
}) {
  if (loading) return <Empty title="Loading build sequence…" />;
  if (stages.length === 0)
    return (
      <Empty
        title="No sequence yet"
        hint="Start the check to watch every build and run step here."
      />
    );

  return (
    <ol
      aria-label="Agent check build and run stages"
      style={{ margin: 0, padding: 0, listStyle: "none" }}
    >
      {stages.map((stage, index) => (
        <li
          key={stage.id}
          style={{
            display: "grid",
            gridTemplateColumns: "28px minmax(0, 1fr) auto",
            gap: 9,
            padding: "10px 12px",
            borderBottom:
              index < stages.length - 1 ? "1px solid var(--border)" : "none",
          }}
        >
          <div
            className="mono"
            style={{ color: "var(--text-3)", fontSize: 9.5 }}
          >
            {String(index + 1).padStart(2, "0")}
          </div>
          <div style={{ minWidth: 0 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 7,
                flexWrap: "wrap",
              }}
            >
              <StatusDot status={STATUS_DOT[stage.status]} size={7} />
              <span
                style={{
                  color: "var(--text)",
                  fontSize: 11.5,
                  fontWeight: 500,
                }}
              >
                {stage.label}
              </span>
              {stage.scenario && <Badge tone="muted">{stage.scenario}</Badge>}
              <Badge tone={statusTone(stage.status)}>
                {operatorCheckStatusLabel(stage.status)}
              </Badge>
            </div>
            {stage.message && (
              <div
                style={{
                  marginTop: 5,
                  color:
                    stage.status === "failed" ? "var(--red)" : "var(--text-2)",
                  fontSize: 10.5,
                  lineHeight: 1.5,
                }}
              >
                {stage.message}
              </div>
            )}
            {stage.details && Object.keys(stage.details).length > 0 && (
              <details style={{ marginTop: 5 }}>
                <summary
                  className="mono"
                  style={{
                    cursor: "pointer",
                    color: "var(--text-3)",
                    fontSize: 9.5,
                  }}
                >
                  Technical evidence
                </summary>
                <pre
                  aria-label={`${stage.label} technical evidence`}
                  style={{
                    maxHeight: 220,
                    margin: "6px 0 0",
                    padding: 8,
                    overflow: "auto",
                    borderRadius: 4,
                    color: "var(--text-2)",
                    background: "var(--bg-2)",
                    fontFamily: "var(--mono)",
                    fontSize: 9.5,
                    lineHeight: 1.5,
                  }}
                >
                  {pretty(stage.details)}
                </pre>
              </details>
            )}
          </div>
          <span
            className="mono"
            style={{ color: "var(--text-3)", fontSize: 9.5 }}
          >
            {formatDuration(stage.durationMs)}
          </span>
        </li>
      ))}
    </ol>
  );
}
