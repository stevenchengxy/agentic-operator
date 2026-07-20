/**
 * Machine-checkable business decision tables shared by factory, runtime and
 * regression generation.  The format intentionally stays data-only: no eval,
 * callbacks, regular expressions or executable expressions can enter a live
 * manifest through this surface.
 */

export type DecisionOperator =
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "between"
  | "in"
  | "not_in"
  | "contains"
  | "exists"
  | "missing";

export interface DecisionPredicate {
  /** Safe path over input/event/lastResult/results, for example `score` or
   * `results.match.result.score`. */
  path: string;
  op: DecisionOperator;
  value?: unknown;
  upper?: number;
  values?: unknown[];
}

export interface DecisionTableRow {
  id: string;
  label?: string;
  /** Every predicate in `all` must match. */
  all?: DecisionPredicate[];
  /** At least one predicate in `any` must match. When both are present both
   * groups must pass. */
  any?: DecisionPredicate[];
  outcome: string;
  emitEvent?: string;
  payload?: Record<string, unknown>;
}

export interface DecisionTableFallback {
  outcome: string;
  emitEvent?: string;
  payload?: Record<string, unknown>;
}

export interface DecisionTable {
  id: string;
  description?: string;
  rows: DecisionTableRow[];
  /** Applied when a row needs a path whose value is absent. This makes null /
   * missing behavior explicit instead of leaving it to prompt interpretation. */
  missing: DecisionTableFallback;
  /** Applied when no row matches. */
  default: DecisionTableFallback;
}

export interface DecisionTableResult extends DecisionTableFallback {
  tableId: string;
  rowId: string | "__missing__" | "__default__";
  matched: boolean;
  reason: string;
}

const SAFE_PATH_RE = /^[A-Za-z_$][A-Za-z0-9_$-]*(?:(?:\??\.)[A-Za-z_$][A-Za-z0-9_$-]*|\[['"][^'"\]]+['"]\])*$/;
const OPS = new Set<DecisionOperator>([
  "eq", "neq", "gt", "gte", "lt", "lte", "between", "in", "not_in", "contains", "exists", "missing",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizePath(path: string): string[] {
  return path
    .replace(/\?\./g, ".")
    .replace(/\[['"]([^'"]+)['"]\]/g, ".$1")
    .split(".")
    .filter(Boolean);
}

export function readDecisionPath(scope: Record<string, unknown>, rawPath: string): { found: boolean; value: unknown } {
  const parts = normalizePath(rawPath.trim());
  if (!parts.length) return { found: false, value: undefined };

  const read = (root: unknown, path: string[]): { found: boolean; value: unknown } => {
    let current = root;
    for (const part of path) {
      if (!isRecord(current) || !Object.prototype.hasOwnProperty.call(current, part)) {
        return { found: false, value: undefined };
      }
      current = current[part];
    }
    return { found: true, value: current };
  };

  const explicitRoots = new Set(["input", "event", "lastResult", "results"]);
  if (explicitRoots.has(parts[0]!)) return read(scope, parts);

  // A bare business field first resolves against input/event.data, then the
  // latest step result. This mirrors the runtime condition dialect.
  for (const root of [scope.input, isRecord(scope.event) ? scope.event.data : undefined, scope.lastResult]) {
    const hit = read(root, parts);
    if (hit.found) return hit;
  }
  return read(scope, parts);
}

function same(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left == null || right == null) return false;
  return String(left) === String(right);
}

function numeric(value: unknown): number | null {
  if (value === "" || value == null) return null;
  const out = Number(value);
  return Number.isFinite(out) ? out : null;
}

export function evaluateDecisionPredicate(
  predicate: DecisionPredicate,
  scope: Record<string, unknown>,
): { matched: boolean; missing: boolean } {
  const hit = readDecisionPath(scope, predicate.path);
  if (predicate.op === "missing") return { matched: !hit.found || hit.value == null, missing: false };
  if (predicate.op === "exists") return { matched: hit.found && hit.value != null, missing: false };
  if (!hit.found || hit.value == null) return { matched: false, missing: true };

  switch (predicate.op) {
    case "eq": return { matched: same(hit.value, predicate.value), missing: false };
    case "neq": return { matched: !same(hit.value, predicate.value), missing: false };
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const left = numeric(hit.value);
      const right = numeric(predicate.value);
      if (left == null || right == null) return { matched: false, missing: false };
      if (predicate.op === "gt") return { matched: left > right, missing: false };
      if (predicate.op === "gte") return { matched: left >= right, missing: false };
      if (predicate.op === "lt") return { matched: left < right, missing: false };
      return { matched: left <= right, missing: false };
    }
    case "between": {
      const left = numeric(hit.value);
      const low = numeric(predicate.value);
      const high = numeric(predicate.upper);
      return { matched: left != null && low != null && high != null && left >= low && left <= high, missing: false };
    }
    case "in": return { matched: (predicate.values ?? []).some((value) => same(hit.value, value)), missing: false };
    case "not_in": return { matched: !(predicate.values ?? []).some((value) => same(hit.value, value)), missing: false };
    case "contains": {
      const matched = Array.isArray(hit.value)
        ? hit.value.some((value) => same(value, predicate.value))
        : typeof hit.value === "string" && hit.value.includes(String(predicate.value ?? ""));
      return { matched, missing: false };
    }
    default: return { matched: false, missing: false };
  }
}

