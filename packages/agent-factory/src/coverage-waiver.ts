/**
 * Wire format for an explicit human waiver of coverage cells that cannot be
 * generated safely without real business data.  This is deliberately a
 * machine-readable token embedded in the existing test-approval message; a
 * plain "approve" must never be interpreted as a waiver.
 */

export interface CoverageWaiverReceipt {
  cells: string[];
  note?: string;
  confirmedAt: number;
}

const PREFIX = "[覆盖豁免:";

export function normalizeCoverageCells(cells: readonly string[]): string[] {
  return [...new Set(cells.map((cell) => cell.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

export function formatCoverageWaiverTag(cells: readonly string[]): string {
  const normalized = normalizeCoverageCells(cells);
  return `${PREFIX}${normalized.map((cell) => encodeURIComponent(cell)).join(",")}]`;
}

export function parseCoverageWaiverTag(text: string): string[] | null {
  const start = text.indexOf(PREFIX);
  if (start < 0) return null;
  const encoded = text.slice(start + PREFIX.length).split("]", 1)[0];
  if (!encoded) return null;
  try {
    const cells = normalizeCoverageCells(encoded.split(",").map((cell) => decodeURIComponent(cell)));
    return cells.length ? cells : null;
  } catch {
    return null;
  }
}

export function coverageWaiverMatches(
  uncoveredCells: readonly string[],
  waiver: Pick<CoverageWaiverReceipt, "cells"> | undefined,
): boolean {
  const expected = normalizeCoverageCells(uncoveredCells);
  if (!expected.length) return true;
  if (!waiver) return false;
  const actual = normalizeCoverageCells(waiver.cells);
  return expected.length === actual.length && expected.every((cell, index) => cell === actual[index]);
}
