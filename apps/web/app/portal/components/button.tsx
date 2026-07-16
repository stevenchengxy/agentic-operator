"use client";

import { useState } from "react";
import type { CSSProperties, MouseEventHandler, ReactNode } from "react";
import { Icon, type IconName } from "./Icon";

/**
 * Button — primary interactive primitive. v1_1 components.jsx:204-236.
 *
 * Tones: default / primary / ghost / danger. `small=true` drops padding
 * and font size. Hover is local React state (matches v1_1); `disabled`
 * is an extra over v1_1 because every other prototype caller eventually
 * needed it.
 */

type ButtonTone = "default" | "primary" | "ghost" | "danger";

const TONES: Record<
  ButtonTone,
  { bg: string; fg: string; border: string; hover: string }
> = {
  default: {
    bg: "transparent",
    fg: "var(--text)",
    border: "var(--border-2)",
    hover: "var(--panel-2)",
  },
  primary: {
    bg: "var(--signal)",
    fg: "#000",
    border: "var(--signal)",
    hover: "var(--signal)",
  },
  ghost: {
    bg: "transparent",
    fg: "var(--text-2)",
    border: "transparent",
    hover: "var(--panel-2)",
  },
  danger: {
    bg: "transparent",
    fg: "var(--red)",
    border: "rgba(255,100,112,0.35)",
    hover: "rgba(255,100,112,0.08)",
  },
};

export interface ButtonProps {
  children?: ReactNode;
  tone?: ButtonTone;
  icon?: IconName;
  onClick?: MouseEventHandler<HTMLButtonElement>;
  small?: boolean;
  style?: CSSProperties;
  title?: string;
  type?: "button" | "submit" | "reset";
  disabled?: boolean;
  /**
   * P2-FE-24 — explicit accessible name for screen readers. Mandatory
   * for icon-only buttons (no `children`). When absent on an icon-only
   * button the component falls back to `title` (which Foundation already
   * threaded for hover tooltips), then to a generic "button" — which is
   * sufficient to silence axe but a poor user experience. Callers
   * should always pass `ariaLabel` for icon-only invocations.
   */
  ariaLabel?: string;
  ariaControls?: string;
  ariaExpanded?: boolean;
}

export function Button({
  children,
  tone = "default",
  icon,
  onClick,
  small,
  style,
  title,
  type = "button",
  disabled,
  ariaLabel,
  ariaControls,
  ariaExpanded,
}: ButtonProps) {
  const t = TONES[tone];
  const [hov, setHov] = useState(false);
  // P2-FE-24 — derive an accessible name for the rare icon-only case.
  // When `children` is non-empty we let the rendered text serve as the
  // accessible name (no aria-label needed); only icon-only buttons get
  // an explicit aria-label.
  const accessibleLabel = !children ? (ariaLabel ?? title) : ariaLabel;
  return (
    <button
      type={type}
      onClick={onClick}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      title={title}
      disabled={disabled}
      aria-label={accessibleLabel}
      aria-controls={ariaControls}
      aria-expanded={ariaExpanded}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: small ? "4px 8px" : "5px 11px",
        fontSize: small ? 11 : 12,
        fontFamily: "var(--sans)",
        fontWeight: 500,
        color: t.fg,
        background: hov && !disabled ? t.hover : t.bg,
        border: `1px solid ${t.border}`,
        borderRadius: 5,
        transition: "background 0.12s",
        whiteSpace: "nowrap",
        opacity: disabled ? 0.45 : 1,
        cursor: disabled ? "not-allowed" : "pointer",
        ...style,
      }}
    >
      {icon && <Icon name={icon} size={small ? 11 : 12} />}
      {children}
    </button>
  );
}

export type { ButtonTone };
