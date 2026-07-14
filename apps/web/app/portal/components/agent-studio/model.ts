export type JsonObject = Record<string, unknown>;

export type InputKind = "prompt" | "value" | "file";

export interface StudioInputPort extends JsonObject {
  id: string;
  label: string;
  description?: string;
  kind: InputKind;
  required: boolean;
  schema: JsonObject;
  default?: unknown;
  example?: unknown;
  sensitivity: "none" | "personal" | "confidential" | "secret";
  ui?: JsonObject;
  file?: JsonObject;
}

export interface StudioOutputPort extends JsonObject {
  id: string;
  label: string;
  description?: string;
  required: boolean;
  schema: JsonObject;
  example?: unknown;
  sensitivity: "none" | "personal" | "confidential" | "secret";
}

export interface StudioAction extends JsonObject {
  order: string;
  name: string;
  description?: string;
  type: "logic" | "tool" | "manual" | "condition" | "delay" | "subflow";
}

export interface StudioToolBinding extends JsonObject {
  name: string;
  description?: string;
  input_schema?: JsonObject;
  config?: JsonObject;
}

export interface StudioDefinition extends JsonObject {
  id: string;
  name: string;
  title: string;
  description: string;
  actor: Array<"Agent" | "Human">;
  stage: number;
  template: string;
  trigger: string[];
  triggered_event: string[];
  actions: StudioAction[];
  inputs: StudioInputPort[];
  input_data: JsonObject;
  ontology_instructions: string;
  user_prompt_template: string;
  outputs: StudioOutputPort[];
  output_config: JsonObject;
  output_bindings: JsonObject;
  tool_use: StudioToolBinding[];
  provider: string;
  model: string;
  temperature: number;
  max_tokens: number;
  timeout_s: number;
  retries: number;
  concurrency: JsonObject;
  tool_loop: JsonObject;
  cron: string | null;
  cron_timezone: string | null;
  observability: JsonObject;
  typescript_code: string;
}

export interface StudioValidationIssue {
  path: string;
  code: string;
  severity: "error" | "warning" | "info";
  message: string;
  suggestion?: string;
}

