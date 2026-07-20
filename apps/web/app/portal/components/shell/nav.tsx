"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon, type IconName } from "../Icon";

/**
 * Sidebar nav primitives — NavGroup + NavItem.
 *
 * Ported from v1_1 app.jsx:240-289. v1_1 used state-driven view switching;
 * here every NavItem is an anchor to `/portal/[tenant]/<view>`, so the
 * browser owns back/forward + bookmarking (audit §8 #11).
 */

export function NavGroup({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div
        style={{
          padding: "6px 10px 4px 10px",
          fontSize: 10,
          fontFamily: "var(--mono)",
          textTransform: "uppercase",
          color: "var(--text-3)",
          letterSpacing: "0.12em",
        }}
      >
        {label}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
        {children}
      </div>
    </div>
  );
}

export interface NavItemProps {
  href: string;
  icon: IconName;
  label: string;
  /** Static count pill (e.g. "Agents (22)"). Numeric or string. */
  count?: number | string | null;
  /** Pulsing-dot pill on the right when > 0 (e.g. running runs). */
  liveCount?: number | null;
  /** Tint the count pill amber to indicate user-attention. */
  highlight?: boolean;
  /**
   * Match the URL with startsWith() instead of equality. Useful for nav
   * items that have detail sub-routes (`/portal/raas/runs/run-…`).
   */
  matchPrefix?: boolean;
}

export function NavItem({
  href,
  icon,
  label,
  count,
  liveCount,
  highlight,
  matchPrefix,
}: NavItemProps) {
  const pathname = usePathname() ?? "";
  const active = matchPrefix
    ? pathname.startsWith(href)
    : pathname === href;

  const body = (
    <>
      <Icon
        name={icon}
        size={13}
        style={{ color: active ? "var(--text)" : "var(--text-3)" }}
      />
      <span style={{ flex: 1 }}>{label}</span>
      {liveCount != null && liveCount > 0 && (
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            fontSize: 10.5,
            fontFamily: "var(--mono)",
            color: "var(--accent-text)",
          }}
        >
          <span className="live-dot" style={{ width: 5, height: 5 }} />
          {liveCount}
        </span>
      )}
      {count != null && (
        <span
          style={{
            fontSize: 10,
            fontFamily: "var(--mono)",
            padding: "1px 6px",
            background: highlight
              ? "color-mix(in srgb, var(--amber) 12%, transparent)"
              : "var(--panel-2)",
            color: highlight ? "var(--amber)" : "var(--text-3)",
            borderRadius: 8,
            border: highlight
              ? "1px solid color-mix(in srgb, var(--amber) 30%, transparent)"
              : "1px solid var(--border)",
          }}
        >
          {count}
        </span>
      )}
    </>
  );

  const baseStyle = {
    display: "flex",
    alignItems: "center",
    gap: 9,
    padding: "6px 10px",
    background: active ? "var(--panel-2)" : "transparent",
    borderLeft: active
      ? "2px solid var(--signal)"
      : "2px solid transparent",
    color: active ? "var(--text)" : "var(--text-2)",
    fontSize: 12.5,
    textAlign: "left" as const,
    cursor: "pointer",
    transition: "background 0.1s",
  };

  return (
    <Link href={href as never} style={baseStyle} tabIndex={0}>
      {body}
    </Link>
  );
}
