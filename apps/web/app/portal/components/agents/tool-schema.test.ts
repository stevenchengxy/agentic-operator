import { describe, expect, it } from "vitest";
import type { ToolInputPropertySchema } from "@/app/portal/components/agent-code/samples";
import type { ToolCatalogEntry } from "@/lib/hooks/useTools";
import { catalogFieldToJsonSchema, catalogToolToToolUse } from "./tool-schema";

const JSON_SCHEMA_TYPES = new Set([
  "array",
  "boolean",
  "integer",
  "null",
  "number",
  "object",
  "string",
]);

function expectValidTypes(schema: ToolInputPropertySchema): void {
  if (typeof schema.type === "string") {
    expect(JSON_SCHEMA_TYPES.has(schema.type), schema.type).toBe(true);
  }
  if (Array.isArray(schema.type)) {
    for (const type of schema.type) {
      expect(JSON_SCHEMA_TYPES.has(type), type).toBe(true);
    }
  }
  if (schema.items) expectValidTypes(schema.items);
  for (const member of schema.anyOf ?? []) expectValidTypes(member);
  if (
    schema.additionalProperties &&
    typeof schema.additionalProperties === "object"
  ) {
    expectValidTypes(schema.additionalProperties);
  }
}

describe("catalog tool JSON Schema conversion", () => {
  it("converts ontology display types into provider-safe JSON Schema", () => {
    const ontology: ToolCatalogEntry = {
      name: "ontology.query",
      category: "ontology",
      summary: "Read the tenant graph",
      sourcePath: "packages/tools/src/ontology/query.ts",
      argsSchema: {
        operation: {
          type: "'search_nodes'|'get_node'|'neighbors'|'find_paths'|'schema'",
          required: true,
        },
        labels: { type: "string[]" },
        max_depth: {
          type: "number",
          default: 3,
          description: "Bounded traversal depth.",
        },
        include_archived: { type: "boolean" },
        filters: { type: "Record<string,string|number|boolean>" },
        raw: { type: "unknown" },
      },
    };

    const converted = catalogToolToToolUse(ontology);
    expect(converted.input_schema.required).toEqual(["operation"]);
    expect(converted.input_schema.properties.operation).toEqual({
      type: "string",
      enum: ["search_nodes", "get_node", "neighbors", "find_paths", "schema"],
    });
    expect(converted.input_schema.properties.labels).toEqual({
      type: "array",
      items: { type: "string" },
    });
    expect(converted.input_schema.properties.max_depth).toEqual({
      type: "number",
      default: 3,
      description: "Bounded traversal depth.",
    });
    expect(converted.input_schema.properties.include_archived).toEqual({
      type: "boolean",
    });
    expect(converted.input_schema.properties.filters).toEqual({
      type: "object",
      additionalProperties: {
        anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }],
      },
    });
    expect(converted.input_schema.properties.raw).toEqual({});
    for (const schema of Object.values(converted.input_schema.properties)) {
      expectValidTypes(schema);
    }
  });

  it("handles general unions, generic arrays, records, and named aliases", () => {
    expect(catalogFieldToJsonSchema({ type: "string|string[]" })).toEqual({
      anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
    });
    expect(
      catalogFieldToJsonSchema({ type: "Array<Record<string, unknown>>" }),
    ).toEqual({
      type: "array",
      items: { type: "object", additionalProperties: true },
    });
    expect(catalogFieldToJsonSchema({ type: "HttpMethod[]" })).toEqual({
      type: "array",
      items: { type: "string" },
    });
    expect(catalogFieldToJsonSchema({ type: "string | undefined" })).toEqual({
      type: "string",
    });
    expect(
      catalogFieldToJsonSchema({
        type: "Array<{title,url,snippet,publishedAt,score}>",
      }),
    ).toEqual({
      type: "array",
      items: { type: "object", additionalProperties: true },
    });
  });
});
