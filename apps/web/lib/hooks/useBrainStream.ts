/**
 * useBrainStream — live SSE stream of the Agent Factory brain (background-run model).
 *
 * A JSON POST starts (or attaches to) a detached background run; this hook only
 * RECONNECTS to the returned run id. Because the brain runs server-side in the
 * run-registry, closing the EventSource only unsubscribes — the run keeps going.
 * The hook confirms the run id from the `run.started` frame,
 * persists it per-tenant to localStorage, and clears it on `done`, so a remount can
 * reconnect to a still-running brain. A new submit bumps `nonce`; a reconnect passes
 * `reconnectRunId`.
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type BrainEvent = { t: string; [k: string]: unknown };

export interface BrainStreamRequest {
  tenant: string;
  /** POST /v1/agent-factory/runs/start has already accepted the goal. */
  reconnectRunId: string;
  conversation?: string;
  /** Append only for a newly-started turn in the same conversation. */
  replayMode?: "append" | "replace";
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

/** Full effect identity: any changed request must close/re-open the SSE. */
export function brainStreamRequestKey(req: BrainStreamRequest | null): string | null {
  return req
    ? JSON.stringify([
        req.tenant,
        req.conversation ?? null,
        req.reconnectRunId,
        req.replayMode ?? "replace",
        req.nonce,
      ])
    : null;
}

/**
 * Visible transcript identity. Consecutive turns in one conversation keep the
 * same view, while a tenant switch can never reuse another tenant's buffered
 * events even if its conversation id happens to be identical.
 */
export function brainStreamViewKey(req: BrainStreamRequest | null): string | null {
  if (!req) return null;
  if (req.replayMode !== "append") {
    return JSON.stringify([req.tenant, "replace", req.reconnectRunId, req.nonce]);
  }
  return JSON.stringify([
    req.tenant,
    req.conversation ?? req.reconnectRunId,
  ]);
}

export function shouldAppendBrainReplay(previousConversation: string | null, req: BrainStreamRequest): boolean {
  return req.replayMode === "append"
    && !!req.conversation
    && req.conversation === previousConversation;
}

export function useBrainStream(req: BrainStreamRequest | null): UseBrainStreamResult {
  const [events, setEvents] = useState<BrainEvent[]>([]);
  const [running, setRunning] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeViewKey, setActiveViewKey] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const generationRef = useRef(0);
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

  const requestKey = brainStreamRequestKey(req);
  const viewKey = brainStreamViewKey(req);

  useEffect(() => {
    const generation = ++generationRef.current;
    const isCurrentGeneration = () => generationRef.current === generation;
    // No request (e.g. after switching domain / new conversation / opening a history run): the
    // previous effect's cleanup already closed the EventSource, but a programmatic close does NOT
    // fire onerror/end, so we must reset run state here — otherwise `running` stays stuck true and
    // the composer locks in inject-mode, and `runId` keeps targeting the navigated-away run's /stop.
    // BUGFIX (新会话): also CLEAR the transcript here. Resetting req to null (新会话 / switch domain)
    // must wipe the prior conversation's events — otherwise the old transcript lingers and it looks
    // like a new conversation never started. (A history run sets `viewingRun`, which bypasses these
    // live events, so clearing here is safe.)
    if (!req) { setActiveViewKey(null); setEvents([]); setRunning(false); setRunId(null); setError(null); lastConvRef.current = null; return; }
    if (!req.reconnectRunId.trim()) {
      setActiveViewKey(null);
      setEvents([]);
      setRunning(false);
      setRunId(null);
      setError("无法连接 Agent 工厂：缺少服务端运行 ID。");
      return;
    }
    // A `started` POST with an existing, finished conversation creates a new turn; its SSE
    // contains only that turn, so append to the prior display. An `attached` POST reconnects
    // an already-live run and replays its full buffer, so replace to avoid duplicates.
    const convKey = req.conversation ?? req.reconnectRunId;
    if (!shouldAppendBrainReplay(lastConvRef.current, req)) setEvents([]);
    lastConvRef.current = convKey;
    setActiveViewKey(viewKey);
    setError(null);
    setRunning(true);
    setRunId(req.reconnectRunId);

    const qs = new URLSearchParams({ tenant: req.tenant });
    qs.set("run", req.reconnectRunId);
    const es = new EventSource(`/factory-stream?${qs.toString()}`, { withCredentials: true });
    esRef.current = es;

    // SILENCE WATCHDOG — a reconnect can attach to a ZOMBIE run (in the live registry but its driver
    // died, so it emits nothing) or a hung run; without this `running` stays true forever and the
    // composer is locked in inject-mode (the "发送没反应" lock). If no frame arrives for a long while,
    // give up: unlock the composer + clear the stored active run so the user can start fresh.
    // #ALIVE-PING — NB: SSE comment lines (`: ping`) NEVER reach onmessage (spec), so they cannot
    // feed this watchdog — that's exactly how healthy-but-quiet runs (ask_user park waiting for the
    // human, slow deep-reasoning first token) used to false-trip「已无响应」. The server now sends a
    // REAL `{"t":"ping"}` data frame every 15s WHILE the run is alive in its registry; a true zombie
    // gets no data-ping and still trips this watchdog — so tripping now genuinely means "dead run".
    const SILENCE_MS = 60_000;
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    const armWatchdog = () => {
      if (watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        if (!isCurrentGeneration()) return;
        setRunning(false);
        persistActive(req.tenant, null);
        setError("该运行已无响应（可能是之前中断的运行）——已解锁，可重新开始。");
        es.close();
      }, SILENCE_MS);
    };
    armWatchdog();

    es.onmessage = (e: MessageEvent) => {
      if (!isCurrentGeneration()) return;
      armWatchdog(); // any DATA frame (incl. the {"t":"ping"} liveness frame) proves the run is alive
      try {
        const ev = JSON.parse(e.data) as BrainEvent;
        // #ALIVE-PING — liveness heartbeat: resets the watchdog above, never enters the transcript.
        if ((ev as { t?: string }).t === "ping") return;
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
      if (!isCurrentGeneration()) return;
      if (watchdog) clearTimeout(watchdog);
      setRunning(false);
      es.close();
    });
    es.onerror = () => {
      if (!isCurrentGeneration()) return;
      if (watchdog) clearTimeout(watchdog);
      es.close();
      // #AUDIT-FIX(L26) — 连接断开≠运行结束：服务器端 run 往往还在继续。旧行为静默把 UI 置为
      // "已结束"且无任何提示（残缺 transcript 被当成完整结果）。现在如实告知 + 指引重连。
      setRunning(false);
      setError("连接中断——服务器端运行可能仍在继续。刷新页面或重新打开本会话即可重连并回放完整过程。");
    };

    return () => {
      if (generationRef.current === generation) generationRef.current += 1;
      if (watchdog) clearTimeout(watchdog);
      es.close();
      esRef.current = null;
    };
  }, [persistActive, requestKey, viewKey]);

  // Effects run after render. Until the new request's effect has claimed its
  // view key, fail closed instead of painting the prior tenant/conversation.
  if (activeViewKey !== viewKey) {
    return { events: [], running: false, runId: null, error: null };
  }
  return { events, running, runId, error };
}
