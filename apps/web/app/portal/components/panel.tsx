import type { CSSProperties, ReactNode } from "react";

/**
 * Panel — workhorse container. v1_1 components.jsx:148-182.
 *
 * Header renders only when `title` is set. `scroll=true` switches the body
 * to `overflow: auto`. Always renders as `<section>` (no polymorphic prop).
 */

export interface PanelProps {
  title?: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
  style?: CSSProperties;
  padded?: boolean;
  scroll?: boolean;
  /** Pass-through for animation/hover utility classes (see global.css). */
  className?: string;
}

export function Panel({
  title,
  subtitle,
  action,
  children,
  style,
  padded = true,
  scroll = false,
  className,
}: PanelProps) {
  return (
    <section
      // Every panel fades/rises in on mount so all views share the dashboard's
      // entrance motion; callers can append `dash-card` for hover-lift etc.
      className={className ? `rise ${className}` : "rise"}
      style={{
        background: "var(--panel)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        overflow: scroll ? "hidden" : "visible",
        display: "flex",
        flexDirection: "column",
        ...style,
      }}
    >
      {title && (
        <header
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "10px 14px",
            borderBottom: "1px solid var(--border)",
            minHeight: 38,
            flexShrink: 0,
          }}
        >
          <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
            <span
              style={{
                fontSize: 11,
                fontFamily: "var(--mono)",
                textTransform: "uppercase",
                letterSpacing: "0.08em",
                color: "var(--text-2)",
              }}
            >
              {title}
            </span>
            {subtitle && (
              <span style={{ fontSize: 11, color: "var(--text-3)" }}>
                {subtitle}
              </span>
            )}
          </div>
          {action && <div>{action}</div>}
        </header>
      )}
      <div
        style={{
          padding: padded ? 14 : 0,
          flex: 1,
          overflow: scroll ? "auto" : "visible",
          minHeight: 0,
        }}
      >
        {children}
      </div>
    </section>
  );
}
