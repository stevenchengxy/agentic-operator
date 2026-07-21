"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon, type IconName } from "../Icon";
import styles from "./sidebar.module.css";
import { useI18n } from "@/app/portal/lib/preferences-context";

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
    <div className={styles.navGroup} role="group" aria-label={label}>
      <div className={styles.navGroupLabel} aria-hidden="true">
        {label}
      </div>
      <div className={styles.navItems}>{children}</div>
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
  disabled?: boolean;
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
  disabled,
  matchPrefix,
}: NavItemProps) {
  const { t } = useI18n();
  const pathname = usePathname() ?? "";
  const active = matchPrefix ? pathname.startsWith(href) : pathname === href;

  const accessibleLabel = liveCount
    ? t("sidebar.currentlyRunning", { label, count: liveCount })
    : count != null
      ? `${label}, ${count}`
      : label;

  // Conditional render is OK because we pass tabIndex=-1 to keep the
  // disabled item out of the tab order without falling out of a List.
  const body = (
    <>
      <span className={styles.navIcon} aria-hidden="true">
        <Icon name={icon} size={16} />
      </span>
      <span className={styles.navLabel}>{label}</span>
      {liveCount != null && liveCount > 0 && (
        <span className={styles.navLive} aria-hidden="true">
          <span className="live-dot" style={{ width: 5, height: 5 }} />
          {liveCount}
        </span>
      )}
      {count != null && (
        <span
          className={styles.navCount}
          data-highlight={highlight === true}
          aria-hidden="true"
        >
          {count}
        </span>
      )}
    </>
  );

  if (disabled) {
    return (
      <div
        className={styles.navItem}
        data-active={active}
        data-disabled="true"
        data-sidebar-tooltip={accessibleLabel}
        role="link"
        aria-disabled="true"
        aria-label={accessibleLabel}
      >
        {body}
      </div>
    );
  }

  return (
    <Link
      href={href as never}
      className={styles.navItem}
      data-active={active}
      data-disabled="false"
      data-sidebar-tooltip={accessibleLabel}
      aria-current={active ? "page" : undefined}
      aria-label={accessibleLabel}
    >
      {body}
    </Link>
  );
}
