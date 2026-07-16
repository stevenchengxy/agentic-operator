"use client";

import { useState } from "react";

/**
 * Splitter — thin drag handle for resizing adjacent panels.
 *
 * Ported verbatim from `apps/web/public/portal/views/agent-code.jsx:141-194`
 * (delta D-5/D-6). Maintains pixel-perfect identity with the prototype: a 6px
 * hit area with a 1px line that goes signal-lime on hover/drag.
 *
 * axis:
 *   "x" — column splitter, dragging moves horizontally
 *   "y" — row splitter, dragging moves vertically
 *
 * invert:
 *   when true, drag direction is reversed. Use for a sidebar on the RIGHT
 *   where dragging LEFT should INCREASE the sidebar width.
 */
export interface SplitterProps {
  axis: "x" | "y";
  getValue: () => number;
  setValue: (v: number) => void;
  min: number;
  max: number;
  invert?: boolean;
  /**
   * Pointer hit-area thickness. The visual divider remains one pixel, while
   * dense enterprise layouts can opt into a more forgiving drag target.
   */
  hitSize?: number;
  /**
   * P2-FE-24 — accessible label for screen readers. Falls back to a
   * generic "panel splitter" when omitted. Provide context for what's
   * being resized (e.g. "Agent list and detail").
   */
  ariaLabel?: string;
  /** Space-separated ids of the adjacent regions controlled by the splitter. */
  ariaControls?: string;
}

export function Splitter({
  axis,
  getValue,
  setValue,
  min,
  max,
  invert,
  hitSize = 6,
  ariaLabel,
  ariaControls,
}: SplitterProps) {
  const [hov, setHov] = useState(false);
  const isX = axis === "x";

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (!e.isPrimary || e.button !== 0) return;
    e.preventDefault();
    const pointerId = e.pointerId;
    const target = e.currentTarget;
    target.setPointerCapture(pointerId);
    const startPos = isX ? e.clientX : e.clientY;
    const start = getValue();
    function move(ev: PointerEvent) {
      if (ev.pointerId !== pointerId) return;
      const cur = isX ? ev.clientX : ev.clientY;
      const delta = invert
        ? start - (cur - startPos)
        : start + (cur - startPos);
      setValue(Math.max(min, Math.min(max, delta)));
    }
    function cleanUp() {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      target.removeEventListener("lostpointercapture", cleanUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    }
    function finish(ev: PointerEvent) {
      if (ev.pointerId !== pointerId) return;
      cleanUp();
      if (target.hasPointerCapture(pointerId)) {
        target.releasePointerCapture(pointerId);
      }
    }
    document.body.style.userSelect = "none";
    document.body.style.cursor = isX ? "col-resize" : "row-resize";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    target.addEventListener("lostpointercapture", cleanUp);
  }

  // P2-FE-24 — keyboard-resizable splitter. Arrow keys nudge by 16px,
  // Home/End jump to min/max. Lets keyboard-only users resize panels.
  function onKeyDown(e: React.KeyboardEvent) {
    const step = 16;
    const cur = getValue();
    let next = cur;
    if (isX) {
      if (e.key === "ArrowLeft") next = invert ? cur + step : cur - step;
      else if (e.key === "ArrowRight") next = invert ? cur - step : cur + step;
      else if (e.key === "Home") next = min;
      else if (e.key === "End") next = max;
      else return;
    } else {
      if (e.key === "ArrowUp") next = invert ? cur + step : cur - step;
      else if (e.key === "ArrowDown") next = invert ? cur - step : cur + step;
      else if (e.key === "Home") next = min;
      else if (e.key === "End") next = max;
      else return;
    }
    e.preventDefault();
    setValue(Math.max(min, Math.min(max, next)));
  }

  return (
    <div
      onPointerDown={onPointerDown}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      onKeyDown={onKeyDown}
      tabIndex={0}
      style={{
        flexShrink: 0,
        cursor: isX ? "col-resize" : "row-resize",
        width: isX ? hitSize : "100%",
        height: isX ? "100%" : hitSize,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "transparent",
        touchAction: "none",
        position: "relative",
        // The splitter rides above the panels it divides so the 6px hit
        // area receives mouse events even when the adjacent content is a
        // larger z stack. --z-base bumps it to 0 (still beneath overlays).
        zIndex: "var(--z-base)" as unknown as number,
      }}
      role="separator"
      aria-orientation={isX ? "vertical" : "horizontal"}
      aria-label={ariaLabel ?? "panel splitter"}
      aria-controls={ariaControls}
      aria-valuenow={getValue()}
      aria-valuemin={min}
      aria-valuemax={max}
    >
      <div
        style={{
          width: isX ? 1 : "100%",
          height: isX ? "100%" : 1,
          background: hov ? "var(--signal)" : "var(--border-2)",
          transition: "background 0.12s",
        }}
      />
    </div>
  );
}
