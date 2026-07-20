"use client";

/**
 * PortalProviders — client-only context wrappers.
 *
 * Splits the QueryClient + DirtyProvider out of the server-component
 * layout so React 19 can keep the page tree async-first. The QueryClient
 * instance is memo'd via lazy initial state so it survives client-side
 * route changes without remounting.
 *
 * Note: the SPA bootstrap-snapshot `DataProvider` (formerly wrapping
 * children here) is gone as of 2026-05-26 — every view consumes canonical
 * TanStack Query hooks (`useAgents`, `useDag`, `useEvents`, …) directly.
 */

import { useEffect, useMemo, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DirtyProvider } from "../../lib/dirty-context";
import { PreferencesProvider } from "../../lib/preferences-context";

export function portalTenantScope(pathname: string | null): string {
  const match = pathname?.match(/^\/portal\/([^/]+)(?:\/|$)/);
  if (!match?.[1]) return "__portal__";
  try {
    return decodeURIComponent(match[1]);
  } catch {
    // A malformed URL must not crash the provider tree. It still receives a
    // distinct cache scope so no previous tenant data can be reused.
    return `__invalid__:${match[1]}`;
  }
}

function createPortalQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        refetchOnWindowFocus: false,
      },
    },
  });
}

export function PortalProviders({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const tenantScope = portalTenantScope(pathname);
  // Most legacy query keys predate URL-scoped tenants. Give every tenant a
  // fresh QueryClient so a client-side tenant switch can never briefly render
  // another tenant's cached runs, events, agents, budgets or audit records.
  const client = useMemo(() => createPortalQueryClient(), [tenantScope]);

  useEffect(() => () => client.clear(), [client]);

  return (
    <PreferencesProvider>
      <QueryClientProvider client={client}>
        <DirtyProvider>{children}</DirtyProvider>
      </QueryClientProvider>
    </PreferencesProvider>
  );
}
