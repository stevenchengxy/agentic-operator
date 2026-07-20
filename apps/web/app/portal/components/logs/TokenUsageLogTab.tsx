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
import { useRuns } from "@/lib/hooks/useRuns";
import { useUsage } from "@/lib/hooks/useUsage";
import {
  LogPane,
  MetaPill,
  TimeCell,
  monoStyle,
  tdStyle,
  thStyle,
} from "./shared";
import { runStartedMs, runTokens } from "./observability";

type UsageWindow = "24h" | "7d" | "30d";

const WINDOWS: Array<{ id: UsageWindow; ms: number }> = [
  { id: "24h", ms: 24 * 60 * 60 * 1000 },
  { id: "7d", ms: 7 * 24 * 60 * 60 * 1000 },
  { id: "30d", ms: 30 * 24 * 60 * 60 * 1000 },
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

function fmtUsd(cents: number): string {
  const dollars = cents / 100;
  if (Math.abs(dollars) < 1_000) return `$${dollars.toFixed(2)}`;
  return `$${(dollars / 1_000).toFixed(1)}k`;
}

export function TokenUsageLogTab() {
  const { t } = useI18n();
  const tenant = useTenant();
  const router = useRouter();
  const [windowId, setWindowId] = useState<UsageWindow>("7d");
  const windowMs =
    WINDOWS.find((item) => item.id === windowId)?.ms ?? WINDOWS[1]!.ms;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, [windowId]);
  const since = now - windowMs;
  const usage = useUsage({ rollingWindowMs: windowMs });
  const runs = useRuns({ limit: 300 });
  const recentRuns = useMemo(
    () => (runs.data ?? []).filter((run) => runStartedMs(run) >= since),
    [runs.data, since],
  );

  if (usage.isLoading && !usage.data) {
    return (
      <LogPane>
        <Empty
          title={t("logsExplorer.loading")}
          hint={t("logsExplorer.tokenLoadingHint")}
        />
      </LogPane>
    );
  }
  if (usage.isError && !usage.data) {
    return (
      <LogPane>
        <Empty
          title={t("logsExplorer.tokenLoadFailed")}
          hint={usage.error?.message ?? ""}
        />
      </LogPane>
    );
  }

  const data = usage.data;
  if (!data) {
    return (
      <LogPane>
        <Empty
          title={t("logsExplorer.tokenLoadFailed")}
          hint={t("logsExplorer.tokenMissingResponse")}
        />
      </LogPane>
    );
  }

  const totals = data.totals;
  // Legacy provenance block — the ledger-based /v1/usage may omit it. When
  // absent, completeness degrades to the ledger signal (zero unpriced calls)
  // and the provenance-only pills/hints are hidden rather than fabricated.
  const coverage = data.coverage ?? null;
  const costComplete = coverage
    ? coverage.costComplete
    : totals.unpricedCalls === 0;
  const provenanceComplete = coverage ? coverage.tokenCoverageComplete : true;
  const costPrefix = !costComplete ? "≥" : coverage?.costEstimated ? "≈" : "";
  const totalTokens = totals.tokensIn + totals.tokensOut;
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
          {coverage && (
            <MetaPill>
              {t("logsExplorer.providerTokenCount", {
                n: fmtNum(coverage.exactProviderTokens),
              })}
            </MetaPill>
          )}
          {(totals.testRuns ?? 0) > 0 && (
            <MetaPill>
              {t("logsExplorer.testRunsCount", { n: totals.testRuns ?? 0 })}
            </MetaPill>
          )}
          {coverage && coverage.auxiliaryCallTokens > 0 && (
            <MetaPill>
              {t("logsExplorer.auxiliaryTokens", {
                n: fmtNum(coverage.auxiliaryCallTokens),
              })}
            </MetaPill>
          )}
          {coverage && coverage.estimatedTokens > 0 && (
            <MetaPill>
              {t("logsExplorer.estimatedTokenCount", {
                n: fmtNum(coverage.estimatedTokens),
              })}
            </MetaPill>
          )}
          {coverage && coverage.ambiguousRuntimeCallTokens > 0 && (
            <MetaPill>
              {t("logsExplorer.ambiguousTokenCount", {
                n: fmtNum(coverage.ambiguousRuntimeCallTokens),
              })}
            </MetaPill>
          )}
          {!costComplete && (
            <MetaPill>
              {t("logsExplorer.unpricedTokens", {
                n: fmtNum(
                  coverage ? coverage.unpricedTokens : totals.unpricedCalls,
                ),
              })}
            </MetaPill>
          )}
          <Badge
            tone={provenanceComplete && costComplete ? "green" : "amber"}
            style={{ marginLeft: "auto" }}
          >
            {provenanceComplete
              ? t("logsExplorer.usageCoverageComplete")
              : t("logsExplorer.usageCoveragePartial")}
          </Badge>
        </>
      }
    >
      <div
        style={{
          padding: 18,
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        {!costComplete && coverage && (
          <div
            role="note"
            style={{
              padding: "9px 11px",
              border:
                "1px solid color-mix(in srgb, var(--amber) 35%, var(--border))",
              borderRadius: 6,
              color: "var(--amber)",
              background: "color-mix(in srgb, var(--amber) 7%, transparent)",
              fontSize: 11.5,
            }}
          >
            {t("logsExplorer.costIncompleteHint", {
              n: fmtNum(coverage.unpricedTokens),
            })}
          </div>
        )}
        {!provenanceComplete && coverage && (
          <div
            role="alert"
            style={{
              padding: "9px 11px",
              border:
                "1px solid color-mix(in srgb, var(--amber) 35%, var(--border))",
              borderRadius: 6,
              color: "var(--amber)",
              background: "color-mix(in srgb, var(--amber) 7%, transparent)",
              fontSize: 11.5,
            }}
          >
            {t("logsExplorer.tokenProvenanceIncompleteHint", {
              ambiguous: fmtNum(coverage.ambiguousRuntimeCallTokens),
              unknown: fmtNum(coverage.unknownSourceTokens),
              ambiguousCalls: fmtNum(coverage.ambiguousRuntimeCalls),
              unknownCalls: fmtNum(coverage.unknownSourceCalls),
              unmeasuredCalls: fmtNum(coverage.unmeasuredRuntimeCalls),
            })}
          </div>
        )}
        {coverage?.costEstimated && (
          <div
            role="note"
            style={{
              padding: "9px 11px",
              border: "1px solid var(--border)",
              borderRadius: 6,
              color: "var(--text-3)",
              background: "var(--panel)",
              fontSize: 11.5,
            }}
          >
            {t("logsExplorer.tokenEstimationHint", {
              estimated: fmtNum(coverage?.estimatedTokens ?? 0),
              legacy: fmtNum(coverage?.legacyRunTokens ?? 0),
            })}
          </div>
        )}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
            border: "1px solid var(--border)",
            borderRadius: 7,
            background: "var(--panel)",
            overflow: "hidden",
          }}
        >
          <Metric
            label={t("logsExplorer.totalTokens")}
            value={fmtNum(totalTokens)}
            accent="var(--signal)"
          />
          <Metric
            label={t("logsExplorer.inputTokens")}
            value={fmtNum(totals.tokensIn)}
          />
          <Metric
            label={t("logsExplorer.outputTokens")}
            value={fmtNum(totals.tokensOut)}
          />
          <Metric
            label={t("logsExplorer.estimatedCost")}
            value={`${costPrefix}${fmtUsd(totals.usdCents)}`}
          />
          <Metric
            label={t("logsExplorer.trackedRuns")}
            value={fmtNum(totals.runs)}
          />
        </div>

        {data.budget && (
          <BudgetMeter
            used={data.budget.usedTokensMonth}
            cap={data.budget.monthlyTokenCap}
          />
        )}

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
            gap: 14,
          }}
        >
          <Panel
            title={t("logsExplorer.tokenTrend")}
            subtitle={t("logsExplorer.realUsageSource")}
            padded={false}
          >
            <LineChart
              values={data.byDay.map((row) => row.tokensIn + row.tokensOut)}
              labels={data.byDay.map((row) => row.key.slice(5))}
              formatY={fmtNum}
              ariaLabel={t("logsExplorer.tokenTrend")}
            />
          </Panel>
          <Panel title={t("logsExplorer.tokensByModel")} padded={false}>
            <HorizontalBarChart
              data={data.byModel.map((row) => ({
                key: row.key,
                value: row.tokensIn + row.tokensOut,
              }))}
              formatValue={fmtNum}
              maxBars={6}
              height={160}
              accent="var(--violet)"
            />
          </Panel>
        </div>

        <Panel
          title={t("logsExplorer.tokensByAgent")}
          subtitle={t("logsExplorer.topAgentsByTokens")}
          padded={false}
        >
          <HorizontalBarChart
            data={data.byAgent.map((row) => ({
              key: row.key,
              value: row.tokensIn + row.tokensOut,
            }))}
            formatValue={fmtNum}
            maxBars={10}
            height={220}
          />
        </Panel>

        <Panel
          title={t("logsExplorer.recentTokenRuns")}
          subtitle={t("logsExplorer.recentTokenRunsHint")}
          padded={false}
        >
          {recentRuns.length === 0 ? (
            <Empty
              title={t("logsExplorer.tokenEmpty")}
              hint={t("logsExplorer.tokenEmptyHint")}
            />
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table
                style={{
                  width: "100%",
                  borderCollapse: "collapse",
                  minWidth: 760,
                }}
              >
                <thead>
                  <tr>
                    <th style={{ ...thStyle, width: 92 }}>
                      {t("logsExplorer.colTime")}
                    </th>
                    <th style={thStyle}>{t("logsExplorer.colAgent")}</th>
                    <th style={thStyle}>{t("logsExplorer.model")}</th>
                    <th style={thStyle}>{t("logsExplorer.inputTokens")}</th>
                    <th style={thStyle}>{t("logsExplorer.outputTokens")}</th>
                    <th style={thStyle}>{t("logsExplorer.totalTokens")}</th>
                    <th style={thStyle}>{t("logsExplorer.colDuration")}</th>
                    <th style={thStyle}>{t("logsExplorer.colStatus")}</th>
                  </tr>
                </thead>
                <tbody>
                  {recentRuns.slice(0, 40).map((run) => (
                    <tr
                      key={run.id}
                      onClick={() =>
                        router.push(`/portal/${tenant}/runs/${run.id}` as never)
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
                      style={{ cursor: "pointer" }}
                      className="hover-row"
                    >
                      <td style={tdStyle}>
                        <TimeCell ms={runStartedMs(run)} />
                      </td>
                      <td style={tdStyle}>
                        <span
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 6,
                          }}
                        >
                          {run.agentTitle || run.agentName}
                          {run.testRun && (
                            <Badge tone="amber">
                              {t("logsExplorer.testRun")}
                            </Badge>
                          )}
                        </span>
                      </td>
                      <td style={tdStyle}>
                        <span style={monoStyle}>{run.model ?? "—"}</span>
                      </td>
                      <td style={tdStyle}>
                        <span style={monoStyle}>
                          {run.tokensIn == null ? "—" : fmtNum(run.tokensIn)}
                        </span>
                      </td>
                      <td style={tdStyle}>
                        <span style={monoStyle}>
                          {run.tokensOut == null ? "—" : fmtNum(run.tokensOut)}
                        </span>
                      </td>
                      <td style={tdStyle}>
                        <span style={{ ...monoStyle, color: "var(--text)" }}>
                          {fmtNum(runTokens(run))}
                        </span>
                      </td>
                      <td style={tdStyle}>
                        <span style={monoStyle}>{fmtDur(run.durationMs)}</span>
                      </td>
                      <td style={tdStyle}>
                        <span
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 6,
                          }}
                        >
                          <StatusDot status={statusName(run.status)} size={6} />
                          <span style={monoStyle}>{run.status}</span>
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

function BudgetMeter({ used, cap }: { used: number; cap: number | null }) {
  const { t } = useI18n();
  const pct = cap && cap > 0 ? Math.min(100, (used / cap) * 100) : null;
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "180px 1fr auto",
        gap: 12,
        alignItems: "center",
        padding: "10px 14px",
        border: "1px solid var(--border)",
        borderRadius: 7,
        background: "var(--panel)",
      }}
    >
      <span
        style={{
          fontSize: 11,
          color: "var(--text-2)",
          fontFamily: "var(--mono)",
        }}
      >
        {t("logsExplorer.monthlyBudget")}
      </span>
      <div
        style={{
          height: 7,
          background: "var(--bg-2)",
          borderRadius: 99,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            height: "100%",
            width: pct == null ? 0 : `${pct}%`,
            background:
              pct != null && pct >= 90
                ? "var(--red)"
                : pct != null && pct >= 70
                  ? "var(--amber)"
                  : "var(--signal)",
          }}
        />
      </div>
      <span style={monoStyle}>
        {fmtNum(used)} /{" "}
        {cap == null ? t("logsExplorer.unlimited") : fmtNum(cap)}
        {pct == null ? "" : ` · ${pct.toFixed(0)}%`}
      </span>
    </div>
  );
}
