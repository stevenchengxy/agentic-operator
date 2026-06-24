"use client";

import { useState } from "react";
import type { CSSProperties, MouseEventHandler, ReactNode } from "react";
import { Icon, type IconName } from "./Icon";

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
    border: "color-mix(in srgb, var(--red) 35%, transparent)",
    hover: "color-mix(in srgb, var(--red) 8%, transparent)",
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
}: ButtonProps) {
  const t = TONES[tone];
  const [hov, setHov] = useState(false);
  return (
    <button
      type={type}
      onClick={onClick}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      title={title}
      disabled={disabled}
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
