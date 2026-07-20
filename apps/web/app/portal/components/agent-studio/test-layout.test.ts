import { describe, expect, it } from "vitest";
import {
  clampPanelWidth,
  maxTestHistoryWidth,
  maxTestSetupWidth,
  testHistoryFitsInline,
  TEST_HISTORY_MAX_WIDTH,
  TEST_HISTORY_MAX_HEIGHT,
  TEST_HISTORY_INLINE_MIN_WIDTH,
  TEST_HISTORY_MIN_HEIGHT,
  TEST_HISTORY_MIN_WIDTH,
  TEST_SETUP_MAX_WIDTH,
  TEST_SETUP_MIN_WIDTH,
} from "./test-layout";

describe("Test Lab resizable layout", () => {
  it("moves history based on the Test Lab container rather than the viewport", () => {
    expect(testHistoryFitsInline(TEST_HISTORY_INLINE_MIN_WIDTH + 1)).toBe(true);
    expect(testHistoryFitsInline(TEST_HISTORY_INLINE_MIN_WIDTH)).toBe(false);
    expect(testHistoryFitsInline(720)).toBe(false);
    expect(testHistoryFitsInline(Number.NaN)).toBe(false);
  });

  it("clamps invalid and out-of-range panel widths", () => {
    expect(clampPanelWidth(Number.NaN, 280, 720)).toBe(280);
    expect(clampPanelWidth(100, 280, 720)).toBe(280);
    expect(clampPanelWidth(900, 280, 720)).toBe(720);
    expect(clampPanelWidth(440, 280, 720)).toBe(440);
  });

  it("reserves the conversation minimum when run history is inline", () => {
    expect(maxTestSetupWidth(1_500, 250, true)).toBe(TEST_SETUP_MAX_WIDTH);
    expect(maxTestSetupWidth(1_050, 250, true)).toBe(448);
    expect(maxTestSetupWidth(700, 250, true)).toBe(TEST_SETUP_MIN_WIDTH);
  });

  it("allows more setup width after history moves below the conversation", () => {
    expect(maxTestSetupWidth(900, 250, false)).toBe(554);
  });

  it("clamps history while preserving setup and conversation widths", () => {
    expect(maxTestHistoryWidth(1_500, 430, true)).toBe(TEST_HISTORY_MAX_WIDTH);
    expect(maxTestHistoryWidth(1_000, 430, true)).toBe(218);
    expect(maxTestHistoryWidth(700, 430, true)).toBe(TEST_HISTORY_MIN_WIDTH);
    expect(maxTestHistoryWidth(700, 430, false)).toBe(TEST_HISTORY_MAX_WIDTH);
  });

  it("provides safe bounds for the stacked history drawer", () => {
    expect(
      clampPanelWidth(120, TEST_HISTORY_MIN_HEIGHT, TEST_HISTORY_MAX_HEIGHT),
    ).toBe(TEST_HISTORY_MIN_HEIGHT);
    expect(
      clampPanelWidth(900, TEST_HISTORY_MIN_HEIGHT, TEST_HISTORY_MAX_HEIGHT),
    ).toBe(TEST_HISTORY_MAX_HEIGHT);
  });
});
