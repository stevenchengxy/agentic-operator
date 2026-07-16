import {
  normalizeWorkflowManifest,
  type AgentDefinitionV2,
  type WorkflowRunEntrypoint,
  type WorkflowRunInputBinding,
  type WorkflowRunInputDescriptor,
  type WorkflowTestRunLimits,
} from "@agentic/contracts";

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
    .join(",")}}`;
}

function bindingFor(
  agent: AgentDefinitionV2,
  event: string,
  inputId: string,
): WorkflowRunInputBinding {
  const binding = agent.trigger_bindings?.[event]?.[inputId];
  if (!binding) return { agentId: agent.id, mode: "direct" };
  if ("path" in binding && typeof binding.path === "string") {
    return { agentId: agent.id, mode: "path", expression: binding.path };
  }
  if ("template" in binding && typeof binding.template === "string") {
    return {
      agentId: agent.id,
      mode: "template",
      expression: binding.template,
    };
  }
  return { agentId: agent.id, mode: "constant" };
}

function sameContract(
  current: WorkflowRunInputDescriptor,
  candidate: WorkflowRunInputDescriptor,
): boolean {
  return (
    current.kind === candidate.kind &&
    current.sensitivity === candidate.sensitivity &&
    stableJson(current.schema) === stableJson(candidate.schema) &&
    stableJson(current.file ?? null) === stableJson(candidate.file ?? null)
  );
}

/** Client-side equivalent of the API profile builder for unsaved manifests. */
export function deriveWorkflowEntrypoints(manifestInput: unknown): {
  entrypoints: WorkflowRunEntrypoint[];
  warnings: string[];
} {
  const manifest = normalizeWorkflowManifest(manifestInput);
  const emitted = new Set(
    manifest.agents.flatMap((agent) => agent.triggered_event),
  );
  const listeners = new Map<string, AgentDefinitionV2[]>();
  for (const agent of manifest.agents) {
    for (const event of agent.trigger) {
      const bucket = listeners.get(event) ?? [];
      bucket.push(agent);
      listeners.set(event, bucket);
    }
  }

  const entrypoints = [...listeners.entries()]
    .map(([event, agents]): WorkflowRunEntrypoint => {
      const inputs = new Map<string, WorkflowRunInputDescriptor>();
      let requiresRawPayload = false;
      for (const agent of agents) {
        for (const port of agent.inputs) {
          const binding = bindingFor(agent, event, port.id);
          requiresRawPayload ||= ["path", "template"].includes(binding.mode);
          const candidate: WorkflowRunInputDescriptor = {
            id: port.id,
            label: port.label ?? port.id,
            description: port.description ?? null,
            kind: port.kind,
            required: port.required && binding.mode !== "constant",
            schema: structuredClone(port.schema),
            ...(port.default !== undefined
              ? { default: structuredClone(port.default) }
              : {}),
            ...(port.example !== undefined
              ? { example: structuredClone(port.example) }
              : {}),
            sensitivity: port.sensitivity,
            ...(port.ui ? { ui: structuredClone(port.ui) } : {}),
            ...(port.file ? { file: structuredClone(port.file) } : {}),
            consumers: [agent.id],
            bindings: [binding],
            conflict: false,
          };
          const current = inputs.get(port.id);
          if (!current) {
            inputs.set(port.id, candidate);
            continue;
          }
          current.required ||= candidate.required;
          current.consumers = [...new Set([...current.consumers, agent.id])];
          current.bindings.push(binding);
          current.conflict ||= !sameContract(current, candidate);
        }
      }
      const source = emitted.has(event) ? "internal" : "external";
      return {
        event,
        source,
        recommended: source === "external",
        listenerAgentIds: agents.map((agent) => agent.id),
        listenerTitles: agents.map(
          (agent) => agent.title ?? agent.name ?? agent.id,
        ),
        inputs: [...inputs.values()].sort((left, right) => {
          const leftOrder = left.ui?.order ?? Number.MAX_SAFE_INTEGER;
          const rightOrder = right.ui?.order ?? Number.MAX_SAFE_INTEGER;
          return (
            leftOrder - rightOrder ||
            left.label.localeCompare(right.label) ||
            left.id.localeCompare(right.id)
          );
        }),
        requiresRawPayload,
      };
    })
    .sort(
      (left, right) =>
        Number(right.recommended) - Number(left.recommended) ||
        left.event.localeCompare(right.event),
    );

  const warnings: string[] = [];
  if (entrypoints.length === 0) {
    warnings.push("The workflow declares no trigger events.");
  } else if (!entrypoints.some((entrypoint) => entrypoint.recommended)) {
    warnings.push(
      "Every trigger is emitted internally. Choose an internal event deliberately and retain bounded test limits.",
    );
  }
  for (const entrypoint of entrypoints) {
    const conflicts = entrypoint.inputs.filter((input) => input.conflict);
    if (conflicts.length > 0) {
      warnings.push(
        `${entrypoint.event} has conflicting contracts for ${conflicts.map((input) => input.id).join(", ")}.`,
      );
    }
  }
  return { entrypoints, warnings };
}

export type WorkflowInputControl =
  | "text"
  | "textarea"
  | "number"
  | "checkbox"
  | "select"
  | "json"
  | "file";

export function workflowInputControl(
  input: WorkflowRunInputDescriptor,
): WorkflowInputControl {
  if (input.kind === "file") return "file";
  if (input.ui?.control) return input.ui.control;
  const schema = input.schema as Record<string, unknown>;
  if (Array.isArray(schema.enum)) return "select";
  if (schema.type === "boolean") return "checkbox";
  if (schema.type === "number" || schema.type === "integer") return "number";
  if (schema.type === "object" || schema.type === "array") return "json";
  if (typeof schema.maxLength === "number" && schema.maxLength > 240) {
    return "textarea";
  }
  return input.kind === "prompt" ? "textarea" : "text";
}

export function seedWorkflowInputValue(
  input: WorkflowRunInputDescriptor,
): unknown {
  if (input.default !== undefined) return structuredClone(input.default);
  if (input.example !== undefined) return structuredClone(input.example);
  const schema = input.schema as Record<string, unknown>;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return schema.enum[0];
  }
  switch (workflowInputControl(input)) {
    case "checkbox":
      return false;
    case "number":
      return "";
    case "json":
      return schema.type === "array" ? [] : {};
    case "file":
      return input.file?.multiple ? [] : null;
    default:
      return "";
  }
}

export function validateWorkflowInputValues(
  entrypoint: WorkflowRunEntrypoint | undefined,
  values: Record<string, unknown>,
): string[] {
  if (!entrypoint) return ["Select an entry event."];
  const errors: string[] = [];
  for (const input of entrypoint.inputs) {
    const value = values[input.id];
    const empty =
      value === undefined ||
      value === null ||
      value === "" ||
      (Array.isArray(value) && value.length === 0);
    if (input.required && empty) {
      errors.push(`${input.label} is required.`);
    }
    if (input.conflict) {
      errors.push(
        `${input.label} has conflicting listener schemas; verify the raw event payload.`,
      );
    }
  }
  return errors;
}

export function parseWorkflowTestLimits(values: {
  maxAgentRuns: string;
  maxEvents: string;
  maxDepth: string;
}): WorkflowTestRunLimits {
  const limits = {
    maxAgentRuns: Number(values.maxAgentRuns),
    maxEvents: Number(values.maxEvents),
    maxDepth: Number(values.maxDepth),
  };
  const constraints = [
    {
      key: "maxAgentRuns" as const,
      label: "Agent runs",
      max: 100,
    },
    { key: "maxEvents" as const, label: "Events", max: 250 },
    { key: "maxDepth" as const, label: "Depth", max: 50 },
  ];
  for (const constraint of constraints) {
    const value = limits[constraint.key];
    if (!Number.isInteger(value) || value < 1 || value > constraint.max) {
      throw new Error(
        `${constraint.label} budget must be a whole number from 1 to ${constraint.max}.`,
      );
    }
  }
  return limits;
}

/**
 * Preserve the production event contract used by trigger binding:
 * direct inputs remain available at the payload root, while the canonical
 * nested `inputs` object cannot be replaced by an advanced raw-payload edit.
 */
export function buildWorkflowEventPayload(
  inputs: Record<string, unknown>,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...inputs,
    ...payload,
    inputs: structuredClone(inputs),
  };
}
