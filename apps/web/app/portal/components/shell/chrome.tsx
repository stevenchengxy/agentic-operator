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
import { useCallback, useEffect, useRef, useState } from "react";
import type { RunStreamEvent } from "@agentic/contracts";
import { useStream } from "@/lib/hooks/useStream";
import { useTenants } from "@/lib/hooks/useTenants";
import { isVisibleRuntimeDomain } from "@/lib/domain-display";
import { useTenant } from "@/app/portal/lib/use-tenant";
import { useMe, useLogout } from "@/lib/hooks/useMe";
import { Sidebar } from "./sidebar";
import { TopBar } from "./topbar";
import { TweaksPanel } from "../tweaks/panel";
import { ToastRegion, toast } from "../toast";
import { CommandPalette } from "../cmd-k";
import type { TenantOption } from "./tenant-switcher";
import {
  SessionProvider,
  type SessionUser,
} from "../../lib/session-context";
import { useI18n } from "@/app/portal/lib/preferences-context";
import styles from "./sidebar.module.css";

/**
 * Detects a layout viewport pinned by a CDP device-metrics override (left
 * behind by browser automation or DevTools device emulation). The override
 * survives reloads and window resizes, so when the window later shrinks —
 * e.g. moving Chrome off an external monitor — the page keeps rendering at
 * the stale width and every shell layer's `overflow: hidden` silently clips
 * the right-hand side. The app cannot observe or clear the override itself;
 * the only reliable signal is behavioral: the OS window resizes while the
 * layout viewport stays frozen wider than the window. Page zoom never
 * trips this (zoom moves innerWidth, not outerWidth), and normal resizes
 * move both together.
 */
