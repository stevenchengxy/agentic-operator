/**
 * useRunLogStream — live SSE log tail for a single run.
 *
 * Subscribes to `/v1/runs/:id/logs?follow=1` (apps/api/src/routes/v1/runs-logs.ts)
 * and accumulates `event: log` / `event: info` / `event: error` frames into a
 * rolling buffer the Logs view renders. Replaces the bootstrap-supplied
 * `sampleLog` hard-coded string.
 *
 * Lifecycle:
 *   - Opens EventSource on mount (or when `runId` becomes truthy).
 *   - Caps the buffer at `maxLines` (default 5000) so a long-running stream
 *     doesn't blow up React reconciliation.
 *   - Closes on unmount or `runId` change.
 *   - Reconnects with exponential backoff on transient error.
 *
 * No TanStack Query — SSE doesn't fit the query model and useStream.ts
 * already establishes the pattern of bypassing the cache for streams.
 */
"use client";

import { useEffect, useRef, useState } from "react";

export interface RunLogLine {
  /** Monotonic sequence so React can key the list without ambiguity. */
  seq: number;
  /** Event channel: "log", "info", "error", "end". */
  kind: "log" | "info" | "error" | "end";
  /** Raw line as written by the api. */
  text: string;
  /** Local receive time (unix ms). The log file's own timestamps are inside `text`. */
  at: number;
}

export interface UseRunLogStreamResult {
  lines: RunLogLine[];
  connected: boolean;
  /** Last transport error message, if any. Cleared on reconnect. */
  error: string | null;
  /** Reset the buffer (e.g. when the user picks a different run). */
  clear: () => void;
}

const MAX_BACKOFF_MS = 15_000;

export function useRunLogStream(
  runId: string | null | undefined,
  opts: { follow?: boolean; maxLines?: number } = {},
): UseRunLogStreamResult {
  const follow = opts.follow ?? true;
  const maxLines = opts.maxLines ?? 5000;

  const [lines, setLines] = useState<RunLogLine[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const seqRef = useRef(0);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!runId) {
      setLines([]);
      setConnected(false);
      setError(null);
      return;
    }

    let cancelled = false;
    let attempt = 0;
    let backoffTimer: ReturnType<typeof setTimeout> | null = null;

    const url = `/v1/runs/${encodeURIComponent(runId)}/logs${follow ? "?follow=1" : ""}`;

    function push(kind: RunLogLine["kind"], text: string) {
      seqRef.current += 1;
      const line: RunLogLine = {
        seq: seqRef.current,
        kind,
        text,
        at: Date.now(),
      };
      setLines((prev) => {
        const next = prev.length >= maxLines ? prev.slice(prev.length - maxLines + 1) : prev.slice();
        next.push(line);
        return next;
      });
    }

    function connect() {
      if (cancelled) return;
      // EventSource's default `message` channel fires only for unnamed
      // frames. The api emits named events ("log", "info", "error", "end"),
      // so we wire each listener explicitly.
      const es = new EventSource(url, { withCredentials: true });
      esRef.current = es;

      es.onopen = () => {
        attempt = 0;
        setConnected(true);
        setError(null);
      };

      es.addEventListener("log", (e: MessageEvent) => push("log", e.data));
      es.addEventListener("info", (e: MessageEvent) => push("info", e.data));
      es.addEventListener("error", (e: MessageEvent) => {
        // Server-sent `event: error` frames carry a payload; transport
        // errors don't and arrive on `es.onerror` instead.
        if (typeof e.data === "string" && e.data) push("error", e.data);
      });
      es.addEventListener("end", () => {
        push("end", "(stream closed by server)");
        es.close();
        setConnected(false);
      });

      es.onerror = () => {
        es.close();
        esRef.current = null;
        setConnected(false);
        if (cancelled || !follow) return;
        attempt += 1;
        const backoff = Math.min(MAX_BACKOFF_MS, 500 * 2 ** Math.min(attempt, 6));
        setError(`disconnected — retry in ${Math.round(backoff / 1000)}s`);
        backoffTimer = setTimeout(connect, backoff);
      };
    }

    connect();
    return () => {
      cancelled = true;
      if (backoffTimer) clearTimeout(backoffTimer);
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }
      setConnected(false);
    };
  }, [runId, follow, maxLines]);

  return {
    lines,
    connected,
    error,
    clear: () => {
      setLines([]);
      seqRef.current = 0;
    },
  };
}
