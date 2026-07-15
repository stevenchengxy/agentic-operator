"use client";

/**
 * AgentEditor — inline node editor for the Workflow editor (P3-FE-01).
 *
 * Drops into the right inspector aside when `editing && selectedAgent`. The
 * operator edits the complete manifest definition without flattening it to the
 * DAG projection. Unknown/additive fields remain on `draft.definition`.
 *
 * Triggers and triggered_event are managed as comma-or-newline-separated
 * lists; we trim + dedupe on commit.
 */

import { useState, useEffect, useRef } from "react";
import { ActorTag, Badge, Button } from "@/app/portal/components";
import type { DagAgent } from "@/lib/hooks/useAgents";
import { Section, type EventCatalogItem } from "./inspectors";
import {
  patchAgentDefinition,
  type AgentActor,
  type CompleteAgentDefinition,
  type DraftAgent,
  type WorkflowDagAgent,
} from "./draft";

export interface AgentEditorProps {
  agent: DagAgent;
  events: EventCatalogItem[];
  /** Current draft for this agent (so the editor stays controlled across re-renders). */
  draft: DraftAgent | undefined;
  onChange: (next: DraftAgent) => void;
  /** Optional lossless callback for callers that store full definitions separately. */
  onDefinitionChange?: (next: CompleteAgentDefinition) => void;
  /** Reports local parse/range errors that have not been committed to the manifest. */
  onValidityChange?: (agentId: string, errors: string[]) => void;
  onRemove: () => void;
  onClose: () => void;
}

