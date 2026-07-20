/**
 * Branch-emit selection (agent migration: forked agents).
 *
 * The runtime emits exactly one downstream event per agent run. Historically
 * that was always `triggered_event[0]`, so an agent with PASS/FAIL or
 * NEED/NO-INTERVIEW outcomes could not route — every run emitted the first
 * declared event regardless of the agent's decision.
 *
 * This pure helper lets an agent's FINAL step pick which of its declared
 * `triggered_event` values to emit: if the last step's result names one (via
 * `_emit` / `event` / `next_event` / `outcome_event`, validated against the
 * declared allow-list so the LLM can't invent an event), that event is
 * emitted; otherwise it falls back to `triggered_event[0]` — fully
 * backward-compatible with every existing single-outcome agent.
 */

import { tryParseStructuredJson } from "./structured-output";

const SELECTOR_KEYS = ["_emit", "event", "next_event", "outcome_event"] as const;

export interface EmitIntent {
  event: string;
  payload?: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    const parsed = tryParseStructuredJson(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  }
  return undefined;
}

export function selectEmittedEvent(
  triggeredEvents: readonly string[],
  lastResult: unknown,
): string | undefined {
  if (!triggeredEvents || triggeredEvents.length === 0) return undefined;
  const record = asRecord(lastResult);
  if (record) {
    for (const key of SELECTOR_KEYS) {
      const v = record[key];
      if (typeof v === "string" && triggeredEvents.includes(v)) return v;
    }
  }
  return triggeredEvents[0];
}

function normalizeIntent(value: unknown, allow: readonly string[]): EmitIntent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const rec = value as Record<string, unknown>;
  const event = typeof rec.event === "string" ? rec.event : typeof rec.name === "string" ? rec.name : "";
  if (!event || !allow.includes(event)) return null;
  const payload = rec.payload && typeof rec.payload === "object" && !Array.isArray(rec.payload)
    ? rec.payload as Record<string, unknown>
    : undefined;
  return payload ? { event, payload } : { event };
}

/** Select every explicitly emitted event in declaration order. Repeated event names are retained:
 * a foreach may legitimately emit the same outcome once per item. When there is no explicit intent,
 * preserve the historical exactly-one branch selection. */
export function selectEmittedEvents(
  triggeredEvents: readonly string[],
  lastResult: unknown,
  explicitIntents: readonly unknown[] = [],
  opts?: { suppressImplicit?: boolean },
): EmitIntent[] {
  if (!triggeredEvents?.length) return [];
  const explicit = explicitIntents
    .map((value) => normalizeIntent(value, triggeredEvents))
    .filter((value): value is EmitIntent => value !== null);
  // The caller explicitly attempted to emit: never reinterpret an invalid/invented event as the
  // manifest's default success branch. An all-invalid list therefore fails closed to no event.
  if (explicitIntents.length) return explicit;

  const record = asRecord(lastResult);
  const embedded = Array.isArray(record?._emits)
    ? record!._emits
        .map((value) => normalizeIntent(value, triggeredEvents))
        .filter((value): value is EmitIntent => value !== null)
    : [];
  if (Array.isArray(record?._emits)) return embedded;

  // An error-policy continue rule may explicitly suppress the historical
  // triggered_event[0] fallback. Explicit/embedded emits above still win.
  if (opts?.suppressImplicit) return [];

  const event = selectEmittedEvent(triggeredEvents, lastResult);
  return event ? [{ event }] : [];
}
