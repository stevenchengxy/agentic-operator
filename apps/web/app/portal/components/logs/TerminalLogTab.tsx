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

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { RunStreamEvent } from "@agentic/contracts";
import { Icon } from "@/app/portal/components";
import { useI18n } from "@/app/portal/lib/preferences-context";
import { useTenant } from "@/app/portal/lib/use-tenant";
import { useStream } from "@/lib/hooks/useStream";

const MAX_LINES = 600;

interface Line {
  key: number;
  at: number;
  kind: string;
  color: string;
  text: string;
}

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
  const pausedRef = useRef(false);
  const seqRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const autoScrollRef = useRef(true);

  // Stable handler (functional setState + refs ⇒ no stale closure, no
  // re-subscribe). useStream captures this once at mount.
  const append = useCallback((ev: RunStreamEvent) => {
    if (pausedRef.current) return;
    const f = format(ev);
    setLines((prev) => {
      const next = [
        ...prev,
        { key: seqRef.current++, at: ev.at, kind: f.kind, color: f.color, text: f.text },
      ];
      return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
    });
  }, []);

  // Stream the VIEWED tenant's activity through the unbuffered /livefeed proxy.
  useStream({ path: `/livefeed?tenant=${encodeURIComponent(tenant)}`, onEvent: append });

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && autoScrollRef.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

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
          {t("logsExplorer.rowCount", { n: lines.length })}
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
          <div style={{ color: "var(--text-3)", padding: "20px 0" }}>
            {t("logsExplorer.terminalWaiting")}
          </div>
        ) : (
          lines.map((l) => (
            <div key={l.key} style={{ display: "flex", gap: 10, whiteSpace: "pre-wrap" }}>
              <span style={{ color: "var(--text-3)", flexShrink: 0 }}>{clock(l.at)}</span>
              <span style={{ color: l.color, flexShrink: 0, width: 52, fontWeight: 500 }}>{l.kind}</span>
              <span style={{ color: "var(--text-2)" }}>{l.text}</span>
            </div>
          ))
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
