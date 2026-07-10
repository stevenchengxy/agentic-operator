/**
 * useStream — subscribe to the per-tenant `/v1/stream` SSE channel and
 * dispatch each event into TanStack Query's cache invalidator.
 *
 * Replaces the v0 `useLiveData` window-event pattern (the SPA's old
 * `window.addEventListener('raas-runs-updated', …)`). Phase 1 (P1-FE-02).
 *
 * Wiring:
 *
 *   import { QueryClientProvider } from "@tanstack/react-query";
 *   import { useStream } from "@/lib/hooks/useStream";
 *
 *   function PortalShell() {
 *     useStream();   // mount once at the app root
 *     return <Routes />;
 *   }
 *
 * The hook is intentionally idempotent — closing/reopening a connection is
 * cheap. Callers don't need to thread `enabled` state through.
 */
"use client";

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { RunStreamEvent, type RunStreamEvent as StreamEvent } from "@agentic/contracts";

export interface UseStreamOptions {
  /** Override the SSE path. Defaults to `/v1/stream`. */
  path?: string;
  /**
   * Auto-reconnect with exponential backoff on disconnect. Defaults to true.
   * Tests can pass `false` to keep behaviour deterministic.
   */
  reconnect?: boolean;
  /**
   * Called for every parsed event. Useful for a debug ticker or a
   * tweaks-panel inspector. Cache invalidation still happens internally.
   */
  onEvent?: (event: StreamEvent) => void;
}

const MAX_BACKOFF_MS = 30_000;

export function useStream(opts: UseStreamOptions = {}): void {
  const queryClient = useQueryClient();
  const path = opts.path ?? "/v1/stream";
  const reconnect = opts.reconnect ?? true;

  useEffect(() => {
    let es: EventSource | null = null;
    let attempt = 0;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    function connect() {
      if (cancelled) return;
      // EventSource defaults to credentialed same-origin requests; the
      // browser sends the session cookie automatically through Next's
      // /v1/* rewrite to apps/api.
      es = new EventSource(path, { withCredentials: true });

      es.onopen = () => {
        attempt = 0;
      };

      es.onmessage = (msg) => {
        const parsed = RunStreamEvent.safeParse(JSON.parse(msg.data));
        if (!parsed.success) {
          console.warn("[useStream] dropping malformed event", parsed.error);
          return;
        }
        dispatch(parsed.data, queryClient);
        opts.onEvent?.(parsed.data);
      };

      es.onerror = () => {
        if (es) es.close();
        es = null;
        if (!reconnect || cancelled) return;
        attempt += 1;
        const delay = Math.min(MAX_BACKOFF_MS, 500 * 2 ** Math.min(attempt, 6));
        timer = setTimeout(connect, delay);
      };
    }

    connect();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      if (es) es.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, reconnect, queryClient]);
}

// ─── Cache invalidation strategy ─────────────────────────────────────────────
// Each SSE event maps to a small fan-out of `queryClient.invalidateQueries`
// calls. Keys match what `useRuns / useEvents / useTasks / useAgents` register.
// Keep this in lockstep with the query keys exported below.

export const RUN_KEYS = {
  all: ["runs"] as const,
  list: (filter?: Record<string, unknown>) =>
    filter ? (["runs", "list", filter] as const) : (["runs", "list"] as const),
  detail: (id: string) => ["runs", "detail", id] as const,
  logs: (id: string) => ["runs", "logs", id] as const,
};

export const EVENT_KEYS = {
  all: ["events"] as const,
  list: (filter?: Record<string, unknown>) =>
    filter ? (["events", "list", filter] as const) : (["events", "list"] as const),
};

export const TASK_KEYS = {
  all: ["tasks"] as const,
  list: ["tasks", "list"] as const,
  detail: (id: string) => ["tasks", "detail", id] as const,
};

export const AGENT_KEYS = {
  all: ["agents"] as const,
  list: ["agents", "list"] as const,
  detail: (kebab: string) => ["agents", "detail", kebab] as const,
};

export const COUNT_KEYS = {
  tenant: ["counts"] as const,
};

export const DEPLOYMENT_KEYS = {
  list: ["deployments", "list"] as const,
};

import type { QueryClient } from "@tanstack/react-query";

export function dispatch(event: StreamEvent, client: QueryClient): void {
  switch (event.type) {
    case "run.started":
    case "run.failed":
    case "run.completed": {
      // The list views all show status; counts shows running runs.
      void client.invalidateQueries({ queryKey: RUN_KEYS.all });
      void client.invalidateQueries({ queryKey: COUNT_KEYS.tenant });
      void client.invalidateQueries({ queryKey: RUN_KEYS.detail(event.runId) });
      // Per-agent throughput changes as runs start/finish. Prefix-match
      // invalidates every window variant ("1h"/"24h"/"7d").
      void client.invalidateQueries({ queryKey: ["workflows", "throughput"] as const });
      break;
    }
    case "run.step.started":
    case "run.step.completed": {
      // The current-step badge on runs.list and the timeline on runs.detail
      // both refetch.
      void client.invalidateQueries({ queryKey: RUN_KEYS.detail(event.runId) });
      void client.invalidateQueries({ queryKey: RUN_KEYS.all });
      break;
    }
    case "event.emitted": {
      void client.invalidateQueries({ queryKey: EVENT_KEYS.all });
      void client.invalidateQueries({ queryKey: COUNT_KEYS.tenant });
      break;
    }
    case "task.created":
    case "task.resolved": {
      void client.invalidateQueries({ queryKey: TASK_KEYS.all });
      void client.invalidateQueries({ queryKey: COUNT_KEYS.tenant });
      break;
    }
    case "deployment.created": {
      // UC-V11-06: refresh the deployments list so a hot-reload lands in
      // the table immediately. The toast itself is fired by the chrome
      // (see chrome.tsx onEvent handler), which has access to useToast().
      void client.invalidateQueries({ queryKey: DEPLOYMENT_KEYS.list });
      break;
    }
  }
}
