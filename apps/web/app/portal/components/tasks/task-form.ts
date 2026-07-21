import type { Translate } from "@/app/portal/lib/preferences-context";

export type TaskResolutionDecision = "approve" | "reject" | "supplement";

export type TaskFormRawValue = string | boolean;

export interface TaskDecisionOption {
  decision: TaskResolutionDecision;
  /** Value written into a schema-declared `decision` property. */
  formValue: string;
  label: string;
}

export interface TaskFormOption {
  value: string;
  label: string;
}

export interface TaskFormField {
  name: string;
  label: string;
  description?: string;
  required: boolean;
  kind: "text" | "textarea" | "select" | "boolean" | "number" | "json";
  schemaType: "string" | "boolean" | "number" | "integer" | "object" | "array";
  options: TaskFormOption[];
  initialValue: TaskFormRawValue;
  minLength?: number;
  maxLength?: number;
}

export interface TaskFormDefinition {
  fields: TaskFormField[];
  decisions: TaskDecisionOption[];
  decisionField?: string;
}

interface JsonSchemaProperty {
  type?: unknown;
  title?: unknown;
  description?: unknown;
  enum?: unknown;
  default?: unknown;
  format?: unknown;
  minLength?: unknown;
  maxLength?: unknown;
}

const FORBIDDEN_NAMES = new Set(["__proto__", "prototype", "constructor"]);

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function titleCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/^\w|\s\w/g, (character) => character.toUpperCase());
}

function propertyType(
  property: JsonSchemaProperty,
): TaskFormField["schemaType"] {
  const raw = Array.isArray(property.type)
    ? property.type.find((item) => item !== "null")
    : property.type;
  if (
    raw === "boolean" ||
    raw === "number" ||
    raw === "integer" ||
    raw === "object" ||
    raw === "array"
  ) {
    return raw;
  }
  return "string";
}

function serializeInitialValue(
  schemaType: TaskFormField["schemaType"],
  value: unknown,
): TaskFormRawValue {
  if (schemaType === "boolean") return value === true;
  if (value === undefined) {
    if (schemaType === "object") return "{}";
    if (schemaType === "array") return "[]";
    return "";
  }
  if (schemaType === "object" || schemaType === "array") {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return schemaType === "object" ? "{}" : "[]";
    }
  }
  return String(value);
}

function decisionOption(value: string): TaskDecisionOption | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === "approve" || normalized === "approved") {
    return { decision: "approve", formValue: value, label: "Approve" };
  }
  if (normalized === "reject" || normalized === "rejected") {
    return { decision: "reject", formValue: value, label: "Reject" };
  }
  if (
    normalized === "supplement" ||
    normalized === "revise" ||
    normalized === "revision" ||
    normalized === "request_changes"
  ) {
    return {
      decision: "supplement",
      formValue: value,
      label:
        normalized === "supplement" ? "Request supplement" : "Request revision",
    };
  }
  return null;
}

function defaultDecisions(includeSupplement: boolean): TaskDecisionOption[] {
  const options: TaskDecisionOption[] = [
    { decision: "approve", formValue: "approve", label: "Approve" },
    { decision: "reject", formValue: "reject", label: "Reject" },
  ];
  if (includeSupplement) {
    options.push({
      decision: "supplement",
      formValue: "supplement",
      label: "Request supplement",
    });
  }
  return options;
}

/**
 * Convert the supported JSON Schema subset into stable portal field metadata.
 * Unknown schema keywords remain harmless; object/array values use JSON inputs.
 */
