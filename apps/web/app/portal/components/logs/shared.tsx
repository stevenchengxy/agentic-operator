"use client";

/**
 * Shared scaffolding for the Logs + observability explorer tabs. Keeps the table
 * chrome (scroll container, toolbar, header/cell styles, time formatting)
 * consistent across 操作 / 事件 / 运行 / 实时.
 */

import type { ReactNode } from "react";
import { fmtAgo } from "@/lib/format";
import { CodeBlock, Icon } from "@/app/portal/components";
import { useI18n } from "@/app/portal/lib/preferences-context";

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
  const { language } = useI18n();
  if (!ms || Number.isNaN(ms)) return <span style={monoStyle}>—</span>;
  return (
    <span
      style={monoStyle}
      title={new Date(ms).toLocaleString(
        language === "zh" ? "zh-CN" : "en-US",
      )}
    >
      {fmtAgo(ms, language)}
    </span>
  );
}

// ─── Expand-to-detail scaffolding ────────────────────────────────────────────
// Every log row can be opened to reveal the FULL record (complete JSON /
// payload / metadata), not the truncated table summary.

/** A chevron in the row's lead column signalling expandability. */
export function ExpandCaret({ open }: { open: boolean }) {
  return (
    <Icon
      name={open ? "chevron-down" : "chevron-right"}
      size={11}
      style={{ color: "var(--text-3)" }}
    />
  );
}

/** A row whose <td> spans the whole table to host the expanded detail. */
export function DetailCell({
  colSpan,
  children,
}: {
  colSpan: number;
  children: ReactNode;
}) {
  return (
    <tr>
      <td
        colSpan={colSpan}
        style={{
          padding: 0,
          background: "var(--bg-2)",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <div
          style={{
            padding: "12px 18px 16px 38px",
            display: "flex",
            flexDirection: "column",
            gap: 10,
          }}
          className="rise"
        >
          {children}
        </div>
      </td>
    </tr>
  );
}

/** A labelled value line inside a detail block. */
export function Field({
  label,
  children,
}: {
  label: ReactNode;
  children: ReactNode;
}) {
  return (
    <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
      <span
        style={{
          fontSize: 9.5,
          fontFamily: "var(--mono)",
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          color: "var(--text-3)",
          minWidth: 96,
        }}
      >
        {label}
      </span>
      <span style={{ fontSize: 12, color: "var(--text)", fontFamily: "var(--mono)", wordBreak: "break-all" }}>
        {children}
      </span>
    </div>
  );
}

/** Pretty-printed JSON (or a muted dash for empty values). */
export function JsonView({ label, value }: { label?: ReactNode; value: unknown }) {
  const empty =
    value == null ||
    (typeof value === "object" && Object.keys(value as object).length === 0);
  return (
    <div>
      {label && (
        <div
          style={{
            fontSize: 9.5,
            fontFamily: "var(--mono)",
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            color: "var(--text-3)",
            marginBottom: 4,
          }}
        >
          {label}
        </div>
      )}
      {empty ? (
        <span style={{ ...monoStyle, color: "var(--text-4)" }}>—</span>
      ) : (
        <CodeBlock>
          {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
        </CodeBlock>
      )}
    </div>
  );
}
