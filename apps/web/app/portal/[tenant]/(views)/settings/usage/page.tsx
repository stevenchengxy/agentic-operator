"use client";

/**
 * Settings → Usage (cost dashboard) — P3-FE-03.
 *
 * Renders three views:
 *   1. Totals strip (runs · tokens in/out · USD this period)
 *   2. Per-day line chart (tokens or USD, user-toggled)
 *   3. Agent/model/reasoning charts plus account/product/API/function billing
 *      attribution drilldowns.
 *
 * Reads:
 *   - GET /v1/usage     — aggregated runs/tokens/exact USD nanodollars
 *   - GET /v1/budgets   — monthly cap + used totals
 *
 * If /v1/usage isn't available yet the page degrades to the budget row
 * only (the brief said: render the budget row at minimum). The user can
 * pick the time window (24h / 7d / 30d) which translates into
 * `?since=<unix-ms>`.
 */

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  Badge,
  Button,
  Empty,
  FilterChip,
  Panel,
  ViewHeader,
} from "@/app/portal/components";
import { useTenant } from "@/app/portal/lib/use-tenant";
import { useI18n } from "@/app/portal/lib/preferences-context";
import { fmtNum } from "@/app/portal/lib/format";
import { useBudget, useUsage, useUpdateBudget } from "@/lib/hooks/useUsage";
import { formatUsdNanos } from "@/lib/format-usd";
import {
  HorizontalBarChart,
  LineChart,
} from "@/app/portal/components/usage/charts";

type Window = "24h" | "7d" | "30d";
type AttributionDimension =
  | "account"
  | "provider"
  | "surface"
  | "action"
  | "function"
  | "api";
type RoutingDimension = "task" | "gateway" | "route" | "actor" | "profile";

const WINDOWS: Array<{ id: Window; label: string; ms: number }> = [
  { id: "24h", label: "24h", ms: 24 * 60 * 60 * 1000 },
  { id: "7d", label: "7d", ms: 7 * 24 * 60 * 60 * 1000 },
  { id: "30d", label: "30d", ms: 30 * 24 * 60 * 60 * 1000 },
];

const ATTRIBUTION_DIMENSIONS: Array<{ id: AttributionDimension }> = [
  { id: "account" },
  { id: "provider" },
  { id: "surface" },
  { id: "action" },
  { id: "function" },
  { id: "api" },
];

const ROUTING_DIMENSIONS: Array<{ id: RoutingDimension }> = [
  { id: "task" },
  { id: "gateway" },
  { id: "route" },
  { id: "actor" },
  { id: "profile" },
];

