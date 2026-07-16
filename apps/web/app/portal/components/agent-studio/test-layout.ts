export const TEST_SETUP_MIN_WIDTH = 280;
export const TEST_SETUP_MAX_WIDTH = 720;
export const TEST_CHAT_MIN_WIDTH = 340;
export const TEST_HISTORY_MIN_WIDTH = 210;
export const TEST_HISTORY_MAX_WIDTH = 520;
export const TEST_HISTORY_DEFAULT_WIDTH = 250;
export const TEST_HISTORY_MIN_HEIGHT = 180;
export const TEST_HISTORY_MAX_HEIGHT = 520;
export const TEST_HISTORY_DEFAULT_HEIGHT = 250;
export const TEST_SPLITTER_WIDTH = 6;

export function clampPanelWidth(
  value: number,
  min: number,
  max: number,
): number {
  const finiteValue = Number.isFinite(value) ? value : min;
  return Math.max(min, Math.min(Math.max(min, max), finiteValue));
}

export function maxTestSetupWidth(
  gridWidth: number,
  historyWidth: number,
  historyInline: boolean,
): number {
  const reserved =
    TEST_CHAT_MIN_WIDTH +
    TEST_SPLITTER_WIDTH +
    (historyInline ? TEST_SPLITTER_WIDTH + historyWidth : 0);
  return clampPanelWidth(
    Math.floor(gridWidth - reserved),
    TEST_SETUP_MIN_WIDTH,
    TEST_SETUP_MAX_WIDTH,
  );
}

export function maxTestHistoryWidth(
  gridWidth: number,
  setupWidth: number,
  historyInline: boolean,
): number {
  if (!historyInline) return TEST_HISTORY_MAX_WIDTH;
  const reserved = TEST_CHAT_MIN_WIDTH + TEST_SPLITTER_WIDTH * 2 + setupWidth;
  return clampPanelWidth(
    Math.floor(gridWidth - reserved),
    TEST_HISTORY_MIN_WIDTH,
    TEST_HISTORY_MAX_WIDTH,
  );
}
