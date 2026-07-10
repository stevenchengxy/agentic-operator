"use client";

import { useCallback, useRef, useState, type CSSProperties, type ReactNode } from "react";

/**
 * HelpTip — a muted "?" that reveals explanatory copy on hover / focus.
 *
 * Replaces always-visible hint paragraphs so dense factory views read calm: the
 * explanation is one hover away instead of on screen permanently. The bubble is
 * `position: fixed` (coords from the trigger's rect, clamped to the viewport) so
 * it never clips inside `overflow:auto` rails/panes. Styling + reveal animation
 * live in global.css (`.help-tip` / `.help-tip-bubble`); theme-aware via tokens.
 */

const BUBBLE_W = 260;
const MARGIN = 10;

export function HelpTip({
  children,
  size = 15,
  style,
}: {
  children: ReactNode;
  /** diameter of the "?" chip in px */
  size?: number;
  style?: CSSProperties;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  const show = useCallback(() => {
    const el = ref.current;
    if (!el || typeof window === "undefined") return;
    const r = el.getBoundingClientRect();
    let left = r.left + r.width / 2 - BUBBLE_W / 2;
    left = Math.max(MARGIN, Math.min(left, window.innerWidth - BUBBLE_W - MARGIN));
    setPos({ left, top: r.bottom + 7 });
  }, []);
  const hide = useCallback(() => setPos(null), []);

  return (
    <span
      ref={ref}
      className="help-tip"
      tabIndex={0}
      role="note"
      aria-label={typeof children === "string" ? children : "说明"}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      // never let the chip trigger an enclosing button (e.g. a collapsible header)
      onClick={(e) => e.stopPropagation()}
      style={{ width: size, height: size, ...style }}
    >
      <span aria-hidden="true">?</span>
      {pos && (
        <span className="help-tip-bubble" role="tooltip" style={{ left: pos.left, top: pos.top, width: BUBBLE_W }}>
          {children}
        </span>
      )}
    </span>
  );
}
