// Phase 3 — the real-verification substrate's PURE core: deterministic cassettes (record/replay
// of tool I/O so a sandbox run is reproducible in CI without live vendor calls), per-CASE-KIND
// verdicts (resolving the reject-case contradiction: a reject case that correctly reaches a FAIL
// terminal is a PASS, and must NOT be counted against a success-only chain gate), and a per-step
// durability check (a forced replay must not double-execute a logical step).
//
// Determinism stance (per the adversarial review): CI gates on cassette-replay + schema + per-step
// durability. The optional LLM-judge / real-model layers are non-reproducible by construction and
// are advisory-only (gated by env), never the blocking verdict — see verificationPolicy().

import {
  canonicalHttpCassetteKey,
  cassetteHash,
  type CanonicalCassetteDocument,
  type CanonicalCassetteEntry,
} from "@agentic/shared/cassette";

export type CaseKind = "pass" | "reject" | "edge" | "fault";

export interface CaseRunOutcome {
  kind: CaseKind;
  /** the chain reached a non-failish terminal event */
  reachedSuccessTerminal: boolean;
  /** the chain reached a failish terminal (rejected / blocked) */
  reachedFailTerminal: boolean;
  /** unhandled error, or no terminal reached at all */
  crashed: boolean;
  /** an agent carried an explicit degraded shell or failed executable evidence */
  degraded?: boolean;
  /** Exact event assertion for structured rule boundary cases. */
  expectedEvent?: string;
  expectedEventMatched?: boolean;
}

/** Verdict for ONE test case, by its declared kind. */
export function caseVerdict(o: CaseRunOutcome): { pass: boolean; reason: string } {
  if (o.crashed) return { pass: false, reason: "crashed / no terminal reached" };
  if (o.expectedEvent) {
    return o.expectedEventMatched === true && !o.degraded
      ? { pass: true, reason: `reached expected event ${o.expectedEvent}` }
      : { pass: false, reason: o.degraded ? `reached ${o.expectedEvent} but an agent degraded` : `did not reach expected event ${o.expectedEvent}` };
  }
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
    case "fault":
      // #W3-FAULT — an injected tool fault must be handled GRACEFULLY: no crash, and the chain must
      // NOT claim a clean success terminal while a tool it depends on was poisoned.
      return !o.reachedSuccessTerminal
        ? { pass: true, reason: "fault handled gracefully (no false success with a poisoned tool)" }
        : { pass: false, reason: "reached a success terminal DESPITE an injected tool fault — the failure path is not wired" };
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
    fault: { total: 0, passed: 0 },
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
  private map = new Map<string, CanonicalCassetteEntry>();

  constructor(input?: CassetteEntry[] | CanonicalCassetteDocument) {
    if (Array.isArray(input)) {
      for (const entry of input) {
        const key = canonicalHttpCassetteKey(entry.method, entry.url);
        this.map.set(key, {
          key,
          request: { kind: "http", method: entry.method, url: entry.url, bodyHash: cassetteHash("") },
          response: { status: entry.status, body: entry.body },
        });
      }
    } else {
      for (const entry of input?.entries ?? []) this.map.set(entry.key, entry);
    }
  }

  static keyFor(method: string, url: string, body?: string): string {
    return canonicalHttpCassetteKey(method, url, body);
  }

  record(method: string, url: string, body: string | undefined, status: number, responseBody: string): void {
    const key = Cassette.keyFor(method, url, body);
    this.map.set(key, {
      key,
      request: { kind: "http", method: (method || "GET").toUpperCase(), url, bodyHash: cassetteHash(body ?? "") },
      response: { status, body: responseBody },
      recordedAt: new Date().toISOString(),
    });
  }

  replay(method: string, url: string, body?: string): CassetteEntry | undefined {
    const entry = this.map.get(Cassette.keyFor(method, url, body));
    if (!entry || entry.request.kind !== "http") return undefined;
    return {
      key: entry.key,
      method: entry.request.method,
      url: entry.request.url,
      status: entry.response.status,
      body: typeof entry.response.body === "string" ? entry.response.body : JSON.stringify(entry.response.body),
    };
  }

  toJSON(): CanonicalCassetteDocument {
    return { version: 1, entries: [...this.map.values()] };
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
  /** use a real LLM in production sandboxes; tests may opt into the deterministic adapter */
  realModel: boolean;
  /** tool dispatch mode: "mock" (dry stubs), "replay" (cassettes), "live" (real vendor sandbox) */
  toolMode: "mock" | "replay" | "live" | "gated";
  /** hard aggregate output-token budget for one factory verification run (0 = unbounded) */
  budgetTokens: number;
  /** the LLM cite-the-field judge is advisory only — never the blocking CI verdict */
  judgeIsBlocking: boolean;
}

/** Resolve the verification policy from env.
 *  #REDESIGN P1b — REAL by default (拒绝 mock): the sandbox uses the REAL gateway model so the
 *  reasoning that runs in verification is the same that runs in production. LLM calls have no
 *  external side-effects, so this is safe to default on. TESTS (NODE_ENV=test) keep the mock model
 *  for free, deterministic, offline CI. Production cannot force the mock model.
 *  Tool side-effects stay gated: production reads call live handlers, while writes are captured at
 *  the boundary unless the operator explicitly enables sandbox writes. */
export function verificationPolicy(env: Record<string, string | undefined> = process.env): VerificationPolicy {
  const isTest = env.NODE_ENV === "test";
  const realModel = isTest ? env.FACTORY_SANDBOX_REAL_MODEL === "1" : true;
  // Mirror runtime sandboxToolMode: default "gated" in production (read live / write gated), "mock"
  // in tests. Production coerces mock/replay to gated so verification can
  // never be promoted on synthetic evidence.
  const toolModeRaw = (env.FACTORY_SANDBOX_TOOL_MODE ?? (isTest ? "mock" : "gated")).toLowerCase();
  const requestedToolMode = ["replay", "live", "mock", "gated"].includes(toolModeRaw) ? (toolModeRaw as VerificationPolicy["toolMode"]) : (isTest ? "mock" : "gated");
  const toolMode = !isTest && (requestedToolMode === "mock" || requestedToolMode === "replay")
    ? "gated"
    : requestedToolMode;
  const budgetTokens = Number(env.FACTORY_SANDBOX_BUDGET_TOKENS ?? "0") || 0;
  return {
    realModel,
    toolMode,
    budgetTokens,
    // The judge is blocking ONLY if explicitly forced AND we're not in a deterministic CI posture.
    judgeIsBlocking: env.FACTORY_SANDBOX_JUDGE_BLOCKING === "1",
  };
}