export default function UsagePage() {
  const tenant = useTenant();
  const { t } = useI18n();
  const [win, setWin] = useState<Window>("7d");
  const [metric, setMetric] = useState<"tokens" | "usd" | "runs">("tokens");
  const [attributionDimension, setAttributionDimension] =
    useState<AttributionDimension>("surface");
  const [routingDimension, setRoutingDimension] =
    useState<RoutingDimension>("task");
  const since = useMemo(() => {
    const w = WINDOWS.find((w) => w.id === win) ?? WINDOWS[1]!;
    return Date.now() - w.ms;
  }, [win]);

  const usage = useUsage({ since });
  const budget = useBudget();

  const total = usage.data?.totals;
  const attempts = usage.data?.attempts;
  const byDay = usage.data?.byDay ?? [];
  const byAgent = usage.data?.byAgent ?? [];
  const byModel = usage.data?.byModel ?? [];
  const byReasoning = usage.data?.byReasoning ?? [];
  const attributionRows =
    attributionDimension === "account"
      ? (usage.data?.byAccount ?? [])
      : attributionDimension === "provider"
        ? (usage.data?.byProvider ?? [])
        : attributionDimension === "surface"
          ? (usage.data?.byProductSurface ?? [])
          : attributionDimension === "action"
            ? (usage.data?.byProductAction ?? [])
            : attributionDimension === "function"
              ? (usage.data?.byFunction ?? [])
              : (usage.data?.byApiCall ?? []);
  const routingRows =
    routingDimension === "task"
      ? (usage.data?.byTask ?? [])
      : routingDimension === "gateway"
        ? (usage.data?.byGateway ?? [])
        : routingDimension === "route"
          ? (usage.data?.byRoute ?? [])
          : routingDimension === "actor"
            ? (usage.data?.byActor ?? [])
            : (usage.data?.byRoutingProfile ?? []);
  const budgetRow = usage.data?.budget ?? budget.data ?? null;
  const usageUnavailable = !usage.data && usage.error != null;

  const series = useMemo(() => {
    if (byDay.length === 0) return { values: [], labels: [] };
    return {
      values: byDay.map((d) =>
        metric === "tokens"
          ? d.tokensIn + d.tokensOut
          : metric === "usd"
            ? d.usdNanos
            : d.runs,
      ),
      labels: byDay.map((d) => d.key.slice(5)), // MM-DD
    };
  }, [byDay, metric]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <ViewHeader
        title={t("settings.section.usage")}
        subtitle={
          <>
            {t("usagePage.tenant")}{" "}
            <span className="mono" style={{ color: "var(--text)" }}>
              {tenant}
            </span>{" "}
            {t("usagePage.windowedReadFrom")}{" "}
            <span className="mono" style={{ color: "var(--text)" }}>
              /v1/usage
            </span>
          </>
        }
        badge={
          usageUnavailable ? (
            <Badge tone="amber">{t("usagePage.limited")}</Badge>
          ) : (
            <Badge tone="muted">{t("usagePage.live")}</Badge>
          )
        }
        action={[
          <Link
            key="back"
            href={`/portal/${tenant}/settings` as never}
            style={{ textDecoration: "none" }}
          >
            <Button small icon="chevron-left" tone="ghost">
              {t("usagePage.backSettings")}
            </Button>
          </Link>,
        ]}
      />

      <div style={{ flex: 1, overflow: "auto", minHeight: 0 }}>
        <div
          style={{
            padding: 24,
            maxWidth: 1180,
            display: "flex",
            flexDirection: "column",
            gap: 16,
          }}
        >
          {/* Window + metric chips */}
          <div
            style={{
              display: "flex",
              gap: 14,
              flexWrap: "wrap",
              alignItems: "center",
            }}
          >
            <div style={{ display: "flex", gap: 6 }}>
              {WINDOWS.map((w) => (
                <FilterChip
                  key={w.id}
                  active={win === w.id}
                  onClick={() => setWin(w.id)}
                >
                  {w.label}
                </FilterChip>
              ))}
            </div>
            <div
              style={{
                width: 1,
                height: 18,
                background: "var(--border)",
              }}
            />
            <div style={{ display: "flex", gap: 6 }}>
              {(
                [
                  { id: "tokens", label: t("usagePage.metric.tokens") },
                  { id: "usd", label: t("usagePage.metric.usd") },
                  { id: "runs", label: t("usagePage.metric.runs") },
                ] as const
              ).map((m) => (
                <FilterChip
                  key={m.id}
                  active={metric === m.id}
                  onClick={() => setMetric(m.id)}
                >
                  {m.label}
                </FilterChip>
              ))}
            </div>
          </div>

          {/* Totals strip */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
              gap: 0,
              border: "1px solid var(--border)",
              borderRadius: 6,
              background: "var(--panel)",
            }}
          >
            <Totals label={t("usagePage.total.runs")} value={fmtNum(total?.runs ?? 0)} />
            <Totals label={t("usagePage.total.tokensIn")} value={fmtNum(total?.tokensIn ?? 0)} />
            <Totals label={t("usagePage.total.tokensOut")} value={fmtNum(total?.tokensOut ?? 0)} />
            <Totals
              label={t("usagePage.total.usdPeriod")}
              value={formatUsdNanos(total?.usdNanos ?? 0)}
              accent="var(--signal)"
            />
            <Totals
              label={t("usagePage.total.unpricedCalls")}
              value={fmtNum(total?.unpricedCalls ?? 0)}
              accent={
                (total?.unpricedCalls ?? 0) > 0 ? "var(--red)" : undefined
              }
            />
            <Totals label={t("usagePage.total.providerAttempts")} value={fmtNum(attempts?.attempts ?? 0)} />
            <Totals
              label={t("usagePage.total.failedTimeout")}
              value={`${fmtNum(attempts?.failed ?? 0)} / ${fmtNum(attempts?.timeouts ?? 0)}`}
              accent={(attempts?.failed ?? 0) > 0 ? "var(--red)" : undefined}
            />
            <Totals
              label={t("usagePage.total.retriesFallbacks")}
              value={`${fmtNum(attempts?.retries ?? 0)} / ${fmtNum(attempts?.fallbacks ?? 0)}`}
            />
            <Totals
              label={t("usagePage.total.latency")}
              value={`${fmtLatency(attempts?.p50LatencyMs)} / ${fmtLatency(attempts?.p95LatencyMs)}`}
            />
          </div>

          {/* Budget row */}
          {budgetRow && (
            <BudgetRow
              row={budgetRow}
              onCapsChanged={() => {
                void usage.refetch();
                void budget.refetch();
              }}
            />
          )}

          {/* Per-day line chart */}
          <Panel
            title={t("usagePage.byDayTitle", { metric: t(`usagePage.metric.${metric}`) })}
            subtitle={t("usagePage.byDaySubtitle", { window: win, count: byDay.length })}
            padded={false}
          >
            <LineChart
              values={series.values}
              labels={series.labels}
              formatY={(v) =>
                metric === "usd"
                  ? formatUsdNanos(v)
                  : metric === "tokens"
                    ? fmtNum(v)
                    : String(Math.round(v))
              }
            />
          </Panel>

          {/* Bar charts */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 16,
            }}
          >
            <Panel
              title={t("usagePage.byAgent")}
              subtitle={t("usagePage.tokensTop")}
              padded={false}
            >
              <HorizontalBarChart
                data={byAgent
                  .map((r) => ({
                    key: r.key,
                    value: r.tokensIn + r.tokensOut,
                    secondary: r.usdNanos,
                  }))
                  .sort((a, b) => b.value - a.value)}
                formatValue={fmtNum}
              />
            </Panel>
            <Panel
              title={t("usagePage.byModel")}
              subtitle={t("usagePage.tokensTop")}
              padded={false}
            >
              <HorizontalBarChart
                data={byModel
                  .map((r) => ({
                    key: r.key,
                    value: r.tokensIn + r.tokensOut,
                    secondary: r.usdNanos,
                  }))
                  .sort((a, b) => b.value - a.value)}
                formatValue={fmtNum}
              />
            </Panel>
          </div>

          <Panel
            title={t("usagePage.byReasoning")}
            subtitle={t("usagePage.byReasoningSubtitle")}
            padded={false}
          >
            <HorizontalBarChart
              data={byReasoning
                .map((row) => ({
                  key: row.key,
                  value: row.tokensIn + row.tokensOut,
                  secondary: row.usdNanos,
                }))
                .sort((a, b) => b.value - a.value)}
              formatValue={fmtNum}
            />
          </Panel>

          <Panel
            title={t("usagePage.routingTitle")}
            subtitle={t("usagePage.routingSubtitle")}
            padded={false}
          >
            <div
              role="group"
              aria-label={t("usagePage.routingDimensionAria")}
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 6,
                padding: "12px 14px",
                borderBottom: "1px solid var(--border)",
              }}
            >
              {ROUTING_DIMENSIONS.map((dimension) => (
                <FilterChip
                  key={dimension.id}
                  active={routingDimension === dimension.id}
                  onClick={() => setRoutingDimension(dimension.id)}
                >
                  {t(`usagePage.routingDimension.${dimension.id}`)}
                </FilterChip>
              ))}
            </div>
            <HorizontalBarChart
              data={routingRows
                .map((row) => ({
                  key: row.key ?? t("usagePage.unattributed"),
                  value: row.attempts,
                  secondary: row.failed,
                }))
                .sort((a, b) => b.value - a.value)}
              formatValue={fmtNum}
            />
            <div
              style={{
                padding: "0 14px 12px",
                color: "var(--text-3)",
                fontSize: 11,
              }}
            >
              {t("usagePage.routingLegend")}
            </div>
          </Panel>

          <Panel
            title={t("usagePage.attributionTitle")}
            subtitle={t("usagePage.attributionSubtitle")}
            padded={false}
          >
            <div
              role="group"
              aria-label={t("usagePage.attributionDimensionAria")}
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 6,
                padding: "12px 14px",
                borderBottom: "1px solid var(--border)",
              }}
            >
              {ATTRIBUTION_DIMENSIONS.map((dimension) => (
                <FilterChip
                  key={dimension.id}
                  active={attributionDimension === dimension.id}
                  onClick={() => setAttributionDimension(dimension.id)}
                >
                  {t(`usagePage.attributionDimension.${dimension.id}`)}
                </FilterChip>
              ))}
            </div>
            <HorizontalBarChart
              data={attributionRows
                .map((row) => ({
                  key: row.key,
                  value:
                    metric === "tokens"
                      ? row.tokensIn + row.tokensOut
                      : metric === "usd"
                        ? row.usdNanos
                        : row.runs,
                  secondary: row.usdNanos,
                }))
                .sort((a, b) => b.value - a.value)}
              formatValue={(value) =>
                metric === "usd" ? formatUsdNanos(value) : fmtNum(value)
              }
            />
          </Panel>

          {usageUnavailable && (
            <Empty
              title={t("usagePage.unavailableTitle")}
              hint={t("usagePage.unavailableHint")}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function fmtLatency(value: number | null | undefined): string {
  if (value == null) return "—";
  return value >= 1_000 ? `${(value / 1_000).toFixed(1)}s` : `${Math.round(value)}ms`;
}

function Totals({
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
      style={{ padding: "14px 18px", borderRight: "1px solid var(--border)" }}
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
          marginTop: 6,
          fontSize: 22,
          fontFamily: "var(--mono)",
          color: accent ?? "var(--text)",
        }}
      >
        {value}
      </div>
    </div>
  );
}

