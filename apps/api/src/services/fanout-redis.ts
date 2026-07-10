// #SCALE-FANOUT — Redis-backed cross-instance SSE fanout bridge. Config-flip: set REDIS_URL and
// install `ioredis` (pnpm add ioredis -F @agentic/api) when you scale to N instances; until then this
// module is inert. Dynamic import → no hard dependency; missing package logs one warning and no-ops.
//
// Hardening notes (they matter in production):
//  - ioredis EMITS 'error' — with no listener attached, a dropped connection becomes an UNCAUGHT
//    exception and kills the process. Both clients get a rate-limited warn listener.
//  - reconnect is ioredis-native (capped backoff via retryStrategy); the subscription survives it.
//  - stopRedisFanout() quits both clients + detaches the bridge — wired into the api's onClose so
//    SIGTERM drains cleanly instead of leaving sockets to time out.
import { setFanoutBridge } from "@agentic/runtime";

interface RedisLike {
  publish(ch: string, msg: string): unknown;
  subscribe(ch: string): Promise<unknown>;
  on(ev: string, cb: (...args: never[]) => void): unknown;
  quit(): Promise<unknown>;
}
interface RedisCtor {
  new (u: string, opts?: Record<string, unknown>): RedisLike;
}

let clients: { pub: RedisLike; sub: RedisLike } | null = null;

/** For /health: "redis" when the bridge is live, else "local". */
export function fanoutStatus(): "redis" | "local" {
  return clients ? "redis" : "local";
}

export async function wireRedisFanout(): Promise<boolean> {
  const url = process.env.REDIS_URL;
  if (!url) return false;
  try {
    const mod = (await import("ioredis" as string)) as { default: RedisCtor };
    const Redis = mod.default;
    // Capped exponential reconnect (200ms → 5s), never give up — the bridge is best-effort and the
    // local emitter keeps working while Redis is away. Offline queue OFF: a publish during an outage
    // should drop (the event was already delivered locally), not pile up unbounded.
    const opts = { retryStrategy: (times: number) => Math.min(200 * 2 ** Math.min(times, 5), 5_000), maxRetriesPerRequest: 2, enableOfflineQueue: false };
    const pub = new Redis(url, opts);
    const sub = new Redis(url, opts);
    // Rate-limited error logging: one line per 30s, not one per reconnect tick.
    let lastWarn = 0;
    const onErr = (which: string) => (err?: { message?: string }) => {
      const now = Date.now();
      if (now - lastWarn > 30_000) {
        lastWarn = now;
        console.warn(`[fanout] redis ${which} error (bridge degraded to local until reconnect):`, String(err?.message ?? err).slice(0, 100));
      }
    };
    (pub.on as (ev: string, cb: (err?: { message?: string }) => void) => unknown)("error", onErr("pub"));
    (sub.on as (ev: string, cb: (err?: { message?: string }) => void) => unknown)("error", onErr("sub"));

    const CH = "agentic:fanout";
    const origin = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    let remoteCb: ((e: unknown) => void) | null = null;
    await sub.subscribe(CH);
    (sub.on as (ev: string, cb: (ch: string, msg: string) => void) => unknown)("message", (_ch: string, msg: string) => {
      try {
        const { o, e } = JSON.parse(msg) as { o: string; e: unknown };
        if (o !== origin) remoteCb?.(e); // never re-deliver our own events
      } catch {
        /* malformed remote frame */
      }
    });
    setFanoutBridge({
      publish: (e) => {
        // enableOfflineQueue:false → publish while disconnected REJECTS/THROWS; swallow both — the
        // event already reached this instance's local subscribers before the mirror.
        try {
          void Promise.resolve(pub.publish(CH, JSON.stringify({ o: origin, e }))).catch(() => {});
        } catch {
          /* disconnected */
        }
      },
      onRemote: (cb) => {
        remoteCb = cb;
      },
    });
    clients = { pub, sub };
    console.log("[fanout] Redis bridge active — cross-instance SSE fanout on", CH);
    return true;
  } catch (err) {
    console.warn("[fanout] REDIS_URL set but ioredis unavailable — staying single-instance:", (err as Error).message.slice(0, 80));
    return false;
  }
}

/** Detach the bridge + quit both clients. Idempotent; wired into the api's onClose drain. */
export async function stopRedisFanout(): Promise<void> {
  const c = clients;
  clients = null;
  if (!c) return;
  setFanoutBridge(null);
  await Promise.allSettled([c.pub.quit(), c.sub.quit()]);
}
