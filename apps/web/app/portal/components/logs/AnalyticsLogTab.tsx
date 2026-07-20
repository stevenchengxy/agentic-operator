"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Badge,
  Empty,
  FilterChip,
  Panel,
  StatusDot,
  type StatusName,
} from "@/app/portal/components";
import { useI18n } from "@/app/portal/lib/preferences-context";
import { useTenant } from "@/app/portal/lib/use-tenant";
import { fmtDur, fmtNum } from "@/app/portal/lib/format";
import {
  HorizontalBarChart,
  LineChart,
} from "@/app/portal/components/usage/charts";
import { useEvents } from "@/lib/hooks/useEvents";
import { useObservabilitySummary } from "@/lib/hooks/useObservability";
import { useRuns } from "@/lib/hooks/useRuns";
import {
  LogPane,
  MetaPill,
  TimeCell,
  monoStyle,
  tdStyle,
  thStyle,
} from "./shared";
import { runStartedMs } from "./observability";

type AnalyticsWindow = "24h" | "7d" | "30d";
type TrendMetric = "runs" | "failures";

const WINDOWS: Array<{ id: AnalyticsWindow; ms: number; bucketMs: number }> = [
  { id: "24h", ms: 24 * 60 * 60 * 1000, bucketMs: 60 * 60 * 1000 },
  { id: "7d", ms: 7 * 24 * 60 * 60 * 1000, bucketMs: 24 * 60 * 60 * 1000 },
  { id: "30d", ms: 30 * 24 * 60 * 60 * 1000, bucketMs: 24 * 60 * 60 * 1000 },
];

const STATUS_SET = new Set<StatusName>([
  "running",
  "ok",
  "failed",
  "waiting",
  "cancelled",
  "paused",
  "idle",
]);

function statusName(status: string): StatusName {
  if (status === "queued") return "waiting";
  return STATUS_SET.has(status as StatusName) ? (status as StatusName) : "idle";
}

