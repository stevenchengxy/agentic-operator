export interface SchemaValidationIssue {
  path: string;
  expected: string;
  actual: string;
  message: string;
}

type Schema = Record<string, unknown>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const actualType = (value: unknown): string => {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value)) return "integer";
  return typeof value;
};

const STANDARD_KEYS = new Set(["$schema", "$id", "$ref", "type", "properties", "required", "items", "enum", "const", "anyOf", "oneOf", "allOf", "nullable", "additionalProperties"]);

/** Factory schema extraction historically produced a field map (`{id:{type,
 * required}}`) while operators may also provide JSON Schema. Normalize both to
 * one JSON-Schema-like representation before validating. */
export function normalizeToolSchema(input: Record<string, unknown> | undefined): Schema | undefined {
  if (!input || Object.keys(input).length === 0) return undefined;
  if (Object.keys(input).some((key) => STANDARD_KEYS.has(key))) return input;
  const required: string[] = [];
  const properties: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(input)) {
    if (!isRecord(field)) {
      properties[name] = {};
      continue;
    }
    const copy = { ...field };
    if (copy.required === true) required.push(name);
    delete copy.required;
    properties[name] = copy;
  }
  return { type: "object", properties, ...(required.length ? { required } : {}) };
}

function declaredTypes(schema: Schema): string[] {
  const raw = schema.type;
  const values = Array.isArray(raw)
    ? raw.map(String)
    : typeof raw === "string"
      ? raw.split("|").map((value) => value.trim())
      : [];
  const out = new Set<string>();
  for (const value of values) {
    const normalized = value.toLocaleLowerCase();
    if (normalized.endsWith("[]")) {
      out.add("array");
    } else if (normalized === "record") {
      out.add("object");
    } else if (normalized === "any" || normalized === "unknown") {
      out.add("unknown");
    } else {
      out.add(normalized);
    }
  }
  if (schema.nullable === true) out.add("null");
  return [...out];
}

function matchesType(value: unknown, expected: string): boolean {
  if (expected === "unknown") return true;
  if (expected === "null") return value === null;
  if (expected === "array") return Array.isArray(value);
  if (expected === "object") return isRecord(value);
  if (expected === "integer") return typeof value === "number" && Number.isInteger(value);
  if (expected === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === expected;
}

function childItemSchema(schema: Schema): Schema | undefined {
  if (isRecord(schema.items)) return schema.items;
  const raw = typeof schema.type === "string" ? schema.type.trim() : "";
  if (!raw.endsWith("[]")) return undefined;
  return { type: raw.slice(0, -2) || "unknown" };
}

function validate(value: unknown, schema: Schema, path: string, issues: SchemaValidationIssue[]): void {
  if (Array.isArray(schema.allOf)) {
    for (const branch of schema.allOf) if (isRecord(branch)) validate(value, branch, path, issues);
  }
  for (const keyword of ["anyOf", "oneOf"] as const) {
    const branches = Array.isArray(schema[keyword]) ? schema[keyword].filter(isRecord) : [];
    if (branches.length) {
      const matches = branches.filter((branch) => {
        const branchIssues: SchemaValidationIssue[] = [];
        validate(value, branch, path, branchIssues);
        return branchIssues.length === 0;
      }).length;
      if ((keyword === "anyOf" && matches === 0) || (keyword === "oneOf" && matches !== 1)) {
        issues.push({ path, expected: keyword, actual: actualType(value), message: `${path} does not satisfy ${keyword}` });
      }
      return;
    }
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => Object.is(candidate, value))) {
    issues.push({ path, expected: `enum(${schema.enum.map(String).join("|")})`, actual: String(value), message: `${path} is not an allowed enum value` });
    return;
  }
  if ("const" in schema && !Object.is(schema.const, value)) {
    issues.push({ path, expected: `const(${String(schema.const)})`, actual: String(value), message: `${path} does not equal const` });
    return;
  }

  const types = declaredTypes(schema);
  if (types.length && !types.some((expected) => matchesType(value, expected))) {
    issues.push({ path, expected: types.join(" | "), actual: actualType(value), message: `${path} expected ${types.join(" | ")}, got ${actualType(value)}` });
    return;
  }

  if (isRecord(value)) {
    const required = Array.isArray(schema.required) ? schema.required.map(String) : [];
    for (const field of required) {
      if (!(field in value) || value[field] === undefined) {
        issues.push({ path: `${path}.${field}`, expected: "required", actual: "missing", message: `${path}.${field} is required` });
      }
    }
    const properties = isRecord(schema.properties) ? schema.properties : {};
    for (const [field, fieldSchema] of Object.entries(properties)) {
      if (value[field] !== undefined && isRecord(fieldSchema)) validate(value[field], fieldSchema, `${path}.${field}`, issues);
    }
  }

  if (Array.isArray(value)) {
    const itemSchema = childItemSchema(schema);
    if (itemSchema) value.forEach((item, index) => validate(item, itemSchema, `${path}[${index}]`, issues));
  }
}

export function validateToolSchema(
  value: unknown,
  input: Record<string, unknown> | undefined,
): SchemaValidationIssue[] {
  const schema = normalizeToolSchema(input);
  if (!schema) return [];
  const issues: SchemaValidationIssue[] = [];
  validate(value, schema, "$", issues);
  return issues;
}

