/**
 * viz.svgChart — deterministic, dependency-free SVG chart renderer.
 *
 * Charts drawn by an LLM free-hand tend to have broken axes/geometry, so the
 * numbers→geometry step is done HERE deterministically and the LLM (or a
 * report pipeline) embeds the returned `svg` string verbatim. Pure function:
 * same spec in, same SVG out — no Date, no randomness, no I/O.
 *
 * Kinds:
 *   bar   — horizontal bars, good for CJK labels.       data: [{label,value}]
 *   donut — share-of-total ring + legend.               data: [{label,value}]
 *   line  — single series trend.                        data: [{label,value}]
 *   flow  — left→right step chain (serpentine wrap).    steps: string[]
 *
 * LLM args = the spec itself. Returns { svg, width, height }.
 */

import { defineTool } from "@agentic/agent-kit";
import { z } from "zod";

export interface ChartDatum {
  label: string;
  value: number;
}

export interface SvgChartSpec {
  kind: "bar" | "donut" | "line" | "flow";
  title?: string;
  data?: ChartDatum[];
  /** flow only — the ordered step labels. */
  steps?: string[];
  width?: number;
  palette?: string[];
}

const PALETTE = ["#5b8def", "#6fcf97", "#f2c94c", "#eb5757", "#9b51e0", "#56ccf2", "#f2994a", "#219653"];
const INK = "#333333";
const INK_2 = "#777777";
const GRID = "#dddddd";
const FONT = `font-family="system-ui, -apple-system, 'PingFang SC', sans-serif"`;

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const fmt = (v: number): string => (Number.isInteger(v) ? String(v) : v.toFixed(2));

/** Palette entries reach fill/stroke ATTRIBUTES verbatim — escape them so a hostile
 *  "color" can never break out of the attribute (valid CSS colors are unaffected). */
function resolvePalette(spec: SvgChartSpec): string[] {
  return (spec.palette?.length ? spec.palette : PALETTE).map((c) => esc(String(c)));
}

function open(width: number, height: number, title?: string): string {
  const head = title
    ? `<text x="${width / 2}" y="22" text-anchor="middle" ${FONT} font-size="14" font-weight="600" fill="${INK}">${esc(title)}</text>`
    : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img">${head}`;
}

function renderBar(spec: SvgChartSpec): { svg: string; width: number; height: number } {
  const data = (spec.data ?? []).slice(0, 14);
  const width = Math.max(spec.width ?? 640, 320); // gutter 168 + value gutter 64 + ≥88px track
  const palette = resolvePalette(spec);
  const top = spec.title ? 38 : 14;
  const rowH = 28;
  const height = top + data.length * rowH + 10;
  const gutter = 168;
  const trackW = width - gutter - 64;
  const max = Math.max(...data.map((d) => Math.max(0, d.value)), 1);
  let body = "";
  data.forEach((d, i) => {
    const y = top + i * rowH;
    const w = Math.max(2, (Math.max(0, d.value) / max) * trackW);
    const color = palette[i % palette.length]!;
    body +=
      `<text x="${gutter - 8}" y="${y + 18}" text-anchor="end" ${FONT} font-size="12" fill="${INK}">${esc(clip(d.label, 14))}</text>` +
      `<rect x="${gutter}" y="${y + 6}" width="${trackW}" height="16" rx="4" fill="#f2f2f2"/>` +
      `<rect x="${gutter}" y="${y + 6}" width="${fmt(w)}" height="16" rx="4" fill="${color}"/>` +
      `<text x="${gutter + w + 6}" y="${y + 18}" ${FONT} font-size="11.5" fill="${INK_2}">${fmt(d.value)}</text>`;
  });
  return { svg: `${open(width, height, spec.title)}${body}</svg>`, width, height };
}

