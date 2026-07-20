"use client";

/**
 * Settings → Usage (cost dashboard) — P3-FE-03.
 *
 * Renders three views:
 *   1. Totals strip (runs · tokens in/out · USD this period)
 *   2. Per-day line chart (tokens or USD, user-toggled)
 *   3. Top agents + top models horizontal bar charts
 *
 * Reads:
 *   - GET /v1/usage     — aggregated runs/tokens/usdCents
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
import {
  useBudget,
  useUsage,
  useUpdateBudget,
  type BudgetRow as BudgetData,
} from "@/lib/hooks/useUsage";
import {
  HorizontalBarChart,
  LineChart,
} from "@/app/portal/components/usage/charts";

type Window = "24h" | "7d" | "30d";

const WINDOWS: Array<{ id: Window; label: string; ms: number }> = [
  { id: "24h", label: "24h", ms: 24 * 60 * 60 * 1000 },
  { id: "7d", label: "7d", ms: 7 * 24 * 60 * 60 * 1000 },
  { id: "30d", label: "30d", ms: 30 * 24 * 60 * 60 * 1000 },
];

export default function UsagePage() {
  const tenant = useTenant();
  const { t } = useI18n();
  const [win, setWin] = useState<Window>("7d");
  const [metric, setMetric] = useState<"tokens" | "usd" | "runs">("tokens");
  const since = useMemo(() => {
    const w = WINDOWS.find((w) => w.id === win) ?? WINDOWS[1]!;
    return Date.now() - w.ms;
  }, [win]);

  const usage = useUsage({ since });
  const budget = useBudget();

  const total = usage.data?.totals;
  const byDay = usage.data?.byDay ?? [];
  const byAgent = usage.data?.byAgent ?? [];
  const byModel = usage.data?.byModel ?? [];
  const budgetRow = budget.data ?? usage.data?.budget ?? null;
  const usageUnavailable = !usage.data && (usage.error != null);
  const usageLoading = !usage.data && usage.isLoading;
  const costComplete = usage.data?.coverage.costComplete ?? true;
  const unpricedTokens = usage.data?.coverage.unpricedTokens ?? 0;

  const series = useMemo(() => {
    if (byDay.length === 0) return { values: [], labels: [] };
    return {
      values: byDay.map((d) =>
        metric === "tokens"
          ? d.tokensIn + d.tokensOut
          : metric === "usd"
            ? d.usdCents
            : d.runs,
      ),
      labels: byDay.map((d) => d.key.slice(5)), // MM-DD
    };
  }, [byDay, metric]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <ViewHeader
        title={t("usage.title")}
        subtitle={
          <>
            {t("usage.subtitleTenant")}{" "}
            <span className="mono" style={{ color: "var(--text)" }}>
              {tenant}
            </span>{" "}
            {t("usage.subtitleWindowed")}{" "}
            <span className="mono" style={{ color: "var(--text)" }}>
              /v1/usage
            </span>
          </>
        }
        badge={
          usageUnavailable ? (
            <Badge tone="red">{t("usage.badgeUnavailable")}</Badge>
          ) : usageLoading ? (
            <Badge tone="muted">{t("usage.loading")}</Badge>
          ) : (
            <Badge tone="muted">{t("usage.badgeLive")}</Badge>
          )
        }
        action={[
          <Link
            key="back"
            href={`/portal/${tenant}/settings` as never}
            style={{ textDecoration: "none" }}
          >
            <Button small icon="chevron-left" tone="ghost">
              {t("usage.backToSettings")}
            </Button>
          </Link>,
        ]}
      />

      <div style={{ flex: 1, overflow: "auto", minHeight: 0 }}>
        <div style={{ padding: 24, maxWidth: 1180, display: "flex", flexDirection: "column", gap: 16 }}>
          {/* Window + metric chips */}
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "center" }}>
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
                  { id: "tokens", label: t("usage.metricTokens") },
                  { id: "usd", label: t("usage.metricUsd") },
                  { id: "runs", label: t("usage.metricRuns") },
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

          {usage.data && !costComplete ? (
            <div
              role="note"
              style={{
                padding: "10px 12px",
                border:
                  "1px solid color-mix(in srgb, var(--amber) 35%, var(--border))",
                borderRadius: 6,
                color: "var(--amber)",
                background:
                  "color-mix(in srgb, var(--amber) 7%, transparent)",
                fontSize: 11.5,
              }}
            >
              <strong>{t("usage.costIncompleteTitle")}</strong>
              {" · "}
              {t("usage.costIncompleteHint", {
                n: fmtNum(unpricedTokens),
              })}
            </div>
          ) : null}

          {/* Totals strip */}
          {usageLoading ? (
            <Empty title={t("usage.loading")} hint="" />
          ) : usageUnavailable ? (
            <Empty
              title={t("usage.emptyTitle")}
              hint={usage.error instanceof Error ? usage.error.message : t("usage.emptyHint")}
            />
          ) : total ? (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(4, 1fr)",
                gap: 0,
                border: "1px solid var(--border)",
                borderRadius: 6,
                background: "var(--panel)",
              }}
            >
              <Totals label={t("usage.totalsRuns")} value={fmtNum(total.runs)} />
              <Totals label={t("usage.totalsTokensIn")} value={fmtNum(total.tokensIn)} />
              <Totals label={t("usage.totalsTokensOut")} value={fmtNum(total.tokensOut)} />
              <Totals
                label={t("usage.totalsUsdPeriod")}
                value={`${costComplete ? "" : "≥"}${fmtUsd(total.usdCents)}`}
                accent="var(--signal)"
              />
            </div>
          ) : null}

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
          {!budgetRow && budget.isError ? (
            <Empty
              title={t("usage.budgetUnavailable")}
              hint={budget.error instanceof Error ? budget.error.message : ""}
            />
          ) : null}

          {/* Per-day line chart */}
          {usage.data ? <Panel
            title={t("usage.byDayTitle", { metric })}
            subtitle={
              metric === "usd" && !costComplete
                ? t("usage.byDayCostIncomplete", {
                    win,
                    buckets: byDay.length,
                  })
                : t("usage.byDaySubtitle", { win, buckets: byDay.length })
            }
            padded={false}
          >
            <LineChart
              values={series.values}
              labels={series.labels}
              formatY={(v) =>
                metric === "usd"
                  ? `${costComplete ? "" : "≥"}${fmtUsd(v)}`
                  : metric === "tokens"
                    ? fmtNum(v)
                    : String(Math.round(v))
              }
            />
          </Panel> : null}

          {/* Bar charts */}
          {usage.data ? <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 16,
            }}
          >
            <Panel title={t("usage.byAgentTitle")} subtitle={t("usage.barChartSubtitle")} padded={false}>
              <HorizontalBarChart
                data={byAgent
                  .map((r) => ({
                    key: r.key,
                    value: r.tokensIn + r.tokensOut,
                    secondary: r.usdCents,
                  }))
                  .sort((a, b) => b.value - a.value)}
                formatValue={fmtNum}
              />
            </Panel>
            <Panel title={t("usage.byModelTitle")} subtitle={t("usage.barChartSubtitle")} padded={false}>
              <HorizontalBarChart
                data={byModel
                  .map((r) => ({
                    key: r.key,
                    value: r.tokensIn + r.tokensOut,
                    secondary: r.usdCents,
                  }))
                  .sort((a, b) => b.value - a.value)}
                formatValue={fmtNum}
              />
            </Panel>
          </div> : null}
        </div>
      </div>
    </div>
  );
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
    <div style={{ padding: "14px 18px", borderRight: "1px solid var(--border)" }}>
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
  row: BudgetData;
  onCapsChanged: () => void;
}) {
  const { t } = useI18n();
  const update = useUpdateBudget();
  const [tokenCap, setTokenCap] = useState(
    row.monthlyTokenCap?.toString() ?? "",
  );
  const [usdCap, setUsdCap] = useState(
    row.monthlyUsdCap != null ? (row.monthlyUsdCap / 100).toFixed(2) : "",
  );
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);
  const tokenPct =
    row.monthlyTokenCap && row.monthlyTokenCap > 0
      ? Math.min(100, ((row.usedTokensMonth + row.reservedTokens) / row.monthlyTokenCap) * 100)
      : null;
  const usdPct =
    row.monthlyUsdCap && row.monthlyUsdCap > 0
      ? Math.min(100, ((row.usedUsdMonth + row.reservedUsdCents) / row.monthlyUsdCap) * 100)
      : null;

  async function saveCaps() {
    const tokenText = tokenCap.trim();
    const usdText = usdCap.trim();
    const tokenNumber = tokenText === "" ? null : Number(tokenText);
    const usdNumber = usdText === "" ? null : Number(usdText);
    if (
      (tokenNumber != null && (!Number.isFinite(tokenNumber) || tokenNumber < 0)) ||
      (usdNumber != null && (!Number.isFinite(usdNumber) || usdNumber < 0))
    ) {
      setFeedback({ ok: false, text: t("usage.invalidCap") });
      return;
    }
    setFeedback(null);
    try {
      await update.mutateAsync({
        monthlyTokenCap: tokenNumber == null ? null : Math.floor(tokenNumber),
        monthlyUsdCap: usdNumber == null ? null : Math.round(usdNumber * 100),
      });
      setFeedback({ ok: true, text: t("usage.capsSaved") });
      onCapsChanged();
    } catch (error) {
      setFeedback({
        ok: false,
        text: error instanceof Error ? error.message : t("usage.saveCapsFailed"),
      });
    }
  }

  return (
    <Panel
      title={t("usage.budgetTitle")}
      subtitle={t("usage.budgetPeriodStarted", {
        date: new Date(row.periodStart).toLocaleDateString(),
      })}
      padded
      action={
        <Button
          small
          icon="check"
          onClick={saveCaps}
          disabled={update.isPending}
        >
          {update.isPending ? t("usage.saving") : t("usage.saveCaps")}
        </Button>
      }
    >
      {!row.costComplete ? (
        <div
          role="note"
          style={{
            marginBottom: 14,
            padding: "8px 10px",
            border:
              "1px solid color-mix(in srgb, var(--amber) 35%, var(--border))",
            borderRadius: 6,
            color: "var(--amber)",
            background: "color-mix(in srgb, var(--amber) 7%, transparent)",
            fontSize: 11,
          }}
        >
          {t("usage.budgetCostIncompleteHint", {
            n: fmtNum(row.unpricedTokens),
          })}
        </div>
      ) : null}
      {row.activeReservations > 0 ? (
        <div
          role="status"
          style={{
            marginBottom: 14,
            padding: "8px 10px",
            border: "1px solid color-mix(in srgb, var(--signal) 30%, var(--border))",
            borderRadius: 6,
            color: "var(--text-2)",
            background: "color-mix(in srgb, var(--signal) 6%, transparent)",
            fontSize: 11,
          }}
        >
          {t("usage.activeReservations", {
            count: row.activeReservations,
            tokens: fmtNum(row.reservedTokens),
            usd: fmtUsd(row.reservedUsdCents),
          })}
        </div>
      ) : null}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 18,
        }}
      >
        <CapInput
          label={t("usage.tokenCapLabel")}
          value={tokenCap}
          onChange={setTokenCap}
          placeholder={t("usage.capUnlimited")}
          used={row.usedTokensMonth}
          usedLabel={fmtNum(row.usedTokensMonth)}
          reserved={row.reservedTokens}
          reservedLabel={fmtNum(row.reservedTokens)}
          pct={tokenPct}
        />
        <CapInput
          label={t("usage.usdCapLabel")}
          value={usdCap}
          onChange={setUsdCap}
          placeholder={t("usage.capUnlimited")}
          used={row.usedUsdMonth}
          usedLabel={`${row.costComplete ? "" : "≥"}${fmtUsd(row.usedUsdMonth)}`}
          reserved={row.reservedUsdCents}
          reservedLabel={fmtUsd(row.reservedUsdCents)}
          pct={usdPct}
          minimum={!row.costComplete}
        />
      </div>
      {feedback ? (
        <div
          role={feedback.ok ? "status" : "alert"}
          style={{ marginTop: 12, color: feedback.ok ? "var(--green)" : "var(--red)", fontSize: 11.5 }}
        >
          {feedback.text}
        </div>
      ) : null}
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
  reserved,
  reservedLabel,
  pct,
  minimum = false,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  used: number;
  usedLabel: string;
  reserved: number;
  reservedLabel: string;
  pct: number | null;
  minimum?: boolean;
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
        type="number"
        min={0}
        step="any"
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
          {t("usage.used", { amount: usedLabel })}
          {reserved > 0 ? ` · ${t("usage.reserved", { amount: reservedLabel })}` : ""}
          {pct != null ? ` · ${minimum ? "≥" : ""}${pct.toFixed(0)}%` : ""}
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
      {used + reserved > 0 && pct == null && (
        <div
          style={{
            marginTop: 4,
            fontSize: 10.5,
            color: "var(--text-3)",
          }}
        >
          {t("usage.noCapConfigured")}
        </div>
      )}
    </div>
  );
}

function fmtUsd(cents: number): string {
  const dollars = cents / 100;
  if (Math.abs(dollars) < 1) return `$${dollars.toFixed(2)}`;
  if (Math.abs(dollars) < 1000) return `$${dollars.toFixed(2)}`;
  return `$${(dollars / 1000).toFixed(1)}k`;
}
