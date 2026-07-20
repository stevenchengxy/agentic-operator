/** Pure value conversion helpers shared by production settings forms. */

function parseNonNegative(value: string, label: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative number or blank.`);
  }
  return parsed;
}

/** Blank means unlimited; the budget API stores whole tokens. */
export function parseTokenCap(value: string): number | null {
  const parsed = parseNonNegative(value, "Token cap");
  if (parsed == null) return null;
  if (!Number.isInteger(parsed)) {
    throw new Error("Token cap must be a whole number or blank.");
  }
  return parsed;
}

/** Blank means unlimited; the budget API stores USD caps in integer cents. */
export function parseUsdCap(value: string): number | null {
  const parsed = parseNonNegative(value, "USD cap");
  return parsed == null ? null : Math.round(parsed * 100);
}
