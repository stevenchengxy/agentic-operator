"use client";

/**
 * 实时终端日志 — a true real-time `tail -f` console of ALL tenant activity.
 *
 * Transport: the api broadcasts a full lifecycle over SSE (/v1/stream) —
 * run.started/step.started/step.completed/completed/failed, event.emitted,
 * task.*, deployment.created. The Next rewrite that fronts /v1/* BUFFERS SSE,
 * so we connect through the dedicated streaming route handler `/livefeed`
 * (apps/web/app/livefeed/route.ts), which pipes the stream unbuffered AND
 * forwards the viewed tenant as `x-agentic-tenant` (EventSource can't set
 * headers itself). Result: events paint the instant they happen.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { RunStreamEvent } from "@agentic/contracts";
import { Icon } from "@/app/portal/components";
import { useI18n, type Translate } from "@/app/portal/lib/preferences-context";
import { useTenant } from "@/app/portal/lib/use-tenant";
import { useStream, type StreamConnectionState } from "@/lib/hooks/useStream";

const MAX_LINES = 1000;
const HISTORY_RETRY_DELAYS_MS = [500, 1_000, 2_000, 4_000] as const;

interface ActivityEnvelope {
  ok?: boolean;
  data?: unknown;
  error?: { message?: string };
}

class ActivityHistoryError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ActivityHistoryError";
  }
}

/**
 * `/v1/activity` can briefly be served by Next before the API process has
 * finished booting. During that window the proxy may return plain text or an
 * HTML error page, so never assume an error response is JSON.
 */
