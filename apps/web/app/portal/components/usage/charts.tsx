"use client";

/**
 * Lightweight inline-SVG charts for the cost dashboard (P3-FE-03).
 *
 * No charting library is in the workspace, so we render bars + a sparkline
 * directly. Matches the inline-style aesthetic of v1_1 and works on any
 * width since everything is `viewBox`-based.
 *
 * Math helpers are exported so the unit tests (P3-FE-03b) can pin the
 * layout without rendering.
 */

import type { CSSProperties } from "react";

import { useI18n } from "@/app/portal/lib/preferences-context";

export interface BarDatum {
  key: string;
  value: number;
  /** Optional secondary value (e.g. usdCents for a token-counts chart). */
  secondary?: number;
}

/**
 * `bucketBars` — clamp a series to a max number of buckets, dropping
 * everything past `limit`. Stable on equal values (input order wins).
 */
export function bucketBars<T extends BarDatum>(data: T[], limit: number): T[] {
  return data.slice(0, Math.max(0, limit));
}

/**
 * `lineChartPoints` — convert a time-series into a normalized SVG path.
 * Returns the path `d` plus the y-baseline. Pure — handy for tests.
 */
export function lineChartPoints(
  values: number[],
  width: number,
  height: number,
  padY = 4,
): { path: string; max: number; coords: Array<{ x: number; y: number }> } {
  if (values.length === 0) {
    return { path: "", max: 0, coords: [] };
  }
  const max = Math.max(1, ...values);
  const dx = values.length > 1 ? width / (values.length - 1) : 0;
  const usable = Math.max(0, height - padY * 2);
  const coords = values.map((v, i) => ({
    // A single observation is a point-in-time value, not a falling trend.
    // Centre it so the chart does not imply movement across the whole window.
    x: values.length === 1 ? width / 2 : i * dx,
    y: padY + usable - (v / max) * usable,
  }));
  const path = coords
    .map((c, i) => `${i === 0 ? "M" : "L"} ${c.x.toFixed(1)} ${c.y.toFixed(1)}`)
    .join(" ");
  return { path, max, coords };
}

export function HorizontalBarChart({
  data,
  formatValue,
  maxBars = 10,
  height = 220,
  accent = "var(--signal)",
}: {
  data: BarDatum[];
  formatValue: (v: number) => string;
  maxBars?: number;
  height?: number;
  accent?: string;
}) {
  const { t } = useI18n();
  const items = bucketBars(data, maxBars);
  if (items.length === 0) {
    return (
      <EmptyState
        label={t("chartsComp.noUsageData")}
        style={{ height }}
      />
    );
  }
  const max = Math.max(1, ...items.map((d) => d.value));
  // Sparse series should still look like bars, not full-height colour blocks.
  const barH = Math.min(28, Math.max(14, Math.floor(height / Math.max(1, items.length)) - 4));
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        gap: 4,
        padding: "8px 14px",
        minHeight: height,
        boxSizing: "border-box",
      }}
    >
      {items.map((d) => (
        <div
          key={d.key}
          style={{
            display: "grid",
            gridTemplateColumns: "160px 1fr 120px",
            gap: 10,
            alignItems: "center",
          }}
        >
          <span
            className="mono"
            style={{
              fontSize: 11.5,
              color: "var(--text-2)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={d.key}
          >
            {d.key}
          </span>
          <div
            style={{
              position: "relative",
              height: barH,
              background: "var(--bg-2)",
              borderRadius: 2,
              overflow: "hidden",
            }}
          >
            <div
              style={{
                position: "absolute",
                top: 0,
                bottom: 0,
                left: 0,
                width: `${(d.value / max) * 100}%`,
                background: accent,
                opacity: 0.85,
                transition: "width 0.2s",
              }}
            />
          </div>
          <span
            className="mono"
            style={{
              fontSize: 11,
              color: "var(--text-2)",
              textAlign: "right",
            }}
          >
            {formatValue(d.value)}
          </span>
        </div>
      ))}
    </div>
  );
}

export function LineChart({
  values,
  labels,
  height = 160,
  width = 600,
  accent = "var(--signal)",
  formatY = (v: number) => String(Math.round(v)),
  ariaLabel,
}: {
  values: number[];
  labels: string[];
  height?: number;
  width?: number;
  accent?: string;
  formatY?: (v: number) => string;
  ariaLabel?: string;
}) {
  const { t } = useI18n();
  if (values.length === 0) {
    return <EmptyState label={t("chartsComp.noDailyData")} style={{ height }} />;
  }
  const innerW = width - 60; // leave space for y labels
  const innerH = height - 20; // leave space for x labels
  const { path, max, coords } = lineChartPoints(values, innerW, innerH);

  // Y axis: 0, max/2, max
  const yTicks = [max, max / 2, 0];

  return (
    <div style={{ padding: "8px 14px" }}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        height={height}
        style={{ display: "block" }}
        aria-label={ariaLabel ?? t("chartsComp.usageOverTime")}
        role="img"
      >
        {/* Gridlines */}
        {yTicks.map((t, i) => {
          const y = (innerH / 2) * i + 4;
          return (
            <g key={i}>
              <line
                x1={50}
                x2={50 + innerW}
                y1={y}
                y2={y}
                stroke="var(--border)"
                strokeDasharray="2 3"
              />
              <text
                x={44}
                y={y + 3}
                fontSize={10}
                fontFamily="var(--mono)"
                textAnchor="end"
                fill="var(--text-3)"
              >
                {formatY(t)}
              </text>
            </g>
          );
        })}

        {/* Line + area */}
        <g transform="translate(50, 4)">
          {path && (
            <>
              {coords.length > 1 && (
                <path d={`${path} L ${innerW} ${innerH} L 0 ${innerH} Z`} fill={accent} opacity={0.08} />
              )}
              <path d={path} fill="none" stroke={accent} strokeWidth={1.5} />
              {coords.map((c, i) => (
                <circle
                  key={i}
                  cx={c.x}
                  cy={c.y}
                  r={2}
                  fill={accent}
                  stroke="var(--bg)"
                  strokeWidth={1}
                />
              ))}
            </>
          )}
        </g>

        {/* X-axis labels (sparse) */}
        <g transform={`translate(50, ${height - 4})`}>
          {labels.map((lbl, i) => {
            // Show at most ~6 ticks across the width.
            const step = Math.max(1, Math.floor(labels.length / 6));
            if (i % step !== 0 && i !== labels.length - 1) return null;
            const single = labels.length === 1;
            const dx = labels.length > 1 ? innerW / (labels.length - 1) : 0;
            return (
              <text
                key={i}
                x={single ? innerW / 2 : i * dx}
                fontSize={10}
                fontFamily="var(--mono)"
                textAnchor={single ? "middle" : i === labels.length - 1 ? "end" : "middle"}
                fill="var(--text-3)"
              >
                {lbl}
              </text>
            );
          })}
        </g>
      </svg>
    </div>
  );
}

function EmptyState({ label, style }: { label: string; style?: CSSProperties }) {
  return (
    <div
      style={{
        ...style,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "var(--text-3)",
        fontSize: 12,
      }}
    >
      {label}
    </div>
  );
}
