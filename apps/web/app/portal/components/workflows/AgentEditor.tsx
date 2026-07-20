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

import { useState, useEffect, useMemo, useRef } from "react";
import {
  AgentSpec as AgentSpecSchema,
  PROVIDER_IDS,
  REASONING_CONTEXTS,
  REASONING_EFFORTS,
  REASONING_MODES,
  REASONING_SUMMARIES,
  TEXT_VERBOSITIES,
  normalizeAgentDefinition,
  type AgentPromptProvenanceV2,
  type WorkflowAgentPromptBody,
} from "@agentic/contracts";
import { ActorTag, Badge, Button, MonacoEditor } from "@/app/portal/components";
import type { DagAgent } from "@/lib/hooks/useAgents";
import { useAvailableModels, useFleet } from "@/lib/hooks/useModelFleet";
import { useGenerateWorkflowAgentPrompt } from "@/lib/hooks/useWorkflowAuthoring";
import {
  CUSTOM_MODEL_OPTION,
  providerModelIds,
} from "@/app/portal/components/agent-studio/test-model-selector";
import { Section, type EventCatalogItem } from "./inspectors";
import {
  deriveEventEdges,
  patchAgentDefinition,
  type AgentActor,
  type CompleteAgentDefinition,
  type DraftAgent,
  type WorkflowDagAgent,
} from "./draft";

export interface AgentEditorProps {
  agent: DagAgent;
  workflowSlug?: string;
  events: EventCatalogItem[];
  /** All effective workflow agents, used to preview event-derived links. */
  workflowAgents: DagAgent[];
  /** Current draft for this agent (so the editor stays controlled across re-renders). */
  draft: DraftAgent | undefined;
  onChange: (next: DraftAgent) => void;
  /** Optional lossless callback for callers that store full definitions separately. */
  onDefinitionChange?: (next: CompleteAgentDefinition) => void;
  /** Reports local parse/range errors that have not been committed to the manifest. */
  onValidityChange?: (agentId: string, errors: string[]) => void;
  /** Expands or restores the in-canvas details panel. */
  onToggleWidth: () => void;
  /** Whether the details panel is currently using its expanded width. */
  isWide: boolean;
  /** False when the responsive layout already gives the panel full width. */
  canResize: boolean;
  onRemove: () => void;
  onClose: () => void;
}