export function evaluateDecisionTable(table: DecisionTable, scope: Record<string, unknown>): DecisionTableResult {
  for (const row of table.rows) {
    const all = row.all ?? [];
    const any = row.any ?? [];
    const evaluations = [...all, ...any].map((predicate) => evaluateDecisionPredicate(predicate, scope));
    if (evaluations.some((result) => result.missing)) {
      return {
        tableId: table.id,
        rowId: "__missing__",
        matched: false,
        reason: `missing input while evaluating ${row.id}`,
        ...table.missing,
      };
    }
    const allPass = all.every((predicate) => evaluateDecisionPredicate(predicate, scope).matched);
    const anyPass = any.length === 0 || any.some((predicate) => evaluateDecisionPredicate(predicate, scope).matched);
    if (allPass && anyPass && (all.length > 0 || any.length > 0)) {
      return {
        tableId: table.id,
        rowId: row.id,
        matched: true,
        reason: `matched row ${row.id}`,
        outcome: row.outcome,
        ...(row.emitEvent ? { emitEvent: row.emitEvent } : {}),
        ...(row.payload ? { payload: row.payload } : {}),
      };
    }
  }
  return {
    tableId: table.id,
    rowId: "__default__",
    matched: false,
    reason: "no row matched",
    ...table.default,
  };
}

export function validateDecisionTables(
  tables: readonly DecisionTable[],
  opts: { declaredEvents?: readonly string[] } = {},
): string[] {
  const errors: string[] = [];
  const tableIds = new Set<string>();
  const allowedEvents = opts.declaredEvents ? new Set(opts.declaredEvents) : null;
  const checkFallback = (value: DecisionTableFallback | undefined, at: string) => {
    if (!value || !value.outcome?.trim()) errors.push(`${at}.outcome is required`);
    if (value?.emitEvent && allowedEvents && !allowedEvents.has(value.emitEvent)) errors.push(`${at}.emitEvent "${value.emitEvent}" is not declared`);
    if (value?.payload !== undefined && !isRecord(value.payload)) errors.push(`${at}.payload must be an object`);
  };
  const checkPredicate = (predicate: DecisionPredicate, at: string) => {
    if (!predicate.path || !SAFE_PATH_RE.test(predicate.path)) errors.push(`${at}.path is not a safe data path`);
    if (!OPS.has(predicate.op)) errors.push(`${at}.op "${String(predicate.op)}" is unsupported`);
    if (["gt", "gte", "lt", "lte"].includes(predicate.op) && numeric(predicate.value) == null) errors.push(`${at}.value must be numeric`);
    if (predicate.op === "between" && (numeric(predicate.value) == null || numeric(predicate.upper) == null)) errors.push(`${at} requires numeric value + upper`);
    if (["in", "not_in"].includes(predicate.op) && !predicate.values?.length) errors.push(`${at}.values must be non-empty`);
    if (["eq", "neq", "contains"].includes(predicate.op) && !Object.prototype.hasOwnProperty.call(predicate, "value")) errors.push(`${at}.value is required`);
  };

  tables.forEach((table, tableIndex) => {
    const at = `decisionTables[${tableIndex}]`;
    if (!table.id?.trim()) errors.push(`${at}.id is required`);
    else if (tableIds.has(table.id)) errors.push(`${at}.id "${table.id}" is duplicated`);
    tableIds.add(table.id);
    if (!Array.isArray(table.rows) || table.rows.length === 0) errors.push(`${at}.rows must be non-empty`);
    const rowIds = new Set<string>();
    for (let rowIndex = 0; rowIndex < (table.rows ?? []).length; rowIndex++) {
      const row = table.rows[rowIndex]!;
      const rowAt = `${at}.rows[${rowIndex}]`;
      if (!row.id?.trim()) errors.push(`${rowAt}.id is required`);
      else if (rowIds.has(row.id)) errors.push(`${rowAt}.id "${row.id}" is duplicated`);
      rowIds.add(row.id);
      if (!row.outcome?.trim()) errors.push(`${rowAt}.outcome is required`);
      if (!(row.all?.length || row.any?.length)) errors.push(`${rowAt} needs all[] or any[] predicates`);
      (row.all ?? []).forEach((predicate, index) => checkPredicate(predicate, `${rowAt}.all[${index}]`));
      (row.any ?? []).forEach((predicate, index) => checkPredicate(predicate, `${rowAt}.any[${index}]`));
      if (row.emitEvent && allowedEvents && !allowedEvents.has(row.emitEvent)) errors.push(`${rowAt}.emitEvent "${row.emitEvent}" is not declared`);
      if (row.payload !== undefined && !isRecord(row.payload)) errors.push(`${rowAt}.payload must be an object`);
    }
    checkFallback(table.missing, `${at}.missing`);
    checkFallback(table.default, `${at}.default`);
  });
  return errors;
}

/** Stable prose used only as an explanation/LLM aid. Execution consumes the
 * structured table above, so changing prose cannot change the decision. */
export function renderDecisionTables(tables: readonly DecisionTable[]): string {
  return tables.map((table) => {
    const rows = table.rows.map((row) => {
      const fmt = (predicate: DecisionPredicate) => `${predicate.path} ${predicate.op} ${JSON.stringify(predicate.values ?? predicate.value ?? predicate.upper ?? null)}`;
      const predicate = [
        row.all?.length ? `ALL(${row.all.map(fmt).join(" && ")})` : "",
        row.any?.length ? `ANY(${row.any.map(fmt).join(" || ")})` : "",
      ].filter(Boolean).join(" + ");
      return `- ${row.id}: ${predicate} => ${row.outcome}${row.emitEvent ? ` / emit ${row.emitEvent}` : ""}`;
    });
    return [
      `表 ${table.id}${table.description ? `：${table.description}` : ""}`,
      ...rows,
      `- MISSING => ${table.missing.outcome}${table.missing.emitEvent ? ` / emit ${table.missing.emitEvent}` : ""}`,
      `- DEFAULT => ${table.default.outcome}${table.default.emitEvent ? ` / emit ${table.default.emitEvent}` : ""}`,
    ].join("\n");
  }).join("\n\n");
}

