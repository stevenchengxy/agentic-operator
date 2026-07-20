/**
 * Minimal condition evaluator (P0-RT-05).
 *
 * Manifest actions can declare a `condition?: string` (e.g. `"lastResult.score > 0.5"`).
 * Phase 0 ships a tiny deterministic evaluator over a fixed two-variable
 * context (`lastResult`, `event`) — NOT a general expression engine.
 *
 * Grammar accepted (loosely; no formal parser):
 *   - Identifiers + dotted paths: `lastResult`, `event.data.subject`
 *   - Literals: numbers, strings ("..." or '...'), `true`/`false`/`null`/`undefined`
 *   - Comparison: `==`, `!=`, `===`, `!==`, `<`, `<=`, `>`, `>=`
 *   - Logical: `&&`, `||`, `!`
 *   - Parentheses
 *   - Method-free truthiness: bare identifier or path coerces to boolean
 *
 * Anything beyond that (function call, template strings, regex, bitwise…)
 * is intentionally NOT supported. Malformed expressions fail CLOSED: the
 * manifest parser normally rejects them before registration, and this public
 * compatibility API returns false as defense in depth.
 */

import { evaluateConditionDetailed } from "./action-plan";

export interface ConditionContext {
  lastResult: unknown;
  event: { name: string; data: Record<string, unknown> };
}

/**
 * Evaluate a manifest condition string. Returns:
 *  - `true` if the condition is missing/empty (no condition = always run).
 *  - `false` if the condition is malformed (FAIL-CLOSED; logs a warning).
 *  - `true` if the expression resolves truthy.
 *  - `false` only if the expression evaluates falsy.
 */
export function evaluateCondition(
  condition: string | undefined | null,
  ctx: ConditionContext,
  log?: (msg: string, extra?: Record<string, unknown>) => void,
): boolean {
  if (!condition) return true;
  const src = condition.trim();
  if (src === "") return true;
  const result = evaluateConditionDetailed(src, {
    lastResult: ctx.lastResult,
    event: ctx.event,
    input: ctx.event.data,
  });
  if (!result.valid) {
    (log ?? defaultWarn)(
      `[condition] invalid expression — failing closed`,
      {
        condition: src,
        error: result.error ?? "invalid condition",
      },
    );
    return false;
  }
  return result.value;
}

function defaultWarn(msg: string, extra?: Record<string, unknown>): void {
  if (extra) {
    console.warn(msg, extra);
  } else {
    console.warn(msg);
  }
}