export function AgentEditor({
  agent,
  events,
  draft,
  onChange,
  onDefinitionChange,
  onValidityChange,
  onRemove,
  onClose,
}: AgentEditorProps) {
  const [values, setValues] = useState(() => editorValues(agent, draft));
  const [actionsError, setActionsError] = useState<string | null>(null);
  const [toolsError, setToolsError] = useState<string | null>(null);
  const [inputsError, setInputsError] = useState<string | null>(null);
  const [outputsError, setOutputsError] = useState<string | null>(null);
  const [numberErrors, setNumberErrors] = useState<Record<string, string>>({});
  const definitionRef = useRef(
    draft?.definition ?? (agent as WorkflowDagAgent).definition,
  );
  const draftRef = useRef(draft);

  // When the agent changes (operator picks a different node), reset inputs.
  useEffect(() => {
    setValues(editorValues(agent, draft));
    setActionsError(null);
    setToolsError(null);
    setInputsError(null);
    setOutputsError(null);
    setNumberErrors({});
    definitionRef.current =
      draft?.definition ?? (agent as WorkflowDagAgent).definition;
    draftRef.current = draft;
    // We intentionally key off agent.kebabId so React's lint rule isn't quite
    // right; rerunning on every field change would clobber typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.kebabId]);

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  useEffect(() => {
    onValidityChange?.(
      agent.kebabId,
      [
        actionsError,
        toolsError,
        inputsError,
        outputsError,
        ...Object.values(numberErrors),
      ].filter((entry): entry is string => Boolean(entry)),
    );
  }, [
    actionsError,
    agent.kebabId,
    inputsError,
    numberErrors,
    onValidityChange,
    outputsError,
    toolsError,
  ]);

  useEffect(
    () => () => {
      onValidityChange?.(agent.kebabId, []);
    },
    [agent.kebabId, onValidityChange],
  );

  function commit(partial: Partial<DraftAgent>) {
    const sparse: DraftAgent = {
      ...(draftRef.current ?? { id: agent.kebabId }),
      id: agent.kebabId,
      ...partial,
    };
    const currentDefinition = definitionRef.current;
    if (currentDefinition) {
      const definition = patchAgentDefinition(currentDefinition, {
        id: agent.kebabId,
        ...partial,
      });
      sparse.definition = definition;
      definitionRef.current = definition;
      onDefinitionChange?.(definition);
    }
    draftRef.current = sparse;
    onChange(sparse);
  }

  function changeOptionalNumber(
    key: "temperature" | "max_tokens" | "retries" | "timeout_s",
    raw: string,
    options: { integer?: boolean; min?: number; max?: number } = {},
  ) {
    setValues((current) => ({ ...current, [key]: raw }));
    const message = validateNumberInput(raw, labelForNumber(key), options);
    setNumberErrors((current) => {
      const next = { ...current };
      if (message) next[key] = message;
      else delete next[key];
      return next;
    });
    if (raw.trim() === "") {
      commit({ [key]: null });
      return;
    }
    const number = Number(raw);
    if (message) return;
    commit({ [key]: number });
  }

  function changeJson(
    key: "actions" | "tool_use" | "inputs" | "outputs",
    raw: string,
    setError: (value: string | null) => void,
  ) {
    setValues((current) => ({ ...current, [key]: raw }));
    if (["tool_use", "inputs", "outputs"].includes(key) && raw.trim() === "") {
      setError(null);
      commit({ [key]: null });
      return;
    }
    try {
      const label =
        key === "actions"
          ? "Actions"
          : key === "tool_use"
            ? "Tools"
            : key === "inputs"
              ? "Inputs"
              : "Outputs";
      const parsed =
        key === "inputs" || key === "outputs"
          ? parseTypedPorts(raw, label, key)
          : parseJsonArray(raw, label);
      setError(null);
      commit({ [key]: parsed });
    } catch (error) {
      setError(error instanceof Error ? error.message : "Invalid JSON array");
    }
  }

  return (
    <div
      style={{
        flex: 1,
        overflow: "auto",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
      }}
    >
      <header
        style={{
          padding: "14px 16px",
          borderBottom: "1px solid var(--border)",
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
        }}
      >
        <div>
          <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
            <ActorTag actor={values.actor} />
            <Badge tone="muted">{agent.kebabId}</Badge>
            <Badge tone="amber">EDIT</Badge>
          </div>
          <div style={{ fontSize: 11, color: "var(--text-3)" }}>
            Changes stay local until you save the draft, then publish it
            explicitly.
          </div>
        </div>
        <Button
          small
          icon="x"
          tone="ghost"
          onClick={onClose}
          ariaLabel="Close"
        />
      </header>

      <Section title="Identity">
        <div style={fieldGridStyle}>
          <EditorField label="Name">
            <input
              value={values.name}
              onChange={(event) => {
                const name = event.target.value;
                setValues((current) => ({ ...current, name }));
                commit({ name });
              }}
              placeholder="camelCase agent name"
              style={inputStyle}
            />
          </EditorField>
          <EditorField label="Title">
            <input
              value={values.title}
              onChange={(event) => {
                const title = event.target.value;
                setValues((current) => ({ ...current, title }));
                commit({ title });
              }}
              placeholder="Human-readable title"
              style={inputStyle}
            />
          </EditorField>
          <EditorField label="Actor">
            <select
              value={values.actor}
              onChange={(event) => {
                const actor = event.target.value as AgentActor;
                setValues((current) => ({ ...current, actor }));
                commit({ actor });
              }}
              style={inputStyle}
            >
              <option value="Agent">Automated agent</option>
              <option value="Human">Human task</option>
            </select>
          </EditorField>
          <EditorField label="Stage">
            <input
              type="number"
              min={0}
              step={1}
              value={values.stage}
              onChange={(event) => {
                const stage = event.target.value;
                setValues((current) => ({ ...current, stage }));
                const stageError = validateNumberInput(stage, "Stage", {
                  integer: true,
                  min: 0,
                  required: true,
                });
                setNumberErrors((current) => {
                  const next = { ...current };
                  if (stageError) next.stage = stageError;
                  else delete next.stage;
                  return next;
                });
                const parsed = Number(stage);
                if (!stageError) commit({ stage: parsed });
              }}
              style={inputStyle}
            />
            {numberErrors.stage ? (
              <ErrorText>{numberErrors.stage}</ErrorText>
            ) : null}
          </EditorField>
        </div>
        <EditorField label="Description">
          <textarea
            value={values.description}
            onChange={(event) => {
              const description = event.target.value;
              setValues((current) => ({ ...current, description }));
              commit({ description: description === "" ? null : description });
            }}
            placeholder="What this step is responsible for"
            rows={3}
            style={textareaStyle}
          />
        </EditorField>
      </Section>

      <Section title="Triggered by · events this agent listens for">
        <textarea
          value={values.triggers}
          onChange={(event) => {
            const triggers = event.target.value;
            setValues((current) => ({ ...current, triggers }));
            commit({ triggers: parseList(triggers) });
          }}
          placeholder="EVENT_A, EVENT_B"
          rows={2}
          style={textareaStyle}
        />
        <EventDictHint events={events} prefix="Available" />
      </Section>

      <Section title="Triggered event · emitted on success">
        <textarea
          value={values.emits}
          onChange={(event) => {
            const emits = event.target.value;
            setValues((current) => ({ ...current, emits }));
            commit({ emits: parseList(emits) });
          }}
          placeholder="EVENT_A, EVENT_B"
          rows={2}
          style={textareaStyle}
        />
        <EventDictHint events={events} prefix="Available" />
      </Section>

      <Section title="Instructions and prompts">
        <EditorField label="System / ontology instructions">
          <textarea
            value={values.ontology_instructions}
            onChange={(event) => {
              const ontology_instructions = event.target.value;
              setValues((current) => ({ ...current, ontology_instructions }));
              commit({
                ontology_instructions:
                  ontology_instructions === "" ? null : ontology_instructions,
              });
            }}
            placeholder="Role, constraints, reasoning policy, output quality bar…"
            rows={7}
            style={textareaStyle}
          />
        </EditorField>
        <EditorField label="User prompt template">
          <textarea
            value={values.user_prompt_template}
            onChange={(event) => {
              const user_prompt_template = event.target.value;
              setValues((current) => ({ ...current, user_prompt_template }));
              commit({
                user_prompt_template:
                  user_prompt_template === "" ? null : user_prompt_template,
              });
            }}
            placeholder="Reference event data or prior results using the runtime's template syntax."
            rows={6}
            style={textareaStyle}
          />
        </EditorField>
      </Section>

      <Section title="Typed inputs and outputs">
        <EditorField label="Inputs JSON">
          <textarea
            aria-label="Typed inputs JSON"
            value={values.inputs}
            onChange={(event) =>
              changeJson("inputs", event.target.value, setInputsError)
            }
            placeholder={
              '[{"id":"request","kind":"value","required":true,"schema":{"type":"object"}}]'
            }
            rows={8}
            spellCheck={false}
            style={jsonTextareaStyle}
          />
          {inputsError ? <ErrorText>{inputsError}</ErrorText> : null}
        </EditorField>
        <EditorField label="Outputs JSON">
          <textarea
            aria-label="Typed outputs JSON"
            value={values.outputs}
            onChange={(event) =>
              changeJson("outputs", event.target.value, setOutputsError)
            }
            placeholder={
              '[{"id":"result","required":true,"schema":{"type":"object"}}]'
            }
            rows={8}
            spellCheck={false}
            style={jsonTextareaStyle}
          />
          {outputsError ? <ErrorText>{outputsError}</ErrorText> : null}
        </EditorField>
        <div style={hintStyle}>
          Optional typed ports. Each port needs an id and JSON Schema; inputs
          also require kind (prompt, value, or file).
        </div>
      </Section>

      <Section title="Actions">
        <textarea
          aria-label="Actions JSON"
          value={values.actions}
          onChange={(event) =>
            changeJson("actions", event.target.value, setActionsError)
          }
          rows={12}
          spellCheck={false}
          style={jsonTextareaStyle}
        />
        {actionsError ? <ErrorText>{actionsError}</ErrorText> : null}
        <div style={hintStyle}>
          A JSON array. Invalid JSON stays local and is never applied.
        </div>
      </Section>

      <Section title="Tools">
        <textarea
          aria-label="Tool use JSON"
          value={values.tool_use}
          onChange={(event) =>
            changeJson("tool_use", event.target.value, setToolsError)
          }
          placeholder={'[{"name":"meta.ping","config":{}}]'}
          rows={8}
          spellCheck={false}
          style={jsonTextareaStyle}
        />
        {toolsError ? <ErrorText>{toolsError}</ErrorText> : null}
        <div style={hintStyle}>Leave blank to inherit no tool allow-list.</div>
      </Section>

      <Section title="Model selection">
        <div style={fieldGridStyle}>
          <EditorField label="Provider">
            <input
              value={values.provider}
              onChange={(event) => {
                const provider = event.target.value;
                setValues((current) => ({ ...current, provider }));
                commit({ provider: provider === "" ? null : provider });
              }}
              placeholder="Inherit gateway default"
              style={inputStyle}
            />
          </EditorField>
          <EditorField label="Model">
            <input
              value={values.model}
              onChange={(event) => {
                const model = event.target.value;
                setValues((current) => ({ ...current, model }));
                commit({ model: model === "" ? null : model });
              }}
              placeholder="Inherit provider default"
              style={inputStyle}
            />
          </EditorField>
        </div>
      </Section>

      <Section title="Runtime controls">
        <div style={fieldGridStyle}>
          <EditorField label="Temperature">
            <input
              type="number"
              min={0}
              max={2}
              step={0.1}
              value={values.temperature}
              onChange={(event) =>
                changeOptionalNumber("temperature", event.target.value, {
                  min: 0,
                  max: 2,
                })
              }
              placeholder="Default"
              style={inputStyle}
            />
            {numberErrors.temperature ? (
              <ErrorText>{numberErrors.temperature}</ErrorText>
            ) : null}
          </EditorField>
          <EditorField label="Max tokens">
            <input
              type="number"
              min={1}
              step={1}
              value={values.max_tokens}
              onChange={(event) =>
                changeOptionalNumber("max_tokens", event.target.value, {
                  integer: true,
                  min: 1,
                })
              }
              placeholder="Default"
              style={inputStyle}
            />
            {numberErrors.max_tokens ? (
              <ErrorText>{numberErrors.max_tokens}</ErrorText>
            ) : null}
          </EditorField>
          <EditorField label="Retries">
            <input
              type="number"
              min={0}
              step={1}
              value={values.retries}
              onChange={(event) =>
                changeOptionalNumber("retries", event.target.value, {
                  integer: true,
                  min: 0,
                })
              }
              placeholder="Default"
              style={inputStyle}
            />
            {numberErrors.retries ? (
              <ErrorText>{numberErrors.retries}</ErrorText>
            ) : null}
          </EditorField>
          <EditorField label="Timeout (seconds)">
            <input
              type="number"
              min={1}
              step={1}
              value={values.timeout_s}
              onChange={(event) =>
                changeOptionalNumber("timeout_s", event.target.value, {
                  integer: true,
                  min: 1,
                })
              }
              placeholder="Default"
              style={inputStyle}
            />
            {numberErrors.timeout_s ? (
              <ErrorText>{numberErrors.timeout_s}</ErrorText>
            ) : null}
          </EditorField>
          <EditorField label="Concurrency limit">
            <input
              type="number"
              min={1}
              step={1}
              value={values.concurrency}
              onChange={(event) => {
                const concurrency = event.target.value;
                setValues((current) => ({ ...current, concurrency }));
                const concurrencyError = validateNumberInput(
                  concurrency,
                  "Concurrency limit",
                  { integer: true, min: 1 },
                );
                setNumberErrors((current) => {
                  const next = { ...current };
                  if (concurrencyError) next.concurrency = concurrencyError;
                  else delete next.concurrency;
                  return next;
                });
                if (concurrency.trim() === "") {
                  commit({ concurrency: null });
                  return;
                }
                const maximum = Number(concurrency);
                if (concurrencyError) return;
                const current = definitionRef.current?.concurrency;
                const base =
                  current &&
                  typeof current === "object" &&
                  !Array.isArray(current)
                    ? (current as Record<string, unknown>)
                    : {};
                commit({
                  concurrency: {
                    ...base,
                    enabled: true,
                    max_concurrent_executions: maximum,
                  },
                });
              }}
              placeholder="Default"
              style={inputStyle}
            />
            {numberErrors.concurrency ? (
              <ErrorText>{numberErrors.concurrency}</ErrorText>
            ) : null}
          </EditorField>
        </div>
      </Section>

      <div
        style={{
          padding: 14,
          marginTop: "auto",
          display: "flex",
          gap: 8,
          borderTop: "1px solid var(--border)",
        }}
      >
        <Button icon="x" tone="danger" onClick={onRemove}>
          Remove node
        </Button>
      </div>
    </div>
  );
}

function EventDictHint({
  events,
  prefix,
}: {
  events: EventCatalogItem[];
  prefix: string;
}) {
  if (events.length === 0) return null;
  return (
    <div style={{ marginTop: 6, fontSize: 10.5, color: "var(--text-3)" }}>
      {prefix}:{" "}
      {events
        .slice(0, 6)
        .map((e) => e.name)
        .join(", ")}
      {events.length > 6 ? `, +${events.length - 6} more` : ""}
    </div>
  );
}

/** Pure helper exposed for tests. */
export function parseList(s: string): string[] {
  const out = new Set<string>();
  for (const part of s.split(/[,\s]+/)) {
    const t = part.trim();
    if (t.length > 0) out.add(t);
  }
  return Array.from(out);
}

/** Parse and validate the free-form JSON editors without mutating the draft. */
export function parseJsonArray(value: string, label: string): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${label} must be valid JSON.`);
  }
  if (!Array.isArray(parsed)) throw new Error(`${label} must be a JSON array.`);
  return parsed;
}

export function parseTypedPorts(
  value: string,
  label: string,
  kind: "inputs" | "outputs",
): unknown[] {
  const ports = parseJsonArray(value, label);
  ports.forEach((port, index) => {
    if (!port || typeof port !== "object" || Array.isArray(port)) {
      throw new Error(`${label}[${index}] must be a JSON object.`);
    }
    const candidate = port as Record<string, unknown>;
    if (typeof candidate.id !== "string" || !candidate.id.trim()) {
      throw new Error(`${label}[${index}].id is required.`);
    }
    if (
      !candidate.schema ||
      typeof candidate.schema !== "object" ||
      Array.isArray(candidate.schema)
    ) {
      throw new Error(`${label}[${index}].schema must be a JSON object.`);
    }
    if (
      kind === "inputs" &&
      !["prompt", "value", "file"].includes(String(candidate.kind))
    ) {
      throw new Error(
        `${label}[${index}].kind must be prompt, value, or file.`,
      );
    }
  });
  return ports;
}

export function validateNumberInput(
  raw: string,
  label: string,
  options: {
    integer?: boolean;
    min?: number;
    max?: number;
    required?: boolean;
  } = {},
): string | null {
  if (raw.trim() === "") {
    return options.required ? `${label} is required.` : null;
  }
  const number = Number(raw);
  if (!Number.isFinite(number)) return `${label} must be a number.`;
  if (options.integer && !Number.isInteger(number)) {
    return `${label} must be a whole number.`;
  }
  if (options.min !== undefined && number < options.min) {
    return `${label} must be at least ${options.min}.`;
  }
  if (options.max !== undefined && number > options.max) {
    return `${label} must be at most ${options.max}.`;
  }
  return null;
}

function labelForNumber(
  key: "temperature" | "max_tokens" | "retries" | "timeout_s",
): string {
  return {
    temperature: "Temperature",
    max_tokens: "Max tokens",
    retries: "Retries",
    timeout_s: "Timeout",
  }[key];
}

interface EditorValues {
  name: string;
  title: string;
  description: string;
  actor: AgentActor;
  stage: string;
  triggers: string;
  emits: string;
  ontology_instructions: string;
  user_prompt_template: string;
  inputs: string;
  outputs: string;
  actions: string;
  tool_use: string;
  provider: string;
  model: string;
  temperature: string;
  max_tokens: string;
  retries: string;
  timeout_s: string;
  concurrency: string;
}

function draftValue<K extends keyof DraftAgent>(
  draft: DraftAgent | undefined,
  key: K,
  fallback: unknown,
): unknown {
  return draft && Object.prototype.hasOwnProperty.call(draft, key)
    ? draft[key]
    : fallback;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value)
    ? String(value)
    : "";
}

function definitionArray(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : fallback;
}

function concurrencyValue(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const limit = (value as Record<string, unknown>).max_concurrent_executions;
  return numberValue(limit);
}

function editorValues(
  agent: DagAgent,
  draft: DraftAgent | undefined,
): EditorValues {
  const completeAgent = agent as WorkflowDagAgent;
  const definition = draft?.definition ?? completeAgent.definition;
  const definitionActor = Array.isArray(definition?.actor)
    ? definition.actor[0]
    : undefined;
  const actions = draftValue(draft, "actions", definition?.actions ?? []);
  const tools = draftValue(draft, "tool_use", definition?.tool_use);
  const inputs = draftValue(draft, "inputs", definition?.inputs);
  const outputs = draftValue(draft, "outputs", definition?.outputs);
  const actor = draftValue(draft, "actor", definitionActor ?? agent.actor);
  const triggers = draftValue(
    draft,
    "triggers",
    definitionArray(definition?.trigger, agent.triggers),
  );
  const emits = draftValue(
    draft,
    "emits",
    definitionArray(definition?.triggered_event, agent.emits),
  );
  return {
    name: stringValue(
      draftValue(draft, "name", stringValue(definition?.name) || agent.name),
    ),
    title: stringValue(
      draftValue(draft, "title", stringValue(definition?.title) || agent.title),
    ),
    description: stringValue(
      draftValue(
        draft,
        "description",
        definition?.description ?? completeAgent.description,
      ),
    ),
    actor: actor === "Human" ? "Human" : "Agent",
    stage: numberValue(
      draftValue(draft, "stage", definition?.stage ?? agent.stage),
    ),
    triggers: definitionArray(triggers, []).join(", "),
    emits: definitionArray(emits, []).join(", "),
    ontology_instructions: stringValue(
      draftValue(
        draft,
        "ontology_instructions",
        definition?.ontology_instructions,
      ),
    ),
    user_prompt_template: stringValue(
      draftValue(
        draft,
        "user_prompt_template",
        definition?.user_prompt_template,
      ),
    ),
    inputs:
      inputs == null
        ? ""
        : JSON.stringify(Array.isArray(inputs) ? inputs : [], null, 2),
    outputs:
      outputs == null
        ? ""
        : JSON.stringify(Array.isArray(outputs) ? outputs : [], null, 2),
    actions: JSON.stringify(Array.isArray(actions) ? actions : [], null, 2),
    tool_use:
      tools == null
        ? ""
        : JSON.stringify(Array.isArray(tools) ? tools : [], null, 2),
    provider: stringValue(draftValue(draft, "provider", definition?.provider)),
    model: stringValue(draftValue(draft, "model", definition?.model)),
    temperature: numberValue(
      draftValue(draft, "temperature", definition?.temperature),
    ),
    max_tokens: numberValue(
      draftValue(draft, "max_tokens", definition?.max_tokens),
    ),
    retries: numberValue(draftValue(draft, "retries", definition?.retries)),
    timeout_s: numberValue(
      draftValue(draft, "timeout_s", definition?.timeout_s),
    ),
    concurrency: concurrencyValue(
      draftValue(draft, "concurrency", definition?.concurrency),
    ),
  };
}

function EditorField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label style={{ display: "grid", gap: 5, marginBottom: 10 }}>
      <span
        style={{
          color: "var(--text-3)",
          fontFamily: "var(--mono)",
          fontSize: 10.5,
          letterSpacing: "0.05em",
          textTransform: "uppercase",
        }}
      >
        {label}
      </span>
      {children}
    </label>
  );
}

function ErrorText({ children }: { children: React.ReactNode }) {
  return (
    <div
      role="alert"
      style={{ marginTop: 6, color: "var(--red)", fontSize: 11 }}
    >
      {children}
    </div>
  );
}

const inputStyle = {
  width: "100%",
  padding: "6px 10px",
  fontSize: 12.5,
  fontFamily: "var(--sans)",
  background: "var(--bg-2)",
  color: "var(--text)",
  border: "1px solid var(--border-2)",
  borderRadius: 4,
};

const textareaStyle = {
  ...inputStyle,
  fontFamily: "var(--mono)",
  fontSize: 12,
  resize: "vertical" as const,
};

const jsonTextareaStyle = {
  ...textareaStyle,
  minHeight: 110,
  lineHeight: 1.45,
};

const fieldGridStyle = {
  display: "grid",
  gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
  gap: "0 10px",
};

const hintStyle = {
  marginTop: 6,
  color: "var(--text-3)",
  fontSize: 10.5,
};