function BudgetRow({
  row,
  onCapsChanged,
}: {
  row: {
    monthlyTokenCap: number | null;
    monthlyUsdCap: number | null;
    usedTokensMonth: number;
    usedUsdMonth: number;
    usedUsdNanos: number;
    periodStart: number;
  };
  onCapsChanged: () => void;
}) {
  const { t, language } = useI18n();
  const update = useUpdateBudget();
  const [tokenCap, setTokenCap] = useState(
    row.monthlyTokenCap?.toString() ?? "",
  );
  const [usdCap, setUsdCap] = useState(
    row.monthlyUsdCap != null ? (row.monthlyUsdCap / 100).toFixed(2) : "",
  );
  const tokenPct =
    row.monthlyTokenCap && row.monthlyTokenCap > 0
      ? Math.min(100, (row.usedTokensMonth / row.monthlyTokenCap) * 100)
      : null;
  const usdPct =
    row.monthlyUsdCap && row.monthlyUsdCap > 0
      ? Math.min(
          100,
          (row.usedUsdNanos / (row.monthlyUsdCap * 10_000_000)) * 100,
        )
      : null;

  async function saveCaps() {
    const t = tokenCap.trim();
    const u = usdCap.trim();
    await update.mutateAsync({
      monthlyTokenCap: t === "" ? null : Math.max(0, Math.floor(Number(t))),
      monthlyUsdCap: u === "" ? null : Math.max(0, Math.round(Number(u) * 100)),
    });
    onCapsChanged();
  }

  return (
    <Panel
      title={t("usagePage.budget.title")}
      subtitle={t("usagePage.budget.periodStarted", {
        date: new Date(row.periodStart).toLocaleDateString(
          language === "zh" ? "zh-CN" : "en-US",
        ),
      })}
      padded
      action={
        <Button
          small
          icon="check"
          onClick={saveCaps}
          disabled={update.isPending}
        >
          {update.isPending ? t("common.saving") : t("usagePage.budget.saveCaps")}
        </Button>
      }
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 18,
        }}
      >
        <CapInput
          label={t("billing.tokenCap")}
          value={tokenCap}
          onChange={setTokenCap}
          placeholder={t("billing.unlimited")}
          used={row.usedTokensMonth}
          usedLabel={fmtNum(row.usedTokensMonth)}
          pct={tokenPct}
        />
        <CapInput
          label={t("billing.usdCap")}
          value={usdCap}
          onChange={setUsdCap}
          placeholder={t("billing.unlimited")}
          used={row.usedUsdNanos}
          usedLabel={formatUsdNanos(row.usedUsdNanos)}
          pct={usdPct}
        />
      </div>
    </Panel>
  );
}

