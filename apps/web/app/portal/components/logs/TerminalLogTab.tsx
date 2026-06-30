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

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { RunStreamEvent } from "@agentic/contracts";
import { Icon } from "@/app/portal/components";
import { useI18n } from "@/app/portal/lib/preferences-context";
import { useTenant } from "@/app/portal/lib/use-tenant";
import { useStream } from "@/lib/hooks/useStream";

const MAX_LINES = 1000;

interface Line {
  key: number;
  at: number;
  kind: string;
  color: string;
  text: string;
  isError: boolean;
  raw: RunStreamEvent;
}

/** Category filters for the console. ERROR is cross-cutting (a failed step is
 *  both STEP and ERROR); the rest match the line's `kind`. */
type Category = "ALL" | "ERROR" | "RUN" | "STEP" | "EVENT" | "TASK" | "DEPLOY";
const CATEGORIES: Category[] = ["ALL", "ERROR", "RUN", "STEP", "EVENT", "TASK", "DEPLOY"];

function isErrorEvent(ev: RunStreamEvent): boolean {
  return (
    ev.type === "run.failed" ||
    (ev.type === "run.step.completed" && ev.status === "failed")
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
  RUN: "var(--blue)",
  STEP: "var(--green)",
  EVENT: "var(--signal)",
  TASK: "var(--amber)",
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

/** Map a stream event to a colored console line. */
function format(ev: RunStreamEvent): { kind: string; color: string; text: string } {
  switch (ev.type) {
    case "run.started":
      return {
        kind: "RUN",
        color: C.blue,
        text: `▶ ${ev.agentName} started${ev.triggerEvent ? ` ← ${ev.triggerEvent}` : ""}${ev.subject ? ` · ${ev.subject}` : ""}`,
      };
    case "run.step.started":
      return { kind: "STEP", color: C.muted, text: `  · ${ev.name} (${ev.stepType}) …` };
    case "run.step.completed":
      return {
        kind: "STEP",
        color: ev.status === "failed" ? C.red : C.green,
        text: `  ✓ ${ev.name} ${ev.status} · ${ev.durationMs}ms${ev.model ? ` · ${ev.model}` : ""}${ev.error ? ` · ${ev.error}` : ""}`,
      };
    case "run.completed":
      return {
        kind: "RUN",
        color: C.green,
        text: `■ run ${ev.runId.slice(-6)} completed · ${ev.durationMs}ms${ev.tokensIn != null ? ` · ${(ev.tokensIn ?? 0) + (ev.tokensOut ?? 0)} tok` : ""}`,
      };
    case "run.failed":
      return { kind: "RUN", color: C.red, text: `✕ run ${ev.runId.slice(-6)} failed · ${ev.errorMessage}` };
    case "event.emitted":
      return { kind: "EVENT", color: C.signal, text: `⚡ ${ev.name}${ev.subject ? ` · ${ev.subject}` : ""}` };
    case "task.created":
      return { kind: "TASK", color: C.amber, text: `☐ task ${ev.taskType}: ${ev.title}` };
    case "task.resolved":
      return { kind: "TASK", color: C.violet, text: `☑ task ${ev.taskId.slice(-6)} → ${ev.decision}` };
    case "deployment.created":
      return { kind: "DEPLOY", color: C.signal, text: `⬆ deployment (${ev.kind})` };
    default:
      return { kind: "•", color: C.muted, text: JSON.stringify(ev) };
  }
}

function clock(ms: number): string {
  return new Date(ms).toTimeString().slice(0, 8);
}

export function TerminalLogTab() {
  const { t } = useI18n();
  const tenant = useTenant();
  const [lines, setLines] = useState<Line[]>([]);
  const [paused, setPaused] = useState(false);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const pausedRef = useRef(false);
  const seqRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const autoScrollRef = useRef(true);

  // Stable handler (functional setState + refs ⇒ no stale closure, no
  // re-subscribe). useStream captures this once at mount.
  const [cat, setCat] = useState<Category>("ALL");

  const append = useCallback((ev: RunStreamEvent) => {
    if (pausedRef.current) return;
    const f = format(ev);
    setLines((prev) => {
      const next = [
        ...prev,
        { key: seqRef.current++, at: ev.at, kind: f.kind, color: f.color, text: f.text, isError: isErrorEvent(ev), raw: ev },
      ];
      return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
    });
  }, []);

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
  useEffect(() => {
    let cancelled = false;
    setBackfilling(true);
    setLines([]);
    fetch(`/v1/activity?limit=${MAX_LINES}`, {
      credentials: "same-origin",
      headers: { Accept: "application/json", "x-agentic-tenant": tenant },
    })
      .then((r) => r.json())
      .then((body: { ok: boolean; data?: RunStreamEvent[] }) => {
        if (cancelled || !body.ok || !body.data) return;
        const seeded: Line[] = body.data.map((ev) => {
          const f = format(ev);
          return { key: seqRef.current++, at: ev.at, kind: f.kind, color: f.color, text: f.text, isError: isErrorEvent(ev), raw: ev };
        });
        // Put history before any live lines that arrived during the fetch.
        setLines((prev) => {
          const merged = [...seeded, ...prev];
          return merged.length > MAX_LINES ? merged.slice(merged.length - MAX_LINES) : merged;
        });
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setBackfilling(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tenant]);

  // Stream the VIEWED tenant's activity through the unbuffered /livefeed proxy.
  useStream({ path: `/livefeed?tenant=${encodeURIComponent(tenant)}`, onEvent: append });

  const counts = useMemo(() => {
    const c: Record<Category, number> = {
      ALL: lines.length, ERROR: 0, RUN: 0, STEP: 0, EVENT: 0, TASK: 0, DEPLOY: 0,
    };
    for (const l of lines) {
      if (l.isError) c.ERROR++;
      if (l.kind in c) c[l.kind as Category]++;
    }
    return c;
  }, [lines]);
  const filtered = useMemo(() => lines.filter((l) => matchesCategory(l, cat)), [lines, cat]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && autoScrollRef.current) el.scrollTop = el.scrollHeight;
  }, [filtered]);

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    autoScrollRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  }
  function togglePause() {
    pausedRef.current = !pausedRef.current;
    setPaused(pausedRef.current);
  }

  return (
    <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", minHeight: 0 }}>
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
            color: paused ? "var(--text-3)" : "var(--green)",
          }}
        >
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: paused ? "var(--text-3)" : "var(--green)",
            }}
          />
          {paused ? t("logsExplorer.paused") : t("logsExplorer.live")}
        </span>
        <span style={{ fontSize: 11, color: "var(--text-3)", fontFamily: "var(--mono)" }}>
          {cat === "ALL"
            ? t("logsExplorer.rowCount", { n: lines.length })
            : `${filtered.length} / ${lines.length}`}
        </span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
          <button onClick={togglePause} style={termBtn}>
            <Icon name={paused ? "play" : "pause"} size={11} />
            {paused ? t("logsExplorer.resume") : t("logsExplorer.pause")}
          </button>
          <button onClick={() => setLines([])} style={termBtn}>
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
                background: active ? `color-mix(in srgb, ${color} 14%, transparent)` : "transparent",
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
            <div style={{ color: "var(--text-3)", padding: "20px 0", lineHeight: 1.8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span className="live-dot green" />
                {t("logsExplorer.terminalWaiting")}
              </div>
              <div style={{ fontSize: 11, color: "var(--text-4)", marginTop: 8, maxWidth: 560 }}>
                {t("logsExplorer.terminalWaitingHint")}
              </div>
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
                  className="hover-row"
                  style={{ display: "flex", gap: 10, whiteSpace: "pre-wrap", cursor: "pointer", borderRadius: 3 }}
                >
                  <span style={{ color: "var(--text-3)", flexShrink: 0 }}>{clock(l.at)}</span>
                  <span style={{ color: l.color, flexShrink: 0, width: 52, fontWeight: 500 }}>{l.kind}</span>
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
