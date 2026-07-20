// #RUN-REGRESSION (P1-6) — pure verdict keying + diff, extracted so the replay tool's core logic is
// unit-testable without standing up the whole sandbox pipeline.

export type CaseVerdict = { pass: boolean; kind: string; reason: string };

/** Zip the sandbox event's parallel arrays (cases[i] ↔ results[i]) into a name-keyed verdict map.
 *  Falls back to `${kind}#${i}` when the arrays are misaligned or a name is missing. */
export function keyVerdictsByCase(
  cases: Array<{ name?: string }> | undefined,
  results: Array<{ kind: string; pass: boolean; reason: string }> | undefined,
): Record<string, CaseVerdict> {
  const out: Record<string, CaseVerdict> = {};
  for (let i = 0; i < (results ?? []).length; i++) {
    const r = results![i]!;
    const key = cases?.[i]?.name?.trim() ? cases![i]!.name!.trim() : `${r.kind}#${i}`;
    out[key] = { pass: r.pass, kind: r.kind, reason: (r.reason ?? "").slice(0, 160) };
  }
  return out;
}

export interface RegressionDiff {
  fixed: string[];
  regressed: string[];
  stillFailing: string[];
  /** cases present now but absent from the baseline (new cases — no diff verdict). */
  newCases: string[];
}

/** Per-case diff vs the previous replay. Only cases present in BOTH sides get a fixed/regressed
 *  verdict; brand-new cases are listed separately, never miscounted as fixes. */
export function diffRegression(
  baseline: Record<string, CaseVerdict> | undefined,
  current: Record<string, CaseVerdict>,
): RegressionDiff {
  const fixed: string[] = [];
  const regressed: string[] = [];
  const stillFailing: string[] = [];
  const newCases: string[] = [];
  for (const [name, v] of Object.entries(current)) {
    const prev = baseline?.[name];
    if (!prev) { newCases.push(name); continue; }
    if (!prev.pass && v.pass) fixed.push(name);
    else if (prev.pass && !v.pass) regressed.push(name);
    else if (!prev.pass && !v.pass) stillFailing.push(name);
  }
  return { fixed, regressed, stillFailing, newCases };
}
