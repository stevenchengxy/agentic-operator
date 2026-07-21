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
import { useI18n, type Translate } from "@/app/portal/lib/preferences-context";
import {
  useOperatorCheck,
  useOperatorCheckHistory,
  useStartOperatorCheck,
} from "@/lib/hooks/useOperatorChecks";
import {
  OPERATOR_CHECK_SCENARIOS,
  isOperatorCheckTerminal,
  operatorCheckProgress,
} from "@/app/portal/components/operator-check/model";
import { formatApiError } from "@/lib/api-response";

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

function formatTime(
  value: Date | null | undefined,
  language: "en" | "zh",
): string {
  if (!value) return "—";
  return Number.isNaN(value.getTime())
    ? "—"
    : value.toLocaleString(language === "zh" ? "zh-CN" : "en-US");
}

function statusLabel(t: Translate, status: OperatorCheckStatus): string {
  return t(`systemCheck.status.${status}`);
}

function stageLabel(t: Translate, stage: OperatorCheckStage): string {
  if (stage.id === "complete" && !stage.scenario) {
    return t("systemCheck.phase.finish");
  }
  return t(`systemCheck.phase.${stage.phase}`);
}

function stageIdLabel(t: Translate, stageId: string): string {
  if (stageId === "complete") return t("systemCheck.phase.finish");
  const phase = stageId.slice(stageId.lastIndexOf(".") + 1);
  return t(`systemCheck.phase.${phase}`);
}

function scenarioTitle(
  t: Translate,
  id: (typeof OPERATOR_CHECK_SCENARIOS)[number]["id"],
): string {
  return t(`systemCheck.scenario.${id}.title`);
}

const ASSERTION_KEYS: Record<string, string> = {
  "Run output is available": "runOutput",
  "Output matches its schema": "outputSchema",
  "Request identity was preserved": "requestIdentity",
  "Support classification is deterministic": "supportClassification",
  "Local mock model answered": "mockAnswered",
  "Global context tool returned pong": "contextPong",
  "Runtime context is tenant-scoped": "tenantScoped",
  "Context starts clean": "contextClean",
  "Diagnostic timestamp is valid": "timestampValid",
  "Trace contains the complete sequence": "traceComplete",
  "Downstream event was safely suppressed": "eventSuppressed",
  "Run log contains expected evidence": "logEvidence",
  "Run log has no error-level entry": "noErrorLog",
  "Output file was saved": "outputSaved",
  "Run record was saved": "recordSaved",
  "Artifacts are non-empty": "artifactsNonEmpty",
  "Run completed successfully": "runCompleted",
  "Run is isolated test traffic": "isolatedTraffic",
  "Expected agent step executed": "stepExecuted",
  "Scenario completed": "scenarioCompleted",
};

function assertionName(t: Translate, value: string): string {
  const key = ASSERTION_KEYS[value];
  return key ? t(`systemCheck.assertion.${key}.name`) : value;
}

function assertionMessage(
  t: Translate,
  assertion: OperatorCheckAssertion,
): string {
  const key = ASSERTION_KEYS[assertion.name];
  if (key === "scenarioCompleted") return assertion.message;
  return key ? t(`systemCheck.assertion.${key}.message`) : assertion.message;
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
  const { t } = useI18n();
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <ViewHeader
        title={t("systemCheck.title")}
        subtitle={t("systemCheck.loadingSaved")}
      />
      <Empty title={t("systemCheck.loading")} />
    </div>
  );
}