export function AgentEditor({
  agent,
  workflowSlug,
  events,
  workflowAgents,
  draft,
  onChange,
  onDefinitionChange,
  onValidityChange,
  onToggleWidth,
  isWide,
  canResize,
  onRemove,
  onClose,
}: AgentEditorProps) {
  const [editorMode, setEditorMode] = useState<"guided" | "complete">("guided");
  const [values, setValues] = useState(() => editorValues(agent, draft));
  const [actionsError, setActionsError] = useState<string | null>(null);
  const [toolsError, setToolsError] = useState<string | null>(null);
  const [inputsError, setInputsError] = useState<string | null>(null);
  const [outputsError, setOutputsError] = useState<string | null>(null);
  const [definitionError, setDefinitionError] = useState<string | null>(null);
  const [numberErrors, setNumberErrors] = useState<Record<string, string>>({});
  const [promptMode, setPromptMode] =
    useState<WorkflowAgentPromptBody["mode"]>("improve");
  const [promptProposal, setPromptProposal] = useState<{
    instructions: string;
    provenance: AgentPromptProvenanceV2;
    sourceInstructions: string;
  } | null>(null);
  const [promptError, setPromptError] = useState<string | null>(null);
  const [manualModelEntry, setManualModelEntry] = useState(false);
  const definitionRef = useRef(resolvedDefinition(agent, draft));
  const [definitionText, setDefinitionText] = useState(() =>
    formatDefinition(resolvedDefinition(agent, draft)),
  );
  const draftRef = useRef(draft);
  const generatePrompt = useGenerateWorkflowAgentPrompt(
    workflowSlug,
    agent.kebabId,
  );
  const fleet = useFleet();
  const availableModels = useAvailableModels(values.provider);

  // When the agent changes (operator picks a different node), reset inputs.
  useEffect(() => {
    const definition = resolvedDefinition(agent, draft);
    setEditorMode("guided");
    setValues(editorValues(agent, draft));
    setActionsError(null);
    setToolsError(null);
    setInputsError(null);
    setOutputsError(null);
    setDefinitionError(null);
    setNumberErrors({});
    setPromptMode(
      definition?.ontology_instructions?.trim() ? "improve" : "generate",
    );
    setPromptProposal(null);
    setPromptError(null);
    setManualModelEntry(false);
    definitionRef.current = definition;
    setDefinitionText(formatDefinition(definition));
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
        definitionError,
        ...Object.values(numberErrors),
      ].filter((entry): entry is string => Boolean(entry)),
    );
  }, [
    actionsError,
    agent.kebabId,
    definitionError,
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
      setDefinitionText(formatDefinition(definition));
      onDefinitionChange?.(definition);
    }
    draftRef.current = sparse;
    onChange(sparse);
  }

  function commitDefinitionFields(partial: Record<string, unknown>) {
    const current = definitionRef.current;
    if (!current) return;
    const definition: Record<string, unknown> = { ...current };
    for (const [key, value] of Object.entries(partial)) {
      if (value === null || value === undefined || value === "") {
        delete definition[key];
      } else {
        definition[key] = value;
      }
    }
    definition.id = agent.kebabId;
    const complete = definition as CompleteAgentDefinition;
    const next: DraftAgent = {
      id: agent.kebabId,
      definition: complete,
    };
    definitionRef.current = complete;
    draftRef.current = next;
    setDefinitionText(formatDefinition(complete));
    setValues(editorValues(agent, next));
    onDefinitionChange?.(complete);
    onChange(next);
  }

  function patchDefinitionObject(
    key: string,
    partial: Record<string, unknown>,
  ) {
    const currentValue = definitionRef.current?.[key];
    const next =
      currentValue &&
      typeof currentValue === "object" &&
      !Array.isArray(currentValue)
        ? { ...(currentValue as Record<string, unknown>) }
        : {};
    for (const [nestedKey, value] of Object.entries(partial)) {
      if (value === null || value === undefined || value === "") {
        delete next[nestedKey];
      } else {
        next[nestedKey] = value;
      }
    }
    commitDefinitionFields({
      [key]: Object.keys(next).length > 0 ? next : null,
    });
  }

  function patchOutputArtifact(partial: Record<string, unknown>) {
    const currentOutput = definitionRef.current?.output_config;
    const outputConfig =
      currentOutput &&
      typeof currentOutput === "object" &&
      !Array.isArray(currentOutput)
        ? { ...(currentOutput as Record<string, unknown>) }
        : {};
    const currentArtifact = outputConfig.artifact;
    const artifact =
      currentArtifact &&
      typeof currentArtifact === "object" &&
      !Array.isArray(currentArtifact)
        ? { ...(currentArtifact as Record<string, unknown>) }
        : {};
    for (const [key, value] of Object.entries(partial)) {
      if (value === null || value === undefined || value === "") {
        delete artifact[key];
      } else {
        artifact[key] = value;
      }
    }
    outputConfig.artifact = artifact;
    commitDefinitionFields({ output_config: outputConfig });
  }

  async function generatePromptProposal() {
    const definition = definitionRef.current;
    if (!definition || !workflowSlug) return;
    const sourceInstructions = values.ontology_instructions;
    setPromptError(null);
    try {
      const response = await generatePrompt.mutateAsync({
        definition: normalizeAgentDefinition(definition),
        mode: promptMode,
        instructions: sourceInstructions,
        ...(values.provider
          ? {
              provider: values.provider as WorkflowAgentPromptBody["provider"],
            }
          : {}),
        ...(values.model ? { model: values.model } : {}),
      });
      setPromptProposal({
        instructions: response.proposedInstructions,
        provenance: response.provenance,
        sourceInstructions,
      });
    } catch (error) {
      setPromptError(
        error instanceof Error ? error.message : "Prompt generation failed.",
      );
    }
  }

  function applyPromptProposal() {
    if (!promptProposal) return;
    commitDefinitionFields({
      ontology_instructions: promptProposal.instructions,
      prompt_provenance: promptProposal.provenance,
    });
    setPromptProposal(null);
    setPromptError(null);
    setPromptMode("improve");
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

  function changeCompleteDefinition(raw: string) {
    setDefinitionText(raw);
    try {
      const definition = parseCompleteAgentDefinition(raw, agent.kebabId);
      const next: DraftAgent = {
        id: agent.kebabId,
        definition,
      };
      setDefinitionError(null);
      setActionsError(null);
      setToolsError(null);
      setInputsError(null);
      setOutputsError(null);
      setNumberErrors({});
      definitionRef.current = definition;
      draftRef.current = next;
      setValues(editorValues(agent, next));
      onDefinitionChange?.(definition);
      onChange(next);
    } catch (error) {
      setDefinitionError(
        error instanceof Error
          ? error.message
          : "Agent definition must be valid JSON.",
      );
    }
  }

  function showGuidedEditor() {
    if (definitionError) {
      setDefinitionText(formatDefinition(definitionRef.current));
      setDefinitionError(null);
    }
    setEditorMode("guided");
  }

  function showCompleteEditor() {
    const currentDraft = draftRef.current ?? draft;
    const definition = resolvedDefinition(agent, currentDraft);
    definitionRef.current = definition;
    setDefinitionText(formatDefinition(definition));
    setDefinitionError(null);
    setActionsError(null);
    setToolsError(null);
    setInputsError(null);
    setOutputsError(null);
    setNumberErrors({});
    setValues(editorValues(agent, currentDraft));
    setEditorMode("complete");
  }

  const automaticLinks = useMemo(
    () =>
      summarizeAutomaticLinks(
        agent.kebabId,
        workflowAgents,
        parseList(values.triggers),
        parseList(values.emits),
      ),
    [agent.kebabId, values.emits, values.triggers, workflowAgents],
  );
  const currentDefinition = definitionRef.current;
  const reasoning = objectValue(currentDefinition?.reasoning);
  const concurrency = objectValue(currentDefinition?.concurrency);
  const toolLoop = objectValue(currentDefinition?.tool_loop);
  const observability = objectValue(currentDefinition?.observability);
  const outputConfig = objectValue(currentDefinition?.output_config);
  const artifactPolicy = objectValue(outputConfig.artifact);
  const discoveredModelIds = providerModelIds(
    values.provider,
    availableModels.data?.models ?? [],
  );
  const fleetModelIds = (fleet.data ?? [])
    .filter((entry) => !values.provider || entry.provider === values.provider)
    .map((entry) => entry.modelName);
  const selectableModelIds = Array.from(
    new Set([...discoveredModelIds, ...fleetModelIds].filter(Boolean)),
  ).sort((left, right) => left.localeCompare(right));
  const selectedModelOption =
    manualModelEntry ||
    (values.model && !selectableModelIds.includes(values.model))
      ? CUSTOM_MODEL_OPTION
      : values.model;
  const proposalIsStale =
    promptProposal !== null &&
    promptProposal.sourceInstructions !== values.ontology_instructions;

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
            <Badge tone="blue">FULL SETTINGS</Badge>
          </div>
          <div style={{ fontSize: 11, color: "var(--text-3)" }}>
            Changes stay local until you save the draft, then publish it
            explicitly.
            {canResize
              ? " Drag the panel edge or expand it for more room."
              : " The panel already uses the full available width."}
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

      <div
        role="group"
        aria-label="Agent settings view"
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 4,
          padding: "10px 16px",
          borderBottom: "1px solid var(--border)",
          background: "var(--panel)",
        }}
      >
        <EditorModeTab
          selected={editorMode === "guided"}
          onClick={showGuidedEditor}
        >
          Guided settings
        </EditorModeTab>
        <EditorModeTab
          selected={editorMode === "complete"}
          onClick={showCompleteEditor}
        >
          Complete definition · all settings
        </EditorModeTab>
      </div>

      {editorMode === "guided" ? (
        <>
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
              <EditorField label="Agent template">
                <select
                  value={stringValue(currentDefinition?.template)}
                  onChange={(event) =>
                    commitDefinitionFields({
                      template: event.target.value || null,
                    })
                  }
                  style={inputStyle}
                >
                  <option value="">Unspecified</option>
                  <option value="blank">Blank</option>
                  <option value="classify">Classify</option>
                  <option value="extract">Extract</option>
                  <option value="rag">RAG / knowledge</option>
                  <option value="loop">Loop</option>
                  <option value="human">Human review</option>
                </select>
              </EditorField>
              <EditorField label="Prompt ownership">
                <select
                  value={
                    typeof currentDefinition?.generated === "boolean"
                      ? String(currentDefinition.generated)
                      : ""
                  }
                  onChange={(event) =>
                    commitDefinitionFields({
                      generated:
                        event.target.value === ""
                          ? null
                          : event.target.value === "true",
                    })
                  }
                  style={inputStyle}
                >
                  <option value="">Inherit manifest behavior</option>
                  <option value="true">Manifest-generated prompt</option>
                  <option value="false">Tenant prompt registry</option>
                </select>
              </EditorField>
            </div>
            <EditorField label="Description">
              <textarea
                value={values.description}
                onChange={(event) => {
                  const description = event.target.value;
                  setValues((current) => ({ ...current, description }));
                  commit({
                    description: description === "" ? null : description,
                  });
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

          <AutomaticLinkSummary summary={automaticLinks} />

          <Section title="Instructions and prompts">
            <div style={{ marginBottom: 10 }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                  marginBottom: 5,
                  flexWrap: "wrap",
                }}
              >
                <span
                  style={{
                    color: "var(--text-3)",
                    fontFamily: "var(--mono)",
                    fontSize: 10.5,
                    letterSpacing: "0.05em",
                    textTransform: "uppercase",
                  }}
                >
                  System / ontology instructions
                </span>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    flexWrap: "wrap",
                  }}
                >
                  <select
                    aria-label="Prompt generation mode"
                    value={promptMode}
                    onChange={(event) =>
                      setPromptMode(
                        event.target.value as WorkflowAgentPromptBody["mode"],
                      )
                    }
                    style={{ ...inputStyle, width: "auto", minWidth: 142 }}
                  >
                    <option value="generate">Generate comprehensive</option>
                    <option value="improve">Improve / regenerate</option>
                    <option value="shorten">Shorten safely</option>
                    <option value="add_guardrails">Add guardrails</option>
                  </select>
                  <Button
                    small
                    icon="spark"
                    onClick={() => void generatePromptProposal()}
                    disabled={
                      generatePrompt.isPending ||
                      !workflowSlug ||
                      !currentDefinition
                    }
                  >
                    {generatePrompt.isPending
                      ? "Generating…"
                      : values.ontology_instructions.trim()
                        ? "Regenerate prompt"
                        : "Generate prompt"}
                  </Button>
                </div>
              </div>
              <textarea
                value={values.ontology_instructions}
                onChange={(event) => {
                  const ontology_instructions = event.target.value;
                  setValues((current) => ({
                    ...current,
                    ontology_instructions,
                  }));
                  commit({
                    ontology_instructions:
                      ontology_instructions === ""
                        ? null
                        : ontology_instructions,
                  });
                }}
                placeholder="Role, constraints, reasoning policy, output quality bar…"
                rows={7}
                style={textareaStyle}
              />
              <div style={hintStyle}>
                Generation uses the complete agent definition, selected
                provider/model, typed ports, tools, actions, and current
                ontology text. It returns a proposal and never overwrites this
                field automatically.
              </div>
              {promptError ? <ErrorText>{promptError}</ErrorText> : null}
            </div>
            {promptProposal ? (
              <div
                style={{
                  display: "grid",
                  gap: 9,
                  padding: 10,
                  marginBottom: 12,
                  background: "rgba(208,255,0,0.045)",
                  border: "1px solid rgba(208,255,0,0.26)",
                  borderRadius: 5,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 8,
                    flexWrap: "wrap",
                  }}
                >
                  <div>
                    <div
                      style={{
                        color: "var(--text)",
                        fontSize: 12,
                        fontWeight: 680,
                      }}
                    >
                      Generated prompt proposal
                    </div>
                    <div style={hintStyle}>
                      {promptProposal.provenance.provider ?? "default"} /{" "}
                      {promptProposal.provenance.model ?? "default"}
                      {promptProposal.provenance.tokens_in != null
                        ? ` · ${promptProposal.provenance.tokens_in} in / ${promptProposal.provenance.tokens_out ?? 0} out`
                        : ""}
                    </div>
                  </div>
                  <Badge tone={proposalIsStale ? "amber" : "green"}>
                    {proposalIsStale ? "SOURCE CHANGED" : "READY TO REVIEW"}
                  </Badge>
                </div>
                <textarea
                  aria-label="Generated prompt proposal"
                  value={promptProposal.instructions}
                  onChange={(event) =>
                    setPromptProposal((current) =>
                      current
                        ? { ...current, instructions: event.target.value }
                        : current,
                    )
                  }
                  rows={13}
                  style={textareaStyle}
                />
                {proposalIsStale ? (
                  <div
                    style={{
                      color: "var(--amber)",
                      fontSize: 11,
                      lineHeight: 1.45,
                    }}
                  >
                    The source instructions changed after this request began.
                    Regenerate, or review the proposal carefully before applying
                    it.
                  </div>
                ) : null}
                <div
                  style={{
                    display: "flex",
                    justifyContent: "flex-end",
                    gap: 7,
                  }}
                >
                  <Button
                    small
                    tone="ghost"
                    onClick={() => setPromptProposal(null)}
                  >
                    Discard
                  </Button>
                  <Button
                    small
                    icon="check"
                    tone="primary"
                    onClick={applyPromptProposal}
                    disabled={!promptProposal.instructions.trim()}
                  >
                    Apply proposal
                  </Button>
                </div>
              </div>
            ) : null}
            <EditorField label="User prompt template">
              <textarea
                value={values.user_prompt_template}
                onChange={(event) => {
                  const user_prompt_template = event.target.value;
                  setValues((current) => ({
                    ...current,
                    user_prompt_template,
                  }));
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
              Optional typed ports. Each port needs an id and JSON Schema;
              inputs also require kind (prompt, value, or file).
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
            <div style={hintStyle}>
              Leave blank to inherit no tool allow-list.
            </div>
          </Section>

          <Section title="Model selection">
            <div style={fieldGridStyle}>
              <EditorField label="Provider">
                <select
                  value={values.provider}
                  onChange={(event) => {
                    const provider = event.target.value;
                    setManualModelEntry(false);
                    setValues((current) => ({
                      ...current,
                      provider,
                      model: "",
                    }));
                    commitDefinitionFields({
                      provider: provider || null,
                      model: null,
                    });
                  }}
                  style={inputStyle}
                >
                  <option value="">Inherit gateway default</option>
                  {PROVIDER_IDS.map((provider) => (
                    <option key={provider} value={provider}>
                      {provider}
                    </option>
                  ))}
                </select>
              </EditorField>
              <EditorField label="Model">
                <select
                  value={selectedModelOption}
                  onChange={(event) => {
                    if (event.target.value === CUSTOM_MODEL_OPTION) {
                      setManualModelEntry(true);
                      if (selectableModelIds.includes(values.model)) {
                        setValues((current) => ({ ...current, model: "" }));
                        commitDefinitionFields({ model: null });
                      }
                      return;
                    }
                    setManualModelEntry(false);
                    const model = event.target.value;
                    setValues((current) => ({ ...current, model }));
                    commitDefinitionFields({ model: model || null });
                  }}
                  style={inputStyle}
                  disabled={
                    Boolean(values.provider) &&
                    availableModels.isLoading &&
                    selectableModelIds.length === 0
                  }
                >
                  <option value="">
                    {values.provider
                      ? "Inherit provider default"
                      : "Inherit workspace model"}
                  </option>
                  {selectableModelIds.map((model) => (
                    <option key={model} value={model}>
                      {model}
                    </option>
                  ))}
                  <option value={CUSTOM_MODEL_OPTION}>
                    Enter a custom model ID…
                  </option>
                </select>
                {manualModelEntry ||
                (values.model && !selectableModelIds.includes(values.model)) ? (
                  <input
                    aria-label="Custom model ID"
                    value={values.model}
                    onChange={(event) => {
                      const model = event.target.value;
                      setValues((current) => ({ ...current, model }));
                      commitDefinitionFields({ model: model || null });
                    }}
                    placeholder={
                      values.provider
                        ? `Custom ${values.provider} model ID`
                        : "Custom workspace model ID"
                    }
                    style={{ ...inputStyle, marginTop: 6 }}
                  />
                ) : null}
                {availableModels.isError && values.provider ? (
                  <div style={{ ...hintStyle, color: "var(--amber)" }}>
                    Model discovery is unavailable; catalog and configured fleet
                    models remain selectable, or enter a custom ID.
                  </div>
                ) : null}
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
              <EditorField label="Concurrency enabled">
                <select
                  value={
                    typeof concurrency.enabled === "boolean"
                      ? String(concurrency.enabled)
                      : ""
                  }
                  onChange={(event) =>
                    patchDefinitionObject("concurrency", {
                      enabled:
                        event.target.value === ""
                          ? null
                          : event.target.value === "true",
                      max_concurrent_executions:
                        concurrency.max_concurrent_executions ?? 1,
                    })
                  }
                  style={inputStyle}
                >
                  <option value="">Inherit</option>
                  <option value="true">Enabled</option>
                  <option value="false">Disabled</option>
                </select>
              </EditorField>
              <EditorField label="Concurrency key">
                <input
                  value={stringValue(concurrency.key)}
                  onChange={(event) =>
                    patchDefinitionObject("concurrency", {
                      key: event.target.value || null,
                      max_concurrent_executions:
                        concurrency.max_concurrent_executions ?? 1,
                    })
                  }
                  placeholder="e.g. {{event.data.subject}}"
                  style={inputStyle}
                />
              </EditorField>
              <EditorField label="Response verbosity">
                <select
                  value={stringValue(currentDefinition?.verbosity)}
                  onChange={(event) =>
                    commitDefinitionFields({
                      verbosity: event.target.value || null,
                    })
                  }
                  style={inputStyle}
                >
                  <option value="">Provider default</option>
                  {TEXT_VERBOSITIES.map((verbosity) => (
                    <option key={verbosity} value={verbosity}>
                      {verbosity}
                    </option>
                  ))}
                </select>
              </EditorField>
              <EditorField label="Provider response storage">
                <select
                  value={
                    typeof currentDefinition?.store === "boolean"
                      ? String(currentDefinition.store)
                      : ""
                  }
                  onChange={(event) =>
                    commitDefinitionFields({
                      store:
                        event.target.value === ""
                          ? null
                          : event.target.value === "true",
                    })
                  }
                  style={inputStyle}
                >
                  <option value="">Provider default</option>
                  <option value="true">Allow provider storage</option>
                  <option value="false">Do not store</option>
                </select>
              </EditorField>
            </div>
            <details style={advancedDetailsStyle}>
              <summary style={advancedSummaryStyle}>
                Reasoning, schedules, tool loop, and observability
              </summary>
              <div style={{ ...fieldGridStyle, marginTop: 11 }}>
                <EditorField label="Reasoning mode">
                  <select
                    value={stringValue(reasoning.mode)}
                    onChange={(event) =>
                      patchDefinitionObject("reasoning", {
                        mode: event.target.value || null,
                      })
                    }
                    style={inputStyle}
                  >
                    <option value="">Model default</option>
                    {REASONING_MODES.map((mode) => (
                      <option key={mode} value={mode}>
                        {mode}
                      </option>
                    ))}
                  </select>
                </EditorField>
                <EditorField label="Reasoning effort">
                  <select
                    value={stringValue(reasoning.effort)}
                    onChange={(event) =>
                      patchDefinitionObject("reasoning", {
                        effort: event.target.value || null,
                      })
                    }
                    style={inputStyle}
                  >
                    <option value="">Model default</option>
                    {REASONING_EFFORTS.map((effort) => (
                      <option key={effort} value={effort}>
                        {effort}
                      </option>
                    ))}
                  </select>
                </EditorField>
                <EditorField label="Reasoning summary">
                  <select
                    value={stringValue(reasoning.summary)}
                    onChange={(event) =>
                      patchDefinitionObject("reasoning", {
                        summary: event.target.value || null,
                      })
                    }
                    style={inputStyle}
                  >
                    <option value="">Model default</option>
                    {REASONING_SUMMARIES.map((summary) => (
                      <option key={summary} value={summary}>
                        {summary}
                      </option>
                    ))}
                  </select>
                </EditorField>
                <EditorField label="Reasoning context">
                  <select
                    value={stringValue(reasoning.context)}
                    onChange={(event) =>
                      patchDefinitionObject("reasoning", {
                        context: event.target.value || null,
                      })
                    }
                    style={inputStyle}
                  >
                    <option value="">Model default</option>
                    {REASONING_CONTEXTS.map((context) => (
                      <option key={context} value={context}>
                        {context}
                      </option>
                    ))}
                  </select>
                </EditorField>
                <EditorField label="Tool-loop max iterations">
                  <input
                    type="number"
                    min={1}
                    max={100}
                    step={1}
                    value={numberValue(toolLoop.max_iterations)}
                    onChange={(event) => {
                      const value = event.target.value;
                      patchDefinitionObject("tool_loop", {
                        max_iterations: value ? Number(value) : null,
                      });
                    }}
                    placeholder="8"
                    style={inputStyle}
                  />
                </EditorField>
                <EditorField label="Cron schedule">
                  <input
                    value={stringValue(currentDefinition?.cron)}
                    onChange={(event) =>
                      commitDefinitionFields({
                        cron: event.target.value || null,
                      })
                    }
                    placeholder="0 9 * * 1-5"
                    style={inputStyle}
                  />
                </EditorField>
                <EditorField label="Cron timezone">
                  <input
                    value={stringValue(currentDefinition?.cron_timezone)}
                    onChange={(event) =>
                      commitDefinitionFields({
                        cron_timezone: event.target.value || null,
                      })
                    }
                    placeholder="Asia/Singapore"
                    style={inputStyle}
                  />
                </EditorField>
                <EditorField label="Trace level">
                  <select
                    value={stringValue(observability.trace_level)}
                    onChange={(event) =>
                      patchDefinitionObject("observability", {
                        trace_level: event.target.value || null,
                      })
                    }
                    style={inputStyle}
                  >
                    <option value="">Standard</option>
                    <option value="minimal">Minimal</option>
                    <option value="standard">Standard</option>
                    <option value="debug">Debug</option>
                  </select>
                </EditorField>
                <EditorField label="Reasoning summaries">
                  <select
                    value={
                      typeof observability.reasoning_summary === "boolean"
                        ? String(observability.reasoning_summary)
                        : ""
                    }
                    onChange={(event) =>
                      patchDefinitionObject("observability", {
                        reasoning_summary:
                          event.target.value === ""
                            ? null
                            : event.target.value === "true",
                      })
                    }
                    style={inputStyle}
                  >
                    <option value="">Default</option>
                    <option value="true">Capture</option>
                    <option value="false">Do not capture</option>
                  </select>
                </EditorField>
                <EditorField label="Persist rendered prompts">
                  <select
                    value={
                      typeof observability.persist_rendered_prompts ===
                      "boolean"
                        ? String(observability.persist_rendered_prompts)
                        : ""
                    }
                    onChange={(event) =>
                      patchDefinitionObject("observability", {
                        persist_rendered_prompts:
                          event.target.value === ""
                            ? null
                            : event.target.value === "true",
                      })
                    }
                    style={inputStyle}
                  >
                    <option value="">Default</option>
                    <option value="true">Persist</option>
                    <option value="false">Do not persist</option>
                  </select>
                </EditorField>
                <EditorField label="Trace retention (days)">
                  <input
                    type="number"
                    min={1}
                    max={3650}
                    step={1}
                    value={numberValue(observability.retention_days)}
                    onChange={(event) =>
                      patchDefinitionObject("observability", {
                        retention_days: event.target.value
                          ? Number(event.target.value)
                          : null,
                      })
                    }
                    placeholder="30"
                    style={inputStyle}
                  />
                </EditorField>
              </div>
            </details>
          </Section>

          <Section title="Output and artifact policy">
            <div style={fieldGridStyle}>
              <EditorField label="Strict JSON output">
                <select
                  value={
                    typeof outputConfig.strict === "boolean"
                      ? String(outputConfig.strict)
                      : ""
                  }
                  onChange={(event) =>
                    patchDefinitionObject("output_config", {
                      strict:
                        event.target.value === ""
                          ? null
                          : event.target.value === "true",
                    })
                  }
                  style={inputStyle}
                >
                  <option value="">Default</option>
                  <option value="true">Strict</option>
                  <option value="false">Best effort</option>
                </select>
              </EditorField>
              <EditorField label="Output repair attempts">
                <input
                  type="number"
                  min={0}
                  max={3}
                  step={1}
                  value={numberValue(outputConfig.repair_attempts)}
                  onChange={(event) =>
                    patchDefinitionObject("output_config", {
                      repair_attempts: event.target.value
                        ? Number(event.target.value)
                        : null,
                    })
                  }
                  placeholder="1"
                  style={inputStyle}
                />
              </EditorField>
              <EditorField label="Unwrap single output">
                <select
                  value={
                    typeof outputConfig.unwrap_single_output === "boolean"
                      ? String(outputConfig.unwrap_single_output)
                      : ""
                  }
                  onChange={(event) =>
                    patchDefinitionObject("output_config", {
                      unwrap_single_output:
                        event.target.value === ""
                          ? null
                          : event.target.value === "true",
                    })
                  }
                  style={inputStyle}
                >
                  <option value="">Default</option>
                  <option value="true">Return the single value</option>
                  <option value="false">Return keyed object</option>
                </select>
              </EditorField>
              <EditorField label="Artifact filename">
                <input
                  value={stringValue(artifactPolicy.filename)}
                  onChange={(event) =>
                    patchOutputArtifact({
                      filename: event.target.value || null,
                    })
                  }
                  placeholder="output.json"
                  style={inputStyle}
                />
              </EditorField>
              <EditorField label="Persist individual outputs">
                <select
                  value={
                    typeof artifactPolicy.persist_individual_outputs ===
                    "boolean"
                      ? String(artifactPolicy.persist_individual_outputs)
                      : ""
                  }
                  onChange={(event) =>
                    patchOutputArtifact({
                      persist_individual_outputs:
                        event.target.value === ""
                          ? null
                          : event.target.value === "true",
                    })
                  }
                  style={inputStyle}
                >
                  <option value="">Default</option>
                  <option value="true">Persist each output</option>
                  <option value="false">Aggregate only</option>
                </select>
              </EditorField>
              <EditorField label="Persist raw provider response">
                <select
                  value={
                    typeof artifactPolicy.persist_raw_response === "boolean"
                      ? String(artifactPolicy.persist_raw_response)
                      : ""
                  }
                  onChange={(event) =>
                    patchOutputArtifact({
                      persist_raw_response:
                        event.target.value === ""
                          ? null
                          : event.target.value === "true",
                    })
                  }
                  style={inputStyle}
                >
                  <option value="">Default</option>
                  <option value="true">Persist raw response</option>
                  <option value="false">Validated output only</option>
                </select>
              </EditorField>
            </div>
            <div style={hintStyle}>
              Trigger bindings, output bindings, input data, TypeScript code,
              extension fields, and every action-level override remain
              losslessly editable in Complete definition · all settings.
            </div>
          </Section>
        </>
      ) : (
        <section
          aria-label="Complete agent definition JSON"
          style={{
            padding: 16,
            display: "grid",
            gap: 10,
            flex: "1 0 auto",
            alignContent: "start",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "flex-start",
              justifyContent: "space-between",
              gap: 12,
              flexWrap: "wrap",
            }}
          >
            <div>
              <div
                style={{
                  color: "var(--text)",
                  fontSize: 12.5,
                  fontWeight: 650,
                }}
              >
                Complete manifest definition
              </div>
              <div style={{ ...hintStyle, maxWidth: 680, lineHeight: 1.5 }}>
                Every saved and extension field is shown here. Valid JSON is
                applied immediately to this workflow draft; invalid edits stay
                local and cannot be saved.
              </div>
            </div>
            <Badge tone={definitionError ? "red" : "green"}>
              {definitionError ? "INVALID JSON" : "VALID DEFINITION"}
            </Badge>
          </div>
          <MonacoEditor
            value={definitionText}
            onChange={changeCompleteDefinition}
            language="json"
            height={isWide ? "calc(100vh - 300px)" : 580}
            minHeight={420}
          />
          {definitionError ? <ErrorText>{definitionError}</ErrorText> : null}
          <div style={hintStyle}>
            The agent id must remain <code>{agent.kebabId}</code>. Guided fields
            and Complete JSON edit the same in-memory workflow definition.
          </div>
        </section>
      )}

      <div
        style={{
          padding: 14,
          marginTop: "auto",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 8,
          borderTop: "1px solid var(--border)",
          background: "var(--panel)",
          position: "sticky",
          bottom: 0,
          zIndex: "var(--z-overlay)",
        }}
      >
        <Button icon="x" tone="danger" onClick={onRemove}>
          Remove node
        </Button>
        {canResize ? (
          <Button
            icon={isWide ? "chevron-right" : "chevron-left"}
            tone="primary"
            onClick={onToggleWidth}
            ariaLabel={
              isWide
                ? "Restore standard agent details width"
                : "Expand agent details panel"
            }
            title={
              isWide
                ? "Restore the standard details width"
                : "Expand the details panel to show more settings"
            }
            style={{ flex: "1 1 170px", justifyContent: "center" }}
          >
            {isWide ? "Restore panel" : "Expand details"}
          </Button>
        ) : (
          <span style={{ color: "var(--text-3)", fontSize: 11 }}>
            Full width on this screen
          </span>
        )}
      </div>
    </div>
  );
}