function useViewportPinWarning(): {
  active: boolean;
  inner: number;
  outer: number;
  dismiss: () => void;
} {
  const [pin, setPin] = useState<{ inner: number; outer: number } | null>(
    null,
  );
  const [dismissed, setDismissed] = useState(false);
  const last = useRef<{ inner: number; outer: number } | null>(null);
  useEffect(() => {
    const tick = () => {
      const inner = window.innerWidth;
      const outer = window.outerWidth;
      const prev = last.current;
      // outerWidth reads 0 while the window is minimized/hidden — skip.
      if (outer > 0 && prev && prev.outer > 0) {
        const outerMoved = Math.abs(outer - prev.outer) > 120;
        const innerFrozen = inner === prev.inner;
        if (outerMoved && innerFrozen && inner > outer + 120) {
          setPin({ inner, outer });
        } else if (inner <= outer + 8) {
          // Window and layout agree again (window grew back to the pinned
          // size, or the override was lifted) — self-heal.
          setPin(null);
          setDismissed(false);
        }
      }
      if (outer > 0) last.current = { inner, outer };
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, []);
  return {
    active: pin != null && !dismissed,
    inner: pin?.inner ?? 0,
    outer: pin?.outer ?? 0,
    dismiss: () => setDismissed(true),
  };
}

export function PortalChrome({
  children,
  user,
}: {
  children: ReactNode;
  user: SessionUser;
}) {
  const { t } = useI18n();
  const { data: me } = useMe();
  const viewportPin = useViewportPinWarning();
  // UC-V11-06 — when the SSE stream surfaces a `deployment.created` event
  // for tenant code, fire a hot-reload toast so engineers see their CLI
  // deploy land without a manual refresh. Manifest deploys already get an
  // explicit "Manifest deployed" toast at save time, so we only fire here
  // for `kind: 'tenant_code'`.
  const onStreamEvent = useCallback(
    (event: RunStreamEvent) => {
      if (event.type === "deployment.created" && event.kind === "tenant_code") {
        toast({
          tone: "signal",
          title: t("chromeComp.toastTenantCodeActive", {
            version: event.version,
          }),
          description: event.workflowSlug
            ? t("chromeComp.toastHotReloadedFor", { slug: event.workflowSlug })
            : t("chromeComp.toastHotReloaded"),
        });
      }
    },
    [t],
  );

  // useStream owns the SSE subscription that invalidates the TanStack Query
  // caches; mount it once at the chrome level so every view inherits live
  // updates without re-subscribing. We connect through the unbuffered
  // `/livefeed` route handler (the `/v1/*` rewrite buffers SSE) and scope it
  // to the VIEWED tenant (EventSource can't set the x-agentic-tenant header,
  // so the proxy forwards it from the query param). Switching tenants
  // re-subscribes via the path dependency.
  const activeTenant = useTenant(user.tenant);
  useStream({
    path: activeTenant
      ? `/livefeed?tenant=${encodeURIComponent(activeTenant)}`
      : "/livefeed",
    onEvent: onStreamEvent,
  });

  // Live tenant list. No static fallback — when /v1/tenants errors we
  // surface a banner so the operator knows the api is unreachable rather
  // than seeing a misleading switcher full of stale entries.
  const tenantsQuery = useTenants();
  const liveItems = tenantsQuery.data?.items;
  const tenants: TenantOption[] = liveItems
    ? liveItems
        .filter((t) => t.archivedAt == null)
        // Tenant visibility comes only from runtime tenancy. Ontology catalog
        // availability must never hide an empty/new tenant from navigation.
        .filter((t) => isVisibleRuntimeDomain(t) || t.slug === activeTenant)
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
    tenantsQuery.isError ||
    (!tenantsQuery.isLoading && !tenantsQuery.data);

  // P6-AUTH — a self-registered user with no tenant membership (and not a
  // platform superadmin) can't use any view yet. Show a "waiting for access"
  // screen instead of a dashboard that would just 403 on every /v1 call.
  const pendingAccess =
    !!me && me.memberships.length === 0 && me.user.platformRole !== "superadmin";
  if (pendingAccess) {
    return (
      <SessionProvider value={user}>
        <PendingAccess email={me.user.email} />
      </SessionProvider>
    );
  }

  return (
    <SessionProvider value={user}>
      {/* Grid frame lives in sidebar.module.css `.shell` — a compact 64px
        * nav rail track; the expanded sidebar overlays the main view instead
        * of reflowing it. */}
      <div className={styles.shell}>
        {/* P2-FE-24 — skip-link is the first focusable element so keyboard
          * users can jump past the sidebar straight to the view body.
          * Styled in tokens.css `.skip-link`. */}
        <a href="#portal-view-content" className="skip-link">
          {t("chromeComp.skipToContent")}
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
          {viewportPin.active ? (
            <ViewportPinnedBanner
              inner={viewportPin.inner}
              outer={viewportPin.outer}
              onDismiss={viewportPin.dismiss}
            />
          ) : null}
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
        <TweaksPanel tenants={tenants.map((t) => ({ id: t.id, name: t.name }))} />
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
  const { t } = useI18n();
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
        {t("chromeComp.bannerCannotReachApi")}{" "}
        {t("chromeComp.bannerCheckPnpmDev")}
      </span>
    </div>
  );
}

/**
 * Companion banner to `useViewportPinWarning` — tells the operator WHY the
 * right side of the UI is unreachable and how to recover (close the tab; a
 * reload does not lift a CDP viewport override). Amber, dismissible: the
 * page still works, it is just clipped.
 */
function ViewportPinnedBanner({
  inner,
  outer,
  onDismiss,
}: {
  inner: number;
  outer: number;
  onDismiss: () => void;
}) {
  const { t } = useI18n();
  return (
    <div
      role="alert"
      style={{
        background: "color-mix(in srgb, var(--amber) 10%, transparent)",
        borderBottom:
          "1px solid color-mix(in srgb, var(--amber) 35%, var(--border))",
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
          background: "var(--amber)",
          flexShrink: 0,
        }}
        aria-hidden
      />
      <span style={{ minWidth: 0 }}>
        {t("chromeComp.bannerViewportPinned", {
          inner: String(inner),
          outer: String(outer),
        })}
      </span>
      {/* No marginLeft:auto — in the clipped state the banner's right edge
        * is off-screen, so the dismiss button must hug the text to stay
        * reachable. */}
      <button
        type="button"
        onClick={onDismiss}
        style={{
          flexShrink: 0,
          background: "none",
          border: "1px solid var(--border-2)",
          borderRadius: 4,
          color: "var(--text-2)",
          fontSize: 11,
          padding: "3px 8px",
          cursor: "pointer",
        }}
      >
        {t("chromeComp.bannerViewportPinnedDismiss")}
      </button>
    </div>
  );
}

/**
 * Shown to a signed-in user who has no tenant membership yet (open
 * self-registration → admin grants access later). Offers only sign-out.
 */
function PendingAccess({ email }: { email: string }) {
  const { t } = useI18n();
  const logout = useLogout();
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--bg)",
        padding: 20,
      }}
    >
      <div
        style={{
          width: 460,
          maxWidth: "90vw",
          background: "var(--panel)",
          border: "1px solid var(--border)",
          borderRadius: 12,
          padding: 28,
          textAlign: "center",
        }}
      >
        <h1
          style={{
            margin: 0,
            fontSize: 22,
            fontFamily: "var(--display)",
            fontWeight: 400,
            color: "var(--text)",
          }}
        >
          {t("auth.pendingTitle")}
        </h1>
        <p style={{ marginTop: 10, fontSize: 13, color: "var(--text-2)", lineHeight: 1.6 }}>
          {t("auth.pendingHint")}
        </p>
        <p style={{ marginTop: 14, fontSize: 11.5, color: "var(--text-3)", fontFamily: "var(--mono)" }}>
          {t("auth.pendingSignedInAs", { email })}
        </p>
        <button
          onClick={() => logout.mutate()}
          disabled={logout.isPending}
          style={{
            marginTop: 18,
            padding: "9px 16px",
            background: "transparent",
            border: "1px solid var(--border-2)",
            borderRadius: 7,
            color: "var(--text-2)",
            fontSize: 12.5,
            cursor: logout.isPending ? "wait" : "pointer",
          }}
        >
          {t("auth.signOut")}
        </button>
      </div>
    </div>
  );
}