function CapInput({
  label,
  value,
  onChange,
  placeholder,
  used,
  usedLabel,
  pct,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  used: number;
  usedLabel: string;
  pct: number | null;
}) {
  const { t } = useI18n();
  return (
    <div>
      <div
        style={{
          fontSize: 10.5,
          fontFamily: "var(--mono)",
          color: "var(--text-3)",
          textTransform: "uppercase",
          letterSpacing: "0.08em",
        }}
      >
        {label}
      </div>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        style={{
          marginTop: 6,
          width: "100%",
          padding: "7px 10px",
          fontSize: 13,
          fontFamily: "var(--mono)",
          background: "var(--bg-2)",
          color: "var(--text)",
          border: "1px solid var(--border-2)",
          borderRadius: 4,
        }}
      />
      <div
        style={{
          marginTop: 8,
          display: "flex",
          alignItems: "center",
          gap: 8,
          fontSize: 11,
        }}
      >
        <span style={{ color: "var(--text-3)" }}>
          {t("usagePage.budget.used", { value: usedLabel })}
          {pct != null ? ` · ${pct.toFixed(0)}%` : ""}
        </span>
        <div
          style={{
            flex: 1,
            height: 6,
            background: "var(--bg-2)",
            borderRadius: 99,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              height: "100%",
              width: pct != null ? `${pct}%` : 0,
              background:
                pct != null && pct >= 90
                  ? "var(--red)"
                  : pct != null && pct >= 70
                    ? "var(--amber)"
                    : "var(--signal)",
              transition: "width 0.2s",
            }}
          />
        </div>
      </div>
      {used > 0 && pct == null && (
        <div
          style={{
            marginTop: 4,
            fontSize: 10.5,
            color: "var(--text-3)",
          }}
        >
          {t("usagePage.budget.noCap")}
        </div>
      )}
    </div>
  );
}