function SystemCheckContent() {
  const { t, language } = useI18n();
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
    const currentStage = check.stages.find(
      (stage) => stage.id === check.currentStage,
    );
    return currentStage
      ? stageLabel(t, currentStage)
      : stageIdLabel(t, check.currentStage);
  }, [check, t]);

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
      {statusLabel(t, check.status)}
    </Badge>
  ) : (
    <Badge tone="muted">{t("systemCheck.status.ready")}</Badge>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <ViewHeader
        title={t("systemCheck.title")}
        subtitle={t("systemCheck.subtitle")}
        badge={headerBadge}
        action={
          <Button
            tone="primary"
            icon="play"
            disabled={startingOrActive}
            onClick={() => void runCheck()}
            ariaLabel={t("systemCheck.runAria")}
          >
            {start.isPending
              ? t("systemCheck.starting")
              : active
                ? t("systemCheck.running")
                : t("systemCheck.run")}
          </Button>
        }
      />

      <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: 20 }}>
        <section
          aria-label={t("systemCheck.whatItDoesAria")}
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
              {t("systemCheck.safeTitle")}
            </strong>
          </div>
          <div
            style={{ color: "var(--text-2)", fontSize: 11.5, lineHeight: 1.6 }}
          >
            {t("systemCheck.safeDescription")}
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
            {t("systemCheck.startFailed", {
              error: formatApiError(start.error, t),
            })}
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
                title={t("systemCheck.currentTitle")}
                subtitle={selectedCheckId ?? t("systemCheck.notStarted")}
                action={
                  check ? (
                    <Badge tone={statusTone(check.status)}>
                      <StatusDot status={STATUS_DOT[check.status]} size={6} />
                      {statusLabel(t, check.status)}
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
                    ? t("systemCheck.reliabilityCheck")
                    : t("systemCheck.readyTitle")}
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
                    {t("systemCheck.readyInstructions")}
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
                    {t("systemCheck.loadingCheck", { id: selectedCheckId })}
                  </div>
                ) : detail.isError ? (
                  <div
                    role="alert"
                    style={{ marginTop: 10, color: "var(--red)", fontSize: 12 }}
                  >
                    {t("systemCheck.detailUnavailable", {
                      error: formatApiError(detail.error, t),
                    })}
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
                            ? statusLabel(t, check.status)
                            : currentStageLabel
                              ? t("systemCheck.nowStage", {
                                  stage: currentStageLabel,
                                })
                              : statusLabel(t, check.status)}
                        </span>
                        <span className="mono">{progress}%</span>
                      </div>
                      <div
                        role="progressbar"
                        aria-label={t("systemCheck.progressAria")}
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
                      <span>
                        {t("systemCheck.started", {
                          time: formatTime(check.startedAt, language),
                        })}
                      </span>
                      <span>
                        {t("systemCheck.duration", {
                          duration: formatDuration(check.durationMs),
                        })}
                      </span>
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
                        {t("systemCheck.stoppedAt", {
                          stage:
                            currentStageLabel ??
                            t("systemCheck.verificationStage"),
                        })}
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
                {t("systemCheck.scenariosTitle")}
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
              title={t("systemCheck.sequenceTitle")}
              subtitle={t("systemCheck.autoUpdates")}
              padded={false}
            >
              <StageTimeline
                stages={check?.stages ?? []}
                loading={Boolean(selectedCheckId && !check && detail.isLoading)}
              />
            </Panel>
          </div>

          <aside
            aria-label={t("systemCheck.historyAria")}
            style={{ minWidth: 0 }}
          >
            <Panel
              title={t("systemCheck.historyTitle")}
              subtitle={t("systemCheck.latestCount", { count: 20 })}
              padded={false}
            >
              {history.isLoading ? (
                <Empty title={t("systemCheck.loadingHistory")} />
              ) : history.isError ? (
                <div
                  role="alert"
                  style={{ padding: 14, color: "var(--red)", fontSize: 11.5 }}
                >
                  {t("systemCheck.historyUnavailable", {
                    error: formatApiError(history.error, t),
                  })}
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
                        aria-label={t("systemCheck.viewHistoryAria", {
                          status: statusLabel(t, item.status),
                          time: formatTime(item.startedAt, language),
                        })}
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
                            {statusLabel(t, item.status)}
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
                          {item.currentStage
                            ? stageIdLabel(t, item.currentStage)
                            : t("systemCheck.reliabilityCheck")}
                        </span>
                        <span
                          className="mono"
                          style={{ color: "var(--text-3)", fontSize: 9.5 }}
                        >
                          {formatTime(item.startedAt, language)}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <Empty
                  title={t("systemCheck.noChecks")}
                  hint={t("systemCheck.noChecksHint")}
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
  const { t } = useI18n();
  const status = result?.status ?? (checkStatus ? "queued" : null);
  const evidenceRows = result
    ? [
        [t("systemCheck.evidence.agent"), result.agentId],
        [t("systemCheck.evidence.draft"), result.draftId],
        [t("systemCheck.evidence.deployment"), result.deploymentId],
        [t("systemCheck.evidence.workflowVersion"), result.workflowVersionId],
        [t("systemCheck.evidence.agentVersion"), result.agentVersionId],
        [t("systemCheck.evidence.triggerEvent"), result.eventId],
        [t("systemCheck.evidence.run"), result.runId],
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
            {scenarioTitle(t, definition.id)}
          </h3>
          {status ? (
            <Badge tone={statusTone(status)}>{statusLabel(t, status)}</Badge>
          ) : (
            <Badge tone="muted">{t("systemCheck.notStarted")}</Badge>
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
          {t(`systemCheck.scenario.${definition.id}.description`)}
        </div>
        <div
          style={{
            marginTop: 6,
            color: "var(--text-3)",
            fontSize: 10.5,
            lineHeight: 1.5,
          }}
        >
          {t(`systemCheck.scenario.${definition.id}.purpose`)}
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
            {t("systemCheck.scenarioSequence")}
          </div>
          <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
            {result?.stages.length ? (
              result.stages.map((stage) => (
                <Badge key={stage.id} tone={statusTone(stage.status)}>
                  {stageLabel(t, stage)}
                </Badge>
              ))
            ) : (
              <span style={{ color: "var(--text-3)", fontSize: 10.5 }}>
                {t("systemCheck.waitingBuild")}
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
            {t("systemCheck.assertionsTitle")}
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
              {t("systemCheck.assertionsPending")}
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
              {t("systemCheck.validatedOutput")}
            </summary>
            <pre
              aria-label={t("systemCheck.outputAria", {
                scenario: scenarioTitle(t, definition.id),
              })}
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
              {t("systemCheck.manifestEvidence")}
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
              {t("systemCheck.openFullRun")}
            </Button>
          </Link>
        )}
      </div>
    </article>
  );
}

function AssertionRow({ assertion }: { assertion: OperatorCheckAssertion }) {
  const { t } = useI18n();
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
            {assertionName(t, assertion.name)}
          </div>
          <div
            style={{
              marginTop: 2,
              color: assertion.passed ? "var(--text-2)" : "var(--red)",
              fontSize: 10.5,
              lineHeight: 1.45,
            }}
          >
            {assertionMessage(t, assertion)}
          </div>
        </div>
      </div>
      {hasComparison && (
        <details style={{ marginTop: 6 }}>
          <summary
            className="mono"
            style={{ cursor: "pointer", color: "var(--text-3)", fontSize: 9.5 }}
          >
            {t("systemCheck.expectedActual")}
          </summary>
          <div style={{ display: "grid", gap: 6, marginTop: 6 }}>
            {assertion.expected !== undefined && (
              <EvidenceValue
                label={t("systemCheck.expected")}
                value={assertion.expected}
              />
            )}
            {assertion.actual !== undefined && (
              <EvidenceValue
                label={t("systemCheck.actual")}
                value={assertion.actual}
              />
            )}
          </div>
        </details>
      )}
    </li>
  );
}

function EvidenceValue({ label, value }: { label: string; value: unknown }) {
  const { t } = useI18n();
  return (
    <div>
      <div className="mono" style={{ color: "var(--text-3)", fontSize: 9 }}>
        {label}
      </div>
      <pre
        aria-label={t("systemCheck.assertionValueAria", { label })}
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
  const { t } = useI18n();
  if (loading) return <Empty title={t("systemCheck.loadingSequence")} />;
  if (stages.length === 0)
    return (
      <Empty
        title={t("systemCheck.noSequence")}
        hint={t("systemCheck.noSequenceHint")}
      />
    );

  return (
    <ol
      aria-label={t("systemCheck.sequenceAria")}
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
                {stageLabel(t, stage)}
              </span>
              {stage.scenario && (
                <Badge tone="muted">{scenarioTitle(t, stage.scenario)}</Badge>
              )}
              <Badge tone={statusTone(stage.status)}>
                {statusLabel(t, stage.status)}
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
                  {t("systemCheck.technicalEvidence")}
                </summary>
                <pre
                  aria-label={t("systemCheck.technicalEvidenceAria", {
                    stage: stageLabel(t, stage),
                  })}
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
