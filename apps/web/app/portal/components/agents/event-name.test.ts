import { describe, expect, it } from "vitest";
import { normalizeAuthoredEventName } from "./event-name";

describe("normalizeAuthoredEventName", () => {
  it("normalizes a free-form name into the deploy contract format", () => {
    expect(normalizeAuthoredEventName("candidate review requested"))
      .toBe("CANDIDATE_REVIEW_REQUESTED");
  });

  it("prefixes names that do not start with a letter", () => {
    expect(normalizeAuthoredEventName("42-ready"))
      .toBe("EVENT_42-READY");
  });

  it("removes unsupported characters and returns blank for blank input", () => {
    expect(normalizeAuthoredEventName("resume @ parsed!"))
      .toBe("RESUME_PARSED");
    expect(normalizeAuthoredEventName("   ")).toBe("");
  });
});
