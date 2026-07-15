"use client";

/**
 * PortalChrome — grid frame around every portal view.
 *
 * Mirrors v1_1 app.jsx:42-105 (232px sidebar + 1fr main; main has a 44px
 * TopBar then a scroll container). Globally mounts:
 *   - Tweaks panel       (P2-FE-16)
 *   - Toast region       (P2-FE-22)
 *   - Cmd-K palette host (P2-FE-23)
 *   - useStream SSE hook (Phase 1)
 *
 * Tenants list is fetched live via `useTenants()` (TanStack Query against
 * `GET /v1/tenants`). 2026-05-26 product rule: production mode = ZERO mock
 * data. If `/v1/tenants` errors we render an inline banner instead of
 * falling back to a static fixture — the previous fallback masked an
 * api-down state by pretending RAAS / SupportFlow / FinanceClose existed
 * when they didn't.
 */

import type { ReactNode } from "react";
import { useCallback } from "react";
import type { RunStreamEvent } from "@agentic/contracts";
import { useStream } from "@/lib/hooks/useStream";
import { useTenants } from "@/lib/hooks/useTenants";
import { Sidebar } from "./sidebar";
import { TopBar } from "./topbar";
import { TweaksPanel } from "../tweaks/panel";
import { ToastRegion, toast } from "../toast";
import { CommandPalette } from "../cmd-k";
import type { TenantOption } from "./tenant-switcher";
import { SessionProvider, type SessionUser } from "../../lib/session-context";
import styles from "./sidebar.module.css";

export function PortalChrome({
  children,
  user,
}: {
  children: ReactNode;
  user: SessionUser;
}) {
  // UC-V11-06 — when the SSE stream surfaces a `deployment.created` event
  // for tenant code, fire a hot-reload toast so engineers see their CLI
  // deploy land without a manual refresh. Manifest deploys already get an
  // explicit "Manifest deployed" toast at save time, so we only fire here
  // for `kind: 'tenant_code'`.
  const onStreamEvent = useCallback((event: RunStreamEvent) => {
    if (event.type === "deployment.created" && event.kind === "tenant_code") {
      toast({
        tone: "signal",
        title: `Tenant code ${event.version} active`,
        description: event.workflowSlug
          ? `Hot-reloaded for ${event.workflowSlug}`
          : "Hot-reloaded",
      });
    }
  }, []);

  // useStream owns the SSE subscription that invalidates the TanStack Query
  // caches; mount it once at the chrome level so every view inherits live
  // updates without re-subscribing.
  useStream({ onEvent: onStreamEvent });

  // Live tenant list. No static fallback — when /v1/tenants errors we
  // surface a banner so the operator knows the api is unreachable rather
  // than seeing a misleading switcher full of stale entries.
  const tenantsQuery = useTenants();
  const liveItems = tenantsQuery.data?.items;
  const tenants: TenantOption[] = liveItems
    ? liveItems
        .filter((t) => t.archivedAt == null)
        .map((t) => ({
          id: t.slug,
          name: t.name,
          subtitle: t.subtitle ?? undefined,
          color: t.color ?? "#d0ff00",
          agentCount: t.agentCount,
          runs24h: t.runs24h,
        }))
    : [];

  const apiUnreachable =
    tenantsQuery.isError || (!tenantsQuery.isLoading && !tenantsQuery.data);

  return (
    <SessionProvider value={user}>
      <div className={styles.shell}>
        {/* P2-FE-24 — skip-link is the first focusable element so keyboard
         * users can jump past the sidebar straight to the view body.
         * Styled in tokens.css `.skip-link`. */}
        <a href="#portal-view-content" className="skip-link">
          Skip to content
        </a>
        <Sidebar tenants={tenants} />
        <main
          style={{
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
            minWidth: 0,
            gridArea: "main",
          }}
        >
          <TopBar user={{ name: user.name, initials: user.initials }} />
          {apiUnreachable ? <ApiUnreachableBanner /> : null}
          <div
            id="portal-view-content"
            tabIndex={-1}
            style={{
              flex: 1,
              overflow: "hidden",
              minHeight: 0,
              position: "relative",
            }}
          >
            {children}
          </div>
        </main>
        <TweaksPanel
          tenants={tenants.map((t) => ({ id: t.id, name: t.name }))}
        />
        <ToastRegion />
        <CommandPalette />
      </div>
    </SessionProvider>
  );
}

/**
 * Inline banner shown when `/v1/tenants` is unreachable. Single source of
 * truth for the "api down" error UX in the portal shell.
 */
function ApiUnreachableBanner() {
  return (
    <div
      role="alert"
      style={{
        background: "rgba(239, 68, 68, 0.12)",
        borderBottom: "1px solid rgba(239, 68, 68, 0.35)",
        color: "var(--text)",
        padding: "8px 16px",
        fontSize: 12,
        display: "flex",
        alignItems: "center",
        gap: 8,
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: "rgb(239, 68, 68)",
          flexShrink: 0,
        }}
        aria-hidden
      />
      <span>
        Cannot reach api on{" "}
        <code style={{ fontFamily: "var(--mono)" }}>:3501</code>
        {" — check that `pnpm dev` is running. The portal will keep retrying."}
      </span>
    </div>
  );
}
