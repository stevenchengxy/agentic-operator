import type { ReactNode } from "react";

/**
 * ViewHeader — top-of-page title strip. v1_1 components.jsx:309-335.
 *
 * Fixed padding `18 24 16 24`, bottom border, optional badge inline with
 * the title and an action node on the right.
 */

export interface ViewHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  badge?: ReactNode;
  action?: ReactNode;
}

export function ViewHeader({
  title,
  subtitle,
  badge,
  action,
}: ViewHeaderProps) {
  return (
    <header
      className="rise"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        flexWrap: "wrap",
        padding: "18px 24px 16px 24px",
        borderBottom: "1px solid var(--border)",
        flexShrink: 0,
        gap: 16,
      }}
    >
      <div style={{ minWidth: 0, flex: "1 1 280px" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            flexWrap: "wrap",
          }}
        >
          <h1
            style={{
              margin: 0,
              fontSize: 22,
              fontFamily: "var(--display)",
              fontWeight: 400,
              letterSpacing: "-0.015em",
              color: "var(--text)",
              lineHeight: 1.1,
              overflowWrap: "anywhere",
            }}
          >
            {title}
          </h1>
          {badge && (
            <span style={{ display: "inline-flex", alignItems: "center" }}>
              {badge}
            </span>
          )}
        </div>
        {subtitle && (
          <div
            style={{
              marginTop: 5,
              fontSize: 12.5,
              color: "var(--text-2)",
              lineHeight: 1.5,
            }}
          >
            {subtitle}
          </div>
        )}
      </div>
      {action && (
        <div
          style={{
            display: "flex",
            minWidth: 0,
            flex: "0 1 auto",
            flexWrap: "wrap",
            justifyContent: "flex-end",
            gap: 8,
          }}
        >
          {action}
        </div>
      )}
    </header>
  );
}
