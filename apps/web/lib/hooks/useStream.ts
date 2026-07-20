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

import { useEffect, useRef } from "react";
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
  /** Transport lifecycle for connection-aware surfaces such as Live terminal. */
  onStatusChange?: (status: StreamConnectionState) => void;
}

export type StreamConnectionState =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "closed";

const MAX_BACKOFF_MS = 30_000;

/** Preserve the last durable SSE id when this hook creates a new EventSource.
 * Native EventSource only carries Last-Event-ID while it owns the reconnect;
 * our explicit backoff closes that instance, so the cursor must travel in the
 * proxy URL and be translated back into a header server-side. */
export function streamPathWithCursor(path: string, lastEventId: string): string {
  if (!lastEventId) return path;
  const absolute = /^https?:\/\//i.test(path);
  const url = new URL(path, "http://agentic.local");
  url.searchParams.set("lastEventId", lastEventId);
  return absolute ? url.toString() : `${url.pathname}${url.search}${url.hash}`;
}

export function useStream(opts: UseStreamOptions = {}): void {
  const queryClient = useQueryClient();
  const path = opts.path ?? "/v1/stream";
  const reconnect = opts.reconnect ?? true;
  const onEventRef = useRef(opts.onEvent);
  const onStatusChangeRef = useRef(opts.onStatusChange);

  useEffect(() => {
    onEventRef.current = opts.onEvent;
    onStatusChangeRef.current = opts.onStatusChange;
  }, [opts.onEvent, opts.onStatusChange]);

  useEffect(() => {
    let es: EventSource | null = null;
    let attempt = 0;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastEventId = "";

    function connect() {
      if (cancelled) return;
      onStatusChangeRef.current?.(attempt > 0 ? "reconnecting" : "connecting");
      // EventSource defaults to credentialed same-origin requests; the
      // browser sends the session cookie automatically through Next's
      // /v1/* rewrite to apps/api.
      es = new EventSource(streamPathWithCursor(path, lastEventId), {
        withCredentials: true,
      });

      es.onopen = () => {
        attempt = 0;
        onStatusChangeRef.current?.("connected");
      };

      es.onmessage = (msg) => {
        if (msg.lastEventId) lastEventId = msg.lastEventId;
        let payload: unknown;
        try {
          payload = JSON.parse(msg.data);
        } catch (error) {
          console.warn("[useStream] dropping non-JSON event", error);
          return;
        }
        const parsed = RunStreamEvent.safeParse(payload);
        if (!parsed.success) {
          console.warn("[useStream] dropping malformed event", parsed.error);
          return;
        }
        dispatch(parsed.data, queryClient);
        onEventRef.current?.(parsed.data);
      };

      es.onerror = () => {
        if (es) es.close();
        es = null;
        if (!reconnect || cancelled) {
          onStatusChangeRef.current?.("closed");
          return;
        }
        attempt += 1;
        onStatusChangeRef.current?.("reconnecting");
        const delay = Math.min(MAX_BACKOFF_MS, 500 * 2 ** Math.min(attempt, 6));
        timer = setTimeout(connect, delay);
      };
    }

    connect();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      if (es) es.close();
      onStatusChangeRef.current?.("closed");
    };
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

export const USAGE_KEYS = {
  all: ["usage"] as const,
};

export const AUDIT_KEYS = {
  all: ["audit"] as const,
};

export const OBSERVABILITY_KEYS = {
  all: ["observability"] as const,
};

import type { QueryClient } from "@tanstack/react-query";

export function dispatch(event: StreamEvent, client: QueryClient): void {
  switch (event.type) {
    case "run.started":
    case "run.failed":
    case "run.cancelled":
    case "run.completed": {
      // The list views all show status; counts shows running runs.
      void client.invalidateQueries({ queryKey: RUN_KEYS.all });
      void client.invalidateQueries({ queryKey: COUNT_KEYS.tenant });
      void client.invalidateQueries({ queryKey: RUN_KEYS.detail(event.runId) });
      // Token/cost totals and per-agent/model series are persisted on run
      // lifecycle changes. Prefix invalidation refreshes every selected range.
      void client.invalidateQueries({ queryKey: USAGE_KEYS.all });
      void client.invalidateQueries({ queryKey: OBSERVABILITY_KEYS.all });
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
      void client.invalidateQueries({ queryKey: OBSERVABILITY_KEYS.all });
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
      // Deployments can add or replace live agents. Keep both the agents page
      // and the sidebar's canonical count projection in sync with that write.
      void client.invalidateQueries({ queryKey: AGENT_KEYS.all });
      void client.invalidateQueries({ queryKey: COUNT_KEYS.tenant });
      break;
    }
    case "audit.recorded": {
      void client.invalidateQueries({ queryKey: AUDIT_KEYS.all });
      void client.invalidateQueries({ queryKey: OBSERVABILITY_KEYS.all });
      break;
    }
    case "llm.call.completed": {
      void client.invalidateQueries({ queryKey: USAGE_KEYS.all });
      void client.invalidateQueries({ queryKey: OBSERVABILITY_KEYS.all });
      break;
    }
    case "tool.call.completed": {
      void client.invalidateQueries({ queryKey: RUN_KEYS.detail(event.runId) });
      void client.invalidateQueries({ queryKey: OBSERVABILITY_KEYS.all });
      break;
    }
    case "log.line": {
      // Consumed directly by terminal subscribers; no query-backed surface.
      break;
    }
  }
}
