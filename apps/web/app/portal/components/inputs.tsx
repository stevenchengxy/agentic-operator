"use client";

import type { CSSProperties, ReactNode } from "react";
import { Icon } from "@/components/Icon";

/**
 * Shared input primitives: SearchInput, FilterChip, CodeBlock.
 *
 * Ported verbatim from `apps/web/public/portal/views/runs.jsx:97-131,340-358`.
 * These are global SPA primitives used by Agents, Settings, Runs, Tasks.
 */

export interface SearchInputProps {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  style?: CSSProperties;
  /**
   * P2-FE-24 — accessible name. Falls back to the placeholder, which
   * axe accepts as a label of last resort. Pass a more descriptive
   * value (e.g. "Search runs") when the placeholder is generic
   * (e.g. "grep…").
   */
  ariaLabel?: string;
}

export function SearchInput({
  value,
  onChange,
  placeholder,
  style,
  ariaLabel,
}: SearchInputProps) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        flex: 1,
        padding: "5px 8px",
        background: "var(--panel-2)",
        border: "1px solid var(--border)",
        borderRadius: 4,
        ...style,
      }}
    >
      <Icon name="search" size={12} style={{ color: "var(--text-3)" }} />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={ariaLabel ?? placeholder ?? "Search"}
        style={{
          flex: 1,
          background: "transparent",
          border: "none",
          outline: "none",
          color: "var(--text)",
          fontSize: 12,
          fontFamily: "var(--sans)",
          minWidth: 0,
        }}
      />
    </div>
  );
}

export interface FilterChipProps {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}

export function FilterChip({ active, onClick, children }: FilterChipProps) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: "3px 9px",
        fontSize: 11,
        fontFamily: "var(--mono)",
        textTransform: "uppercase",
        letterSpacing: "0.04em",
        color: active ? "var(--on-signal)" : "var(--text-2)",
        background: active ? "var(--signal)" : "transparent",
        border: `1px solid ${active ? "var(--signal)" : "var(--border-2)"}`,
        borderRadius: 3,
        cursor: "pointer",
      }}
    >
      {children}
    </button>
  );
}

export function CodeBlock({
  children,
  maxHeight = 360,
}: {
  children: ReactNode;
  maxHeight?: number | string;
}) {
  return (
    <pre
      style={{
        margin: 0,
        padding: 12,
        background: "var(--bg-2)",
        border: "1px solid var(--border)",
        borderRadius: 4,
        fontFamily: "var(--mono)",
        fontSize: 11.5,
        lineHeight: 1.6,
        color: "var(--text-2)",
        whiteSpace: "pre",
        overflow: "auto",
        maxHeight,
      }}
    >
      {children}
    </pre>
  );
}

export function Th({
  children,
  style,
}: {
  children?: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <th
      style={{
        textAlign: "left",
        padding: "8px 12px",
        fontSize: 10.5,
        fontFamily: "var(--mono)",
        fontWeight: 500,
        color: "var(--text-3)",
        textTransform: "uppercase",
        letterSpacing: "0.08em",
        ...style,
      }}
    >
      {children}
    </th>
  );
}

export function Td({
  children,
  style,
  colSpan,
  onClick,
}: {
  children?: ReactNode;
  style?: CSSProperties;
  colSpan?: number;
  onClick?: () => void;
}) {
  return (
    <td
      colSpan={colSpan}
      onClick={onClick}
      style={{ padding: "8px 12px", verticalAlign: "middle", ...style }}
    >
      {children}
    </td>
  );
}