function EditorModeTab({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      style={{
        minHeight: 34,
        padding: "7px 10px",
        color: selected ? "var(--text)" : "var(--text-2)",
        background: selected ? "var(--panel-2)" : "transparent",
        border: selected
          ? "1px solid var(--border-2)"
          : "1px solid transparent",
        borderRadius: 5,
        fontSize: 11.5,
        fontWeight: selected ? 650 : 500,
        cursor: "pointer",
      }}
    >
      {children}
    </button>
  );
}

export interface AutomaticAgentLink {
  event: string;
  agentId: string;
  agentTitle: string;
}

export interface AutomaticLinkSummaryData {
  incoming: AutomaticAgentLink[];
  outgoing: AutomaticAgentLink[];
  unmatchedTriggers: string[];
  unmatchedEmits: string[];
  hasWorkflowContext: boolean;
}

/** Pure event-link projection used by the inspector and unit tests. */
export function summarizeAutomaticLinks(
  agentId: string,
  workflowAgents: DagAgent[],
  currentTriggers: string[],
  currentEmits: string[],
): AutomaticLinkSummaryData {
  if (workflowAgents.length === 0) {
    return {
      incoming: [],
      outgoing: [],
      unmatchedTriggers: currentTriggers,
      unmatchedEmits: currentEmits,
      hasWorkflowContext: false,
    };
  }

  const effectiveAgents = workflowAgents.map((candidate) =>
    candidate.kebabId === agentId
      ? {
          ...candidate,
          triggers: currentTriggers,
          emits: currentEmits,
        }
      : candidate,
  );
  const labels = new Map(
    effectiveAgents.map((candidate) => [
      candidate.kebabId,
      candidate.title || candidate.name || candidate.kebabId,
    ]),
  );
  const edges = deriveEventEdges(effectiveAgents);
  const incoming = edges
    .filter((edge) => edge.dst === agentId)
    .map((edge) => ({
      event: edge.event,
      agentId: edge.src,
      agentTitle: labels.get(edge.src) ?? edge.src,
    }));
  const outgoing = edges
    .filter((edge) => edge.src === agentId)
    .map((edge) => ({
      event: edge.event,
      agentId: edge.dst,
      agentTitle: labels.get(edge.dst) ?? edge.dst,
    }));
  const matchedTriggers = new Set(incoming.map((link) => link.event));
  const matchedEmits = new Set(outgoing.map((link) => link.event));

  return {
    incoming,
    outgoing,
    unmatchedTriggers: parseList(currentTriggers.join(",")).filter(
      (event) => !matchedTriggers.has(event),
    ),
    unmatchedEmits: parseList(currentEmits.join(",")).filter(
      (event) => !matchedEmits.has(event),
    ),
    hasWorkflowContext: true,
  };
}