function renderDonut(spec: SvgChartSpec): { svg: string; width: number; height: number } {
  const data = (spec.data ?? []).filter((d) => d.value > 0).slice(0, 8);
  const width = Math.max(spec.width ?? 480, 320); // legend text starts at x=248
  const height = spec.title ? 240 : 216;
  const palette = resolvePalette(spec);
  const total = data.reduce((s, d) => s + d.value, 0) || 1;
  const cx = 118;
  const cy = height / 2 + (spec.title ? 10 : 0);
  const r = 70;
  const C = 2 * Math.PI * r;
  let acc = 0;
  let rings = "";
  let legend = "";
  data.forEach((d, i) => {
    const frac = d.value / total;
    const color = palette[i % palette.length]!;
    rings += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="26" stroke-dasharray="${fmt(frac * C)} ${fmt(C)}" stroke-dashoffset="${fmt(-acc * C)}" transform="rotate(-90 ${cx} ${cy})"/>`;
    const ly = cy - (data.length * 22) / 2 + i * 22 + 6;
    legend +=
      `<rect x="228" y="${ly - 10}" width="12" height="12" rx="3" fill="${color}"/>` +
      `<text x="248" y="${ly + 1}" ${FONT} font-size="12" fill="${INK}">${esc(clip(d.label, 16))}</text>` +
      `<text x="${width - 12}" y="${ly + 1}" text-anchor="end" ${FONT} font-size="11.5" fill="${INK_2}">${fmt(d.value)} · ${Math.round(frac * 100)}%</text>`;
    acc += frac;
  });
  const center = `<text x="${cx}" y="${cy + 5}" text-anchor="middle" ${FONT} font-size="18" font-weight="700" fill="${INK}">${fmt(total)}</text>`;
  return { svg: `${open(width, height, spec.title)}${rings}${center}${legend}</svg>`, width, height };
}

function renderLine(spec: SvgChartSpec): { svg: string; width: number; height: number } {
  const data = (spec.data ?? []).slice(0, 24);
  const width = Math.max(spec.width ?? 640, 240); // keeps the x-axis wider than the left gutter
  const height = spec.title ? 260 : 236;
  const palette = resolvePalette(spec);
  const top = spec.title ? 44 : 20;
  const bottom = height - 34;
  const left = 46;
  const right = width - 20;
  const max = Math.max(...data.map((d) => Math.max(0, d.value)), 1);
  const x = (i: number) => (data.length <= 1 ? (left + right) / 2 : left + (i / (data.length - 1)) * (right - left));
  const y = (v: number) => bottom - (Math.max(0, v) / max) * (bottom - top);
  let grid = "";
  for (let g = 0; g <= 4; g++) {
    const gy = top + (g / 4) * (bottom - top);
    grid +=
      `<line x1="${left}" y1="${fmt(gy)}" x2="${right}" y2="${fmt(gy)}" stroke="${GRID}" stroke-width="1"/>` +
      `<text x="${left - 6}" y="${fmt(gy + 4)}" text-anchor="end" ${FONT} font-size="10.5" fill="${INK_2}">${fmt(max * (1 - g / 4))}</text>`;
  }
  const pts = data.map((d, i) => `${fmt(x(i))},${fmt(y(d.value))}`).join(" ");
  const dots = data
    .map(
      (d, i) =>
        `<circle cx="${fmt(x(i))}" cy="${fmt(y(d.value))}" r="3.5" fill="${palette[0]}"/>` +
        `<text x="${fmt(x(i))}" y="${bottom + 16}" text-anchor="middle" ${FONT} font-size="10.5" fill="${INK_2}">${esc(clip(d.label, 8))}</text>`,
    )
    .join("");
  const line = data.length > 1 ? `<polyline points="${pts}" fill="none" stroke="${palette[0]}" stroke-width="2.5" stroke-linejoin="round"/>` : "";
  return { svg: `${open(width, height, spec.title)}${grid}${line}${dots}</svg>`, width, height };
}

function renderFlow(spec: SvgChartSpec): { svg: string; width: number; height: number } {
  const steps = (spec.steps ?? []).slice(0, 12);
  const width = Math.max(spec.width ?? 640, 580); // 3 × 172px boxes + margins + ≥20px gaps
  const perRow = 3;
  const boxW = 172;
  const boxH = 44;
  const gapX = (width - 24 - perRow * boxW) / Math.max(1, perRow - 1);
  const gapY = 34;
  const top = spec.title ? 42 : 16;
  const rows = Math.ceil(steps.length / perRow);
  const height = top + rows * boxH + (rows - 1) * gapY + 16;
  let body = "";
  const pos = (i: number) => {
    const row = Math.floor(i / perRow);
    const col = i % perRow;
    return { x: 12 + col * (boxW + gapX), y: top + row * (boxH + gapY), row, col };
  };
  const arrow = `marker-end="url(#vizarr)"`;
  steps.forEach((s, i) => {
    const { x, y } = pos(i);
    body +=
      `<rect x="${fmt(x)}" y="${y}" width="${boxW}" height="${boxH}" rx="9" fill="#f6f8fc" stroke="#c9d6ee"/>` +
      // Smaller font, longer clip: event names like MATCH_PASSED_NEED_INTERVIEW must survive —
      // truncated labels leaked into report PROSE when the model quoted them off the chart.
      `<text x="${fmt(x + boxW / 2)}" y="${y + boxH / 2 + 4}" text-anchor="middle" ${FONT} font-size="9.5" fill="${INK}">${esc(clip(s, 30))}</text>`;
    if (i < steps.length - 1) {
      const a = pos(i);
      const b = pos(i + 1);
      if (a.row === b.row) {
        body += `<line x1="${fmt(a.x + boxW)}" y1="${a.y + boxH / 2}" x2="${fmt(b.x - 6)}" y2="${b.y + boxH / 2}" stroke="#9db4dd" stroke-width="1.5" ${arrow}/>`;
      } else {
        const mid = a.y + boxH + gapY / 2;
        body += `<polyline points="${fmt(a.x + boxW / 2)},${a.y + boxH} ${fmt(a.x + boxW / 2)},${mid} ${fmt(b.x + boxW / 2)},${mid} ${fmt(b.x + boxW / 2)},${b.y - 6}" fill="none" stroke="#9db4dd" stroke-width="1.5" ${arrow}/>`;
      }
    }
  });
  const defs = `<defs><marker id="vizarr" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#9db4dd"/></marker></defs>`;
  return { svg: `${open(width, height, spec.title)}${defs}${body}</svg>`, width, height };
}

/** Pure renderer — reused by the report pipeline server-side and the viz.svgChart tool. */
export function renderSvgChart(spec: SvgChartSpec): { svg: string; width: number; height: number } {
  switch (spec.kind) {
    case "bar":
      return renderBar(spec);
    case "donut":
      return renderDonut(spec);
    case "line":
      return renderLine(spec);
    case "flow":
      return renderFlow(spec);
    default:
      throw new Error(`viz.svgChart: unknown kind '${String((spec as { kind?: unknown }).kind)}' (bar|donut|line|flow)`);
  }
}

export const svgChart = defineTool({
  name: "viz.svgChart",
  description:
    "Render a deterministic inline-SVG chart from data. " +
    'REQUIRED: { kind: "bar"|"donut"|"line"|"flow" } plus data: [{label, value}] (bar/donut/line) or steps: string[] (flow). ' +
    "Optional: { title, width, palette }. Returns { svg, width, height } — embed `svg` verbatim in HTML reports.",
  output: z.object({
    svg: z.string(),
    width: z.number(),
    height: z.number(),
  }),
  async handler(ctx) {
    const args = (ctx.event?.data ?? {}) as Record<string, unknown>;
    const kind = String(args.kind ?? "");
    if (!["bar", "donut", "line", "flow"].includes(kind)) {
      throw new Error("viz.svgChart: required arg `kind` must be one of bar|donut|line|flow.");
    }
    const data = Array.isArray(args.data)
      ? (args.data as Array<Record<string, unknown>>)
          .map((d) => ({ label: String(d.label ?? ""), value: Number(d.value ?? 0) }))
          .filter((d) => d.label && Number.isFinite(d.value))
      : undefined;
    if ((kind === "bar" || kind === "line") && data?.some((d) => d.value < 0)) {
      const bad = data.find((d) => d.value < 0)!;
      throw new Error(`viz.svgChart: ${kind} requires non-negative values (got ${bad.value} for '${bad.label}') — plot magnitudes or offset the series.`);
    }
    const steps = Array.isArray(args.steps) ? (args.steps as unknown[]).map((s) => String(s)).filter(Boolean) : undefined;
    if (kind === "flow" ? !steps?.length : !data?.length) {
      throw new Error(kind === "flow" ? "viz.svgChart: flow requires non-empty `steps: string[]`." : "viz.svgChart: requires non-empty `data: [{label, value}]`.");
    }
    const out = renderSvgChart({
      kind: kind as SvgChartSpec["kind"],
      title: typeof args.title === "string" ? args.title : undefined,
      data,
      steps,
      width: typeof args.width === "number" && Number.isFinite(args.width) ? args.width : undefined,
      palette: Array.isArray(args.palette) ? (args.palette as string[]) : undefined,
    });
    return { data: out };
  },
});
