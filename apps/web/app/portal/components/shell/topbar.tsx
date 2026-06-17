"use client";

/**
 * TopBar — 44px header strip above every view. v1_1 app.jsx:291-374.
 *
 * Left: breadcrumb derived from URL.
 * Right: Cmd-K search button (240px), LIVE/PAUSED toggle, user chip.
 *
 * Breadcrumb logic: split the path after `/portal/<tenant>/`, capitalize
 * the first segment for plain views, render mono-styled IDs (runId/agentId/
 * eventName/taskId) as the final crumb. v1_1 used in-component state to
 * decide the breadcrumb shape; here the URL is the source of truth.
 */

import { useMemo } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon } from "../Icon";
import { Kbd } from "../atoms";
import { useTweaks } from "../tweaks/use-tweaks";
import { useI18n } from "../../lib/preferences-context";
import { ThemeToggle, LanguageToggle } from "./appearance-controls";
import { useCommandPalette } from "../cmd-k";
import { useTenant } from "../../lib/use-tenant";

export interface TopBarProps {
  /** Display name + avatar initials for the user chip. */
  user?: { name: string; initials: string };
}

type Translate = (key: string) => string;

export function TopBar({
  user = { name: "Liu Wei", initials: "LW" },
}: TopBarProps) {
  const pathname = usePathname() ?? "";
  const tenant = useTenant();
  const [tweaks, setTweak] = useTweaks();
  const { t } = useI18n();
  const cmdK = useCommandPalette();

  const crumb = useMemo(
    () => buildCrumb(pathname, tenant, t),
    [pathname, tenant, t],
  );
  const liveStream = tweaks.liveStream;

  return (
    <div
      style={{
        height: 44,
        borderBottom: "1px solid var(--border)",
        display: "flex",
        alignItems: "center",
        padding: "0 18px",
        gap: 14,
        background: "var(--bg)",
        flexShrink: 0,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          fontSize: 12,
          color: "var(--text-3)",
        }}
      >
        {crumb.map((c, i) => {
          const last = i === crumb.length - 1;
          if (last) {
            return (
              <span
                key={i}
                style={{ color: "var(--text)" }}
                className={c.mono ? "mono" : ""}
              >
                {c.label}
              </span>
            );
          }
          if (c.href) {
            return (
              <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                <Link href={c.href as never} style={{ color: "var(--text-2)" }}>
                  {c.label}
                </Link>
                <Icon
                  name="chevron-right"
                  size={10}
                  style={{ color: "var(--text-4)" }}
                />
              </span>
            );
          }
          return (
            <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              <span style={{ color: "var(--text-2)" }}>{c.label}</span>
              <Icon
                name="chevron-right"
                size={10}
                style={{ color: "var(--text-4)" }}
              />
            </span>
          );
        })}
      </div>

      <button
        onClick={() => cmdK.setOpen(true)}
        aria-label="Open command palette"
        style={{
          marginLeft: "auto",
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "5px 9px",
          background: "var(--panel)",
          border: "1px solid var(--border-2)",
          borderRadius: 5,
          fontSize: 11.5,
          color: "var(--text-3)",
          minWidth: 240,
        }}
      >
        <Icon name="search" size={11} />
        <span>{t("topbar.search")}</span>
        <span style={{ marginLeft: "auto" }}>
          <Kbd>⌘</Kbd> <Kbd>K</Kbd>
        </span>
      </button>

      <ThemeToggle />
      <LanguageToggle />

      <button
        onClick={() => setTweak("liveStream", !liveStream)}
        aria-pressed={liveStream}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "5px 10px",
          background: liveStream ? "rgba(208,255,0,0.08)" : "transparent",
          border: `1px solid ${liveStream ? "rgba(208,255,0,0.3)" : "var(--border-2)"}`,
          borderRadius: 5,
          fontSize: 11.5,
          fontFamily: "var(--mono)",
          letterSpacing: "0.04em",
          color: liveStream ? "var(--signal)" : "var(--text-3)",
        }}
      >
        <Icon name={liveStream ? "pause" : "play"} size={10} />
        {liveStream ? t("topbar.live") : t("topbar.paused")}
      </button>

      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div
          style={{
            width: 22,
            height: 22,
            borderRadius: "50%",
            background: "var(--violet)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 10,
            color: "#000",
            fontWeight: 600,
          }}
        >
          {user.initials}
        </div>
        <div style={{ fontSize: 11.5, color: "var(--text-2)" }}>
          {user.name}
        </div>
      </div>
    </div>
  );
}

interface CrumbPart {
  label: string;
  href?: string;
  mono?: boolean;
}

/** Translate a view segment via `nav.<view>`, falling back to Capitalized. */
function viewLabel(view: string, t: Translate): string {
  const key = `nav.${view}`;
  const translated = t(key);
  return translated === key ? capitalize(view) : translated;
}

/** Build breadcrumb parts from `/portal/<tenant>/<view>[/<id>]`. */
function buildCrumb(
  pathname: string,
  tenant: string,
  t: Translate,
): CrumbPart[] {
  // Split, drop leading "portal" + tenant.
  const parts = pathname.split("/").filter(Boolean);
  // parts: ["portal", tenant, view?, ...rest]
  const view = parts[2];
  const rest = parts.slice(3);
  const base = `/portal/${tenant}`;

  if (!view) {
    return [{ label: t("nav.dashboard") }];
  }
  const viewTitle = viewLabel(view, t);
  if (rest.length === 0) {
    return [{ label: viewTitle }];
  }
  // Detail view — last segment is an ID.
  const tail = rest[rest.length - 1] ?? "";
  return [
    { label: viewTitle, href: `${base}/${view}` },
    { label: tail, mono: looksLikeId(tail) },
  ];
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function looksLikeId(s: string): boolean {
  return /^(run|evt|agt|tsk|TASK|REQ|CAN)-/i.test(s);
}
