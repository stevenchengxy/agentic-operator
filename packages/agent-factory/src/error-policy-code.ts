/**
 * Dependency-free error-policy evaluator embedded into generated TypeScript.
 *
 * Keep this deliberately aligned with `packages/runtime/src/error-policy.ts`:
 * predicates are data-only, ordered, first-match-wins, and an invalid/missing
 * default fails terminally.  Generated modules cannot import the runtime
 * evaluator (CodeAct only permits `@agentic/runtime`), so both renderers share
 * these exact source bytes instead of maintaining two message-regex classifiers.
 */
export const ERROR_POLICY_RUNTIME_SRC = String.raw`
type _AfPolicyAction = "park" | "retry" | "terminal" | "continue";
type _AfPolicyRule = {
  when?: string;
  do?: _AfPolicyAction;
  default?: _AfPolicyAction;
  defaultResult?: unknown;
  emitEvent?: string;
  emitPayload?: Record<string, unknown>;
  suppressEmit?: boolean;
};
type _AfErrorFacts = {
  kind?: string;
  code?: string;
  status?: number;
  name: string;
  message: string;
  data?: Record<string, unknown>;
  meta?: Record<string, unknown>;
};
type _AfFailureResolution = {
  disposition: "retry" | "terminal" | "continue";
  policyAction: _AfPolicyAction | "soft";
  facts: _AfErrorFacts;
  defaultResult?: unknown;
  emitEvent?: string;
  emitPayload?: Record<string, unknown>;
  suppressEmit: boolean;
  policyError?: string;
};
function _afRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function _afScalar(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}
function _afErrorFacts(value: unknown): _AfErrorFacts {
  const root = value instanceof Error ? value : undefined;
  let kind: string | undefined;
  let code: string | undefined;
  let status: number | undefined;
  let name = root?.name || "Error";
  let message = root?.message || _afScalar(value) || "action failed";
  let data: Record<string, unknown> | undefined;
  let meta: Record<string, unknown> | undefined;
  const queue: unknown[] = [value];
  const seen = new Set<unknown>();
  for (let i = 0; i < queue.length && i < 24; i++) {
    const current = queue[i];
    if (current == null || seen.has(current)) continue;
    seen.add(current);
    if (current instanceof Error) {
      if ((!message || message === "action failed") && current.message) message = current.message;
      if (name === "Error" && current.name) name = current.name;
      queue.push(current.cause);
    }
    const row = _afRecord(current);
    if (!row) continue;
    kind ??= _afScalar(row.kind) ?? _afScalar(row.failureKind) ?? _afScalar(row.failure_kind) ?? _afScalar(row.category);
    code ??= _afScalar(row.code) ?? _afScalar(row.errorCode) ?? _afScalar(row.error_code);
    const rawStatus = row.status ?? row.statusCode ?? row.status_code;
    if (status === undefined && Number.isFinite(Number(rawStatus))) status = Number(rawStatus);
    const nestedData = _afRecord(row.data);
    const nestedMeta = _afRecord(row.meta);
    data ??= nestedData;
    meta ??= nestedMeta;
    kind ??= _afScalar(nestedMeta?.error) ?? _afScalar(nestedData?.kind);
    code ??= _afScalar(nestedMeta?.code) ?? _afScalar(nestedData?.code) ?? _afScalar(nestedData?.error_code);
    const nestedStatus = nestedMeta?.status ?? nestedData?.status;
    if (status === undefined && Number.isFinite(Number(nestedStatus))) status = Number(nestedStatus);
    queue.push(row.cause, row.error, row.reason, row.output, row.result, row.data, row.meta);
  }
  if (!kind) {
    const prefixed = message.match(/^([a-z][a-z0-9_-]{1,80})\s*:/i);
    if (prefixed) kind = prefixed[1];
  }
  if (status === undefined) {
    const http = message.match(/\bHTTP\s+(\d{3})\b/i);
    if (http) status = Number(http[1]);
  }
  return { ...(kind ? { kind } : {}), ...(code ? { code } : {}), ...(status !== undefined ? { status } : {}), name, message, ...(data ? { data } : {}), ...(meta ? { meta } : {}) };
}
function _afStripParens(source: string): string {
  let out = source.trim();
  while (out.startsWith("(") && out.endsWith(")")) {
    let depth = 0; let quote = ""; let wraps = true;
    for (let i = 0; i < out.length; i++) {
      const c = out[i]!;
      if (quote) { if (c === "\\") i++; else if (c === quote) quote = ""; continue; }
      if (c === "'" || c === '"') { quote = c; continue; }
      if (c === "(") depth++; else if (c === ")") depth--;
      if (depth === 0 && i < out.length - 1) { wraps = false; break; }
    }
    if (!wraps || depth !== 0) break;
    out = out.slice(1, -1).trim();
  }
  return out;
}
function _afSplitTop(source: string, operator: "&&" | "||"): string[] {
  const parts: string[] = []; let buffer = ""; let depth = 0; let quote = "";
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!;
    if (quote) { buffer += c; if (c === "\\" && i + 1 < source.length) buffer += source[++i]!; else if (c === quote) quote = ""; continue; }
    if (c === "'" || c === '"') { quote = c; buffer += c; continue; }
    if (c === "(") depth++; else if (c === ")") depth--;
    if (depth === 0 && source.startsWith(operator, i)) { parts.push(buffer); buffer = ""; i++; continue; }
    buffer += c;
  }
  parts.push(buffer);
  return parts;
}
function _afRead(value: unknown, path: string): unknown {
  let current = value;
  for (const key of path.split(".")) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}
function _afLiteral(source: string): unknown {
  const value = source.trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) return value.slice(1, -1);
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null" || value === "undefined") return null;
  return value;
}
function _afCompare(left: unknown, right: unknown, operator: string): boolean {
  if (right === null) {
    if (operator === "==" || operator === "===") return left == null;
    if (operator === "!=" || operator === "!==") return left != null;
  }
  if (operator === "===") return left === right;
  if (operator === "!==") return left !== right;
  if (operator === "==") return left === right || (left != null && right != null && String(left) === String(right));
  if (operator === "!=") return !(left === right || (left != null && right != null && String(left) === String(right)));
  if (operator === ">") return Number(left) > Number(right);
  if (operator === "<") return Number(left) < Number(right);
  if (operator === ">=") return Number(left) >= Number(right);
  return Number(left) <= Number(right);
}
function _afPredicateAtom(source: string, facts: _AfErrorFacts): boolean {
  const atom = _afStripParens(source);
  if (/^true$/i.test(atom)) return true;
  if (/^false$/i.test(atom)) return false;
  const path = "(?:error\\.)?(?:kind|code|status|name|message|data(?:\\.[A-Za-z_$][A-Za-z0-9_$-]*)*|meta(?:\\.[A-Za-z_$][A-Za-z0-9_$-]*)*)";
  const literal = "(?:'(?:\\\\.|[^'\\\\])*'|\"(?:\\\\.|[^\"\\\\])*\"|-?\\d+(?:\\.\\d+)?|true|false|null|undefined|[A-Za-z_$][A-Za-z0-9_$.-]*)";
  const includes = atom.match(new RegExp("^(" + path + ")\\.includes\\(\\s*(" + literal + ")\\s*\\)$", "i"));
  if (includes) {
    const left = _afRead(facts, includes[1]!.replace(/^error\./, ""));
    const right = _afLiteral(includes[2]!);
    return typeof left === "string" ? left.includes(String(right)) : Array.isArray(left) && left.includes(right);
  }
  const comparison = atom.match(new RegExp("^(" + path + ")\\s*(===|!==|==|!=|>=|<=|>|<)\\s*(" + literal + ")$", "i"));
  if (comparison) return _afCompare(_afRead(facts, comparison[1]!.replace(/^error\./, "")), _afLiteral(comparison[3]!), comparison[2]!);
  const presence = atom.match(new RegExp("^(!{0,2})(" + path + ")$", "i"));
  if (!presence) return false;
  const value = Boolean(_afRead(facts, presence[2]!.replace(/^error\./, "")));
  return presence[1] === "!" ? !value : value;
}
function _afErrorPredicate(predicate: string, facts: _AfErrorFacts): boolean {
  const evaluate = (source: string): boolean => {
    const normalized = _afStripParens(source);
    const ors = _afSplitTop(normalized, "||");
    if (ors.length > 1) return ors.some(evaluate);
    const ands = _afSplitTop(normalized, "&&");
    return ands.length > 1 ? ands.every(evaluate) : _afPredicateAtom(normalized, facts);
  };
  return evaluate(predicate);
}
function _afResolveFailure(policy: "soft" | "terminal" | "park" | _AfPolicyRule[] | undefined, failure: unknown, stepDefault?: unknown): _AfFailureResolution {
  const facts = _afErrorFacts(failure);
  if (policy === "soft") return { disposition: "continue", policyAction: "soft", facts, defaultResult: stepDefault, suppressEmit: false };
  if (policy === "terminal") return { disposition: "terminal", policyAction: "terminal", facts, suppressEmit: true };
  if (policy === "park") return { disposition: "retry", policyAction: "park", facts, suppressEmit: true };
  if (!Array.isArray(policy)) return { disposition: "retry", policyAction: "retry", facts, suppressEmit: true };
  for (const rule of policy) {
    const action = typeof rule.when === "string" ? (_afErrorPredicate(rule.when, facts) ? rule.do : undefined) : rule.default;
    if (!action) continue;
    const ownDefault = Object.prototype.hasOwnProperty.call(rule, "defaultResult");
    const defaultResult = ownDefault ? rule.defaultResult : stepDefault;
    return {
      disposition: action === "park" || action === "retry" ? "retry" : action,
      policyAction: action,
      facts,
      ...(ownDefault || stepDefault !== undefined ? { defaultResult } : {}),
      ...(rule.emitEvent ? { emitEvent: rule.emitEvent } : {}),
      ...(rule.emitPayload ? { emitPayload: rule.emitPayload } : {}),
      suppressEmit: rule.suppressEmit ?? false,
    };
  }
  return { disposition: "terminal", policyAction: "terminal", facts, suppressEmit: true, policyError: "error policy has no matching/default rule" };
}
function _afFailurePayload(resolution: _AfFailureResolution): Record<string, unknown> {
  const fallback = resolution.defaultResult && typeof resolution.defaultResult === "object" && !Array.isArray(resolution.defaultResult)
    ? resolution.defaultResult as Record<string, unknown>
    : { error: resolution.facts };
  return { ...fallback, ...(resolution.emitPayload ?? {}) };
}
`.trim();
