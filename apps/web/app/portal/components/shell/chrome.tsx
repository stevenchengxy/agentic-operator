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
import { useAgentFactoryDomains } from "@/lib/hooks/useAgentFactoryDomains";
import {
  buildRuntimeDomainNameMap,
  buildRuntimeDomainSlugSet,
  displayRuntimeDomainName,
  isVisibleRuntimeDomain,
} from "@/lib/domain-display";
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

export function PortalChrome({
  children,
  user,
}: {
  children: ReactNode;
  user: SessionUser;
}) {
  const { t } = useI18n();
  const { data: me } = useMe();
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
  const activeTenant = useTenant();
  const domainsQuery = useAgentFactoryDomains();
  const domainNames = buildRuntimeDomainNameMap(domainsQuery.data?.domains);
  const domainSlugs = buildRuntimeDomainSlugSet(domainsQuery.data?.domains);
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
        // 业务领域 = user-facing runtime domains. Hide internal sandbox/system rows
        // and empty test leftovers, but keep the URL-active domain visible while
        // the operator is already inside it.
        .filter((t) => isVisibleRuntimeDomain(t, domainSlugs) || t.slug === activeTenant)
        .map((t) => ({
          id: t.slug,
          name: displayRuntimeDomainName(t, domainNames),
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
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "232px 1fr",
          gridTemplateAreas: '"side main"',
          height: "100vh",
          background: "var(--bg)",
          overflow: "hidden",
        }}
      >
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
        <code style={{ fontFamily: "var(--mono)" }}>:3540</code>
        {t("chromeComp.bannerCheckPnpmDev")}
      </span>
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
