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

import { useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DirtyProvider } from "../../lib/dirty-context";
import { PreferencesProvider } from "../../lib/preferences-context";

export function PortalProviders({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            refetchOnWindowFocus: false,
          },
        },
      }),
  );
  return (
    <PreferencesProvider>
      <QueryClientProvider client={client}>
        <DirtyProvider>{children}</DirtyProvider>
      </QueryClientProvider>
    </PreferencesProvider>
  );
}
