import type {
  ToolInputPropertySchema,
  ToolUseSchema,
} from "@/app/portal/components/agent-code/samples";
import type { ToolCatalogEntry, ToolFieldSchema } from "@/lib/hooks/useTools";

function stripOuterParentheses(value: string): string {
  let current = value.trim();
  while (current.startsWith("(") && current.endsWith(")")) {
    let depth = 0;
    let enclosesWholeValue = true;
    for (let index = 0; index < current.length; index += 1) {
      const character = current[index];
      if (character === "(") depth += 1;
      if (character === ")") depth -= 1;
      if (depth === 0 && index < current.length - 1) {
        enclosesWholeValue = false;
        break;
      }
    }
    if (!enclosesWholeValue) break;
    current = current.slice(1, -1).trim();
  }
  return current;
}

/** Split a TypeScript-style union without splitting nested generic members. */
function splitUnion(value: string): string[] {
  const members: string[] = [];
  let start = 0;
  let angleDepth = 0;
  let parenDepth = 0;
  let bracketDepth = 0;
  let quote: "'" | '"' | null = null;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (character === quote && value[index - 1] !== "\\") quote = null;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === "<") angleDepth += 1;
    else if (character === ">") angleDepth = Math.max(0, angleDepth - 1);
    else if (character === "(") parenDepth += 1;
    else if (character === ")") parenDepth = Math.max(0, parenDepth - 1);
    else if (character === "[") bracketDepth += 1;
    else if (character === "]") bracketDepth = Math.max(0, bracketDepth - 1);
    else if (
      character === "|" &&
      angleDepth === 0 &&
      parenDepth === 0 &&
      bracketDepth === 0
    ) {
      members.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  members.push(value.slice(start).trim());
  return members.filter(Boolean);
}

function literalValue(
  value: string,
): string | number | boolean | null | undefined {
  const trimmed = value.trim();
  const quoted = trimmed.match(/^(['"])([\s\S]*)\1$/);
  if (quoted) return quoted[2]!.replace(/\\(['"\\])/g, "$1");
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(trimmed)) return Number(trimmed);
  return undefined;
}

function literalType(
  value: string | number | boolean | null,
): string | undefined {
  if (value === null) return "null";
  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  return undefined;
}

function schemaForType(rawType: string): ToolInputPropertySchema {
  const type = stripOuterParentheses(rawType.trim());
  if (!type || type === "unknown" || type === "any" || type === "never") {
    return {};
  }

  const union = splitUnion(type).filter(
    (member) => member !== "undefined" && member !== "void",
  );
  if (union.length > 1) {
    const literals = union.map(literalValue);
    if (literals.every((value) => value !== undefined)) {
      const values = literals as Array<string | number | boolean | null>;
      const types = Array.from(
        new Set(values.map(literalType).filter(Boolean)),
      );
      return {
        ...(types.length === 1 ? { type: types[0] } : {}),
        enum: values,
      };
    }
    return { anyOf: union.map(schemaForType) };
  }
  if (union.length === 1 && union[0] !== type) {
    return schemaForType(union[0]!);
  }

  const literal = literalValue(type);
  if (literal !== undefined) {
    return { type: literalType(literal), enum: [literal] };
  }

  if (type.endsWith("[]")) {
    return {
      type: "array",
      items: schemaForType(type.slice(0, -2)),
    };
  }
  const array = type.match(/^(?:Array|ReadonlyArray)<([\s\S]+)>$/);
  if (array) {
    return { type: "array", items: schemaForType(array[1]!) };
  }

  const record = type.match(/^Record<[^,]+,([\s\S]+)>$/);
  if (record) {
    const valueSchema = schemaForType(record[1]!);
    return {
      type: "object",
      additionalProperties:
        Object.keys(valueSchema).length > 0 ? valueSchema : true,
    };
  }

  if (type.startsWith("{") && type.endsWith("}")) {
    return { type: "object", additionalProperties: true };
  }

  switch (type.toLowerCase()) {
    case "string":
      return { type: "string" };
    case "number":
      return { type: "number" };
    case "integer":
    case "int":
      return { type: "integer" };
    case "boolean":
    case "bool":
      return { type: "boolean" };
    case "object":
      return { type: "object", additionalProperties: true };
    case "null":
      return { type: "null" };
    default:
      // Named TypeScript aliases are catalog display metadata, not JSON
      // Schema types. Treat them as strings instead of emitting an invalid
      // provider/AJV `type` value (for example HttpMethod).
      return { type: "string" };
  }
}

export function catalogFieldToJsonSchema(
  field: ToolFieldSchema,
): ToolInputPropertySchema {
  return {
    ...schemaForType(field.type),
    ...(field.description ? { description: field.description } : {}),
    ...(field.default !== undefined ? { default: field.default } : {}),
  };
}

export function catalogToolToToolUse(tool: ToolCatalogEntry): ToolUseSchema {
  const fields = tool.argsSchema ?? {};
  return {
    name: tool.name,
    description: tool.description ?? tool.summary,
    input_schema: {
      type: "object",
      properties: Object.fromEntries(
        Object.entries(fields).map(([name, field]) => [
          name,
          catalogFieldToJsonSchema(field),
        ]),
      ),
      required: Object.entries(fields)
        .filter(([, field]) => field.required)
        .map(([name]) => name),
    },
  };
}