function AutomaticLinkSummary({
  summary,
}: {
  summary: AutomaticLinkSummaryData;
}) {
  const activeCount = summary.incoming.length + summary.outgoing.length;
  return (
    <Section title="Automatic canvas links">
      <div
        aria-live="polite"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
          marginBottom: 9,
        }}
      >
        <span style={{ color: "var(--text-2)", fontSize: 11.5 }}>
          Matching emitted and triggered event names draw links immediately.
        </span>
        <Badge tone={activeCount > 0 ? "green" : "muted"}>
          {activeCount} active
        </Badge>
      </div>

      {!summary.hasWorkflowContext ? (
        <div style={hintStyle}>
          Workflow context is loading. Event names will connect automatically as
          soon as the canvas is ready.
        </div>
      ) : (
        <div style={{ display: "grid", gap: 7 }}>
          {summary.incoming.map((link) => (
            <AutomaticLinkRow
              key={`in-${link.agentId}-${link.event}`}
              direction="From"
              link={link}
            />
          ))}
          {summary.outgoing.map((link) => (
            <AutomaticLinkRow
              key={`out-${link.agentId}-${link.event}`}
              direction="To"
              link={link}
            />
          ))}
          {summary.unmatchedTriggers.map((event) => (
            <div key={`trigger-${event}`} style={linkRowStyle}>
              <Badge tone="blue">{event}</Badge>
              <span style={{ color: "var(--text-3)", fontSize: 11 }}>
                External or manual trigger — no upstream agent emits it yet.
              </span>
            </div>
          ))}
          {summary.unmatchedEmits.map((event) => (
            <div key={`emit-${event}`} style={linkRowStyle}>
              <Badge tone="amber">{event}</Badge>
              <span style={{ color: "var(--text-3)", fontSize: 11 }}>
                No downstream agent listens for this event yet.
              </span>
            </div>
          ))}
          {activeCount === 0 &&
          summary.unmatchedTriggers.length === 0 &&
          summary.unmatchedEmits.length === 0 ? (
            <div style={hintStyle}>
              Add a triggered-by or emitted event to create a workflow
              relationship.
            </div>
          ) : null}
        </div>
      )}
    </Section>
  );
}