async function readActivityResponse(
  response: Response,
  t?: Translate,
): Promise<unknown[]> {
  const text = await response.text();
  let body: ActivityEnvelope | null = null;

  if (text.trim()) {
    try {
      body = JSON.parse(text) as ActivityEnvelope;
    } catch {
      body = null;
    }
  }

  if (!response.ok) {
    const plainText = text.replace(/\s+/g, " ").trim().slice(0, 240);
    const detail =
      body?.error?.message?.trim() || plainText || response.statusText;
    const retryable =
      response.status === 408 ||
      response.status === 425 ||
      response.status === 429 ||
      response.status >= 500;
    throw new ActivityHistoryError(
      `HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
      retryable,
    );
  }

  if (!body || body.ok !== true || !Array.isArray(body.data)) {
    throw new ActivityHistoryError(
      body?.error?.message?.trim() ||
        t?.("logsExplorer.historyInvalidResponse") ||
        "Activity API returned an invalid JSON response",
      true,
    );
  }

  return body.data;
}

interface Line {
  key: number;
  identity: string;
  at: number;
  kind: string;
  color: string;
  text: string;
  isError: boolean;
  raw: RunStreamEvent;
}

/** Category filters for the console. ERROR is cross-cutting (a failed step is
 *  both STEP and ERROR); the rest match the line's `kind`. */
type Category =
  | "ALL"
  | "ERROR"
  | "LOG"
  | "RUN"
  | "STEP"
  | "EVENT"
  | "TASK"
  | "AUDIT"
  | "LLM"
  | "TOOL"
  | "DEPLOY";
const CATEGORIES: Category[] = [
  "ALL",
  "ERROR",
  "LOG",
  "RUN",
  "STEP",
  "EVENT",
  "TASK",
  "AUDIT",
  "LLM",
  "TOOL",
  "DEPLOY",
];

function isErrorEvent(ev: RunStreamEvent): boolean {
  return (
    ev.type === "run.failed" ||
    (ev.type === "run.step.completed" && ev.status === "failed") ||
    (ev.type === "log.line" && ev.level === "ERROR") ||
    (ev.type === "llm.call.completed" && ev.ok === false) ||
    (ev.type === "tool.call.completed" && !ev.ok) ||
    (ev.type === "audit.recorded" && ev.decision === "deny")
  );
}

function matchesCategory(l: Line, cat: Category): boolean {
  if (cat === "ALL") return true;
  if (cat === "ERROR") return l.isError;
  return l.kind === cat;
}

const CAT_COLOR: Record<Category, string> = {
  ALL: "var(--text)",
  ERROR: "var(--red)",
  LOG: "var(--text-2)",
  RUN: "var(--blue)",
  STEP: "var(--green)",
  EVENT: "var(--signal)",
  TASK: "var(--amber)",
  AUDIT: "var(--blue)",
  LLM: "var(--violet)",
  TOOL: "var(--green)",
  DEPLOY: "var(--violet)",
};

const C = {
  blue: "var(--blue)",
  green: "var(--green)",
  red: "var(--red)",
  amber: "var(--amber)",
  violet: "var(--violet)",
  signal: "var(--signal)",
  muted: "var(--text-3)",
};

function stepStatusLabel(status: string, t: Translate): string {
  if (status === "ok") return t("logsExplorer.lineStatusOk");
  if (status === "failed") return t("logsExplorer.lineStatusFailed");
  if (status === "skipped") return t("logsExplorer.lineStatusSkipped");
  return status;
}

/**
 * Map a stream event to a colored console line. Only the client-authored
 * lifecycle copy is translated; event names, subjects, errors, decisions,
 * log messages, and the expandable raw frame remain byte-for-byte runtime
 * evidence.
 */
export function formatStreamEvent(
  ev: RunStreamEvent,
  t: Translate,
): { kind: string; color: string; text: string } {
  switch (ev.type) {
    case "run.started":
      return {
        kind: "RUN",
        color: C.blue,
        // Keep automated verification traffic visibly distinct from genuine
        // business runs. The flag comes from the persisted run row for
        // backfill and from the runtime event for live frames.
        text: `▶ ${t("logsExplorer.lineRunStarted", { agent: ev.agentName })}${ev.testRun ? ` · ${t("logsExplorer.testRun")}` : ""}${ev.triggerEvent ? ` ← ${ev.triggerEvent}` : ""}${ev.subject ? ` · ${ev.subject}` : ""}`,
      };
    case "run.step.started":
      return {
        kind: "STEP",
        color: C.muted,
        text: `  · ${ev.name} (${ev.stepType}) …`,
      };
    case "run.step.completed":
      return {
        kind: "STEP",
        color: ev.status === "failed" ? C.red : C.green,
        text: `  ${ev.status === "failed" ? "✕" : "✓"} ${ev.name} ${stepStatusLabel(ev.status, t)}${ev.durationMs == null ? "" : ` · ${ev.durationMs}ms`}${ev.model ? ` · ${ev.model}` : ""}${ev.error ? ` · ${ev.error}` : ""}`,
      };
    case "run.completed":
      return {
        kind: "RUN",
        color: C.green,
        text: `■ ${t("logsExplorer.lineRunCompleted", { id: ev.runId.slice(-6) })}${ev.durationMs == null ? "" : ` · ${ev.durationMs}ms`}${ev.tokensIn != null || ev.tokensOut != null ? ` · ${(ev.tokensIn ?? 0) + (ev.tokensOut ?? 0)} ${t("logsExplorer.lineTokensShort")}` : ""}`,
      };
    case "run.failed":
      return {
        kind: "RUN",
        color: C.red,
        text: `✕ ${t("logsExplorer.lineRunFailed", { id: ev.runId.slice(-6) })} · ${ev.errorMessage}`,
      };
    case "run.cancelled":
      return {
        kind: "RUN",
        color: C.amber,
        text: `■ ${t("logsExplorer.lineRunCancelled", { id: ev.runId.slice(-6) })} · ${ev.reason}`,
      };
    case "event.emitted":
      return {
        kind: "EVENT",
        color: C.signal,
        text: `⚡ ${ev.name}${ev.subject ? ` · ${ev.subject}` : ""}`,
      };
    case "task.created":
      return {
        kind: "TASK",
        color: C.amber,
        text: `☐ ${t("logsExplorer.lineTaskCreated", { type: ev.taskType, title: ev.title })}`,
      };
    case "task.resolved":
      return {
        kind: "TASK",
        color: C.violet,
        text: `☑ ${t("logsExplorer.lineTaskResolved", { id: ev.taskId.slice(-6), decision: ev.decision })}`,
      };
    case "deployment.created":
      return {
        kind: "DEPLOY",
        color: C.signal,
        text: `⬆ ${t("logsExplorer.lineDeploymentCreated", { version: ev.version, kind: ev.kind })}${ev.workflowSlug ? ` · ${ev.workflowSlug}` : ""}`,
      };
    case "log.line": {
      const levelColor =
        ev.level === "ERROR"
          ? C.red
          : ev.level === "WARN"
            ? C.amber
            : ev.level === "DEBUG"
              ? C.muted
              : C.blue;
      return {
        kind: "LOG",
        color: levelColor,
        // message is the exact persisted line, including timestamp/level/event.
        // Do not prepend a second synthetic copy of those fields.
        text: ev.message,
      };
    }
    case "audit.recorded":
      return {
        kind: "AUDIT",
        color: ev.decision === "deny" ? C.red : C.blue,
        text: `${ev.action}${ev.targetType ? ` · ${ev.targetType}` : ""}${ev.targetId ? `:${ev.targetId}` : ""}${ev.decision ? ` · ${ev.decision}` : ""}`,
      };
    case "llm.call.completed":
      return {
        kind: "LLM",
        color: ev.ok === false ? C.red : ev.ok === true ? C.violet : C.muted,
        text: `${ev.provider ?? t("logsExplorer.lineUnknown")}/${ev.servedModel ?? ev.requestedModel ?? t("logsExplorer.lineUnknown")} ${ev.ok === true ? t("logsExplorer.lineLlmCompleted") : ev.ok === false ? t("logsExplorer.lineStatusFailed") : t("logsExplorer.lineStatusUnknown")}${ev.latencyMs != null ? ` · ${ev.latencyMs}ms` : ""}${ev.tokensIn != null || ev.tokensOut != null ? ` · ${(ev.tokensIn ?? 0) + (ev.tokensOut ?? 0)} ${t("logsExplorer.lineTokensShort")}${ev.tokenSource === "estimated_chars" ? ` ${t("logsExplorer.lineEstimated")}` : ev.tokenSource == null ? ` ${t("logsExplorer.lineSourceUnknown")}` : ""}` : ""}${ev.fallback ? ` · ${t("logsExplorer.lineFallback")}` : ""}${ev.failureReason ? ` · ${ev.failureReason}` : ""}`,
      };
    case "tool.call.completed":
      return {
        kind: "TOOL",
        color: ev.ok ? C.green : C.red,
        text: `${ev.agentName ?? t("logsExplorer.lineDefaultAgent")} → ${ev.toolName} ${ev.ok ? t("logsExplorer.lineStatusOk") : t("logsExplorer.lineStatusFailed")}${ev.durationMs != null ? ` · ${ev.durationMs}ms` : ""}${ev.error ? ` · ${ev.error}` : ""}`,
      };
    default:
      return { kind: "•", color: C.muted, text: JSON.stringify(ev) };
  }
}

function clock(ms: number): string {
  return new Date(ms).toTimeString().slice(0, 8);
}

/** Stable identity shared by persisted backfill + its matching live frame. */
export function streamEventIdentity(ev: RunStreamEvent): string {
  switch (ev.type) {
    case "run.started":
    case "run.completed":
    case "run.failed":
    case "run.cancelled":
      return `${ev.type}:${ev.runId}`;
    case "run.step.started":
    case "run.step.completed":
      return `${ev.type}:${ev.stepId}`;
    case "event.emitted":
      return `${ev.type}:${ev.eventId}`;
    case "task.created":
    case "task.resolved":
      return `${ev.type}:${ev.taskId}`;
    case "deployment.created":
      return `${ev.type}:${ev.deploymentId}`;
    case "log.line":
      // Multiple writes of the same event can land in the same millisecond.
      // Include the exact persisted line so those records remain distinct,
      // while a live frame and its later file backfill still deduplicate.
      return `${ev.type}:${ev.runId}:${ev.at}:${ev.event}:${ev.message}`;
    case "audit.recorded":
      return `${ev.type}:${ev.auditId}`;
    case "llm.call.completed":
      return `${ev.type}:${ev.callId}`;
    case "tool.call.completed":
      return `${ev.type}:${ev.runId}:${ev.at}:${ev.toolName}:${ev.correlationId}:${ev.stepName ?? ""}`;
    default: {
      // Forward-compatible with additive stream variants. Prefer a stable
      // resource id when present; fall back to the serialized frame.
      const frame = ev as RunStreamEvent & Record<string, unknown>;
      const resourceId =
        frame.logId ?? frame.auditId ?? frame.callId ?? frame.id;
      return `${frame.type}:${resourceId ?? JSON.stringify(frame)}:${frame.at}`;
    }
  }
}

export function TerminalLogTab() {
  const { t } = useI18n();
  const tenant = useTenant();
  const [lines, setLines] = useState<Line[]>([]);
  const [paused, setPaused] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [connection, setConnection] =
    useState<StreamConnectionState>("connecting");
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const pausedRef = useRef(false);
  const pendingRef = useRef<Line[]>([]);
  const seqRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const autoScrollRef = useRef(true);

  // Stable handler (functional setState + refs ⇒ no stale closure, no
  // re-subscribe). useStream captures this once at mount.
  const [cat, setCat] = useState<Category>("ALL");

  const toLine = useCallback(
    (ev: RunStreamEvent): Line => {
      const f = formatStreamEvent(ev, t);
      return {
        key: seqRef.current++,
        identity: streamEventIdentity(ev),
        at: ev.at,
        kind: f.kind,
        color: f.color,
        text: f.text,
        isError: isErrorEvent(ev),
        raw: ev,
      };
    },
    [t],
  );

  const mergeLines = useCallback(
    (current: Line[], incoming: Line[]): Line[] => {
      const byIdentity = new Map<string, Line>();
      for (const line of [...current, ...incoming]) {
        if (!byIdentity.has(line.identity)) byIdentity.set(line.identity, line);
      }
      const merged = Array.from(byIdentity.values()).sort(
        (a, b) => a.at - b.at || a.key - b.key,
      );
      return merged.length > MAX_LINES
        ? merged.slice(merged.length - MAX_LINES)
        : merged;
    },
    [],
  );

  const append = useCallback(
    (ev: RunStreamEvent) => {
      const line = toLine(ev);
      if (pausedRef.current) {
        pendingRef.current = [...pendingRef.current, line].slice(-MAX_LINES);
        setPendingCount(pendingRef.current.length);
        return;
      }
      setLines((prev) => mergeLines(prev, [line]));
    },
    [mergeLines, toLine],
  );

  const toggleLine = (key: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });

  // Backfill: seed the console from the persisted recent lifecycle so the
  // terminal isn't empty when there's no live traffic (production mode) and
  // survives tab switches. Then live events append on top via /livefeed.
  const [backfilling, setBackfilling] = useState(true);
  const [historyError, setHistoryError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let releaseRetryWait: (() => void) | null = null;

    const waitForRetry = (delayMs: number) =>
      new Promise<void>((resolve) => {
        releaseRetryWait = resolve;
        retryTimer = setTimeout(() => {
          retryTimer = null;
          releaseRetryWait = null;
          resolve();
        }, delayMs);
      });

    setBackfilling(true);
    setHistoryError(null);
    setLines([]);
    pendingRef.current = [];
    setPendingCount(0);

    async function backfill() {
      for (
        let attempt = 0;
        attempt <= HISTORY_RETRY_DELAYS_MS.length;
        attempt += 1
      ) {
        if (cancelled) return;
        if (attempt > 0) {
          await waitForRetry(HISTORY_RETRY_DELAYS_MS[attempt - 1]!);
          if (cancelled) return;
        }

        try {
          const response = await fetch(`/v1/activity?limit=${MAX_LINES}`, {
            credentials: "same-origin",
            headers: { Accept: "application/json", "x-agentic-tenant": tenant },
            signal: controller.signal,
          });
          const raw = await readActivityResponse(response, t);
          if (cancelled) return;

          const seeded = raw.flatMap((candidate) => {
            const parsed = RunStreamEvent.safeParse(candidate);
            return parsed.success ? [toLine(parsed.data)] : [];
          });
          // Put history before any live lines that arrived during the fetch.
          setLines((prev) => mergeLines(seeded, prev));
          setHistoryError(null);
          setBackfilling(false);
          return;
        } catch (error: unknown) {
          if (
            cancelled ||
            (error instanceof DOMException && error.name === "AbortError")
          )
            return;
          const message =
            error instanceof Error ? error.message : String(error);
          setHistoryError(message);
          const retryable =
            !(error instanceof ActivityHistoryError) || error.retryable;
          if (!retryable || attempt === HISTORY_RETRY_DELAYS_MS.length) {
            setBackfilling(false);
            return;
          }
        }
      }
    }

    void backfill();
    return () => {
      cancelled = true;
      controller.abort();
      if (retryTimer) clearTimeout(retryTimer);
      releaseRetryWait?.();
    };
  }, [mergeLines, t, tenant, toLine]);

  // Stream the VIEWED tenant's activity through the unbuffered /livefeed proxy.
  const onStatusChange = useCallback((status: StreamConnectionState) => {
    setConnection(status);
  }, []);
  useStream({
    path: `/livefeed?tenant=${encodeURIComponent(tenant)}&backfill=${MAX_LINES}`,
    onEvent: append,
    onStatusChange,
  });

  const counts = useMemo(() => {
    const c: Record<Category, number> = {
      ALL: lines.length,
      ERROR: 0,
      LOG: 0,
      RUN: 0,
      STEP: 0,
      EVENT: 0,
      TASK: 0,
      AUDIT: 0,
      LLM: 0,
      TOOL: 0,
      DEPLOY: 0,
    };
    for (const l of lines) {
      if (l.isError) c.ERROR++;
      if (l.kind in c) c[l.kind as Category]++;
    }
    return c;
  }, [lines]);
  const filtered = useMemo(
    () => lines.filter((l) => matchesCategory(l, cat)),
    [lines, cat],
  );

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && autoScrollRef.current) el.scrollTop = el.scrollHeight;
  }, [filtered]);

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    autoScrollRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  }
  function togglePause() {
    const nextPaused = !pausedRef.current;
    pausedRef.current = nextPaused;
    setPaused(nextPaused);
    if (!nextPaused && pendingRef.current.length > 0) {
      const pending = pendingRef.current;
      pendingRef.current = [];
      setPendingCount(0);
      autoScrollRef.current = true;
      setLines((prev) => mergeLines(prev, pending));
    }
  }
  function clearTerminal() {
    setLines([]);
    pendingRef.current = [];
    setPendingCount(0);
    setExpanded(new Set());
    seqRef.current = 0;
  }

  const connectionColor = paused
    ? "var(--text-3)"
    : connection === "connected"
      ? "var(--green)"
      : connection === "reconnecting"
        ? "var(--amber)"
        : "var(--text-3)";
  const connectionLabel = paused
    ? t("logsExplorer.paused")
    : t(`logsExplorer.connection_${connection}`);

  return (
    <div
      style={{
        flex: 1,
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "8px 24px",
          borderBottom: "1px solid var(--border)",
          flexShrink: 0,
        }}
      >
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontSize: 11,
            fontFamily: "var(--mono)",
            color: connectionColor,
          }}
          role="status"
          aria-live="polite"
        >
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: connectionColor,
            }}
          />
          {connectionLabel}
        </span>
        <span
          style={{
            fontSize: 11,
            color: "var(--text-3)",
            fontFamily: "var(--mono)",
          }}
        >
          {cat === "ALL"
            ? t("logsExplorer.rowCount", { n: lines.length })
            : `${filtered.length} / ${lines.length}`}
        </span>
        {paused && pendingCount > 0 && (
          <span
            style={{
              fontSize: 11,
              color: "var(--amber)",
              fontFamily: "var(--mono)",
            }}
          >
            {t("logsExplorer.buffered", { n: pendingCount })}
          </span>
        )}
        <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
          <button
            onClick={togglePause}
            style={termBtn}
            type="button"
            aria-pressed={paused}
          >
            <Icon name={paused ? "play" : "pause"} size={11} />
            {paused ? t("logsExplorer.resume") : t("logsExplorer.pause")}
          </button>
          <button onClick={clearTerminal} style={termBtn} type="button">
            <Icon name="x" size={11} />
            {t("logsExplorer.clear")}
          </button>
        </div>
      </div>

      {/* Category filter chips — classify by error / run / step / event / … */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          flexWrap: "wrap",
          padding: "8px 24px",
          borderBottom: "1px solid var(--border)",
          flexShrink: 0,
        }}
      >
        {CATEGORIES.map((c) => {
          const active = cat === c;
          const color = CAT_COLOR[c];
          return (
            <button
              key={c}
              type="button"
              onClick={() => setCat(c)}
              style={{
                fontSize: 10.5,
                fontFamily: "var(--mono)",
                padding: "3px 9px",
                borderRadius: 99,
                cursor: "pointer",
                border: `1px solid ${active ? color : "var(--border-2)"}`,
                background: active
                  ? `color-mix(in srgb, ${color} 14%, transparent)`
                  : "transparent",
                color: active ? color : "var(--text-3)",
              }}
            >
              {t(`logsExplorer.cat_${c}`)} {counts[c]}
            </button>
          );
        })}
      </div>

      <div
        ref={scrollRef}
        onScroll={onScroll}
        role="log"
        aria-live="off"
        aria-label={t("logsExplorer.terminalAriaLabel")}
        style={{
          flex: 1,
          overflow: "auto",
          minHeight: 0,
          background: "var(--bg-2)",
          padding: "10px 18px",
          fontFamily: "var(--mono)",
          fontSize: 11.5,
          lineHeight: 1.7,
        }}
      >
        {lines.length === 0 ? (
          backfilling ? (
            <div style={{ color: "var(--text-3)", padding: "20px 0" }}>
              {t("logsExplorer.terminalLoading")}
            </div>
          ) : (
            <div
              style={{
                color: "var(--text-3)",
                padding: "20px 0",
                lineHeight: 1.8,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span className="live-dot green" />
                {t("logsExplorer.terminalWaiting")}
              </div>
              <div
                style={{
                  fontSize: 11,
                  color: "var(--text-4)",
                  marginTop: 8,
                  maxWidth: 560,
                }}
              >
                {t("logsExplorer.terminalWaitingHint")}
              </div>
              {historyError && (
                <div
                  role="alert"
                  style={{
                    fontSize: 11,
                    color: "var(--red)",
                    marginTop: 8,
                    maxWidth: 680,
                  }}
                >
                  {t("logsExplorer.historyLoadFailed")}: {historyError}
                </div>
              )}
              {connection !== "connected" && (
                <div
                  style={{
                    fontSize: 11,
                    color: "var(--amber)",
                    marginTop: 6,
                    maxWidth: 680,
                  }}
                >
                  {t("logsExplorer.streamUnavailableHint")}
                </div>
              )}
            </div>
          )
        ) : filtered.length === 0 ? (
          <div style={{ color: "var(--text-3)", padding: "20px 0" }}>
            {t("logsExplorer.catEmpty", { cat: t(`logsExplorer.cat_${cat}`) })}
          </div>
        ) : (
          filtered.map((l) => {
            const isOpen = expanded.has(l.key);
            return (
              <div key={l.key}>
                <div
                  onClick={() => toggleLine(l.key)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      toggleLine(l.key);
                    }
                  }}
                  role="button"
                  tabIndex={0}
                  aria-expanded={isOpen}
                  className="hover-row"
                  style={{
                    display: "flex",
                    gap: 10,
                    whiteSpace: "pre-wrap",
                    cursor: "pointer",
                    borderRadius: 3,
                  }}
                >
                  <span style={{ color: "var(--text-3)", flexShrink: 0 }}>
                    {clock(l.at)}
                  </span>
                  <span
                    style={{
                      color: l.color,
                      flexShrink: 0,
                      width: 52,
                      fontWeight: 500,
                    }}
                  >
                    {l.kind}
                  </span>
                  <span style={{ color: "var(--text-2)" }}>{l.text}</span>
                </div>
                {isOpen && (
                  <pre
                    className="rise"
                    style={{
                      margin: "4px 0 8px 62px",
                      padding: "10px 12px",
                      background: "var(--panel)",
                      border: "1px solid var(--border)",
                      borderRadius: 6,
                      color: "var(--text-2)",
                      fontSize: 11,
                      lineHeight: 1.55,
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-all",
                    }}
                  >
                    {JSON.stringify(l.raw, null, 2)}
                  </pre>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

const termBtn: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  padding: "4px 9px",
  fontSize: 11,
  fontFamily: "var(--mono)",
  color: "var(--text-2)",
  background: "var(--panel-2)",
  border: "1px solid var(--border-2)",
  borderRadius: 4,
  cursor: "pointer",
};
