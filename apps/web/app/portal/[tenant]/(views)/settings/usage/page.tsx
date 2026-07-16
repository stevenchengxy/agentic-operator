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
import { fmtNum } from "@/app/portal/lib/format";
import { useBudget, useUsage, useUpdateBudget } from "@/lib/hooks/useUsage";
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
  const byReasoning = usage.data?.byReasoning ?? [];
  const budgetRow = usage.data?.budget ?? budget.data ?? null;
  const usageUnavailable = !usage.data && (usage.error != null);

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
        title="Usage & cost"
        subtitle={
          <>
            Tenant{" "}
            <span className="mono" style={{ color: "var(--text)" }}>
              {tenant}
            </span>{" "}
            · windowed read from{" "}
            <span className="mono" style={{ color: "var(--text)" }}>
              /v1/usage
            </span>
          </>
        }
        badge={
          usageUnavailable ? (
            <Badge tone="amber">limited</Badge>
          ) : (
            <Badge tone="muted">live</Badge>
          )
        }
        action={[
          <Link
            key="back"
            href={`/portal/${tenant}/settings` as never}
            style={{ textDecoration: "none" }}
          >
            <Button small icon="chevron-left" tone="ghost">
              Back to Settings
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
                  { id: "tokens", label: "Tokens" },
                  { id: "usd", label: "USD" },
                  { id: "runs", label: "Runs" },
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
              gridTemplateColumns: "repeat(4, 1fr)",
              gap: 0,
              border: "1px solid var(--border)",
              borderRadius: 6,
              background: "var(--panel)",
            }}
          >
            <Totals label="Runs" value={fmtNum(total?.runs ?? 0)} />
            <Totals label="Tokens in" value={fmtNum(total?.tokensIn ?? 0)} />
            <Totals label="Tokens out" value={fmtNum(total?.tokensOut ?? 0)} />
            <Totals
              label="USD this period"
              value={fmtUsd(total?.usdCents ?? 0)}
              accent="var(--signal)"
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
            title={`Usage by day · ${metric}`}
            subtitle={`Last ${win} · ${byDay.length} buckets`}
            padded={false}
          >
            <LineChart
              values={series.values}
              labels={series.labels}
              formatY={(v) =>
                metric === "usd"
                  ? fmtUsd(v)
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
            <Panel title="By agent" subtitle="Tokens in+out · top 10" padded={false}>
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
            <Panel title="By model" subtitle="Tokens in+out · top 10" padded={false}>
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
          </div>

          <Panel
            title="By reasoning configuration"
            subtitle="Mode · effort · summary/context · verbosity/storage · tokens in+out"
            padded={false}
          >
            <HorizontalBarChart
              data={byReasoning
                .map((row) => ({
                  key: row.key,
                  value: row.tokensIn + row.tokensOut,
                  secondary: row.usdCents,
                }))
                .sort((a, b) => b.value - a.value)}
              formatValue={fmtNum}
            />
          </Panel>

          {usageUnavailable && (
            <Empty
              title="Live usage data unavailable"
              hint="The /v1/usage endpoint did not respond. Showing budget row only."
            />
          )}
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
  row: {
    monthlyTokenCap: number | null;
    monthlyUsdCap: number | null;
    usedTokensMonth: number;
    usedUsdMonth: number;
    periodStart: number;
  };
  onCapsChanged: () => void;
}) {
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
      ? Math.min(100, (row.usedUsdMonth / row.monthlyUsdCap) * 100)
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
      title="Monthly budget"
      subtitle={`Period started ${new Date(row.periodStart).toLocaleDateString()}`}
      padded
      action={
        <Button
          small
          icon="check"
          onClick={saveCaps}
          disabled={update.isPending}
        >
          {update.isPending ? "Saving…" : "Save caps"}
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
          label="Monthly token cap"
          value={tokenCap}
          onChange={setTokenCap}
          placeholder="unlimited"
          used={row.usedTokensMonth}
          usedLabel={fmtNum(row.usedTokensMonth)}
          pct={tokenPct}
        />
        <CapInput
          label="Monthly USD cap"
          value={usdCap}
          onChange={setUsdCap}
          placeholder="unlimited"
          used={row.usedUsdMonth}
          usedLabel={fmtUsd(row.usedUsdMonth)}
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
          Used {usedLabel}
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
          (no cap configured — unlimited)
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