export function isRecord(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function asRecord(value: unknown): JsonObject {
  return isRecord(value) ? value : {};
}

export function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export function cloneDefinition<T>(value: T): T {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

function normalizeSchema(value: unknown, fallbackType = "string"): JsonObject {
  const schema = asRecord(value);
  return Object.keys(schema).length > 0 ? cloneDefinition(schema) : { type: fallbackType };
}

function normalizeInputs(raw: JsonObject, requirePrompt: boolean): StudioInputPort[] {
  const provided = Array.isArray(raw.inputs) ? raw.inputs : [];
  const normalized = provided
    .map((entry, index): StudioInputPort | null => {
      const row = asRecord(entry);
      const id = asString(row.id).trim();
      if (!id) return null;
      const kindValue = asString(row.kind, id === "prompt" ? "prompt" : "value");
      const kind: InputKind =
        kindValue === "prompt" || kindValue === "file" ? kindValue : "value";
      const sensitivityValue = asString(row.sensitivity, row.sensitive === true ? "confidential" : "none");
      const sensitivity = (
        ["none", "personal", "confidential", "secret"].includes(sensitivityValue)
          ? sensitivityValue
          : "none"
      ) as StudioInputPort["sensitivity"];
      return {
        ...cloneDefinition(row),
        id,
        label: asString(row.label, titleCase(id)),
        description: asString(row.description) || undefined,
        kind,
        required: asBoolean(row.required, kind === "prompt" || index === 0),
        schema: normalizeSchema(row.schema, kind === "file" ? "object" : "string"),
        sensitivity,
        ...(row.default !== undefined ? { default: cloneDefinition(row.default) } : {}),
        ...(row.example !== undefined ? { example: cloneDefinition(row.example) } : {}),
        ...(isRecord(row.ui) ? { ui: cloneDefinition(row.ui) } : {}),
      };
    })
    .filter((entry): entry is StudioInputPort => Boolean(entry));

  if (requirePrompt && !normalized.some((entry) => entry.kind === "prompt")) {
    const defaults = asRecord(raw.input_data);
    const defaultPrompt =
      asString(defaults.prompt) || asString(defaults.message) || asString(defaults.input);
    normalized.unshift({
      id: "prompt",
      label: "Request",
      description: "The conversational request sent to the model as the user message.",
      kind: "prompt",
      required: true,
      schema: { type: "string", minLength: 1 },
      sensitivity: "none",
      ...(defaultPrompt ? { default: defaultPrompt } : {}),
      ui: { control: "textarea" },
    });
  }

  return normalized;
}

function normalizeOutputs(raw: JsonObject): StudioOutputPort[] {
  const provided = Array.isArray(raw.outputs) ? raw.outputs : [];
  const normalized = provided
    .map((entry): StudioOutputPort | null => {
      const row = asRecord(entry);
      const id = asString(row.id).trim();
      if (!id) return null;
      const sensitivityValue = asString(row.sensitivity, row.sensitive === true ? "confidential" : "none");
      const sensitivity = (
        ["none", "personal", "confidential", "secret"].includes(sensitivityValue)
          ? sensitivityValue
          : "none"
      ) as StudioOutputPort["sensitivity"];
      return {
        ...cloneDefinition(row),
        id,
        label: asString(row.label, titleCase(id)),
        description: asString(row.description) || undefined,
        required: asBoolean(row.required, true),
        schema: normalizeSchema(row.schema, "object"),
        sensitivity,
        ...(row.example !== undefined ? { example: cloneDefinition(row.example) } : {}),
      };
    })
    .filter((entry): entry is StudioOutputPort => Boolean(entry));

  return normalized.length > 0
    ? normalized
    : [
        {
          id: "result",
          label: "Result",
          description: "Legacy-compatible structured result.",
          required: true,
          schema: {},
          sensitivity: "none",
        },
      ];
}

function normalizeActions(raw: JsonObject): StudioAction[] {
  const provided = Array.isArray(raw.actions) ? raw.actions : [];
  const allowed = new Set(["logic", "tool", "manual", "condition", "delay", "subflow"]);
  const normalized = provided.map((entry, index): StudioAction => {
    const row = asRecord(entry);
    const rawType = asString(row.type, "logic");
    const type = (allowed.has(rawType) ? rawType : "logic") as StudioAction["type"];
    return {
      ...cloneDefinition(row),
      order: asString(row.order, String(index + 1)),
      name: asString(row.name, `step${index + 1}`),
      description: asString(row.description) || undefined,
      type,
    };
  });
  return normalized.length > 0
    ? normalized
    : [{ order: "1", name: asString(raw.name, "runAgent"), type: "logic" }];
}

function normalizeTools(raw: JsonObject): StudioToolBinding[] {
  const provided = Array.isArray(raw.tool_use) ? raw.tool_use : [];
  return provided
    .map((entry): StudioToolBinding | null => {
      if (typeof entry === "string") return { name: entry };
      const row = asRecord(entry);
      const name = asString(row.name).trim();
      if (!name) return null;
      return {
        ...cloneDefinition(row),
        name,
        description: asString(row.description) || undefined,
        ...(isRecord(row.input_schema) ? { input_schema: cloneDefinition(row.input_schema) } : {}),
        ...(isRecord(row.config) ? { config: cloneDefinition(row.config) } : {}),
      };
    })
    .filter((entry): entry is StudioToolBinding => Boolean(entry));
}

export function normalizeStudioDefinition(
  value: unknown,
  fallback: Partial<StudioDefinition> = {},
): StudioDefinition {
  const raw = asRecord(value);
  const actorRaw = Array.isArray(raw.actor)
    ? raw.actor
    : typeof raw.actor === "string"
      ? [raw.actor]
      : fallback.actor ?? ["Agent"];
  const actor: Array<"Agent" | "Human"> = actorRaw.includes("Human")
    ? ["Human"]
    : ["Agent"];
  const concurrency = asRecord(raw.concurrency);
  const outputConfig = asRecord(raw.output_config);
  const observability = asRecord(raw.observability);

  return {
    ...cloneDefinition(raw),
    id: asString(raw.id, fallback.id ?? "agent-draft"),
    name: asString(raw.name, fallback.name ?? "agentDraft"),
    title: asString(raw.title, fallback.title ?? "Untitled agent"),
    description: asString(raw.description, fallback.description ?? ""),
    actor,
    stage: asNumber(raw.stage, fallback.stage ?? 0),
    template: asString(raw.template, fallback.template ?? "blank"),
    trigger: asStringArray(raw.trigger ?? raw.triggers),
    triggered_event: asStringArray(raw.triggered_event ?? raw.triggeredEvents),
    actions: normalizeActions(raw),
    inputs: normalizeInputs(raw, actor.includes("Agent")),
    input_data: cloneDefinition(asRecord(raw.input_data)),
    ontology_instructions: asString(raw.ontology_instructions),
    user_prompt_template: asString(raw.user_prompt_template),
    outputs: normalizeOutputs(raw),
    output_config: {
      ...cloneDefinition(outputConfig),
      format: "json",
      strict: asBoolean(outputConfig.strict, false),
      repair_attempts: asNumber(outputConfig.repair_attempts, 1),
      artifact: {
        filename: "output.json",
        persist_individual_outputs: false,
        ...cloneDefinition(asRecord(outputConfig.artifact)),
      },
    },
    output_bindings: cloneDefinition(asRecord(raw.output_bindings)),
    tool_use: normalizeTools(raw),
    provider: asString(raw.provider),
    model: asString(raw.model),
    temperature: asNumber(raw.temperature, 0.2),
    max_tokens: asNumber(raw.max_tokens, 2400),
    timeout_s: asNumber(raw.timeout_s, 120),
    retries: asNumber(raw.retries, 3),
    concurrency: {
      ...cloneDefinition(concurrency),
      enabled: asBoolean(concurrency.enabled, true),
      max_concurrent_executions: asNumber(concurrency.max_concurrent_executions, 8),
      key: asString(concurrency.key, "$.subject"),
    },
    tool_loop: {
      max_iterations: 8,
      ...cloneDefinition(asRecord(raw.tool_loop)),
    },
    cron: typeof raw.cron === "string" ? raw.cron : null,
    cron_timezone: typeof raw.cron_timezone === "string" ? raw.cron_timezone : null,
    observability: {
      ...cloneDefinition(observability),
      trace_level: asString(observability.trace_level, "standard"),
      reasoning_summary: asBoolean(observability.reasoning_summary, true),
      persist_rendered_prompts: asBoolean(observability.persist_rendered_prompts, false),
      retention_days: asNumber(observability.retention_days, 30),
    },
    typescript_code: asString(raw.typescript_code),
  };
}

export function localValidation(definition: StudioDefinition): StudioValidationIssue[] {
  const issues: StudioValidationIssue[] = [];
  const add = (
    path: string,
    code: string,
    severity: StudioValidationIssue["severity"],
    message: string,
  ) => issues.push({ path, code, severity, message });

  if (!/^[a-z][A-Za-z0-9]*$/.test(definition.name)) {
    add("/name", "invalid_name", "error", "Name must use lower camelCase letters and numbers.");
  }
  if (!definition.title.trim()) add("/title", "required", "error", "Title is required.");
  if (definition.actor.includes("Agent") && definition.ontology_instructions.trim().length < 40) {
    add(
      "/ontology_instructions",
      "instructions_short",
      "warning",
      "Instructions should be at least 40 characters so the model has a clear objective.",
    );
  }
  const promptCount = definition.inputs.filter((input) => input.kind === "prompt").length;
  if (definition.actor.includes("Agent") && promptCount !== 1) {
    add("/inputs", "prompt_count", "error", "LLM agents require exactly one prompt input.");
  }
  definition.inputs.forEach((input, index) => {
    if (input.kind === "prompt" && input.id !== "prompt") {
      add(
        `/inputs/${index}/id`,
        "prompt_id_reserved",
        "error",
        'The prompt input must use the reserved variable ID "prompt".',
      );
    }
  });
  if (definition.outputs.length === 0) {
    add("/outputs", "output_required", "error", "Add at least one named output.");
  }
  if (new Set(definition.inputs.map((input) => input.id)).size !== definition.inputs.length) {
    add("/inputs", "duplicate_input", "error", "Input IDs must be unique.");
  }
  if (new Set(definition.outputs.map((output) => output.id)).size !== definition.outputs.length) {
    add("/outputs", "duplicate_output", "error", "Output IDs must be unique.");
  }
  if (!definition.model) {
    add("/model", "model_inherited", "info", "This agent inherits the workspace primary model.");
  }
  if (definition.trigger.length === 0) {
    add("/trigger", "manual_only", "warning", "No trigger event is configured; production runs are manual only.");
  }
  return issues;
}

export function titleCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export function parseLooseJson(text: string): { value?: unknown; error?: string } {
  try {
    return { value: JSON.parse(text) as unknown };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export function toPrettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function csvToList(value: string): string[] {
  return Array.from(
    new Set(
      value
        .split(/[\n,]+/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  );
}

export function isTerminalStatus(status: string | null | undefined): boolean {
  return status === "ok" || status === "failed" || status === "cancelled";
}
