// Phase 3 — the real-verification substrate's PURE core: deterministic cassettes (record/replay
// of tool I/O so a sandbox run is reproducible in CI without live vendor calls), per-CASE-KIND
// verdicts (resolving the reject-case contradiction: a reject case that correctly reaches a FAIL
// terminal is a PASS, and must NOT be counted against a success-only chain gate), and a per-step
// durability check (a forced replay must not double-execute a logical step).
//
// Determinism stance (per the adversarial review): CI gates on cassette-replay + schema + per-step
// durability. The optional LLM-judge / real-model layers are non-reproducible by construction and
// are advisory-only (gated by env), never the blocking verdict — see verificationPolicy().

export type CaseKind = "pass" | "reject" | "edge";

export interface CaseRunOutcome {
  kind: CaseKind;
  /** the chain reached a non-failish terminal event */
  reachedSuccessTerminal: boolean;
  /** the chain reached a failish terminal (rejected / blocked) */
  reachedFailTerminal: boolean;
  /** unhandled error, or no terminal reached at all */
  crashed: boolean;
  /** an agent degraded (e.g. tool-less / mock) */
  degraded?: boolean;
}

/** Verdict for ONE test case, by its declared kind. */
export function caseVerdict(o: CaseRunOutcome): { pass: boolean; reason: string } {
  if (o.crashed) return { pass: false, reason: "crashed / no terminal reached" };
  switch (o.kind) {
    case "pass":
      return o.reachedSuccessTerminal && !o.degraded
        ? { pass: true, reason: "reached success terminal" }
        : { pass: false, reason: o.degraded ? "reached terminal but an agent degraded" : "did not reach a clean success terminal" };
    case "reject":
      // A reject case is CORRECT when it reaches the FAIL terminal (not success). This is the split
      // that stops a correct rejection from dragging a success-only chain gate to false.
      return o.reachedFailTerminal && !o.reachedSuccessTerminal
        ? { pass: true, reason: "correctly reached the fail terminal" }
        : { pass: false, reason: "reject case did not reach a fail terminal (it should be blocked)" };
    case "edge":
      return { pass: true, reason: "completed without crash (graceful)" };
    default:
      return { pass: false, reason: `unknown case kind ${String((o as { kind?: unknown }).kind)}` };
  }
}

export interface ChainVerdict {
  allPass: boolean;
  results: Array<{ kind: CaseKind; pass: boolean; reason: string }>;
  byKind: Record<CaseKind, { total: number; passed: number }>;
}

/** Aggregate per-kind verdicts. success cases must reach success; reject cases must reach FAIL
 *  (counted on their OWN axis, not against success); edge cases must not crash. */
export function chainVerdictByKind(outcomes: CaseRunOutcome[]): ChainVerdict {
  const byKind: Record<CaseKind, { total: number; passed: number }> = {
    pass: { total: 0, passed: 0 },
    reject: { total: 0, passed: 0 },
    edge: { total: 0, passed: 0 },
  };
  const results = outcomes.map((o) => {
    const v = caseVerdict(o);
    byKind[o.kind].total++;
    if (v.pass) byKind[o.kind].passed++;
    return { kind: o.kind, pass: v.pass, reason: v.reason };
  });
  return { allPass: results.length > 0 && results.every((r) => r.pass), results, byKind };
}

// ── deterministic cassettes ─────────────────────────────────────────────────

function hashStr(s: string): string {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export interface CassetteEntry {
  key: string;
  method: string;
  url: string;
  status: number;
  body: string;
}

/** A request→response tape for deterministic tool replay. In LIVE mode the deployer records real
 *  vendor responses; in REPLAY mode (CI) the recorded tape answers, so a sandbox run is free +
 *  reproducible. The fetchFn() plugs straight into makeDeclarativeTool({ fetchFn }). */
export class Cassette {
  private map = new Map<string, CassetteEntry>();

  constructor(entries?: CassetteEntry[]) {
    for (const e of entries ?? []) this.map.set(e.key, e);
  }

  static keyFor(method: string, url: string, body?: string): string {
    return hashStr(`${(method || "GET").toUpperCase()} ${url} ${body ?? ""}`);
  }

  record(method: string, url: string, body: string | undefined, status: number, responseBody: string): void {
    const key = Cassette.keyFor(method, url, body);
    this.map.set(key, { key, method: (method || "GET").toUpperCase(), url, status, body: responseBody });
  }

  replay(method: string, url: string, body?: string): CassetteEntry | undefined {
    return this.map.get(Cassette.keyFor(method, url, body));
  }

  toJSON(): CassetteEntry[] {
    return [...this.map.values()];
  }

  /** A fetch-compatible fn that answers from the tape (REPLAY). A miss throws (fail-closed: a CI
   *  run must not silently hit the network). */
  fetchFn(): typeof fetch {
    return (async (url: string, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toString();
      const body = init?.body != null ? String(init.body) : undefined;
      const hit = this.replay(method, String(url), body);
      if (!hit) throw new Error(`cassette miss: ${method} ${String(url)} (no recorded response — record in LIVE mode first)`);
      return new Response(hit.body, { status: hit.status, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
  }
}

// ── per-step durability check ───────────────────────────────────────────────

export interface StepRowLike {
  ord: number;
  name: string;
  /** whether this step performed an external/DB side effect (tool / invoke) */
  sideEffect?: boolean;
}

/** A forced replay (re-fire the same subject) must NOT double-execute a logical step. Given the
 *  step rows observed across a replay, return the names of side-effecting steps that appear more
 *  than once — a non-empty result means the step.run idempotency discipline is broken. */
export function duplicateSideEffectSteps(steps: StepRowLike[]): string[] {
  const counts = new Map<string, number>();
  for (const s of steps) {
    if (s.sideEffect === false) continue;
    counts.set(s.name, (counts.get(s.name) ?? 0) + 1);
  }
  return [...counts.entries()].filter(([, n]) => n > 1).map(([name]) => name);
}

// ── verification policy (determinism + cost) ────────────────────────────────

export interface VerificationPolicy {
  /** use a real LLM in the sandbox (default false — mock-model-v1 keeps runs free + deterministic) */
  realModel: boolean;
  /** tool dispatch mode: "mock" (dry stubs), "replay" (cassettes), "live" (real vendor sandbox) */
  toolMode: "mock" | "replay" | "live";
  /** hard aggregate output-token budget for one factory verification run (0 = unbounded/mock) */
  budgetTokens: number;
  /** the LLM cite-the-field judge is advisory only — never the blocking CI verdict */
  judgeIsBlocking: boolean;
}

/** Resolve the verification policy from env. Safe defaults: mock model + mock tools + advisory
 *  judge, so the default sandbox run stays free, deterministic, and side-effect-free. Real model /
 *  live tools require an explicit opt-in + a budget. */
export function verificationPolicy(env: Record<string, string | undefined> = process.env): VerificationPolicy {
  const realModel = env.FACTORY_SANDBOX_REAL_MODEL === "1";
  const toolModeRaw = (env.FACTORY_SANDBOX_TOOL_MODE ?? "mock").toLowerCase();
  const toolMode = toolModeRaw === "replay" || toolModeRaw === "live" ? (toolModeRaw as "replay" | "live") : "mock";
  const budgetTokens = Number(env.FACTORY_SANDBOX_BUDGET_TOKENS ?? "0") || 0;
  return {
    realModel,
    toolMode,
    budgetTokens,
    // The judge is blocking ONLY if explicitly forced AND we're not in a deterministic CI posture.
    judgeIsBlocking: env.FACTORY_SANDBOX_JUDGE_BLOCKING === "1",
  };
}
