/**
 * Per-tenant in-process broadcast channel for RunStreamEvent (P1-RT-05).
 *
 * The runtime's step engine + register.ts call `publish()` to emit lifecycle
 * events; the API's `GET /v1/stream` SSE handler calls `subscribe()` to push
 * those events to connected browsers.
 *
 * Design choices:
 *
 *   - **In-process only.** v1 keeps this as a `Map<tenantId, EventEmitter>` so
 *     there's no infra dependency. Multi-pod deployments (Phase 4+) will
 *     replace the broker with Redis pub/sub or Postgres NOTIFY; the
 *     `publish` / `subscribe` API contract stays the same so callers don't
 *     change.
 *
 *   - **Per-tenant isolation.** Channels are keyed by `tenantId`. A subscriber
 *     never sees another tenant's events. The SSE handler is responsible for
 *     deriving the tenant id from the auth context — this module trusts it.
 *
 *   - **Backpressure (none).** EventEmitter delivers synchronously. If a slow
 *     subscriber blocks, it blocks the whole runtime. The SSE handler must
 *     therefore push events into a per-connection bounded queue and drop
 *     oldest if needed. v1 accepts this risk since the event volume is low
 *     (a few per run × ~10s of concurrent runs); Phase 4 ops harness will
 *     swap in a real queue with a high-water mark.
 *
 *   - **No persistence.** Events are fire-and-forget. Subscribers that join
 *     mid-run won't see prior events for that run; they should backfill via
 *     `GET /v1/runs/:id` then start streaming.
 */

import { EventEmitter } from "node:events";
import type { RunStreamEvent } from "@agentic/contracts";

type StreamListener = (event: RunStreamEvent) => void;

/**
 * Internal map of tenantId -> EventEmitter. Lazily created on first use.
 *
 * Each emitter sets `maxListeners` to a reasonably high number so we don't
 * trip Node's leak warning when many browsers subscribe to the same tenant.
 */
const channels = new Map<string, EventEmitter>();

function getChannel(tenantId: string): EventEmitter {
  let ch = channels.get(tenantId);
  if (!ch) {
    ch = new EventEmitter();
    // Cap listeners; 256 is well above realistic browser connections per
    // tenant and below the runaway-process threshold.
    ch.setMaxListeners(256);
    channels.set(tenantId, ch);
  }
  return ch;
}

/**
 * Publish an event to a tenant's channel. No-op when no subscribers are
 * connected — publish is always best-effort. Errors thrown by subscribers
 * are caught + logged so a buggy SSE handler can't break the runtime.
 */
export function publish(event: RunStreamEvent): void {
  __fanoutMirror(event); // #SCALE-FANOUT — cross-instance mirror when a bridge is configured
  __deliverLocal(event);
}

/** Deliver to THIS instance's subscribers only (no bridge mirror — used for remote-origin events). */
function __deliverLocal(event: RunStreamEvent): void {
  const ch = getChannel(event.tenantId);
  try {
    ch.emit("event", event);
  } catch (err) {
    // EventEmitter.emit catches sync listener errors itself when there's no
    // 'error' listener registered, but we double-guard.
    console.warn("[broadcast] subscriber error", err);
  }
}

/**
 * Subscribe to a tenant's channel. Returns an unsubscribe function that the
 * caller MUST invoke when the connection closes — otherwise the listener
 * leaks for the life of the process.
 *
 * Typical usage in the SSE route:
 *
 *   const unsub = subscribe(auth.tenantId, (event) => {
 *     reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
 *   });
 *   req.raw.on("close", unsub);
 */
export function subscribe(
  tenantId: string,
  listener: StreamListener,
): () => void {
  const ch = getChannel(tenantId);
  ch.on("event", listener);
  return () => {
    ch.off("event", listener);
  };
}

/**
 * For tests: count active subscribers per tenant.
 */
export function __subscriberCount(tenantId: string): number {
  const ch = channels.get(tenantId);
  return ch ? ch.listenerCount("event") : 0;
}

/**
 * For tests: clear every channel. NEVER call from production code.
 */
export function __resetForTest(): void {
  for (const ch of channels.values()) ch.removeAllListeners("event");
  channels.clear();
}

// #SCALE-FANOUT — pluggable cross-instance fanout bridge: publish() mirrors every event to the bridge
// (e.g. Redis pub/sub), and bridge-delivered events from OTHER instances re-enter the local
// subscriber set. No bridge configured = exactly today's single-instance behavior.
export interface FanoutBridge {
  publish(event: unknown): void;
  /** register the callback that delivers REMOTE events into this instance. */
  onRemote(cb: (event: unknown) => void): void;
}
let fanoutBridge: FanoutBridge | null = null;
export function setFanoutBridge(bridge: FanoutBridge | null): void {
  fanoutBridge = bridge;
  bridge?.onRemote((event) => {
    // deliver remote events locally WITHOUT re-publishing to the bridge (no loops).
    try { __deliverLocal(event as RunStreamEvent); } catch { /* best-effort */ }
  });
}
export function __fanoutMirror(event: unknown): void {
  try { fanoutBridge?.publish(event); } catch { /* bridge best-effort */ }
}
