/**
 * Portal layout (P2-FE-05) — outermost wrapper around `/portal/*`.
 *
 * Owns the QueryClient + DataProvider providers, the Tweaks panel, the
 * ⌘+K command palette, the toast region, and the shell shape (Sidebar +
 * TopBar). Tenant resolution lives one level deeper (`[tenant]/layout.tsx`)
 * because Sidebar reads `useTenant()` from the URL.
 *
 * Auth gate: this layout calls into `lib/auth/session.ts`, which forwards the
 * opaque session cookie to the API's canonical verifier. Anonymous visitors
 * are redirected to /sign-in.
 *
 * The `<html>` element keeps `data-theme` and `data-density` defaults; the
 * Tweaks panel mutates them at runtime via `useTweaks` (which also persists
 * to localStorage).
 */

import { redirect } from "next/navigation";
import { readSession } from "@/lib/auth/session";
import { PortalProviders } from "./components/shell/providers";
import { PortalChrome } from "./components/shell/chrome";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function PortalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await readSession();
  if (!session) {
    redirect("/sign-in?return=/portal");
  }

  return (
    <PortalProviders>
      <PortalChrome
        user={{
          sub: session.sub,
          name: session.name,
          initials: session.initials,
          tenant: session.tenant,
        }}
      >
        {children}
      </PortalChrome>
    </PortalProviders>
  );
}