function AutomaticLinkRow({
  direction,
  link,
}: {
  direction: "From" | "To";
  link: AutomaticAgentLink;
}) {
  return (
    <div style={linkRowStyle}>
      <Badge tone="green">{link.event}</Badge>
      <span style={{ color: "var(--text-2)", fontSize: 11 }}>
        {direction}{" "}
        <strong style={{ color: "var(--text)" }}>{link.agentTitle}</strong>
      </span>
    </div>
  );
}

const linkRowStyle = {
  display: "flex",
  alignItems: "center",
  flexWrap: "wrap" as const,
  gap: 7,
  minHeight: 26,
  padding: "4px 6px",
  background: "var(--panel-2)",
  border: "1px solid var(--border)",
  borderRadius: 4,
};

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

/** Parse and validate a lossless complete manifest definition. */
export function parseCompleteAgentDefinition(
  value: string,
  expectedId: string,
): CompleteAgentDefinition {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Agent definition must be valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Agent definition must be a JSON object.");
  }

  const result = AgentSpecSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue?.path.length
      ? ` at ${issue.path.map(String).join(".")}`
      : "";
    throw new Error(
      `Agent definition is invalid${path}: ${issue?.message ?? "check every required field."}`,
    );
  }
  if (result.data.id !== expectedId) {
    throw new Error(`Agent id must remain "${expectedId}".`);
  }
  // Validate with the shared schema, but retain the original object so
  // passthrough extension fields and intentionally omitted defaults are not
  // normalized or stripped by Zod.
  return parsed as CompleteAgentDefinition;
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

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
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

function resolvedDefinition(
  agent: DagAgent,
  draft: DraftAgent | undefined,
): CompleteAgentDefinition | undefined {
  const source = draft?.definition ?? (agent as WorkflowDagAgent).definition;
  if (!source) return undefined;
  return draft
    ? patchAgentDefinition(source, {
        ...draft,
        id: agent.kebabId,
      })
    : source;
}

function formatDefinition(
  definition: CompleteAgentDefinition | undefined,
): string {
  return JSON.stringify(definition ?? {}, null, 2);
}

function editorValues(
  agent: DagAgent,
  draft: DraftAgent | undefined,
): EditorValues {
  const completeAgent = agent as WorkflowDagAgent;
  const definition = resolvedDefinition(agent, draft);
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

const advancedDetailsStyle = {
  marginTop: 4,
  padding: "9px 10px",
  background: "var(--panel-2)",
  border: "1px solid var(--border)",
  borderRadius: 5,
};

const advancedSummaryStyle = {
  color: "var(--text-2)",
  fontFamily: "var(--mono)",
  fontSize: 10.5,
  cursor: "pointer",
};
