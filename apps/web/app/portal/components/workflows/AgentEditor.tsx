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
import { useI18n, type Translate } from "@/app/portal/lib/preferences-context";
import {
  formatWorkflowAuthoringError,
  useGenerateWorkflowAgentPrompt,
} from "@/lib/hooks/useWorkflowAuthoring";
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
  const { t } = useI18n();
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
        error instanceof Error
          ? formatWorkflowAuthoringError(error, t)
          : t("agentEditor.promptGenerationFailed"),
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
    const message = validateNumberInput(
      raw,
      labelForNumber(key, t),
      options,
      t,
    );
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
          ? t("agentEditor.actions")
          : key === "tool_use"
            ? t("agentEditor.tools")
            : key === "inputs"
              ? t("agentEditor.inputs")
              : t("agentEditor.outputs");
      const parsed =
        key === "inputs" || key === "outputs"
          ? parseTypedPorts(raw, label, key, t)
          : parseJsonArray(raw, label, t);
      setError(null);
      commit({ [key]: parsed });
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : t("agentEditor.invalidJsonArray"),
      );
    }
  }

  function changeCompleteDefinition(raw: string) {
    setDefinitionText(raw);
    try {
      const definition = parseCompleteAgentDefinition(raw, agent.kebabId, t);
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
          : t("agentEditor.definitionValidJson"),
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
            <ActorTag
              actor={values.actor}
              label={t(
                values.actor === "Agent"
                  ? "common.actorAgent"
                  : "common.actorHuman",
              )}
            />
            <Badge tone="muted">{agent.kebabId}</Badge>
            <Badge tone="amber">{t("agentEditor.editBadge")}</Badge>
            <Badge tone="blue">{t("agentEditor.fullSettingsBadge")}</Badge>
          </div>
          <div style={{ fontSize: 11, color: "var(--text-3)" }}>
            {t("agentEditor.localChangesHint")}
            {canResize
              ? t("agentEditor.resizeHint")
              : t("agentEditor.fullWidthHint")}
          </div>
        </div>
        <Button
          small
          icon="x"
          tone="ghost"
          onClick={onClose}
          ariaLabel={t("agentEditor.close")}
        />
      </header>

      <div
        role="group"
        aria-label={t("agentEditor.settingsViewAria")}
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
          {t("agentEditor.guidedSettings")}
        </EditorModeTab>
        <EditorModeTab
          selected={editorMode === "complete"}
          onClick={showCompleteEditor}
        >
          {t("agentEditor.completeSettings")}
        </EditorModeTab>
      </div>

      {editorMode === "guided" ? (
        <>
          <Section title={t("agentEditor.identity")}>
            <div style={fieldGridStyle}>
              <EditorField label={t("agentEditor.name")}>
                <input
                  value={values.name}
                  onChange={(event) => {
                    const name = event.target.value;
                    setValues((current) => ({ ...current, name }));
                    commit({ name });
                  }}
                  placeholder={t("agentEditor.namePlaceholder")}
                  style={inputStyle}
                />
              </EditorField>
              <EditorField label={t("agentEditor.titleSection")}>
                <input
                  value={values.title}
                  onChange={(event) => {
                    const title = event.target.value;
                    setValues((current) => ({ ...current, title }));
                    commit({ title });
                  }}
                  placeholder={t("agentEditor.titlePlaceholder")}
                  style={inputStyle}
                />
              </EditorField>
              <EditorField label={t("agentEditor.actor")}>
                <select
                  value={values.actor}
                  onChange={(event) => {
                    const actor = event.target.value as AgentActor;
                    setValues((current) => ({ ...current, actor }));
                    commit({ actor });
                  }}
                  style={inputStyle}
                >
                  <option value="Agent">
                    {t("agentEditor.automatedAgent")}
                  </option>
                  <option value="Human">{t("agentEditor.humanTask")}</option>
                </select>
              </EditorField>
              <EditorField label={t("agentEditor.stage")}>
                <input
                  type="number"
                  min={0}
                  step={1}
                  value={values.stage}
                  onChange={(event) => {
                    const stage = event.target.value;
                    setValues((current) => ({ ...current, stage }));
                    const stageError = validateNumberInput(
                      stage,
                      t("agentEditor.stage"),
                      {
                        integer: true,
                        min: 0,
                        required: true,
                      },
                      t,
                    );
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
              <EditorField label={t("agentEditor.agentTemplate")}>
                <select
                  value={stringValue(currentDefinition?.template)}
                  onChange={(event) =>
                    commitDefinitionFields({
                      template: event.target.value || null,
                    })
                  }
                  style={inputStyle}
                >
                  <option value="">{t("agentEditor.unspecified")}</option>
                  <option value="blank">
                    {t("agentEditor.templateBlank")}
                  </option>
                  <option value="classify">
                    {t("agentEditor.templateClassify")}
                  </option>
                  <option value="extract">
                    {t("agentEditor.templateExtract")}
                  </option>
                  <option value="rag">{t("agentEditor.templateRag")}</option>
                  <option value="loop">{t("agentEditor.templateLoop")}</option>
                  <option value="human">
                    {t("agentEditor.templateHuman")}
                  </option>
                </select>
              </EditorField>
              <EditorField label={t("agentEditor.promptOwnership")}>
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
                  <option value="">
                    {t("agentEditor.inheritManifestBehavior")}
                  </option>
                  <option value="true">
                    {t("agentEditor.manifestGeneratedPrompt")}
                  </option>
                  <option value="false">
                    {t("agentEditor.tenantPromptRegistry")}
                  </option>
                </select>
              </EditorField>
            </div>
            <EditorField label={t("agentEditor.description")}>
              <textarea
                value={values.description}
                onChange={(event) => {
                  const description = event.target.value;
                  setValues((current) => ({ ...current, description }));
                  commit({
                    description: description === "" ? null : description,
                  });
                }}
                placeholder={t("agentEditor.descriptionPlaceholder")}
                rows={3}
                style={textareaStyle}
              />
            </EditorField>
          </Section>

          <Section title={t("agentEditor.triggeredBySection")}>
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
            <EventDictHint
              events={events}
              prefix={t("agentEditor.available")}
            />
          </Section>

          <Section title={t("agentEditor.triggeredEventSection")}>
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
            <EventDictHint
              events={events}
              prefix={t("agentEditor.available")}
            />
          </Section>

          <AutomaticLinkSummary summary={automaticLinks} />

          <Section title={t("agentEditor.instructionsPrompts")}>
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
                  {t("agentEditor.systemOntologyInstructions")}
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
                    aria-label={t("agentEditor.promptModeAria")}
                    value={promptMode}
                    onChange={(event) =>
                      setPromptMode(
                        event.target.value as WorkflowAgentPromptBody["mode"],
                      )
                    }
                    style={{ ...inputStyle, width: "auto", minWidth: 142 }}
                  >
                    <option value="generate">
                      {t("agentEditor.promptModeGenerate")}
                    </option>
                    <option value="improve">
                      {t("agentEditor.promptModeImprove")}
                    </option>
                    <option value="shorten">
                      {t("agentEditor.promptModeShorten")}
                    </option>
                    <option value="add_guardrails">
                      {t("agentEditor.promptModeGuardrails")}
                    </option>
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
                      ? t("agentEditor.generating")
                      : values.ontology_instructions.trim()
                        ? t("agentEditor.regeneratePrompt")
                        : t("agentEditor.generatePrompt")}
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
                placeholder={t("agentEditor.ontologyPlaceholder")}
                rows={7}
                style={textareaStyle}
              />
              <div style={hintStyle}>{t("agentEditor.generationHelp")}</div>
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
                      {t("agentEditor.generatedProposal")}
                    </div>
                    <div style={hintStyle}>
                      {promptProposal.provenance.provider ??
                        t("agentEditor.defaultValue")}{" "}
                      /{" "}
                      {promptProposal.provenance.model ??
                        t("agentEditor.defaultValue")}
                      {promptProposal.provenance.tokens_in != null
                        ? t("agentEditor.tokenUsage", {
                            input: promptProposal.provenance.tokens_in,
                            output: promptProposal.provenance.tokens_out ?? 0,
                          })
                        : ""}
                    </div>
                  </div>
                  <Badge tone={proposalIsStale ? "amber" : "green"}>
                    {proposalIsStale
                      ? t("agentEditor.sourceChanged")
                      : t("agentEditor.readyToReview")}
                  </Badge>
                </div>
                <textarea
                  aria-label={t("agentEditor.generatedProposalAria")}
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
                    {t("agentEditor.staleProposalHelp")}
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
                    {t("agentEditor.discard")}
                  </Button>
                  <Button
                    small
                    icon="check"
                    tone="primary"
                    onClick={applyPromptProposal}
                    disabled={!promptProposal.instructions.trim()}
                  >
                    {t("agentEditor.applyProposal")}
                  </Button>
                </div>
              </div>
            ) : null}
            <EditorField label={t("agentEditor.userPromptTemplate")}>
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
                placeholder={t("agentEditor.userPromptPlaceholder")}
                rows={6}
                style={textareaStyle}
              />
            </EditorField>
          </Section>

          <Section title={t("agentEditor.typedInputsOutputs")}>
            <EditorField label={t("agentEditor.inputsJson")}>
              <textarea
                aria-label={t("agentEditor.inputsJsonAria")}
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
            <EditorField label={t("agentEditor.outputsJson")}>
              <textarea
                aria-label={t("agentEditor.outputsJsonAria")}
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
            <div style={hintStyle}>{t("agentEditor.typedPortsHelp")}</div>
          </Section>

          <Section title={t("agentEditor.actions")}>
            <textarea
              aria-label={t("agentEditor.actionsJsonAria")}
              value={values.actions}
              onChange={(event) =>
                changeJson("actions", event.target.value, setActionsError)
              }
              rows={12}
              spellCheck={false}
              style={jsonTextareaStyle}
            />
            {actionsError ? <ErrorText>{actionsError}</ErrorText> : null}
            <div style={hintStyle}>{t("agentEditor.jsonArrayHelp")}</div>
          </Section>

          <Section title={t("agentEditor.tools")}>
            <textarea
              aria-label={t("agentEditor.toolUseJsonAria")}
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
            <div style={hintStyle}>{t("agentEditor.toolsHelp")}</div>
          </Section>

          <Section title={t("agentEditor.modelSelection")}>
            <div style={fieldGridStyle}>
              <EditorField label={t("agentEditor.provider")}>
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
                  <option value="">
                    {t("agentEditor.inheritGatewayDefault")}
                  </option>
                  {PROVIDER_IDS.map((provider) => (
                    <option key={provider} value={provider}>
                      {provider}
                    </option>
                  ))}
                </select>
              </EditorField>
              <EditorField label={t("agentEditor.model")}>
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
                      ? t("agentEditor.inheritProviderDefault")
                      : t("agentEditor.inheritWorkspaceModel")}
                  </option>
                  {selectableModelIds.map((model) => (
                    <option key={model} value={model}>
                      {model}
                    </option>
                  ))}
                  <option value={CUSTOM_MODEL_OPTION}>
                    {t("agentEditor.customModelOption")}
                  </option>
                </select>
                {manualModelEntry ||
                (values.model && !selectableModelIds.includes(values.model)) ? (
                  <input
                    aria-label={t("agentEditor.customModelAria")}
                    value={values.model}
                    onChange={(event) => {
                      const model = event.target.value;
                      setValues((current) => ({ ...current, model }));
                      commitDefinitionFields({ model: model || null });
                    }}
                    placeholder={
                      values.provider
                        ? t("agentEditor.customProviderModelPlaceholder", {
                            provider: values.provider,
                          })
                        : t("agentEditor.customWorkspaceModelPlaceholder")
                    }
                    style={{ ...inputStyle, marginTop: 6 }}
                  />
                ) : null}
                {availableModels.isError && values.provider ? (
                  <div style={{ ...hintStyle, color: "var(--amber)" }}>
                    {t("agentEditor.modelDiscoveryUnavailable")}
                  </div>
                ) : null}
              </EditorField>
            </div>
          </Section>

          <Section title={t("agentEditor.runtimeControls")}>
            <div style={fieldGridStyle}>
              <EditorField label={t("agentEditor.temperature")}>
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
                  placeholder={t("agentEditor.defaultValue")}
                  style={inputStyle}
                />
                {numberErrors.temperature ? (
                  <ErrorText>{numberErrors.temperature}</ErrorText>
                ) : null}
              </EditorField>
              <EditorField label={t("agentEditor.maxTokens")}>
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
                  placeholder={t("agentEditor.defaultValue")}
                  style={inputStyle}
                />
                {numberErrors.max_tokens ? (
                  <ErrorText>{numberErrors.max_tokens}</ErrorText>
                ) : null}
              </EditorField>
              <EditorField label={t("agentEditor.retries")}>
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
                  placeholder={t("agentEditor.defaultValue")}
                  style={inputStyle}
                />
                {numberErrors.retries ? (
                  <ErrorText>{numberErrors.retries}</ErrorText>
                ) : null}
              </EditorField>
              <EditorField label={t("agentEditor.timeoutSeconds")}>
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
                  placeholder={t("agentEditor.defaultValue")}
                  style={inputStyle}
                />
                {numberErrors.timeout_s ? (
                  <ErrorText>{numberErrors.timeout_s}</ErrorText>
                ) : null}
              </EditorField>
              <EditorField label={t("agentEditor.concurrencyLimit")}>
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
                      t("agentEditor.concurrencyLimit"),
                      { integer: true, min: 1 },
                      t,
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
                  placeholder={t("agentEditor.defaultValue")}
                  style={inputStyle}
                />
                {numberErrors.concurrency ? (
                  <ErrorText>{numberErrors.concurrency}</ErrorText>
                ) : null}
              </EditorField>
              <EditorField label={t("agentEditor.concurrencyEnabled")}>
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
                  <option value="">{t("agentEditor.inherit")}</option>
                  <option value="true">{t("agentEditor.enabled")}</option>
                  <option value="false">{t("agentEditor.disabled")}</option>
                </select>
              </EditorField>
              <EditorField label={t("agentEditor.concurrencyKey")}>
                <input
                  value={stringValue(concurrency.key)}
                  onChange={(event) =>
                    patchDefinitionObject("concurrency", {
                      key: event.target.value || null,
                      max_concurrent_executions:
                        concurrency.max_concurrent_executions ?? 1,
                    })
                  }
                  placeholder={t("agentEditor.concurrencyKeyPlaceholder")}
                  style={inputStyle}
                />
              </EditorField>
              <EditorField label={t("agentEditor.responseVerbosity")}>
                <select
                  value={stringValue(currentDefinition?.verbosity)}
                  onChange={(event) =>
                    commitDefinitionFields({
                      verbosity: event.target.value || null,
                    })
                  }
                  style={inputStyle}
                >
                  <option value="">{t("agentEditor.providerDefault")}</option>
                  {TEXT_VERBOSITIES.map((verbosity) => (
                    <option key={verbosity} value={verbosity}>
                      {verbosity}
                    </option>
                  ))}
                </select>
              </EditorField>
              <EditorField label={t("agentEditor.providerStorage")}>
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
                  <option value="">{t("agentEditor.providerDefault")}</option>
                  <option value="true">
                    {t("agentEditor.allowProviderStorage")}
                  </option>
                  <option value="false">{t("agentEditor.doNotStore")}</option>
                </select>
              </EditorField>
            </div>
            <details style={advancedDetailsStyle}>
              <summary style={advancedSummaryStyle}>
                {t("agentEditor.advancedRuntime")}
              </summary>
              <div style={{ ...fieldGridStyle, marginTop: 11 }}>
                <EditorField label={t("agentEditor.reasoningMode")}>
                  <select
                    value={stringValue(reasoning.mode)}
                    onChange={(event) =>
                      patchDefinitionObject("reasoning", {
                        mode: event.target.value || null,
                      })
                    }
                    style={inputStyle}
                  >
                    <option value="">{t("agentEditor.modelDefault")}</option>
                    {REASONING_MODES.map((mode) => (
                      <option key={mode} value={mode}>
                        {mode}
                      </option>
                    ))}
                  </select>
                </EditorField>
                <EditorField label={t("agentEditor.reasoningEffort")}>
                  <select
                    value={stringValue(reasoning.effort)}
                    onChange={(event) =>
                      patchDefinitionObject("reasoning", {
                        effort: event.target.value || null,
                      })
                    }
                    style={inputStyle}
                  >
                    <option value="">{t("agentEditor.modelDefault")}</option>
                    {REASONING_EFFORTS.map((effort) => (
                      <option key={effort} value={effort}>
                        {effort}
                      </option>
                    ))}
                  </select>
                </EditorField>
                <EditorField label={t("agentEditor.reasoningSummary")}>
                  <select
                    value={stringValue(reasoning.summary)}
                    onChange={(event) =>
                      patchDefinitionObject("reasoning", {
                        summary: event.target.value || null,
                      })
                    }
                    style={inputStyle}
                  >
                    <option value="">{t("agentEditor.modelDefault")}</option>
                    {REASONING_SUMMARIES.map((summary) => (
                      <option key={summary} value={summary}>
                        {summary}
                      </option>
                    ))}
                  </select>
                </EditorField>
                <EditorField label={t("agentEditor.reasoningContext")}>
                  <select
                    value={stringValue(reasoning.context)}
                    onChange={(event) =>
                      patchDefinitionObject("reasoning", {
                        context: event.target.value || null,
                      })
                    }
                    style={inputStyle}
                  >
                    <option value="">{t("agentEditor.modelDefault")}</option>
                    {REASONING_CONTEXTS.map((context) => (
                      <option key={context} value={context}>
                        {context}
                      </option>
                    ))}
                  </select>
                </EditorField>
                <EditorField label={t("agentEditor.toolLoopMax")}>
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
                <EditorField label={t("agentEditor.cronSchedule")}>
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
                <EditorField label={t("agentEditor.cronTimezone")}>
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
                <EditorField label={t("agentEditor.traceLevel")}>
                  <select
                    value={stringValue(observability.trace_level)}
                    onChange={(event) =>
                      patchDefinitionObject("observability", {
                        trace_level: event.target.value || null,
                      })
                    }
                    style={inputStyle}
                  >
                    <option value="">{t("agentEditor.standard")}</option>
                    <option value="minimal">{t("agentEditor.minimal")}</option>
                    <option value="standard">
                      {t("agentEditor.standard")}
                    </option>
                    <option value="debug">{t("agentEditor.debug")}</option>
                  </select>
                </EditorField>
                <EditorField label={t("agentEditor.reasoningSummaries")}>
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
                    <option value="">{t("agentEditor.defaultValue")}</option>
                    <option value="true">{t("agentEditor.capture")}</option>
                    <option value="false">
                      {t("agentEditor.doNotCapture")}
                    </option>
                  </select>
                </EditorField>
                <EditorField label={t("agentEditor.persistRenderedPrompts")}>
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
                    <option value="">{t("agentEditor.defaultValue")}</option>
                    <option value="true">{t("agentEditor.persist")}</option>
                    <option value="false">
                      {t("agentEditor.doNotPersist")}
                    </option>
                  </select>
                </EditorField>
                <EditorField label={t("agentEditor.traceRetention")}>
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

          <Section title={t("agentEditor.outputPolicy")}>
            <div style={fieldGridStyle}>
              <EditorField label={t("agentEditor.strictJsonOutput")}>
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
                  <option value="">{t("agentEditor.defaultValue")}</option>
                  <option value="true">{t("agentEditor.strict")}</option>
                  <option value="false">{t("agentEditor.bestEffort")}</option>
                </select>
              </EditorField>
              <EditorField label={t("agentEditor.outputRepairAttempts")}>
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
              <EditorField label={t("agentEditor.unwrapSingleOutput")}>
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
                  <option value="">{t("agentEditor.defaultValue")}</option>
                  <option value="true">
                    {t("agentEditor.returnSingleValue")}
                  </option>
                  <option value="false">
                    {t("agentEditor.returnKeyedObject")}
                  </option>
                </select>
              </EditorField>
              <EditorField label={t("agentEditor.artifactFilename")}>
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
              <EditorField label={t("agentEditor.persistIndividualOutputs")}>
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
                  <option value="">{t("agentEditor.defaultValue")}</option>
                  <option value="true">
                    {t("agentEditor.persistEachOutput")}
                  </option>
                  <option value="false">
                    {t("agentEditor.aggregateOnly")}
                  </option>
                </select>
              </EditorField>
              <EditorField label={t("agentEditor.persistRawResponse")}>
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
                  <option value="">{t("agentEditor.defaultValue")}</option>
                  <option value="true">
                    {t("agentEditor.persistRawResponseOption")}
                  </option>
                  <option value="false">
                    {t("agentEditor.validatedOutputOnly")}
                  </option>
                </select>
              </EditorField>
            </div>
            <div style={hintStyle}>{t("agentEditor.completeSettingsHelp")}</div>
          </Section>
        </>
      ) : (
        <section
          aria-label={t("agentEditor.completeJsonAria")}
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
                {t("agentEditor.completeManifestDefinition")}
              </div>
              <div style={{ ...hintStyle, maxWidth: 680, lineHeight: 1.5 }}>
                {t("agentEditor.completeManifestHelp")}
              </div>
            </div>
            <Badge tone={definitionError ? "red" : "green"}>
              {definitionError
                ? t("agentEditor.invalidJsonBadge")
                : t("agentEditor.validDefinitionBadge")}
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
            {t("agentEditor.idMustRemainBefore")} <code>{agent.kebabId}</code>.{" "}
            {t("agentEditor.idMustRemainAfter")}
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
          {t("agentEditor.removeNode")}
        </Button>
        {canResize ? (
          <Button
            icon={isWide ? "chevron-right" : "chevron-left"}
            tone="primary"
            onClick={onToggleWidth}
            ariaLabel={
              isWide
                ? t("agentEditor.restoreWidthAria")
                : t("agentEditor.expandWidthAria")
            }
            title={
              isWide
                ? t("agentEditor.restoreWidthTitle")
                : t("agentEditor.expandWidthTitle")
            }
            style={{ flex: "1 1 170px", justifyContent: "center" }}
          >
            {isWide
              ? t("agentEditor.restorePanel")
              : t("agentEditor.expandDetails")}
          </Button>
        ) : (
          <span style={{ color: "var(--text-3)", fontSize: 11 }}>
            {t("agentEditor.fullWidth")}
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
  const { t } = useI18n();
  const activeCount = summary.incoming.length + summary.outgoing.length;
  return (
    <Section title={t("agentEditor.automaticLinks")}>
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
          {t("agentEditor.automaticLinksHelp")}
        </span>
        <Badge tone={activeCount > 0 ? "green" : "muted"}>
          {t("agentEditor.activeLinks", { count: activeCount })}
        </Badge>
      </div>

      {!summary.hasWorkflowContext ? (
        <div style={hintStyle}>{t("agentEditor.workflowContextLoading")}</div>
      ) : (
        <div style={{ display: "grid", gap: 7 }}>
          {summary.incoming.map((link) => (
            <AutomaticLinkRow
              key={`in-${link.agentId}-${link.event}`}
              direction={t("agentEditor.from")}
              link={link}
            />
          ))}
          {summary.outgoing.map((link) => (
            <AutomaticLinkRow
              key={`out-${link.agentId}-${link.event}`}
              direction={t("agentEditor.to")}
              link={link}
            />
          ))}
          {summary.unmatchedTriggers.map((event) => (
            <div key={`trigger-${event}`} style={linkRowStyle}>
              <Badge tone="blue">{event}</Badge>
              <span style={{ color: "var(--text-3)", fontSize: 11 }}>
                {t("agentEditor.unmatchedTrigger")}
              </span>
            </div>
          ))}
          {summary.unmatchedEmits.map((event) => (
            <div key={`emit-${event}`} style={linkRowStyle}>
              <Badge tone="amber">{event}</Badge>
              <span style={{ color: "var(--text-3)", fontSize: 11 }}>
                {t("agentEditor.unmatchedEmit")}
              </span>
            </div>
          ))}
          {activeCount === 0 &&
          summary.unmatchedTriggers.length === 0 &&
          summary.unmatchedEmits.length === 0 ? (
            <div style={hintStyle}>{t("agentEditor.addEventRelationship")}</div>
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
  direction: string;
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
  const { t } = useI18n();
  if (events.length === 0) return null;
  return (
    <div style={{ marginTop: 6, fontSize: 10.5, color: "var(--text-3)" }}>
      {prefix}:{" "}
      {events
        .slice(0, 6)
        .map((e) => e.name)
        .join(", ")}
      {events.length > 6
        ? t("agentEditor.moreCount", { count: events.length - 6 })
        : ""}
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
  t?: Translate,
): CompleteAgentDefinition {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(
      t?.("agentEditor.definitionValidJson") ??
        "Agent definition must be valid JSON.",
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      t?.("agentEditor.definitionJsonObject") ??
        "Agent definition must be a JSON object.",
    );
  }

  const result = AgentSpecSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue?.path.length
      ? ` at ${issue.path.map(String).join(".")}`
      : "";
    const detail = issue?.message ?? "check every required field.";
    throw new Error(
      t?.("agentEditor.definitionInvalid", { path, detail }) ??
        `Agent definition is invalid${path}: ${detail}`,
    );
  }
  if (result.data.id !== expectedId) {
    throw new Error(
      t?.("agentEditor.idMustRemain", { id: expectedId }) ??
        `Agent id must remain "${expectedId}".`,
    );
  }
  // Validate with the shared schema, but retain the original object so
  // passthrough extension fields and intentionally omitted defaults are not
  // normalized or stripped by Zod.
  return parsed as CompleteAgentDefinition;
}

/** Parse and validate the free-form JSON editors without mutating the draft. */
export function parseJsonArray(
  value: string,
  label: string,
  t?: Translate,
): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(
      t?.("agentEditor.mustBeValidJson", { label }) ??
        `${label} must be valid JSON.`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(
      t?.("agentEditor.mustBeJsonArray", { label }) ??
        `${label} must be a JSON array.`,
    );
  }
  return parsed;
}

export function parseTypedPorts(
  value: string,
  label: string,
  kind: "inputs" | "outputs",
  t?: Translate,
): unknown[] {
  const ports = parseJsonArray(value, label, t);
  ports.forEach((port, index) => {
    if (!port || typeof port !== "object" || Array.isArray(port)) {
      throw new Error(
        t?.("agentEditor.portJsonObject", { label, index }) ??
          `${label}[${index}] must be a JSON object.`,
      );
    }
    const candidate = port as Record<string, unknown>;
    if (typeof candidate.id !== "string" || !candidate.id.trim()) {
      throw new Error(
        t?.("agentEditor.portIdRequired", { label, index }) ??
          `${label}[${index}].id is required.`,
      );
    }
    if (
      !candidate.schema ||
      typeof candidate.schema !== "object" ||
      Array.isArray(candidate.schema)
    ) {
      throw new Error(
        t?.("agentEditor.portSchemaObject", { label, index }) ??
          `${label}[${index}].schema must be a JSON object.`,
      );
    }
    if (
      kind === "inputs" &&
      !["prompt", "value", "file"].includes(String(candidate.kind))
    ) {
      throw new Error(
        t?.("agentEditor.portKind", { label, index }) ??
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
  t?: Translate,
): string | null {
  if (raw.trim() === "") {
    return options.required
      ? (t?.("agentEditor.numberRequired", { label }) ??
          `${label} is required.`)
      : null;
  }
  const number = Number(raw);
  if (!Number.isFinite(number)) {
    return (
      t?.("agentEditor.mustBeNumber", { label }) ?? `${label} must be a number.`
    );
  }
  if (options.integer && !Number.isInteger(number)) {
    return (
      t?.("agentEditor.mustBeWholeNumber", { label }) ??
      `${label} must be a whole number.`
    );
  }
  if (options.min !== undefined && number < options.min) {
    return (
      t?.("agentEditor.mustBeAtLeast", { label, min: options.min }) ??
      `${label} must be at least ${options.min}.`
    );
  }
  if (options.max !== undefined && number > options.max) {
    return (
      t?.("agentEditor.mustBeAtMost", { label, max: options.max }) ??
      `${label} must be at most ${options.max}.`
    );
  }
  return null;
}

function labelForNumber(
  key: "temperature" | "max_tokens" | "retries" | "timeout_s",
  t?: Translate,
): string {
  return {
    temperature: t?.("agentEditor.temperature") ?? "Temperature",
    max_tokens: t?.("agentEditor.maxTokens") ?? "Max tokens",
    retries: t?.("agentEditor.retries") ?? "Retries",
    timeout_s: t?.("agentEditor.timeout") ?? "Timeout",
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