export function AnalyticsLogTab() {
  const { t } = useI18n();
  const tenant = useTenant();
  const router = useRouter();
  const [windowId, setWindowId] = useState<AnalyticsWindow>("7d");
  const [metric, setMetric] = useState<TrendMetric>("runs");
  const windowDef = WINDOWS.find((item) => item.id === windowId) ?? WINDOWS[1]!;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, [windowId]);
  const since = now - windowDef.ms;
  const observability = useObservabilitySummary({
    since,
    until: now,
    bucketMs: windowDef.bucketMs,
  });
  const runsQuery = useRuns({ limit: 500 });
  const eventsQuery = useEvents({ limit: 500 });
  const runs = useMemo(
    () => (runsQuery.data ?? []).filter((run) => runStartedMs(run) >= since),
    [runsQuery.data, since],
  );
  const events = useMemo(
    () =>
      (eventsQuery.data ?? []).filter((event) => {
        const at = event.receivedAt ? Date.parse(event.receivedAt) : 0;
        return Number.isFinite(at) && at >= since;
      }),
    [eventsQuery.data, since],
  );
  const series = useMemo(() => {
    if (!observability.data) return [];
    const hourly = windowDef.bucketMs < 24 * 60 * 60 * 1000;
    return observability.data.timeSeries.map((bucket) => {
      // Daily buckets are rolling 24-hour windows. Label them by their end
      // date so the live/current bucket reads as today instead of yesterday.
      const date = new Date(
        hourly ? bucket.start : Math.max(bucket.start, bucket.end - 1),
      );
      return {
        at: bucket.start,
        label: hourly
          ? `${String(date.getHours()).padStart(2, "0")}:00`
          : `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`,
        runs: bucket.runs,
        failures: bucket.errors,
      };
    });
  }, [observability.data, windowDef.bucketMs]);
  const statusBars = useMemo(() => {
    return (observability.data?.byStatus ?? [])
      .map((row) => ({ key: row.status, value: row.runs }))
      .filter((row) => row.value > 0)
      .sort((a, b) => b.value - a.value);
  }, [observability.data]);
  const eventBars = useMemo(() => {
    const counts = new Map<string, number>();
    for (const event of events)
      counts.set(event.name, (counts.get(event.name) ?? 0) + 1);
    return Array.from(counts, ([key, value]) => ({ key, value })).sort(
      (a, b) => b.value - a.value,
    );
  }, [events]);
  const latencyBars = useMemo(
    () =>
      (observability.data?.byAgent ?? [])
        .flatMap((row) =>
          row.p95DurationMs == null
            ? []
            : [
                {
                  key: row.agentTitle || row.agentName,
                  value: row.p95DurationMs,
                },
              ],
        )
        .sort((a, b) => b.value - a.value),
    [observability.data],
  );
  const attention = useMemo(() => {
    const slowThreshold = observability.data?.latency.p95Ms ?? null;
    return runs
      .filter(
        (run) =>
          run.status === "failed" ||
          (slowThreshold != null &&
            slowThreshold > 0 &&
            (run.durationMs ?? 0) >= slowThreshold),
      )
      .sort((a, b) => {
        const severity =
          Number(b.status === "failed") - Number(a.status === "failed");
        return severity || runStartedMs(b) - runStartedMs(a);
      })
      .slice(0, 30);
  }, [observability.data?.latency.p95Ms, runs]);

  if (observability.isLoading && !observability.data) {
    return (
      <LogPane>
        <Empty
          title={t("logsExplorer.loading")}
          hint={t("logsExplorer.analyticsLoadingHint")}
        />
      </LogPane>
    );
  }
  if (observability.isError && !observability.data) {
    return (
      <LogPane>
        <Empty
          title={t("logsExplorer.analyticsLoadFailed")}
          hint={observability.error?.message ?? ""}
        />
      </LogPane>
    );
  }

  const partialError = runsQuery.isError || eventsQuery.isError;
  const summary = observability.data;
  if (!summary) return null;
  const metrics = {
    runs: summary.totals.runs,
    successRate: summary.rates.success * 100,
    errorRate: summary.rates.error * 100,
    p95DurationMs: summary.latency.p95Ms,
    active: summary.totals.active,
    events: summary.totals.events,
    testRuns: summary.totals.testRuns,
  };

  return (
    <LogPane
      toolbar={
        <>
          <div style={{ display: "flex", gap: 6 }}>
            {WINDOWS.map((item) => (
              <FilterChip
                key={item.id}
                active={windowId === item.id}
                onClick={() => setWindowId(item.id)}
              >
                {item.id}
              </FilterChip>
            ))}
          </div>
          <div style={{ width: 1, height: 18, background: "var(--border)" }} />
          <div style={{ display: "flex", gap: 6 }}>
            <FilterChip
              active={metric === "runs"}
              onClick={() => setMetric("runs")}
            >
              {t("logsExplorer.metricRuns")}
            </FilterChip>
            <FilterChip
              active={metric === "failures"}
              onClick={() => setMetric("failures")}
            >
              {t("logsExplorer.metricFailures")}
            </FilterChip>
          </div>
          <MetaPill>
            {t("logsExplorer.analyticsCoverage", {
              runs: metrics.runs,
              events: metrics.events,
            })}
          </MetaPill>
          <Badge
            tone={partialError ? "amber" : "green"}
            style={{ marginLeft: "auto" }}
          >
            {partialError
              ? t("logsExplorer.partialData")
              : t("logsExplorer.unifiedObservability")}
          </Badge>
        </>
      }
    >
      {metrics.runs === 0 && metrics.events === 0 ? (
        <Empty
          title={t("logsExplorer.analyticsEmpty")}
          hint={t("logsExplorer.analyticsEmptyHint")}
        />
      ) : (
        <div
          style={{
            padding: 18,
            display: "flex",
            flexDirection: "column",
            gap: 14,
          }}
        >
          {partialError && (
            <div
              role="alert"
              style={{
                padding: "8px 11px",
                border:
                  "1px solid color-mix(in srgb, var(--amber) 35%, var(--border))",
                borderRadius: 6,
                color: "var(--amber)",
                background: "color-mix(in srgb, var(--amber) 7%, transparent)",
                fontSize: 11.5,
              }}
            >
              {t("logsExplorer.partialDataHint")}
            </div>
          )}
          {((runsQuery.data?.length ?? 0) >= 500 ||
            (eventsQuery.data?.length ?? 0) >= 500) && (
            <div
              role="note"
              style={{
                padding: "8px 11px",
                border: "1px solid var(--border)",
                borderRadius: 6,
                color: "var(--text-3)",
                background: "var(--panel)",
                fontSize: 11.5,
              }}
            >
              {t("logsExplorer.analyticsCoverageLimit")}
            </div>
          )}

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(145px, 1fr))",
              border: "1px solid var(--border)",
              borderRadius: 7,
              background: "var(--panel)",
              overflow: "hidden",
            }}
          >
            <Metric
              label={t("logsExplorer.trackedRuns")}
              value={fmtNum(metrics.runs)}
            />
            <Metric
              label={t("logsExplorer.successRate")}
              value={`${metrics.successRate.toFixed(1)}%`}
              accent="var(--green)"
            />
            <Metric
              label={t("logsExplorer.errorRate")}
              value={`${metrics.errorRate.toFixed(1)}%`}
              accent={metrics.errorRate > 0 ? "var(--red)" : undefined}
            />
            <Metric
              label={t("logsExplorer.p95Latency")}
              value={fmtDur(metrics.p95DurationMs)}
            />
            <Metric
              label={t("logsExplorer.activeRuns")}
              value={fmtNum(metrics.active)}
              accent={metrics.active > 0 ? "var(--signal)" : undefined}
            />
            <Metric
              label={t("logsExplorer.eventVolume")}
              value={fmtNum(metrics.events)}
            />
            <Metric
              label={t("logsExplorer.testRuns")}
              value={fmtNum(metrics.testRuns)}
              accent={metrics.testRuns > 0 ? "var(--amber)" : undefined}
            />
            <Metric
              label={t("logsExplorer.llmCalls")}
              value={fmtNum(summary.totals.llmCalls)}
            />
            <Metric
              label={t("logsExplorer.toolCalls")}
              value={fmtNum(summary.totals.toolCalls)}
            />
          </div>

          <Panel
            title={t("logsExplorer.runTrend")}
            subtitle={t("logsExplorer.runTrendHint", { win: windowId })}
            padded={false}
          >
            <LineChart
              values={series.map((bucket) =>
                metric === "runs" ? bucket.runs : bucket.failures,
              )}
              labels={series.map((bucket) => bucket.label)}
              formatY={(value) => String(Math.round(value))}
              accent={metric === "failures" ? "var(--red)" : "var(--signal)"}
              ariaLabel={
                metric === "failures"
                  ? t("logsExplorer.failureTrend")
                  : t("logsExplorer.runTrend")
              }
            />
          </Panel>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
              gap: 14,
            }}
          >
            <Panel title={t("logsExplorer.statusDistribution")} padded={false}>
              <HorizontalBarChart
                data={statusBars}
                formatValue={fmtNum}
                maxBars={8}
                height={180}
                accent="var(--blue)"
              />
            </Panel>
            <Panel title={t("logsExplorer.topEvents")} padded={false}>
              <HorizontalBarChart
                data={eventBars}
                formatValue={fmtNum}
                maxBars={8}
                height={180}
                accent="var(--violet)"
              />
            </Panel>
            <Panel
              title={t("logsExplorer.latencyByAgent")}
              subtitle={t("logsExplorer.p95PerAgent")}
              padded={false}
            >
              <HorizontalBarChart
                data={latencyBars}
                formatValue={fmtDur}
                maxBars={8}
                height={180}
                accent="var(--amber)"
              />
            </Panel>
          </div>

          <Panel
            title={t("logsExplorer.attentionQueue")}
            subtitle={t("logsExplorer.attentionQueueHint")}
            padded={false}
          >
            {attention.length === 0 ? (
              <Empty
                title={t("logsExplorer.noAttentionItems")}
                hint={t("logsExplorer.noAttentionItemsHint")}
              />
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table
                  style={{
                    width: "100%",
                    minWidth: 760,
                    borderCollapse: "collapse",
                  }}
                >
                  <thead>
                    <tr>
                      <th style={{ ...thStyle, width: 92 }}>
                        {t("logsExplorer.colTime")}
                      </th>
                      <th style={thStyle}>{t("logsExplorer.colAgent")}</th>
                      <th style={thStyle}>{t("logsExplorer.colSubject")}</th>
                      <th style={thStyle}>{t("logsExplorer.colStatus")}</th>
                      <th style={thStyle}>{t("logsExplorer.colDuration")}</th>
                      <th style={thStyle}>{t("logsExplorer.reason")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {attention.map((run) => (
                      <tr
                        key={run.id}
                        onClick={() =>
                          router.push(
                            `/portal/${tenant}/runs/${run.id}` as never,
                          )
                        }
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            router.push(
                              `/portal/${tenant}/runs/${run.id}` as never,
                            );
                          }
                        }}
                        tabIndex={0}
                        className="hover-row"
                        style={{ cursor: "pointer" }}
                      >
                        <td style={tdStyle}>
                          <TimeCell ms={runStartedMs(run)} />
                        </td>
                        <td style={{ ...tdStyle, color: "var(--text)" }}>
                          {run.agentTitle || run.agentName}
                        </td>
                        <td style={tdStyle}>
                          <span style={monoStyle}>{run.subject ?? "—"}</span>
                        </td>
                        <td style={tdStyle}>
                          <span
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              gap: 6,
                            }}
                          >
                            <StatusDot
                              status={statusName(run.status)}
                              size={6}
                            />
                            <span style={monoStyle}>{run.status}</span>
                          </span>
                        </td>
                        <td style={tdStyle}>
                          <span style={monoStyle}>
                            {fmtDur(run.durationMs)}
                          </span>
                        </td>
                        <td style={tdStyle}>
                          <span
                            style={{
                              ...monoStyle,
                              color:
                                run.status === "failed"
                                  ? "var(--red)"
                                  : "var(--amber)",
                            }}
                          >
                            {run.status === "failed"
                              ? (run.error ?? t("logsExplorer.runFailed"))
                              : t("logsExplorer.slowP95")}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </div>
      )}
    </LogPane>
  );
}

function Metric({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: string;
}) {
  return (
    <div
      style={{ padding: "13px 16px", borderRight: "1px solid var(--border)" }}
    >
      <div
        style={{
          fontSize: 9.5,
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
          marginTop: 6,
          fontSize: 21,
          fontFamily: "var(--mono)",
          color: accent ?? "var(--text)",
        }}
      >
        {value}
      </div>
    </div>
  );
}