export function buildTaskFormDefinition(schema: unknown): TaskFormDefinition {
  const root = record(schema);
  const properties = record(root?.properties);
  const required = new Set(
    Array.isArray(root?.required)
      ? root.required.filter((item): item is string => typeof item === "string")
      : [],
  );
  const hasSchema = Boolean(root && properties);
  const decisionProperty = record(
    properties?.decision,
  ) as JsonSchemaProperty | null;
  const decisionValues = Array.isArray(decisionProperty?.enum)
    ? decisionProperty.enum.filter(
        (item): item is string => typeof item === "string",
      )
    : [];
  const decisions = decisionValues.length
    ? decisionValues
        .map(decisionOption)
        .filter((item): item is TaskDecisionOption => item !== null)
        .filter(
          (item, index, all) =>
            all.findIndex(
              (candidate) => candidate.decision === item.decision,
            ) === index,
        )
    : defaultDecisions(hasSchema);

  const fields: TaskFormField[] = [];
  for (const [name, rawProperty] of Object.entries(properties ?? {})) {
    if (name === "decision" || FORBIDDEN_NAMES.has(name)) continue;
    const property = record(rawProperty) as JsonSchemaProperty | null;
    if (!property) continue;
    const schemaType = propertyType(property);
    const enumValues = Array.isArray(property.enum)
      ? property.enum.filter((item): item is string => typeof item === "string")
      : [];
    const format = typeof property.format === "string" ? property.format : "";
    const longText =
      format === "textarea" ||
      format === "markdown" ||
      /(notes?|rationale|reason|comment|details?|description)$/i.test(name);
    const kind: TaskFormField["kind"] = enumValues.length
      ? "select"
      : schemaType === "boolean"
        ? "boolean"
        : schemaType === "number" || schemaType === "integer"
          ? "number"
          : schemaType === "object" || schemaType === "array"
            ? "json"
            : longText
              ? "textarea"
              : "text";
    fields.push({
      name,
      label:
        typeof property.title === "string" && property.title.trim()
          ? property.title.trim()
          : titleCase(name),
      ...(typeof property.description === "string" &&
      property.description.trim()
        ? { description: property.description.trim() }
        : {}),
      required: required.has(name),
      kind,
      schemaType,
      options: enumValues.map((value) => ({ value, label: titleCase(value) })),
      initialValue: serializeInitialValue(schemaType, property.default),
      ...(typeof property.minLength === "number"
        ? { minLength: property.minLength }
        : {}),
      ...(typeof property.maxLength === "number"
        ? { maxLength: property.maxLength }
        : {}),
    });
  }

  return {
    fields,
    decisions: decisions.length ? decisions : defaultDecisions(hasSchema),
    ...(decisionProperty ? { decisionField: "decision" } : {}),
  };
}

export function initialTaskFormValues(
  definition: TaskFormDefinition,
): Record<string, TaskFormRawValue> {
  return Object.fromEntries(
    definition.fields.map((field) => [field.name, field.initialValue]),
  );
}

export type TaskPayloadBuildResult =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; errors: Record<string, string> };

/** Validate and coerce browser field values into the operator payload. */
export function buildTaskResolutionPayload(
  definition: TaskFormDefinition,
  values: Record<string, TaskFormRawValue>,
  option: TaskDecisionOption,
  t?: Translate,
): TaskPayloadBuildResult {
  const payload: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  if (definition.decisionField) {
    payload[definition.decisionField] = option.formValue;
  }

  for (const field of definition.fields) {
    const raw = values[field.name] ?? field.initialValue;
    if (field.kind === "boolean") {
      payload[field.name] = raw === true;
      continue;
    }
    const text = typeof raw === "string" ? raw : String(raw);
    if (!text.trim()) {
      if (field.required)
        errors[field.name] =
          t?.("tasks.validation.required", { label: field.label }) ??
          `${field.label} is required.`;
      continue;
    }
    if (field.minLength !== undefined && text.length < field.minLength) {
      errors[field.name] =
        t?.("tasks.validation.minLength", {
          label: field.label,
          count: field.minLength,
        }) ?? `${field.label} must be at least ${field.minLength} characters.`;
      continue;
    }
    if (field.maxLength !== undefined && text.length > field.maxLength) {
      errors[field.name] =
        t?.("tasks.validation.maxLength", {
          label: field.label,
          count: field.maxLength,
        }) ?? `${field.label} must be at most ${field.maxLength} characters.`;
      continue;
    }
    if (field.kind === "select") {
      if (!field.options.some((item) => item.value === text)) {
        errors[field.name] =
          t?.("tasks.validation.validChoice", { label: field.label }) ??
          `Choose a valid ${field.label.toLowerCase()}.`;
      } else {
        payload[field.name] = text;
      }
      continue;
    }
    if (field.kind === "number") {
      const number = Number(text);
      if (
        !Number.isFinite(number) ||
        (field.schemaType === "integer" && !Number.isInteger(number))
      ) {
        errors[field.name] =
          t?.("tasks.validation.validType", {
            label: field.label,
            type: field.schemaType,
          }) ?? `${field.label} must be a valid ${field.schemaType}.`;
      } else {
        payload[field.name] = number;
      }
      continue;
    }
    if (field.kind === "json") {
      try {
        const parsed = JSON.parse(text) as unknown;
        const validShape =
          field.schemaType === "array"
            ? Array.isArray(parsed)
            : parsed !== null &&
              typeof parsed === "object" &&
              !Array.isArray(parsed);
        if (!validShape) {
          errors[field.name] =
            t?.("tasks.validation.jsonShape", {
              label: field.label,
              type: field.schemaType,
            }) ?? `${field.label} must be a JSON ${field.schemaType}.`;
        } else {
          payload[field.name] = parsed;
        }
      } catch {
        errors[field.name] =
          t?.("tasks.validation.validJson", { label: field.label }) ??
          `${field.label} must contain valid JSON.`;
      }
      continue;
    }
    payload[field.name] = text;
  }

  return Object.keys(errors).length
    ? { ok: false, errors }
    : { ok: true, payload };
}
