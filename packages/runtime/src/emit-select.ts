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

const SELECTOR_KEYS = ["_emit", "event", "next_event", "outcome_event"] as const;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // not JSON — no selector available
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
