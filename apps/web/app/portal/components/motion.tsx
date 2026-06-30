"use client";

/**
 * Motion primitives — shared so the whole portal animates consistently.
 *
 * - <CountUp> eases a number from its previous value (0 on first mount).
 * - <GrowBar> grows a fill bar from 0 to `pct`% on mount/update.
 *
 * Both respect `prefers-reduced-motion` implicitly: CountUp's final frame is
 * the target value, and GrowBar's CSS transition is a no-op when the user has
 * reduced motion (the width still lands correctly). Entrance/hover utilities
 * (`.rise`, `.dash-card`, `.health-pulse`, `.spark-draw`) live in global.css.
 */

import { useEffect, useRef, useState } from "react";

export function CountUp({
  value,
  format,
  durationMs = 800,
}: {
  value: number;
  format?: (n: number) => string;
  durationMs?: number;
}) {
  const [display, setDisplay] = useState(0);
  const prev = useRef(0);
  useEffect(() => {
    const from = prev.current;
    const to = value;
    if (from === to) {
      setDisplay(to);
      return;
    }
    let raf = 0;
    const t0 = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / durationMs);
      const e = 1 - Math.pow(1 - p, 3);
      setDisplay(from + (to - from) * e);
      if (p < 1) raf = requestAnimationFrame(tick);
      else prev.current = to;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, durationMs]);
  return <>{format ? format(display) : Math.round(display).toString()}</>;
}

export function GrowBar({
  pct,
  color = "var(--signal)",
  height = 8,
  track = "var(--panel-3)",
}: {
  pct: number;
  color?: string;
  height?: number;
  track?: string;
}) {
  const [w, setW] = useState(0);
  const target = Math.max(0, Math.min(100, pct));
  useEffect(() => {
    const id = requestAnimationFrame(() => setW(target));
    return () => cancelAnimationFrame(id);
  }, [target]);
  return (
    <div style={{ height, background: track, borderRadius: 99, overflow: "hidden" }}>
      <div
        style={{
          height: "100%",
          width: `${w}%`,
          background: color,
          borderRadius: 99,
          transition: "width 1s cubic-bezier(0.2, 0.7, 0.2, 1)",
        }}
      />
    </div>
  );
}
