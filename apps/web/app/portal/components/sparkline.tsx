/**
 * Sparkline — inline SVG line, optionally filled. v1_1 components.jsx:239-258.
 *
 * Returns null when `values` is empty so callers don't need a guard.
 * The math (`computeSparkPaths`) is exported separately so it can be tested
 * without rendering a DOM.
 */

export interface SparklineProps {
  values: number[];
  width?: number;
  height?: number;
  color?: string;
  filled?: boolean;
  /** Animate the line drawing in (CSS `.spark-draw`, see global.css). */
  animate?: boolean;
}

export interface SparkPaths {
  line: string;
  area: string;
}

export function computeSparkPaths(
  values: number[],
  width: number,
  height: number,
): SparkPaths | null {
  if (!values || values.length === 0) return null;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = Math.max(1, max - min);
  const pad = 1.5;
  const stepX = (width - pad * 2) / Math.max(1, values.length - 1);
  const pts = values.map(
    (v, i) =>
      `${pad + i * stepX},${pad + (height - pad * 2) * (1 - (v - min) / range)}`,
  );
  const line = "M" + pts.join(" L");
  const area = `${line} L${pad + (values.length - 1) * stepX},${height - pad} L${pad},${height - pad} Z`;
  return { line, area };
}

export function Sparkline({
  values,
  width = 80,
  height = 22,
  color = "var(--signal)",
  filled = true,
  animate = false,
}: SparklineProps) {
  const paths = computeSparkPaths(values, width, height);
  if (!paths) return null;
  return (
    <svg width={width} height={height} style={{ display: "block", overflow: "visible" }}>
      {filled && <path d={paths.area} fill={color} opacity={0.12} />}
      <path
        className={animate ? "spark-draw" : undefined}
        d={paths.line}
        stroke={color}
        fill="none"
        strokeWidth={1.25}
        strokeLinecap="round"
      />
    </svg>
  );
}
