import { NonRetriableError } from "inngest";

/**
 * Runtime error taxonomy exposed to an action's declarative predicate ladder.
 *
 * The surface is deliberately small and data-only.  Predicates never execute
 * JavaScript; they may inspect these scalar fields plus nested `data`/`meta`
 * values captured from a failed StepOutput.
 */
export interface ActionErrorFacts {
  kind?: string;
  code?: string;
  status?: number;
  name: string;
  message: string;
  data?: Record<string, unknown>;
  meta?: Record<string, unknown>;
}

export type ErrorPolicyAction = "park" | "retry" | "terminal" | "continue";

export interface RuntimeErrorPolicyRule {
  when?: string;
  do?: ErrorPolicyAction;
  default?: ErrorPolicyAction;
  default_result?: unknown;
  defaultResult?: unknown;
  emit_event?: string;
  emitEvent?: string;
  emit_payload?: Record<string, unknown>;
  emitPayload?: Record<string, unknown>;
  suppress_emit?: boolean;
  suppressEmit?: boolean;
}

export type RuntimeOnErrorPolicy =
  | "soft"
  | "terminal"
  | ReadonlyArray<RuntimeErrorPolicyRule>
  | undefined;

export interface ActionFailureResolution {
  /** `park` is normalized to retry; both deliberately keep Inngest retries alive. */
  disposition: "retry" | "terminal" | "continue";
  policyAction: ErrorPolicyAction | "soft";
  facts: ActionErrorFacts;
  defaultResult?: unknown;
  emitEvent?: string;
  emitPayload?: Record<string, unknown>;
  suppressEmit: boolean;
  matchedRule?: number;
  /** Defense-in-depth reason when an invalid ladder bypassed manifest validation. */
  policyError?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function scalarString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

/**
 * Extract typed facts without depending on a concrete tool implementation.
 * This understands Error.cause, the runtime's failed StepOutput shape, and
 * ordinary `{ kind/code/status }` records.  It therefore survives an Inngest
 * StepError wrapper while remaining useful for any future tool family.
 */
export function actionErrorFacts(value: unknown): ActionErrorFacts {
  const rootError = value instanceof Error ? value : undefined;
  let kind: string | undefined;
  let code: string | undefined;
  let status: number | undefined;
  let name = rootError?.name || "Error";
  let message = rootError?.message || scalarString(value) || "action failed";
  let data: Record<string, unknown> | undefined;
  let meta: Record<string, unknown> | undefined;

  const queue: unknown[] = [value];
  const seen = new Set<unknown>();
  for (let i = 0; i < queue.length && i < 24; i++) {
    const current = queue[i];
    if (current == null || seen.has(current)) continue;
    seen.add(current);
    if (current instanceof Error) {
      if (!message || message === "action failed") message = current.message || message;
      if (name === "Error" && current.name) name = current.name;
      queue.push(current.cause);
    }
    const rec = asRecord(current);
    if (!rec) continue;

    kind ??=
      scalarString(rec.kind) ??
      scalarString(rec.failureKind) ??
      scalarString(rec.failure_kind) ??
      scalarString(rec.category);
    code ??=
      scalarString(rec.code) ??
      scalarString(rec.errorCode) ??
      scalarString(rec.error_code);
    const rawStatus = rec.status ?? rec.statusCode ?? rec.status_code;
    if (status === undefined && Number.isFinite(Number(rawStatus))) {
      status = Number(rawStatus);
    }
    const nestedData = asRecord(rec.data);
    const nestedMeta = asRecord(rec.meta);
    data ??= nestedData;
    meta ??= nestedMeta;
    kind ??= scalarString(nestedMeta?.error) ?? scalarString(nestedData?.kind);
    code ??=
      scalarString(nestedMeta?.code) ??
      scalarString(nestedData?.code) ??
      scalarString(nestedData?.error_code);
    const nestedStatus = nestedMeta?.status ?? nestedData?.status;
    if (status === undefined && Number.isFinite(Number(nestedStatus))) {
      status = Number(nestedStatus);
    }

    queue.push(
      rec.cause,
      rec.error,
      rec.reason,
      rec.output,
      rec.result,
      rec.data,
      rec.meta,
    );
  }

  // Declarative errors prefix their message with a stable kind.  Reading the
  // prefix is a serialization fallback, not a tool-name heuristic.
  if (!kind) {
    const prefixed = message.match(/^([a-z][a-z0-9_-]{1,80})\s*:/i);
    if (prefixed) kind = prefixed[1];
  }
  if (status === undefined) {
    const httpStatus = message.match(/\bHTTP\s+(\d{3})\b/i);
    if (httpStatus) status = Number(httpStatus[1]);
  }

  return {
    ...(kind ? { kind } : {}),
    ...(code ? { code } : {}),
    ...(status !== undefined ? { status } : {}),
    name,
    message,
    ...(data ? { data } : {}),
    ...(meta ? { meta } : {}),
  };
}

function stripOuterParens(source: string): string {
  let out = source.trim();
  while (out.startsWith("(") && out.endsWith(")")) {
    let depth = 0;
    let quote = "";
    let wraps = true;
    for (let i = 0; i < out.length; i++) {
      const c = out[i]!;
      if (quote) {
        if (c === "\\") i++;
        else if (c === quote) quote = "";
        continue;
      }
      if (c === "'" || c === '"') {
        quote = c;
        continue;
      }
      if (c === "(") depth++;
      else if (c === ")") depth--;
      if (depth === 0 && i < out.length - 1) {
        wraps = false;
        break;
      }
    }
    if (!wraps || depth !== 0) break;
    out = out.slice(1, -1).trim();
  }
  return out;
}

function splitTop(source: string, operator: "&&" | "||"): string[] {
  const parts: string[] = [];
  let buffer = "";
  let depth = 0;
  let quote = "";
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!;
    if (quote) {
      buffer += c;
      if (c === "\\" && i + 1 < source.length) buffer += source[++i]!;
      else if (c === quote) quote = "";
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      buffer += c;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") depth--;
    if (depth === 0 && source.startsWith(operator, i)) {
      parts.push(buffer);
      buffer = "";
      i++;
      continue;
    }
    buffer += c;
  }
  parts.push(buffer);
  return parts;
}

const ERROR_PATH = String.raw`(?:error\.)?(?:kind|code|status|name|message|data(?:\.[A-Za-z_$][A-Za-z0-9_$-]*)*|meta(?:\.[A-Za-z_$][A-Za-z0-9_$-]*)*)`;
const QUOTED = String.raw`(?:'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*")`;
const BARE = String.raw`(?:[A-Za-z_$][A-Za-z0-9_$.-]*)`;
const LITERAL = String.raw`(?:${QUOTED}|-?\d+(?:\.\d+)?|true|false|null|undefined|${BARE})`;

function predicateAtomValid(source: string): boolean {
  const atom = stripOuterParens(source);
  if (/^(true|false)$/i.test(atom)) return true;
  if (new RegExp(`^${ERROR_PATH}\\.includes\\(\\s*${LITERAL}\\s*\\)$`, "i").test(atom)) return true;
  if (new RegExp(`^${ERROR_PATH}\\s*(?:===|!==|==|!=|>=|<=|>|<)\\s*${LITERAL}$`, "i").test(atom)) return true;
  return new RegExp(`^!{0,2}${ERROR_PATH}$`, "i").test(atom);
}

function predicateExpressionValid(source: string): boolean {
  const normalized = stripOuterParens(source);
  const ors = splitTop(normalized, "||");
  if (ors.length > 1) return ors.every(predicateExpressionValid);
  const ands = splitTop(normalized, "&&");
  return ands.length > 1
    ? ands.every(predicateExpressionValid)
    : predicateAtomValid(normalized);
}

/** Validate the deliberately non-executable error predicate DSL. */
export function validateErrorPredicateSyntax(predicate: string): string | null {
  const source = predicate.trim();
  if (!source) return "error predicate is empty";
  if (source.length > 1024) return "error predicate is longer than 1024 characters";
  if (/=>|;|`|\b(new|function|return|process|globalThis|require|import|eval)\b/.test(source)) {
    return "error predicate contains executable/forbidden syntax";
  }
  if (/[^A-Za-z0-9_$.[\]()?'"\\\s=!<>&|,.-]/.test(source)) {
    return "error predicate contains unsupported characters";
  }
  return predicateExpressionValid(source)
    ? null
    : "error predicate is not in the safe predicate DSL";
}

function readPath(value: unknown, path: string): unknown {
  let current = value;
  for (const key of path.split(".")) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function parsePredicateLiteral(source: string): unknown {
  const value = source.trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1).replace(/\\([\\'"nrt])/g, (_m, c: string) =>
      c === "n" ? "\n" : c === "r" ? "\r" : c === "t" ? "\t" : c,
    );
  }
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null" || value === "undefined") return null;
  // Bare identifiers are inert string literals.  This supports the concise
  // ontology form `code==QUOTA_EXHAUSTED` without treating the RHS as code.
  return value;
}

function predicatePath(facts: ActionErrorFacts, raw: string): unknown {
  const path = raw.trim().replace(/^error\./, "");
  return readPath(facts, path);
}

function compare(left: unknown, right: unknown, operator: string): boolean {
  if (right === null) {
    if (operator === "==" || operator === "===") return left == null;
    if (operator === "!=" || operator === "!==") return left != null;
  }
  switch (operator) {
    case "===": return left === right;
    case "!==": return left !== right;
    case "==": return left === right || (left != null && right != null && String(left) === String(right));
    case "!=": return !(left === right || (left != null && right != null && String(left) === String(right)));
    case ">": return Number(left) > Number(right);
    case "<": return Number(left) < Number(right);
    case ">=": return Number(left) >= Number(right);
    case "<=": return Number(left) <= Number(right);
    default: return false;
  }
}

function evaluatePredicateAtom(source: string, facts: ActionErrorFacts): boolean {
  const atom = stripOuterParens(source);
  if (/^true$/i.test(atom)) return true;
  if (/^false$/i.test(atom)) return false;

  const includes = atom.match(new RegExp(`^(${ERROR_PATH})\\.includes\\(\\s*(${LITERAL})\\s*\\)$`, "i"));
  if (includes) {
    const left = predicatePath(facts, includes[1]!);
    const right = parsePredicateLiteral(includes[2]!);
    return typeof left === "string"
      ? left.includes(String(right))
      : Array.isArray(left) && left.includes(right);
  }
  const comparison = atom.match(new RegExp(`^(${ERROR_PATH})\\s*(===|!==|==|!=|>=|<=|>|<)\\s*(${LITERAL})$`, "i"));
  if (comparison) {
    return compare(
      predicatePath(facts, comparison[1]!),
      parsePredicateLiteral(comparison[3]!),
      comparison[2]!,
    );
  }
  const presence = atom.match(new RegExp(`^(!{0,2})(${ERROR_PATH})$`, "i"));
  if (!presence) return false;
  const value = Boolean(predicatePath(facts, presence[2]!));
  return presence[1] === "!" ? !value : value;
}

/** Evaluate a previously validated predicate without eval/new Function. */
export function evaluateErrorPredicate(predicate: string, facts: ActionErrorFacts): {
  valid: boolean;
  value: boolean;
  error?: string;
} {
  const syntaxError = validateErrorPredicateSyntax(predicate);
  if (syntaxError) return { valid: false, value: false, error: syntaxError };
  const evaluate = (source: string): boolean => {
    const normalized = stripOuterParens(source);
    const ors = splitTop(normalized, "||");
    if (ors.length > 1) return ors.some(evaluate);
    const ands = splitTop(normalized, "&&");
    return ands.length > 1 ? ands.every(evaluate) : evaluatePredicateAtom(normalized, facts);
  };
  return { valid: true, value: evaluate(predicate) };
}

function hasOwn(record: object, camel: string, snake: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, camel) || Object.prototype.hasOwnProperty.call(record, snake);
}

function normalizeDisposition(action: ErrorPolicyAction): "retry" | "terminal" | "continue" {
  return action === "park" || action === "retry" ? "retry" : action;
}

/** First-match-wins classification with a required/default fail-closed posture. */
export function classifyActionFailure(args: {
  policy: RuntimeOnErrorPolicy;
  failure: unknown;
  defaultResult?: unknown;
}): ActionFailureResolution {
  const facts = actionErrorFacts(args.failure);
  if (args.policy === "soft") {
    return {
      disposition: "continue",
      policyAction: "soft",
      facts,
      defaultResult: args.defaultResult,
      suppressEmit: false,
    };
  }
  if (args.policy === "terminal") {
    return {
      disposition: "terminal",
      policyAction: "terminal",
      facts,
      suppressEmit: true,
    };
  }
  if (!Array.isArray(args.policy)) {
    return {
      disposition: "retry",
      policyAction: "retry",
      facts,
      suppressEmit: true,
    };
  }

  for (let index = 0; index < args.policy.length; index++) {
    const rule = args.policy[index]!;
    let action: ErrorPolicyAction | undefined;
    if (typeof rule.when === "string") {
      const evaluated = evaluateErrorPredicate(rule.when, facts);
      if (!evaluated.valid) {
        return {
          disposition: "terminal",
          policyAction: "terminal",
          facts,
          suppressEmit: true,
          matchedRule: index,
          policyError: evaluated.error,
        };
      }
      if (!evaluated.value) continue;
      action = rule.do;
    } else {
      action = rule.default;
    }
    if (!action) continue;
    const ownDefault = hasOwn(rule, "defaultResult", "default_result");
    const defaultResult = ownDefault
      ? (Object.prototype.hasOwnProperty.call(rule, "defaultResult") ? rule.defaultResult : rule.default_result)
      : args.defaultResult;
    const emitEvent = rule.emitEvent ?? rule.emit_event;
    const emitPayload = rule.emitPayload ?? rule.emit_payload;
    const suppressEmit = rule.suppressEmit ?? rule.suppress_emit ?? false;
    return {
      disposition: normalizeDisposition(action),
      policyAction: action,
      facts,
      ...(ownDefault || args.defaultResult !== undefined ? { defaultResult } : {}),
      ...(emitEvent ? { emitEvent } : {}),
      ...(emitPayload ? { emitPayload } : {}),
      suppressEmit,
      matchedRule: index,
    };
  }

  // A malformed ladder with no matching/default rule must never silently retry
  // an unknown permanent defect.  Manifest validation normally prevents this.
  return {
    disposition: "terminal",
    policyAction: "terminal",
    facts,
    suppressEmit: true,
    policyError: "error policy has no matching/default rule",
  };
}

/** Convert a classified failure into Inngest control flow. */
export function failureForDisposition(
  resolution: ActionFailureResolution,
  cause: unknown,
): Error | null {
  if (resolution.disposition === "continue") return null;
  const source = cause instanceof Error ? cause : new Error(String(cause));
  if (resolution.disposition === "terminal") {
    return new NonRetriableError(
      `terminal action failure${resolution.facts.code ? ` (${resolution.facts.code})` : ""}: ${resolution.facts.message}`,
      { cause: source },
    );
  }
  return source;
}

/** Robust across SDK wrappers/serialization boundaries. */
export function isNonRetriableFailure(value: unknown): boolean {
  const queue: unknown[] = [value];
  const seen = new Set<unknown>();
  for (let i = 0; i < queue.length && i < 12; i++) {
    const current = queue[i];
    if (current == null || seen.has(current)) continue;
    seen.add(current);
    if (current instanceof NonRetriableError) return true;
    if (current instanceof Error && current.name === "NonRetriableError") return true;
    const rec = asRecord(current);
    if (rec) queue.push(rec.cause, rec.error, rec.reason);
  }
  return false;
}
