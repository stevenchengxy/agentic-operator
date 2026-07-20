import {
  renderDecisionTables,
  validateDecisionTables,
  type DecisionPredicate,
  type DecisionTable,
} from "@agentic/shared";

export interface DecisionBoundaryFixture {
  id: string;
  name: string;
  payload: Record<string, unknown>;
  expectedEvent?: string;
  expectedOutcome: string;
  cell: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Strict raw-input parser used at the model boundary. It does not repair or
 * infer incomplete rows: the model/human must resubmit an unambiguous table. */
export function parseDecisionTables(
  value: unknown,
  opts: { declaredEvents?: readonly string[] } = {},
): { ok: true; tables: DecisionTable[] } | { ok: false; errors: string[] } {
  if (value === undefined) return { ok: true, tables: [] };
  if (!Array.isArray(value)) return { ok: false, errors: ["decision_tables must be an array"] };

  const shapeErrors: string[] = [];
  value.forEach((table, tableIndex) => {
    const at = `decision_tables[${tableIndex}]`;
    if (!isRecord(table)) { shapeErrors.push(`${at} must be an object`); return; }
    if (!Array.isArray(table.rows)) shapeErrors.push(`${at}.rows must be an array`);
    else table.rows.forEach((row, rowIndex) => {
      const rowAt = `${at}.rows[${rowIndex}]`;
      if (!isRecord(row)) { shapeErrors.push(`${rowAt} must be an object`); return; }
      for (const key of ["all", "any"] as const) {
        if (row[key] !== undefined && !Array.isArray(row[key])) shapeErrors.push(`${rowAt}.${key} must be an array`);
        else if (Array.isArray(row[key])) row[key].forEach((predicate, predicateIndex) => {
          if (!isRecord(predicate)) shapeErrors.push(`${rowAt}.${key}[${predicateIndex}] must be an object`);
        });
      }
    });
    if (!isRecord(table.missing)) shapeErrors.push(`${at}.missing must be an object`);
    if (!isRecord(table.default)) shapeErrors.push(`${at}.default must be an object`);
  });
  if (shapeErrors.length) return { ok: false, errors: shapeErrors };

  const tables = structuredClone(value) as DecisionTable[];
  const errors = validateDecisionTables(tables, opts);
  return errors.length ? { ok: false, errors } : { ok: true, tables };
}

export function decisionTablesPromptBlock(tables: readonly DecisionTable[]): string {
  if (!tables.length) return "";
  return [
    "【结构化决策表（运行时直接执行；此处文字只供解释，禁止改写阈值）】",
    renderDecisionTables(tables),
  ].join("\n");
}

function directPayloadField(path: string): string | null {
  const normalized = path.replace(/^event\.data\./, "").replace(/^input\./, "");
  return /^[A-Za-z_$][A-Za-z0-9_$-]*$/.test(normalized) ? normalized : null;
}

function satisfyingValue(predicate: DecisionPredicate): unknown {
  const value = predicate.value;
  switch (predicate.op) {
    case "eq": return value;
    case "neq": return typeof value === "number" ? value + 1 : `${String(value ?? "value")}_other`;
    case "gt": return Number(value) + 1;
    case "gte": return Number(value);
    case "lt": return Number(value) - 1;
    case "lte": return Number(value);
    case "between": return (Number(value) + Number(predicate.upper)) / 2;
    case "in": return predicate.values?.[0];
    case "not_in": return "__outside_set__";
    case "contains": return [value];
    case "exists": return "present";
    default: return undefined;
  }
}

/** Derive deterministic row/missing fixtures from the machine-readable table.
 * Complex named-result predicates remain executable, but cannot be synthesized
 * at the entry-event boundary and are therefore left for authored fixtures. */
export function deriveDecisionBoundaryFixtures(
  actionName: string,
  tables: readonly DecisionTable[],
  basePayload: Record<string, unknown>,
): DecisionBoundaryFixture[] {
  const out: DecisionBoundaryFixture[] = [];
  for (const table of tables) {
    const directFields = new Set<string>();
    for (const row of table.rows) {
      const predicates = [...(row.all ?? []), ...(row.any ?? [])];
      const usable = predicates
        .map((predicate) => ({ predicate, field: directPayloadField(predicate.path) }))
        .filter((entry): entry is { predicate: DecisionPredicate; field: string } => !!entry.field);
      if (!usable.length || usable.length !== predicates.length) continue;
      const payload = { ...basePayload };
      let constructible = true;
      for (const { predicate, field } of usable) {
        directFields.add(field);
        if (predicate.op === "missing") delete payload[field];
        else {
          const value = satisfyingValue(predicate);
          if (value === undefined) { constructible = false; break; }
          payload[field] = value;
        }
      }
      if (!constructible) continue;
      out.push({
        id: `dt_${table.id}_${row.id}`.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 90),
        name: `${table.id} · ${row.label ?? row.id}`,
        payload,
        expectedEvent: row.emitEvent,
        expectedOutcome: row.outcome,
        cell: `decision:${actionName}:${table.id}:${row.id}`,
      });
    }
    if (directFields.size) {
      const payload = { ...basePayload };
      for (const field of directFields) delete payload[field];
      out.push({
        id: `dt_${table.id}_missing`.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 90),
        name: `${table.id} · missing`,
        payload,
        expectedEvent: table.missing.emitEvent,
        expectedOutcome: table.missing.outcome,
        cell: `decision:${actionName}:${table.id}:missing`,
      });
    }
  }
  return out;
}

