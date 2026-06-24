"use client";

/**
 * Shared scaffolding for the 4-facet Logs explorer tabs. Keeps the table
 * chrome (scroll container, toolbar, header/cell styles, time formatting)
 * consistent across 操作 / 事件 / 运行 / 实时.
 */

import type { ReactNode } from "react";
import { fmtAgo } from "@/lib/format";

/** Full-height column: a sticky toolbar over a single scroll region. */
export function LogPane({
  toolbar,
  children,
}: {
  toolbar?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      style={{
        flex: 1,
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
      }}
    >
      {toolbar && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "10px 24px",
            borderBottom: "1px solid var(--border)",
            flexShrink: 0,
            flexWrap: "wrap",
          }}
        >
          {toolbar}
        </div>
      )}
      <div style={{ flex: 1, overflow: "auto", minHeight: 0 }}>{children}</div>
    </div>
  );
}

/** A compact text input used for the per-tab filter. */
export function LogSearch({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      style={{
        flex: "1 1 240px",
        maxWidth: 360,
        background: "var(--panel-2)",
        border: "1px solid var(--border-2)",
        borderRadius: 4,
        padding: "5px 9px",
        color: "var(--text)",
        fontFamily: "var(--mono)",
        fontSize: 11.5,
        outline: "none",
      }}
    />
  );
}

export function MetaPill({ children }: { children: ReactNode }) {
  return (
    <span
      style={{
        fontSize: 11,
        color: "var(--text-3)",
        fontFamily: "var(--mono)",
      }}
    >
      {children}
    </span>
  );
}

/** Header row for a log table. */
export const thStyle: React.CSSProperties = {
  textAlign: "left",
  padding: "7px 14px",
  fontSize: 9.5,
  fontFamily: "var(--mono)",
  textTransform: "uppercase",
  letterSpacing: "0.1em",
  color: "var(--text-3)",
  fontWeight: 500,
  position: "sticky",
  top: 0,
  background: "var(--bg)",
  borderBottom: "1px solid var(--border)",
  whiteSpace: "nowrap",
};

export const tdStyle: React.CSSProperties = {
  padding: "8px 14px",
  fontSize: 12,
  color: "var(--text-2)",
  borderBottom: "1px solid var(--border)",
  verticalAlign: "top",
};

export const monoStyle: React.CSSProperties = {
  fontFamily: "var(--mono)",
  fontSize: 11,
  color: "var(--text-3)",
  whiteSpace: "nowrap",
};

/** Relative + absolute time. Title carries the full local timestamp. */
export function TimeCell({ ms }: { ms: number }) {
  if (!ms || Number.isNaN(ms)) return <span style={monoStyle}>—</span>;
  return (
    <span style={monoStyle} title={new Date(ms).toLocaleString()}>
      {fmtAgo(ms)}
    </span>
  );
}
