// Phase 1a — pure, dependency-free decision logic extracted from the Inngest-coupled
// register.ts / step-engine.ts so the production-grade orchestration semantics
// (stable idempotency-keyed step ids, real condition branching, synchronous soft-invoke)
// are unit-testable WITHOUT a live Inngest or a DB handle.
//
// Nothing here imports inngest / drizzle / better-sqlite3 — keep it that way.

/** Inngest step ids must be stable + contain only safe chars. Mirrors the OLD agents'
 *  `sanitize()` (resume-parser-agent.ts) so the same logical step memoizes across replays. */
export function sanitizeStepId(s: string): string {
  const cleaned = (s || "").replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 80);
  // An all-separator result ("---") is a valid-but-useless Inngest id; collapse to the fallback.
  return /[A-Za-z0-9]/.test(cleaned) ? cleaned : "step";
}

/** Walk a dotted path on a plain object/scope. Returns undefined on any miss. */
export function readPath(obj: unknown, path: string): unknown {
  if (obj == null || !path) return undefined;
  let cur: unknown = obj;
  for (const part of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

export interface StepScope {
  event?: { name?: string; data?: Record<string, unknown> };
  subject?: unknown;
  lastResult?: unknown;
}

/** Resolve the business key an action dedupes on, from `idempotencyKeyFrom`. Tries the
 *  trigger event's data first (the common case — `entity_id`, `subject`), then the scope. */
export function resolveBusinessKey(key: string | undefined, scope: StepScope): string | undefined {
  if (!key) return undefined;
  if (key === "subject") {
    return scope.subject != null && String(scope.subject).trim() ? String(scope.subject) : undefined;
  }
  const fromData = readPath(scope.event?.data, key);
  if (fromData != null && String(fromData).trim()) return String(fromData);
  const fromScope = readPath(scope, key);
  if (fromScope != null && String(fromScope).trim()) return String(fromScope);
  return undefined;
}

/** Stable, unique-per-iteration Inngest step id. When an action declares
 *  `idempotencyKeyFrom`, the resolved business key is appended (so a loop over a
 *  collection produces distinct, replay-stable ids — the OLD `download-and-parse-${key}`
 *  pattern). Falls back to the action name alone when no key resolves (back-compat). */
export function stableStepId(actionName: string, idempotencyKeyFrom: string | undefined, scope: StepScope): string {
  const base = sanitizeStepId(actionName);
  const biz = resolveBusinessKey(idempotencyKeyFrom, scope);
  return biz ? `${base}-${sanitizeStepId(biz)}` : base;
}

// ── condition evaluator ───────────────────────────────────────────────────────
// A small SAFE boolean expression evaluator (NO eval / new Function). Supports:
//   true / false literals
//   <path> == <lit> | != | >= | <= | > | <      (lit = 'str' | "str" | number | true | false | null)
//   presence:  <path>            (truthy)
//   negation:  !<path>
//   conjunction / disjunction:  &&  ||
// Anything it can't parse → false (deterministic, never throws).

export interface ConditionScope {
  lastResult?: unknown;
  results?: Record<string, unknown>;
  event?: { name?: string; data?: Record<string, unknown> };
}

function splitTop(e: string, op: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = "";
  let buf = "";
  for (let i = 0; i < e.length; i++) {
    const c = e[i]!;
    if (quote) {
      buf += c;
      if (c === quote) quote = "";
      continue;
    }
    if (c === "'" || c === '"') { quote = c; buf += c; continue; }
    if (c === "(") depth++;
    else if (c === ")") depth--;
    if (depth === 0 && e.startsWith(op, i)) { out.push(buf); buf = ""; i += op.length - 1; continue; }
    buf += c;
  }
  out.push(buf);
  return out;
}

function parseLiteral(s: string): unknown {
  const t = s.trim();
  if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) return t.slice(1, -1);
  if (t === "null") return null;
  if (t === "true") return true;
  if (t === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  return t;
}

function compare(l: unknown, r: unknown, op: string): boolean {
  switch (op) {
    case "==": return l === r || (l != null && r != null && String(l) === String(r));
    case "!=": return !(l === r || (l != null && r != null && String(l) === String(r)));
    case ">": return Number(l) > Number(r);
    case "<": return Number(l) < Number(r);
    case ">=": return Number(l) >= Number(r);
    case "<=": return Number(l) <= Number(r);
    default: return false;
  }
}

function evalAtom(atom: string, scope: ConditionScope): boolean {
  const a = atom.trim();
  if (!a) return false;
  if (/^true$/i.test(a)) return true;
  if (/^false$/i.test(a)) return false;
  const m = a.match(/^(.+?)\s*(==|!=|>=|<=|>|<)\s*(.+)$/);
  if (m) return compare(readPath(scope, m[1]!.trim()), parseLiteral(m[3]!), m[2]!);
  if (a.startsWith("!")) return !Boolean(readPath(scope, a.slice(1).trim()));
  return Boolean(readPath(scope, a));
}

export function evaluateCondition(expr: string, scope: ConditionScope): boolean {
  const e = (expr || "").trim();
  if (!e) return false;
  try {
    const ors = splitTop(e, "||");
    if (ors.length > 1) return ors.some((p) => evaluateCondition(p, scope));
    const ands = splitTop(e, "&&");
    if (ands.length > 1) return ands.every((p) => evaluateCondition(p, scope));
    return evalAtom(e, scope);
  } catch {
    return false;
  }
}

// ── dependsOn gating (real branching) ──────────────────────────────────────────

export interface GateState {
  /** condition step name → its evaluated boolean */
  conditionTrue: Record<string, boolean>;
  /** step names that were skipped (so transitive dependents also skip) */
  skipped: Set<string>;
}

/** An action is skipped when any step it dependsOn was itself skipped, or is a condition
 *  step that evaluated false. This is what turns the (previously inert) condition result
 *  into a real branch/skip in the register.ts action loop. */
export function shouldSkip(action: { name: string; dependsOn?: string[] }, gate: GateState): { skip: boolean; reason?: string } {
  for (const dep of action.dependsOn ?? []) {
    if (gate.skipped.has(dep)) return { skip: true, reason: `dependency "${dep}" was skipped` };
    if (dep in gate.conditionTrue && gate.conditionTrue[dep] === false) return { skip: true, reason: `condition "${dep}" is false` };
  }
  return { skip: false };
}

// ── synchronous soft-invoke ─────────────────────────────────────────────────────

export interface SoftInvokeResult<T> {
  ok: boolean;
  data: T | undefined;
  timedOut: boolean;
  softFailed: boolean;
}

/** Run a synchronous sub-call (e.g. a step.invoke of a dedup/identity sub-agent) with a
 *  timeout and a soft-fail-to-default policy — the candidate-identity pattern. On error or
 *  timeout: onError:"soft" → resolve to `fallback`; onError:"terminal" → rethrow. */
export async function softInvoke<T>(
  fn: () => Promise<T>,
  opts?: { timeoutMs?: number; onError?: "soft" | "terminal"; fallback?: T },
): Promise<SoftInvokeResult<T>> {
  const { timeoutMs, onError = "soft", fallback } = opts ?? {};
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    let result: T;
    if (timeoutMs && timeoutMs > 0) {
      const timeoutP = new Promise<never>((_, rej) => {
        timer = setTimeout(() => { timedOut = true; rej(new Error("invoke timeout")); }, timeoutMs);
      });
      result = await Promise.race([fn(), timeoutP]);
    } else {
      result = await fn();
    }
    return { ok: true, data: result, timedOut: false, softFailed: false };
  } catch (e) {
    if (onError === "terminal") throw e;
    return { ok: false, data: fallback, timedOut, softFailed: true };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
