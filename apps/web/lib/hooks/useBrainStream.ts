/**
 * useBrainStream — live SSE stream of the Agent Factory brain (background-run model).
 *
 * Opening the stream starts (or RECONNECTS to) a detached background run. Because the
 * brain runs server-side in the run-registry, closing the EventSource only unsubscribes
 * — the run keeps going. The hook captures the run id (from the `run.started` frame),
 * persists it per-tenant to localStorage, and clears it on `done`, so a remount can
 * reconnect to a still-running brain. A new submit bumps `nonce`; a reconnect passes
 * `reconnectRunId`.
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type BrainEvent = { t: string; [k: string]: unknown };

export interface BrainStreamRequest {
  tenant: string;
  domain?: string;
  goal?: string;
  conversation?: string;
  /** reconnect to a live/finished background run instead of starting a new one */
  reconnectRunId?: string;
  /** bump to (re)start with otherwise-identical params */
  nonce: number;
}

export interface UseBrainStreamResult {
  events: BrainEvent[];
  running: boolean;
  runId: string | null;
  error: string | null;
}

export const activeRunKey = (tenant: string) => `ao:factory:activeRun:${tenant}`;

export function useBrainStream(req: BrainStreamRequest | null): UseBrainStreamResult {
  const [events, setEvents] = useState<BrainEvent[]>([]);
  const [running, setRunning] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);
  // #2a — the last conversation id we streamed, so a 2nd message in the SAME conversation keeps
  // the prior transcript (the resumed brain continues; the UI should show continuity, not wipe).
  const lastConvRef = useRef<string | null>(null);

  const persistActive = useCallback((tenant: string, id: string | null) => {
    try {
      if (id) localStorage.setItem(activeRunKey(tenant), id);
      else localStorage.removeItem(activeRunKey(tenant));
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    // No request (e.g. after switching domain / new conversation / opening a history run): the
    // previous effect's cleanup already closed the EventSource, but a programmatic close does NOT
    // fire onerror/end, so we must reset run state here — otherwise `running` stays stuck true and
    // the composer locks in inject-mode, and `runId` keeps targeting the navigated-away run's /stop.
    // BUGFIX (新会话): also CLEAR the transcript here. Resetting req to null (新会话 / switch domain)
    // must wipe the prior conversation's events — otherwise the old transcript lingers and it looks
    // like a new conversation never started. (A history run sets `viewingRun`, which bypasses these
    // live events, so clearing here is safe.)
    if (!req) { setEvents([]); setRunning(false); setRunId(null); lastConvRef.current = null; return; }
    const isReconnect = !!req.reconnectRunId;
    if (!isReconnect && (!req.domain || !req.goal)) return;
    // #2a FIX: only wipe the transcript on a genuinely NEW conversation, or on a reconnect (where
    // the SSE replays the whole run buffer). A fresh turn in the SAME conversation accumulates —
    // the new run's frames append to the prior turns so the user keeps the full history.
    const convKey = req.conversation ?? req.reconnectRunId ?? null;
    const sameConversation = !isReconnect && !!req.conversation && req.conversation === lastConvRef.current;
    if (!sameConversation) setEvents([]);
    lastConvRef.current = convKey;
    setError(null);
    setRunning(true);
    setRunId(req.reconnectRunId ?? null);

    const qs = new URLSearchParams({ tenant: req.tenant });
    if (isReconnect) {
      qs.set("run", req.reconnectRunId!);
    } else {
      qs.set("domain", req.domain!);
      qs.set("goal", req.goal!);
      if (req.conversation) qs.set("conversation", req.conversation);
    }
    const es = new EventSource(`/factory-stream?${qs.toString()}`, { withCredentials: true });
    esRef.current = es;

    // SILENCE WATCHDOG — a reconnect can attach to a ZOMBIE run (in the live registry but its driver
    // died, so it emits nothing) or a hung run; without this `running` stays true forever and the
    // composer is locked in inject-mode (the "发送没反应" lock). If no frame arrives for a long while,
    // give up: unlock the composer + clear the stored active run so the user can start fresh. Reset
    // on every frame, so a genuinely-active run (which streams think/tool frames continuously, and
    // emits a keepalive at worst) never trips it.
    const SILENCE_MS = 60_000;
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    const armWatchdog = () => {
      if (watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        setRunning(false);
        persistActive(req.tenant, null);
        setError("该运行已无响应（可能是之前中断的运行）——已解锁，可重新开始。");
        es.close();
      }, SILENCE_MS);
    };
    armWatchdog();

    es.onmessage = (e: MessageEvent) => {
      armWatchdog(); // any frame (incl. keepalive) proves the stream is alive
      try {
        const ev = JSON.parse(e.data) as BrainEvent;
        if (ev.t === "run.started" || ev.t === "run") {
          const id = String(ev.runId ?? "");
          if (id) {
            setRunId(id);
            persistActive(req.tenant, id);
          }
          return; // control frame, not a transcript block
        }
        if (ev.t === "done") {
          setRunning(false);
          persistActive(req.tenant, null);
        }
        // Cap the client buffer, but NEVER drop structural frames: think/model deltas are
        // ~90% of the stream, while agent.created / tool.created / sandbox / stage frames
        // are what deriveAgents/deriveWorkers/ask-cards fold over — trimming those made
        // worker cards + pending tool confirmations silently vanish on long runs.
        setEvents((prev) => {
          if (prev.length <= 4000) return [...prev, ev];
          const cut = prev.length - 3000;
          const head = prev.slice(0, cut).filter((e) => e.t !== "think" && e.t !== "model");
          return [...head, ...prev.slice(cut), ev];
        });
      } catch {
        /* ignore keepalive / malformed frame */
      }
    };
    es.addEventListener("end", () => {
      if (watchdog) clearTimeout(watchdog);
      setRunning(false);
      es.close();
    });
    es.onerror = () => {
      if (watchdog) clearTimeout(watchdog);
      es.close();
      // #AUDIT-FIX(L26) — 连接断开≠运行结束：服务器端 run 往往还在继续。旧行为静默把 UI 置为
      // "已结束"且无任何提示（残缺 transcript 被当成完整结果）。现在如实告知 + 指引重连。
      setRunning(false);
      setError("连接中断——服务器端运行可能仍在继续。刷新页面或重新打开本会话即可重连并回放完整过程。");
    };

    return () => {
      if (watchdog) clearTimeout(watchdog);
      es.close();
      esRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req?.nonce]);

  return { events, running, runId, error };
}
