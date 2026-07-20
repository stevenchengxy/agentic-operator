import { describe, it, expect } from "vitest";
import { selectEmittedEvent, selectEmittedEvents } from "@agentic/runtime";

const EVENTS = [
  "MATCH_PASSED_NEED_INTERVIEW",
  "MATCH_PASSED_NO_INTERVIEW",
  "MATCH_FAILED",
];

describe("selectEmittedEvent (branch-emit)", () => {
  it("returns undefined when no events are declared", () => {
    expect(selectEmittedEvent([], { _emit: "X" })).toBeUndefined();
  });

  it("defaults to triggered_event[0] when the result names nothing", () => {
    expect(selectEmittedEvent(EVENTS, { score: 0.9 })).toBe(
      "MATCH_PASSED_NEED_INTERVIEW",
    );
  });

  it("defaults to [0] for non-object results (raw text / null)", () => {
    expect(selectEmittedEvent(EVENTS, "free-text summary")).toBe(
      "MATCH_PASSED_NEED_INTERVIEW",
    );
    expect(selectEmittedEvent(EVENTS, null)).toBe(
      "MATCH_PASSED_NEED_INTERVIEW",
    );
  });

  it("emits the event the result selects via _emit", () => {
    expect(selectEmittedEvent(EVENTS, { _emit: "MATCH_FAILED" })).toBe(
      "MATCH_FAILED",
    );
  });

  it("supports event / next_event / outcome_event selector keys", () => {
    expect(
      selectEmittedEvent(EVENTS, { event: "MATCH_PASSED_NO_INTERVIEW" }),
    ).toBe("MATCH_PASSED_NO_INTERVIEW");
    expect(selectEmittedEvent(EVENTS, { next_event: "MATCH_FAILED" })).toBe(
      "MATCH_FAILED",
    );
    expect(
      selectEmittedEvent(EVENTS, { outcome_event: "MATCH_FAILED" }),
    ).toBe("MATCH_FAILED");
  });

  it("ignores a selector not in the declared allow-list (no inventing events)", () => {
    expect(selectEmittedEvent(EVENTS, { _emit: "TOTALLY_MADE_UP" })).toBe(
      "MATCH_PASSED_NEED_INTERVIEW",
    );
  });

  it("parses a JSON-string result and reads its selector", () => {
    expect(
      selectEmittedEvent(EVENTS, JSON.stringify({ _emit: "MATCH_FAILED" })),
    ).toBe("MATCH_FAILED");
  });

  it("_emit takes precedence over event", () => {
    expect(
      selectEmittedEvent(EVENTS, {
        _emit: "MATCH_FAILED",
        event: "MATCH_PASSED_NO_INTERVIEW",
      }),
    ).toBe("MATCH_FAILED");
  });
});

describe("selectEmittedEvents (error-policy emission)", () => {
  it("suppresses only the implicit default event", () => {
    expect(
      selectEmittedEvents(EVENTS, { score: 0.9 }, [], { suppressImplicit: true }),
    ).toEqual([]);
  });

  it("keeps an explicitly selected error event even when implicit emission is suppressed", () => {
    expect(
      selectEmittedEvents(
        EVENTS,
        { score: 0.9 },
        [{ event: "MATCH_FAILED", payload: { reason: "classified" } }],
        { suppressImplicit: true },
      ),
    ).toEqual([{ event: "MATCH_FAILED", payload: { reason: "classified" } }]);
  });
});
