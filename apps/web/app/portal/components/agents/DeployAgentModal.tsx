"use client";

/**
 * DeployAgentModal — 6-step wizard for adding a new agent to the workflow.
 *
 * Live data via canonical TanStack hooks. Prompt generation and deployment
 * are server-backed; the prompt remains fully editable before deployment.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type {
  AgentModelSelection,
  DeployAuthoredAgentResponse,
} from "@agentic/contracts";
import {
  ActorTag,
  Badge,
  Button,
  CodeBlock,
  Icon,
  ModalOverlay,
  Panel,
} from "@/app/portal/components";
import { useDag } from "@/lib/hooks/useAgents";
import { useEventCatalog, useEvents } from "@/lib/hooks/useEvents";
import { type ToolUseSchema } from "@/app/portal/components/agent-code/samples";
import { AgentToolUseEditPanel } from "@/app/portal/components/agent-code/EditPanels";
import { useFleet, type FleetEntry } from "@/lib/hooks/useModelFleet";
import { useTools, type ToolCatalogEntry } from "@/lib/hooks/useTools";
import {
  useDeployAuthoredAgent,
  useGenerateAgentPrompt,
  useAgentNameAvailability,
  type GenerateAgentPromptBody,
} from "@/lib/hooks/useAgentAuthoring";
import { useTenant } from "@/app/portal/lib/use-tenant";
import { useToast } from "@/app/portal/components/toast";
import { normalizeAuthoredEventName } from "./event-name";
import {
  AGENT_BUILDER_TEMPLATES,
  deepSearchStepsForMode,
  defaultStepModels,
  modelLabel,
  modelSelectionReason,
  recommendFleetModel,
  type AgentBuilderStep,
  type AgentBuilderTemplate,
  type DeepSearchMode,
} from "./agent-builder";
import { catalogToolToToolUse } from "./tool-schema";
import {
  isCurrentPromptRequest,
  promptRequestFingerprint,
} from "./prompt-generation-guard";

const AUTO_MODEL = "auto";
const INHERIT_MODEL = "inherit";

export function DeployAgentModal({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const tenant = useTenant();
  const toast = useToast();
  const { data: dag } = useDag();
  const { data: liveEvents = [] } = useEvents({ limit: 100 });
  const { data: eventCatalog = [] } = useEventCatalog();
  const { data: fleet = [], isLoading: fleetLoading } = useFleet();
  const { data: toolCatalog, isLoading: toolsLoading } = useTools();
  const generatePrompt = useGenerateAgentPrompt();
  const deployAgent = useDeployAuthoredAgent();
  const [createdEvents, setCreatedEvents] = useState<string[]>([]);
  // Event-name catalog combines persisted ontology rows, names seen on the
  // live stream, and every name declared by an agent in the DAG.
  const existingEvents = useMemo(() => {
    const set = new Set<string>();
    for (const e of eventCatalog) set.add(e.name);
    for (const e of liveEvents) set.add(e.name);
    for (const a of dag?.agents ?? []) {
      for (const n of a.triggers) set.add(n);
      for (const n of a.emits) set.add(n);
    }
    return Array.from(set).sort();
  }, [eventCatalog, liveEvents, dag]);
  const events = useMemo(
    () => Array.from(new Set([...existingEvents, ...createdEvents])).sort(),
    [existingEvents, createdEvents],
  );
  const draftNewEvents = useMemo(
    () => createdEvents.filter((name) => !existingEvents.includes(name)),
    [createdEvents, existingEvents],
  );
  const [step, setStep] = useState(0);
  const [template, setTemplate] = useState<AgentBuilderTemplate | null>(null);
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [desc, setDesc] = useState("");
  const [modelChoice, setModelChoice] = useState(AUTO_MODEL);
  const [executionSteps, setExecutionSteps] = useState<AgentBuilderStep[]>([]);
  const [deepSearchMode, setDeepSearchMode] =
    useState<DeepSearchMode>("investigate");
  const [tools, setTools] = useState<string[]>([]);
  const [triggers, setTriggers] = useState<string[]>([]);
  const [emits, setEmits] = useState<string[]>([]);
  const [retries, setRetries] = useState(3);
  const [timeout, setTimeoutVal] = useState(120);
  const [concurrency, setConcurrency] = useState(8);
  const [implTab, setImplTab] = useState<
    "plan" | "prompt" | "code" | "tools" | "bind"
  >("plan");
  const [tsCode, setTsCode] = useState("");
  const [toolUse, setToolUse] = useState<ToolUseSchema[]>([]);
  const [systemPrompt, setSystemPrompt] = useState("");
  const [generatedPromptFingerprint, setGeneratedPromptFingerprint] = useState<
    string | null
  >(null);
  const [promptError, setPromptError] = useState<string | null>(null);
  const [deployError, setDeployError] = useState<string | null>(null);
  const [autoModelSelection, setAutoModelSelection] =
    useState<AgentModelSelection | null>(null);
  const [published, setPublished] =
    useState<DeployAuthoredAgentResponse | null>(null);
  const promptRequestSequenceRef = useRef(0);
  const currentPromptFingerprintRef = useRef("");

  const wizardSteps = [
    "Template",
    "Identity",
    "Events",
    "Build",
    "Runtime",
    "Review",
  ];

  const availableTools = toolCatalog?.tools ?? [];
  const ontologyTools = useMemo(
    () =>
      availableTools.filter((tool) => {
        const search = `${tool.category} ${tool.name}`.toLowerCase();
        return search.includes("ontology") || search.includes("neo4j");
      }),
    [availableTools],
  );
  const recommendedModel = recommendFleetModel(fleet, template, desc);
  const selectedModel =
    modelChoice === AUTO_MODEL
      ? recommendedModel
      : fleet.find((entry) => entry.id === modelChoice);
  const displayModel =
    modelChoice === AUTO_MODEL && autoModelSelection
      ? `${autoModelSelection.model} · ${autoModelSelection.provider}`
      : modelLabel(selectedModel);
  const displayModelReason =
    modelChoice === AUTO_MODEL && autoModelSelection
      ? autoModelSelection.reason
      : modelSelectionReason(template, desc);
  const nameValid = /^[a-z][A-Za-z0-9]*$/.test(name);
  const nameAvailability = useAgentNameAvailability(name, nameValid);
  const nameAvailable = nameAvailability.data?.available === true;
  const identityValid =
    nameValid &&
    nameAvailable &&
    title.trim().length > 0 &&
    desc.trim().length >= 10;
  const eventsValid = triggers.length > 0 && emits.length > 0;
  const promptSourceFingerprint = template
    ? promptRequestFingerprint(promptBody())
    : "";
  useLayoutEffect(() => {
    currentPromptFingerprintRef.current = promptSourceFingerprint;
  }, [promptSourceFingerprint]);
  const promptIsStale =
    systemPrompt.trim().length > 0 &&
    generatedPromptFingerprint !== null &&
    generatedPromptFingerprint !== promptSourceFingerprint;
  const implementationValid =
    systemPrompt.trim().length >= 40 && !promptIsStale;
  const behaviorValid =
    retries >= 0 &&
    retries <= 10 &&
    timeout >= 1 &&
    timeout <= 3600 &&
    concurrency >= 1 &&
    concurrency <= 100;
  const allValid =
    Boolean(template) &&
    identityValid &&
    eventsValid &&
    implementationValid &&
    behaviorValid;

  useEffect(() => {
    if (ontologyTools.length === 0) return;
    setTools((current) =>
      Array.from(
        new Set([...current, ...ontologyTools.map((tool) => tool.name)]),
      ),
    );
    setToolUse((current) => {
      const existing = new Set(current.map((tool) => tool.name));
      const additions = ontologyTools
        .filter((tool) => !existing.has(tool.name))
        .map(catalogToolToToolUse);
      return additions.length > 0 ? [...current, ...additions] : current;
    });
  }, [ontologyTools]);

  function pickTemplate(t: AgentBuilderTemplate) {
    setTemplate(t);
    setModelChoice(AUTO_MODEL);
    setAutoModelSelection(null);
    setSystemPrompt("");
    setGeneratedPromptFingerprint(null);
    setDeepSearchMode("investigate");
    setExecutionSteps(defaultStepModels(t));
    setStep(1);
  }

  function promptBody(): GenerateAgentPromptBody {
    const explicitlySelectedModel =
      modelChoice === AUTO_MODEL
        ? undefined
        : fleet.find((entry) => entry.id === modelChoice);
    return {
      name,
      title: title.trim(),
      description: desc.trim(),
      actor: template?.actor ?? "Agent",
      template: template?.id ?? "blank",
      triggers,
      emits,
      tools: authoredTools(),
      steps: authoredSteps(),
      ...(template?.id === "rag" ? { searchMode: deepSearchMode } : {}),
      ...(explicitlySelectedModel
        ? {
            provider:
              explicitlySelectedModel.provider as GenerateAgentPromptBody["provider"],
            model: explicitlySelectedModel.modelName,
          }
        : {}),
    };
  }

  function authoredTools(): GenerateAgentPromptBody["tools"] {
    return toolUse.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.input_schema,
    }));
  }

  function authoredSteps(
    source = executionSteps,
  ): NonNullable<GenerateAgentPromptBody["steps"]> {
    return source.map((item) => {
      const model =
        item.modelOverride && item.modelOverride !== INHERIT_MODEL
          ? fleet.find((entry) => entry.id === item.modelOverride)
          : undefined;
      return {
        id: item.id,
        name: item.title,
        description: item.description,
        type: item.execution === "human" ? "manual" : "logic",
        ...(model
          ? {
              provider: model.provider as GenerateAgentPromptBody["provider"],
              model: model.modelName,
            }
          : {}),
      };
    });
  }

  async function requestSystemPrompt(
    overrides: Partial<GenerateAgentPromptBody> = {},
  ) {
    if (!identityValid || !eventsValid || !template) return;
    const requestBody = {
      ...promptBody(),
      ...overrides,
    };
    const requestFingerprint = promptRequestFingerprint(requestBody);
    const requestId = ++promptRequestSequenceRef.current;
    currentPromptFingerprintRef.current = requestFingerprint;
    setPromptError(null);
    try {
      const result = await generatePrompt.mutateAsync(requestBody);
      if (
        !isCurrentPromptRequest({
          requestId,
          latestRequestId: promptRequestSequenceRef.current,
          requestFingerprint,
          currentFingerprint: currentPromptFingerprintRef.current,
        })
      ) {
        return;
      }
      setSystemPrompt(result.systemPrompt);
      setGeneratedPromptFingerprint(requestFingerprint);
      setAutoModelSelection(result.modelSelection);
    } catch (error) {
      if (
        !isCurrentPromptRequest({
          requestId,
          latestRequestId: promptRequestSequenceRef.current,
          requestFingerprint,
          currentFingerprint: currentPromptFingerprintRef.current,
        })
      ) {
        return;
      }
      setPromptError(
        error instanceof Error
          ? error.message
          : "Could not generate the system prompt",
      );
    }
  }

  function next() {
    if (step === 2) {
      setStep(3);
      if (
        (!systemPrompt.trim() || promptIsStale) &&
        !generatePrompt.isPending
      ) {
        void requestSystemPrompt();
      }
      return;
    }
    setStep((s) => Math.min(wizardSteps.length - 1, s + 1));
  }
  function back() {
    setStep((s) => Math.max(0, s - 1));
  }
  function toggleTool(tool: ToolCatalogEntry) {
    const isSelected = tools.includes(tool.name);
    setTools((current) =>
      isSelected
        ? current.filter((name) => name !== tool.name)
        : [...current, tool.name],
    );
    setToolUse((current) =>
      isSelected
        ? current.filter((entry) => entry.name !== tool.name)
        : current.some((entry) => entry.name === tool.name)
          ? current
          : [...current, catalogToolToToolUse(tool)],
    );
  }
  function addEvent(
    set: React.Dispatch<React.SetStateAction<string[]>>,
    val: string,
  ) {
    const v = normalizeAuthoredEventName(val);
    if (!v) return;
    if (!existingEvents.includes(v)) {
      setCreatedEvents((current) =>
        current.includes(v) ? current : [...current, v],
      );
    }
    set((arr) => (arr.includes(v) ? arr : [...arr, v]));
  }
  function removeEvent(
    set: React.Dispatch<React.SetStateAction<string[]>>,
    v: string,
  ) {
    set((arr) => arr.filter((x) => x !== v));
  }
  function addEmit(val: string) {
    addEvent(setEmits, val);
  }
  function applySuggestedContract() {
    if (!template) return;
    addEvent(setTriggers, template.suggestedTrigger);
    addEvent(setEmits, template.suggestedEmit);
  }
  function updateStepModel(stepId: string, modelOverride: string) {
    setExecutionSteps((current) =>
      current.map((item) =>
        item.id === stepId ? { ...item, modelOverride } : item,
      ),
    );
  }
  function changeDeepSearchMode(mode: DeepSearchMode) {
    setDeepSearchMode(mode);
    if (template?.id === "rag") {
      const nextSteps = deepSearchStepsForMode(template, mode);
      setExecutionSteps(nextSteps);
      setSystemPrompt("");
      setGeneratedPromptFingerprint(null);
      setAutoModelSelection(null);
      if (step >= 3) {
        void requestSystemPrompt({
          searchMode: mode,
          steps: authoredSteps(nextSteps),
        });
      }
    }
  }

  function canContinue(): boolean {
    if (step === 0) return Boolean(template);
    if (step === 1) return identityValid;
    if (step === 2) return eventsValid;
    if (step === 3) return implementationValid && !generatePrompt.isPending;
    if (step === 4) return behaviorValid;
    return allValid;
  }

  async function deploy() {
    if (!template || !allValid) return;
    setDeployError(null);
    try {
      const context = promptBody();
      const result = await deployAgent.mutateAsync({
        name: context.name,
        title: context.title,
        description: context.description,
        actor: context.actor,
        template: context.template,
        triggers: context.triggers,
        emits: context.emits,
        steps: context.steps,
        ...(context.searchMode ? { searchMode: context.searchMode } : {}),
        ...(context.provider ? { provider: context.provider } : {}),
        ...(context.model ? { model: context.model } : {}),
        systemPrompt,
        toolUse: authoredTools(),
        retries,
        timeoutS: timeout,
        concurrency,
        ...(tsCode.trim() ? { typescriptCode: tsCode } : {}),
      });
      toast({
        tone: "green",
        title: `${result.agent.title} is live`,
        description: `${result.runtime.functionId} is published and ready to run.${result.events.created.length > 0 ? ` ${result.events.created.length} new event type${result.events.created.length === 1 ? "" : "s"} created.` : ""}`,
      });
      setPublished(result);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Agent publishing failed";
      setDeployError(message);
      toast({ tone: "red", title: "Publish failed", description: message });
    }
  }

  return (
    <ModalOverlay onClose={onClose}>
      <div
        style={{
          width: 1080,
          maxHeight: "88vh",
          background: "var(--panel)",
          border: "1px solid var(--border-2)",
          borderRadius: 8,
          overflow: "hidden",
          boxShadow: "0 24px 60px -20px rgba(0,0,0,0.6)",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <header
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "14px 18px",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <Icon name="agent" size={14} style={{ color: "var(--signal)" }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{ fontSize: 14, color: "var(--text)", fontWeight: 500 }}
            >
              {published ? "Agent is live" : "New Agent"}
            </div>
            <div style={{ fontSize: 11, color: "var(--text-3)" }}>
              {published ? (
                <>
                  Published to <span className="mono">{tenant}</span> and ready
                  for events.
                </>
              ) : (
                <>
                  Design an event-driven agent, publish it, and run it in{" "}
                  <span className="mono">{tenant}</span>.
                </>
              )}
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close New Agent builder"
            style={{ color: "var(--text-3)" }}
          >
            <Icon name="x" size={13} />
          </button>
        </header>

        {!published && (
          <div
            style={{
              display: "flex",
              gap: 6,
              padding: "10px 18px",
              borderBottom: "1px solid var(--border)",
              background: "var(--bg-2)",
            }}
          >
            {wizardSteps.map((s, i) => (
              <div
                key={s}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  opacity: i === step ? 1 : i < step ? 0.85 : 0.45,
                }}
              >
                <span
                  style={{
                    width: 18,
                    height: 18,
                    borderRadius: "50%",
                    background: i < step ? "var(--signal)" : "transparent",
                    border: `1px solid ${i <= step ? "var(--signal)" : "var(--border-2)"}`,
                    color:
                      i < step
                        ? "#000"
                        : i === step
                          ? "var(--signal)"
                          : "var(--text-3)",
                    fontSize: 10,
                    fontFamily: "var(--mono)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  {i < step ? "✓" : i + 1}
                </span>
                <span
                  style={{
                    fontSize: 11,
                    fontFamily: "var(--mono)",
                    textTransform: "uppercase",
                    letterSpacing: "0.06em",
                    color: i === step ? "var(--text)" : "var(--text-3)",
                  }}
                >
                  {s}
                </span>
                {i < wizardSteps.length - 1 && (
                  <span
                    style={{
                      width: 14,
                      height: 1,
                      background: "var(--border)",
                      marginLeft: 4,
                    }}
                  />
                )}
              </div>
            ))}
          </div>
        )}

        <div style={{ padding: 20, overflow: "auto", flex: 1, minHeight: 0 }}>
          {published && (
            <PublishedAgentSummary result={published} tenant={tenant} />
          )}
          {!published && step === 0 && (
            <div>
              <SectionLabel>Choose how this agent works</SectionLabel>
              <div
                style={{
                  fontSize: 12,
                  color: "var(--text-2)",
                  lineHeight: 1.6,
                  margin: "-2px 0 12px",
                }}
              >
                Each pattern includes a production execution plan, safeguards,
                and an automatic model recommendation. Everything stays
                editable.
              </div>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(3, 1fr)",
                  gap: 10,
                }}
              >
                {AGENT_BUILDER_TEMPLATES.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => pickTemplate(t)}
                    style={{
                      padding: "12px 14px",
                      background: "var(--panel-2)",
                      border: "1px solid var(--border)",
                      borderLeft: `3px solid ${t.color}`,
                      borderRadius: 5,
                      textAlign: "left",
                      cursor: "pointer",
                      transition: "background 0.12s, border-color 0.12s",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        marginBottom: 6,
                      }}
                    >
                      <ActorTag actor={t.actor} />
                    </div>
                    <div
                      style={{
                        fontSize: 13,
                        color: "var(--text)",
                        fontWeight: 500,
                        marginBottom: 3,
                      }}
                    >
                      {t.name}
                    </div>
                    <div
                      style={{
                        fontSize: 11.5,
                        color: "var(--text-2)",
                        lineHeight: 1.5,
                      }}
                    >
                      {t.description}
                    </div>
                    <div
                      style={{
                        display: "flex",
                        flexWrap: "wrap",
                        gap: 4,
                        marginTop: 9,
                      }}
                    >
                      {t.bestFor.slice(0, 2).map((useCase) => (
                        <span
                          key={useCase}
                          style={{
                            padding: "2px 5px",
                            border: "1px solid var(--border)",
                            borderRadius: 3,
                            color: "var(--text-3)",
                            fontFamily: "var(--mono)",
                            fontSize: 9.5,
                          }}
                        >
                          {useCase}
                        </span>
                      ))}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {!published && step === 1 && template && (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 14,
                maxWidth: 900,
              }}
            >
              <div style={{ gridColumn: "1 / -1" }}>
                <TemplateBrief template={template} />
              </div>
              <EditField
                className="new-agent-paired-field"
                htmlFor="new-agent-name"
                label="Name (id)"
                hint="lowercase camelCase, used in events & logs"
              >
                <EditText
                  id="new-agent-name"
                  value={name}
                  onChange={setName}
                  mono
                />
                {name.length > 0 && !nameValid && (
                  <InlineMessage tone="red">
                    Start with a lowercase letter and use letters or numbers
                    only.
                  </InlineMessage>
                )}
                {nameValid && (
                  <div aria-live="polite">
                    {nameAvailability.isChecking && (
                      <InlineMessage tone="signal">
                        Checking whether this agent ID is available…
                      </InlineMessage>
                    )}
                    {!nameAvailability.isChecking &&
                      nameAvailability.data?.available && (
                        <InlineMessage tone="green">
                          Agent ID {nameAvailability.data.id} is available.
                        </InlineMessage>
                      )}
                    {!nameAvailability.isChecking &&
                      nameAvailability.data &&
                      !nameAvailability.data.available && (
                        <InlineMessage tone="red">
                          An agent with this{" "}
                          {nameAvailability.data.conflict?.field ?? "name"}{" "}
                          already exists:{" "}
                          {nameAvailability.data.conflict?.value ?? name}.
                          Choose a different name.
                        </InlineMessage>
                      )}
                    {!nameAvailability.isChecking &&
                      nameAvailability.isError && (
                        <InlineMessage tone="red">
                          Could not verify this agent ID. Continue is disabled
                          until the check succeeds.{" "}
                          <button
                            type="button"
                            onClick={() => void nameAvailability.refetch()}
                            style={{
                              color: "inherit",
                              textDecoration: "underline",
                              font: "inherit",
                            }}
                          >
                            Try again
                          </button>
                        </InlineMessage>
                      )}
                  </div>
                )}
              </EditField>
              <EditField
                className="new-agent-paired-field"
                htmlFor="new-agent-title"
                label="Title"
                hint="Shown in the operator UI"
              >
                <EditText
                  id="new-agent-title"
                  value={title}
                  onChange={setTitle}
                />
              </EditField>
              <div style={{ gridColumn: "1 / -1" }}>
                <EditField
                  htmlFor="new-agent-purpose"
                  label="Purpose and success criteria"
                  hint="Explain what the agent should accomplish, the context it can trust, and what a successful result contains. Auto model selection uses this brief."
                >
                  <EditTextarea
                    id="new-agent-purpose"
                    value={desc}
                    onChange={(value) => {
                      setDesc(value);
                      setAutoModelSelection(null);
                    }}
                    rows={3}
                  />
                  {desc.length > 0 && desc.trim().length < 10 && (
                    <InlineMessage tone="red">
                      Describe the agent in at least 10 characters.
                    </InlineMessage>
                  )}
                </EditField>
              </div>
              <EditField
                className="new-agent-paired-field"
                label="Execution"
                hint="Agents are placed by their event contract, not a workflow stage."
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <ActorTag actor={template.actor} />
                  <span style={{ color: "var(--text-3)", fontSize: 11 }}>
                    {template.actor === "Human"
                      ? "Prepares context and pauses for operator authority"
                      : "Runs automatically when a trigger event arrives"}
                  </span>
                </div>
              </EditField>
              <EditField
                className="new-agent-paired-field"
                label="Architecture"
                hint="Every agent is independent and event-driven."
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 7,
                    color: "var(--green)",
                    fontSize: 11.5,
                  }}
                >
                  <Icon name="check" size={11} />
                  No workflow stage required
                </div>
              </EditField>
            </div>
          )}

          {!published && step === 2 && (
            <div style={{ maxWidth: 900 }}>
              {template && (
                <button
                  type="button"
                  onClick={applySuggestedContract}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    width: "100%",
                    padding: "9px 10px",
                    marginBottom: 10,
                    background: "rgba(203,255,0,0.04)",
                    border:
                      "1px solid color-mix(in srgb, var(--signal) 32%, var(--border))",
                    borderRadius: 5,
                    color: "var(--text-2)",
                    textAlign: "left",
                    fontSize: 11.5,
                  }}
                >
                  <Icon
                    name="spark"
                    size={11}
                    style={{ color: "var(--signal)" }}
                  />
                  <span>Use suggested contract</span>
                  <span
                    className="mono"
                    style={{ marginLeft: "auto", color: "var(--blue)" }}
                  >
                    {template.suggestedTrigger}
                  </span>
                  <Icon name="chevron-right" size={10} />
                  <span className="mono" style={{ color: "var(--green)" }}>
                    {template.suggestedEmit}
                  </span>
                </button>
              )}
              <div className="new-agent-events-grid">
                <EditField
                  className="new-agent-paired-field new-agent-events-field"
                  htmlFor="new-agent-trigger-event"
                  label="Trigger events"
                  hint="The agent starts whenever any selected event arrives. Pick an existing event or create a new type."
                >
                  <EventPicker
                    inputId="new-agent-trigger-event"
                    selected={triggers}
                    onAdd={(v) => addEvent(setTriggers, v)}
                    onRemove={(v) => removeEvent(setTriggers, v)}
                    tone="blue"
                    all={events}
                    newEvents={draftNewEvents}
                  />
                  {triggers.length === 0 && (
                    <InlineMessage tone="amber">
                      At least one trigger is required so the runtime can start
                      this agent.
                    </InlineMessage>
                  )}
                </EditField>
                <EditField
                  className="new-agent-paired-field new-agent-events-field"
                  htmlFor="new-agent-emit-event"
                  label="Emit events"
                  hint="Publish one or more result events so downstream agents can continue the work."
                >
                  <EventPicker
                    inputId="new-agent-emit-event"
                    selected={emits}
                    onAdd={addEmit}
                    onRemove={(v) => removeEvent(setEmits, v)}
                    tone="green"
                    all={events}
                    newEvents={draftNewEvents}
                  />
                  {emits.length === 0 && (
                    <InlineMessage tone="amber">
                      At least one emitted event is required to complete the
                      event contract.
                    </InlineMessage>
                  )}
                </EditField>
              </div>
              <InlineMessage tone="signal">
                Event names are the agent&apos;s API. New event types are
                created only when you publish.
              </InlineMessage>
            </div>
          )}

          {!published && step === 3 && (
            <div>
              <div
                style={{
                  display: "flex",
                  gap: 0,
                  borderBottom: "1px solid var(--border)",
                  marginBottom: 14,
                }}
              >
                {(
                  [
                    {
                      id: "plan",
                      label: "Execution plan",
                      icon: "git" as const,
                    },
                    {
                      id: "prompt",
                      label: "System prompt",
                      icon: "logs" as const,
                    },
                    {
                      id: "code",
                      label: "TypeScript code",
                      icon: "code" as const,
                    },
                    { id: "tools", label: "tool_use", icon: "spark" as const },
                    {
                      id: "bind",
                      label: "Capabilities",
                      icon: "deploy" as const,
                    },
                  ] as const
                ).map((t) => (
                  <button
                    key={t.id}
                    onClick={() => setImplTab(t.id)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      padding: "8px 14px",
                      fontSize: 11.5,
                      fontFamily: "var(--mono)",
                      textTransform: "uppercase",
                      letterSpacing: "0.06em",
                      color: implTab === t.id ? "var(--text)" : "var(--text-3)",
                      borderBottom: `2px solid ${implTab === t.id ? "var(--signal)" : "transparent"}`,
                      marginBottom: -1,
                    }}
                  >
                    <Icon name={t.icon} size={11} />
                    {t.label}
                    {t.id === "tools" && (
                      <span
                        style={{
                          marginLeft: 4,
                          padding: "0 5px",
                          background: "var(--panel-2)",
                          border: "1px solid var(--border)",
                          borderRadius: 8,
                          fontSize: 9.5,
                          color: "var(--text-3)",
                        }}
                      >
                        {toolUse.length}
                      </span>
                    )}
                    {t.id === "bind" && (
                      <span
                        style={{
                          marginLeft: 4,
                          padding: "0 5px",
                          background: "var(--panel-2)",
                          border: "1px solid var(--border)",
                          borderRadius: 8,
                          fontSize: 9.5,
                          color: "var(--text-3)",
                        }}
                      >
                        {tools.length}
                      </span>
                    )}
                  </button>
                ))}
                <div
                  style={{
                    marginLeft: "auto",
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "4px 0",
                  }}
                >
                  <span style={{ fontSize: 11, color: "var(--text-3)" }}>
                    Model
                  </span>
                  <select
                    value={modelChoice}
                    onChange={(e) => {
                      setModelChoice(e.target.value);
                      setAutoModelSelection(null);
                    }}
                    style={{
                      background: "var(--panel-2)",
                      border: "1px solid var(--border-2)",
                      borderRadius: 4,
                      padding: "4px 8px",
                      color: "var(--text)",
                      fontFamily: "var(--mono)",
                      fontSize: 11.5,
                      outline: "none",
                    }}
                  >
                    <option value={AUTO_MODEL}>
                      {fleetLoading
                        ? "Auto · loading fleet…"
                        : `Auto · ${
                            autoModelSelection
                              ? `${autoModelSelection.model} · ${autoModelSelection.provider}`
                              : modelLabel(recommendedModel)
                          }`}
                    </option>
                    {!fleetLoading &&
                      fleet.map((entry) => (
                        <option key={entry.id} value={entry.id}>
                          {entry.alias || entry.modelName} · {entry.provider}
                        </option>
                      ))}
                  </select>
                </div>
              </div>

              {implTab === "plan" && template && (
                <>
                  {template.id === "rag" && (
                    <DeepSearchModePicker
                      value={deepSearchMode}
                      onChange={changeDeepSearchMode}
                    />
                  )}
                  <ExecutionPlanEditor
                    template={template}
                    steps={executionSteps}
                    fleet={fleet}
                    selectedModel={displayModel}
                    modelChoice={modelChoice}
                    modelReason={displayModelReason}
                    onModelChange={updateStepModel}
                  />
                  {generatePrompt.isPending && (
                    <PromptGenerationProgress compact />
                  )}
                  {promptError && (
                    <InlineMessage tone="red">
                      {promptError} Open System prompt to retry.
                    </InlineMessage>
                  )}
                </>
              )}

              {implTab === "prompt" && (
                <div
                  className="new-agent-prompt-editor"
                  aria-busy={generatePrompt.isPending}
                >
                  <div className="new-agent-prompt-header">
                    <div className="new-agent-prompt-heading">
                      <label
                        className="new-agent-edit-field-label"
                        htmlFor="new-agent-system-prompt"
                      >
                        System prompt
                      </label>
                      <div className="new-agent-edit-field-hint">
                        Generated from the purpose, event contract, execution
                        pattern, model policy, ontology, and tools. Review it
                        before publishing.
                      </div>
                    </div>
                    <Button
                      tone={generatePrompt.isPending ? "primary" : "default"}
                      onClick={() => void requestSystemPrompt()}
                      disabled={
                        generatePrompt.isPending ||
                        !identityValid ||
                        !eventsValid
                      }
                      style={
                        generatePrompt.isPending
                          ? {
                              opacity: 1,
                              cursor: "progress",
                              boxShadow:
                                "0 0 0 1px rgba(203,255,0,0.25), 0 0 22px rgba(203,255,0,0.18)",
                            }
                          : undefined
                      }
                    >
                      <span
                        className={
                          generatePrompt.isPending
                            ? "new-agent-generate-icon new-agent-generate-icon--active"
                            : "new-agent-generate-icon"
                        }
                        aria-hidden="true"
                      >
                        <Icon name="spark" size={12} />
                      </span>
                      {generatePrompt.isPending
                        ? "Generating prompt…"
                        : systemPrompt
                          ? "Regenerate"
                          : "Generate"}
                    </Button>
                  </div>
                  {generatePrompt.isPending && <PromptGenerationProgress />}
                  <EditTextarea
                    id="new-agent-system-prompt"
                    className="new-agent-system-prompt-input"
                    ariaLabel="Generated system prompt"
                    value={systemPrompt}
                    onChange={(value) => {
                      setSystemPrompt(value);
                      setGeneratedPromptFingerprint(promptSourceFingerprint);
                      setPromptError(null);
                    }}
                    rows={18}
                    mono
                    readOnly={generatePrompt.isPending}
                  />
                  {promptError && (
                    <InlineMessage tone="red">{promptError}</InlineMessage>
                  )}
                  {promptIsStale && (
                    <InlineMessage tone="signal">
                      Agent details changed after this prompt was generated.
                      Regenerate it, or edit the prompt to confirm your custom
                      version.
                    </InlineMessage>
                  )}
                  {!generatePrompt.isPending &&
                    !promptError &&
                    systemPrompt.trim().length > 0 &&
                    systemPrompt.trim().length < 40 && (
                      <InlineMessage tone="red">
                        The system prompt must contain at least 40 characters.
                      </InlineMessage>
                    )}
                </div>
              )}

              {implTab === "code" && (
                <EditField
                  htmlFor="new-agent-typescript"
                  label="TypeScript source (optional)"
                  hint="Stored with the manifest as implementation metadata. Generated manifest agents execute through the system prompt and runtime tool loop."
                >
                  <EditTextarea
                    id="new-agent-typescript"
                    value={tsCode}
                    onChange={setTsCode}
                    rows={18}
                    mono
                  />
                </EditField>
              )}
              {implTab === "tools" &&
                (toolUse.length > 0 ? (
                  <AgentToolUseEditPanel
                    tools={toolUse}
                    onChange={setToolUse}
                  />
                ) : (
                  <div
                    style={{
                      padding: 24,
                      background: "var(--panel-2)",
                      border: "1px solid var(--border)",
                      borderRadius: 5,
                      color: "var(--text-3)",
                      fontSize: 12,
                      lineHeight: 1.6,
                    }}
                  >
                    No tools selected. Choose workspace tools under{" "}
                    <span className="mono" style={{ color: "var(--text-2)" }}>
                      Tool bindings
                    </span>
                    ; their live schemas will appear here for editing.
                  </div>
                ))}

              {implTab === "bind" && (
                <div>
                  <OntologyCapability
                    isLoading={toolsLoading}
                    tools={ontologyTools}
                  />
                  <EditField
                    label={`Additional capabilities · ${Math.max(0, tools.length - ontologyTools.length)} selected`}
                    hint="Choose only the workspace tools this agent may invoke. Ontology access is included for every agent."
                  >
                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns: "1fr 1fr",
                        gap: 4,
                        maxHeight: 420,
                        overflow: "auto",
                        padding: 2,
                      }}
                    >
                      {toolsLoading && (
                        <div style={{ color: "var(--text-3)", fontSize: 11.5 }}>
                          Loading workspace tools…
                        </div>
                      )}
                      {!toolsLoading && availableTools.length === 0 && (
                        <div style={{ color: "var(--text-3)", fontSize: 11.5 }}>
                          No workspace tools are registered.
                        </div>
                      )}
                      {availableTools.map((tool) => {
                        const on = tools.includes(tool.name);
                        const ontologyTool = ontologyTools.some(
                          (entry) => entry.name === tool.name,
                        );
                        return (
                          <button
                            key={tool.name}
                            onClick={() => {
                              if (!ontologyTool) toggleTool(tool);
                            }}
                            title={
                              ontologyTool
                                ? "Included with Ontology API"
                                : (tool.description ?? tool.summary)
                            }
                            aria-disabled={ontologyTool}
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 8,
                              padding: "7px 9px",
                              background: on
                                ? "rgba(208,255,0,0.06)"
                                : "var(--panel-2)",
                              border: `1px solid ${on ? (ontologyTool ? "var(--violet)" : "var(--signal)") : "var(--border)"}`,
                              borderRadius: 4,
                              textAlign: "left",
                              cursor: ontologyTool ? "default" : "pointer",
                            }}
                          >
                            <span
                              style={{
                                width: 12,
                                height: 12,
                                borderRadius: 2,
                                background: on
                                  ? "var(--signal)"
                                  : "transparent",
                                border: `1px solid ${on ? "var(--signal)" : "var(--border-3)"}`,
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                              }}
                            >
                              {on && (
                                <Icon
                                  name="check"
                                  size={9}
                                  style={{ color: "#000" }}
                                />
                              )}
                            </span>
                            <span
                              className="mono"
                              style={{ fontSize: 11.5, color: "var(--text)" }}
                            >
                              {tool.name}
                            </span>
                            {ontologyTool && (
                              <Badge tone="violet">included</Badge>
                            )}
                            <Badge tone="muted" style={{ marginLeft: "auto" }}>
                              {tool.category}
                            </Badge>
                          </button>
                        );
                      })}
                    </div>
                  </EditField>
                </div>
              )}
            </div>
          )}

          {!published && step === 4 && (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 14,
                maxWidth: 900,
              }}
            >
              <div style={{ gridColumn: "1 / -1" }}>
                <Panel title="Model policy" padded>
                  <div
                    style={{ display: "flex", alignItems: "center", gap: 8 }}
                  >
                    <Badge
                      tone={modelChoice === AUTO_MODEL ? "signal" : "blue"}
                    >
                      {modelChoice === AUTO_MODEL
                        ? "Auto selected"
                        : "User selected"}
                    </Badge>
                    <span
                      className="mono"
                      style={{ color: "var(--text)", fontSize: 11.5 }}
                    >
                      {displayModel}
                    </span>
                  </div>
                  <div
                    style={{
                      marginTop: 7,
                      color: "var(--text-3)",
                      fontSize: 11,
                      lineHeight: 1.55,
                    }}
                  >
                    {displayModelReason} Per-step overrides are configured in
                    the execution plan.
                  </div>
                </Panel>
              </div>
              <EditField
                className="new-agent-paired-field"
                htmlFor="new-agent-retries"
                label="Retries"
                hint="Maximum immediate retry attempts for a failed model action."
              >
                <EditText
                  id="new-agent-retries"
                  value={String(retries)}
                  onChange={(v) => setRetries(parseInt(v, 10) || 0)}
                  mono
                  suffix="attempts"
                />
              </EditField>
              <EditField
                className="new-agent-paired-field"
                htmlFor="new-agent-timeout"
                label="Per-call timeout"
                hint="Maximum duration of each model gateway call; a multi-step run may take longer."
              >
                <EditText
                  id="new-agent-timeout"
                  value={String(timeout)}
                  onChange={(v) => setTimeoutVal(parseInt(v, 10) || 0)}
                  mono
                  suffix="seconds"
                />
              </EditField>
              <EditField
                htmlFor="new-agent-concurrency"
                label="Concurrency"
                hint="Max simultaneous runs."
              >
                <EditText
                  id="new-agent-concurrency"
                  value={String(concurrency)}
                  onChange={(v) => setConcurrency(parseInt(v, 10) || 0)}
                  mono
                  suffix="runs"
                />
              </EditField>
              <div style={{ gridColumn: "1 / -1" }}>
                <InlineMessage tone="signal">
                  Concurrency is partitioned by the runtime event subject.
                  Exhausted retries are recorded in the run and audit logs.
                </InlineMessage>
              </div>
            </div>
          )}

          {!published && step === 5 && (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 14,
              }}
            >
              <Panel title="Manifest" padded={false}>
                <CodeBlock>
                  {JSON.stringify(
                    {
                      id:
                        name
                          .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
                          .toLowerCase() || "new-agent",
                      name: name || "newAgent",
                      title: title || "New agent",
                      description: desc,
                      actor: [template?.actor || "Agent"],
                      template: template?.id,
                      ...(template?.id === "rag"
                        ? { search_mode: deepSearchMode }
                        : {}),
                      trigger: triggers,
                      actions: executionSteps.map((item, index) => ({
                        order: String(index + 1),
                        name: item.id,
                        description: item.description,
                        type: item.execution === "human" ? "manual" : "logic",
                        ...(item.modelOverride &&
                        item.modelOverride !== INHERIT_MODEL
                          ? {
                              provider: fleet.find(
                                (entry) => entry.id === item.modelOverride,
                              )?.provider,
                              model: fleet.find(
                                (entry) => entry.id === item.modelOverride,
                              )?.modelName,
                            }
                          : {}),
                      })),
                      triggered_event: emits,
                      generated: template?.actor !== "Human",
                      ontology_instructions: systemPrompt,
                      tool_use: toolUse,
                      model_policy: {
                        mode: modelChoice === AUTO_MODEL ? "auto" : "fixed",
                        provider:
                          modelChoice === AUTO_MODEL
                            ? autoModelSelection?.provider
                            : selectedModel?.provider,
                        model:
                          modelChoice === AUTO_MODEL
                            ? autoModelSelection?.model
                            : selectedModel?.modelName,
                      },
                      ontology: {
                        enabled: true,
                        tools:
                          ontologyTools.length > 0
                            ? ontologyTools.map((tool) => tool.name)
                            : ["ontology.query"],
                      },
                      retries,
                      concurrency: {
                        enabled: true,
                        max_concurrent_executions: concurrency,
                      },
                      timeout_s: timeout,
                      ...(tsCode.trim()
                        ? {
                            typescript_code: `<inline · ${tsCode.split("\n").length} lines>`,
                          }
                        : {}),
                    },
                    null,
                    2,
                  )}
                </CodeBlock>
              </Panel>
              <div>
                <Panel title="Pre-flight" padded>
                  <ValidationLine
                    ok={identityValid}
                    label="Identity valid"
                    hint={
                      identityValid
                        ? "ready"
                        : "available name, title, description required"
                    }
                  />
                  <ValidationLine
                    ok={nameAvailable}
                    label="Agent ID available"
                    hint={nameAvailability.data?.id}
                  />
                  <ValidationLine
                    ok={triggers.length > 0}
                    label={`${triggers.length} trigger event(s)`}
                  />
                  <ValidationLine
                    ok={emits.length > 0}
                    warn={emits.length === 0}
                    label={`${emits.length} emit event(s)`}
                  />
                  <ValidationLine
                    ok={implementationValid}
                    label="System prompt ready"
                    hint={`${systemPrompt.trim().length} chars`}
                  />
                  <ValidationLine
                    ok
                    label="Ontology API"
                    hint={
                      ontologyTools.length > 0
                        ? `${ontologyTools.length} graph tool(s)`
                        : "ontology.query · server managed"
                    }
                  />
                  <ValidationLine
                    ok
                    label={`${executionSteps.length} execution step(s)`}
                    hint={`${executionSteps.filter((item) => item.modelOverride !== INHERIT_MODEL).length} model override(s)`}
                  />
                  <ValidationLine
                    ok
                    label={`${tools.length} live tool binding(s)`}
                  />
                  {template?.actor !== "Human" && (
                    <ValidationLine
                      ok
                      label={
                        tsCode.trim()
                          ? `typescript_code metadata · ${tsCode.split("\n").length} lines`
                          : "No TypeScript metadata"
                      }
                    />
                  )}
                  {template?.actor !== "Human" && (
                    <ValidationLine
                      ok
                      warn={toolUse.length === 0}
                      label={`tool_use · ${toolUse.length} defined`}
                      hint={
                        toolUse.length ? "live catalog schemas" : "optional"
                      }
                    />
                  )}
                  <ValidationLine
                    ok
                    label="Model selection"
                    hint={`${modelChoice === AUTO_MODEL ? "auto · " : ""}${displayModel}`}
                  />
                  <ValidationLine
                    ok={behaviorValid}
                    label="Runtime limits valid"
                  />
                </Panel>
                <Panel title="Publish target" padded style={{ marginTop: 12 }}>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      padding: "8px 10px",
                      background: "var(--panel-2)",
                      border: "1px solid var(--signal)",
                      borderRadius: 4,
                    }}
                  >
                    <Icon
                      name="deploy"
                      size={12}
                      style={{ color: "var(--signal)" }}
                    />
                    <div>
                      <div style={{ fontSize: 12, color: "var(--text)" }}>
                        Live runtime · <span className="mono">{tenant}</span>
                      </div>
                      <div style={{ fontSize: 10.5, color: "var(--text-3)" }}>
                        Persist manifest, create a workflow version, and
                        hot-load the runtime function
                      </div>
                    </div>
                  </div>
                  <div
                    style={{
                      marginTop: 10,
                      padding: "8px 10px",
                      background: "var(--bg-2)",
                      border: "1px solid var(--border)",
                      borderRadius: 4,
                      fontSize: 11,
                      color: "var(--text-3)",
                      lineHeight: 1.55,
                    }}
                  >
                    Publishing succeeds only after the API confirms{" "}
                    <span className="mono" style={{ color: "var(--text-2)" }}>
                      {tenant}.{name || "agentName"}
                    </span>{" "}
                    is registered, live, and ready for its trigger events.
                  </div>
                </Panel>
                {deployError && (
                  <InlineMessage tone="red">{deployError}</InlineMessage>
                )}
              </div>
            </div>
          )}
        </div>

        <footer
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "12px 18px",
            borderTop: "1px solid var(--border)",
            background: "var(--panel-2)",
          }}
        >
          {!published && step > 0 && (
            <Button tone="ghost" icon="chevron-left" onClick={back}>
              Back
            </Button>
          )}
          {!published && (
            <span style={{ fontSize: 11, color: "var(--text-3)" }}>
              Step {step + 1} of {wizardSteps.length}
            </span>
          )}
          <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
            {published ? (
              <>
                <Button tone="ghost" onClick={onClose}>
                  Done
                </Button>
                <Button
                  tone="primary"
                  icon="play"
                  onClick={() => {
                    router.push(
                      `/portal/${tenant}/agents/${encodeURIComponent(published.agent.id)}?section=test` as never,
                    );
                    onClose();
                  }}
                >
                  Open &amp; run
                </Button>
              </>
            ) : (
              <>
                <Button tone="ghost" onClick={onClose}>
                  Cancel
                </Button>
                {step < wizardSteps.length - 1 ? (
                  <Button
                    tone="primary"
                    onClick={next}
                    disabled={!canContinue()}
                  >
                    {step >= 2 && generatePrompt.isPending
                      ? "Generating prompt…"
                      : "Continue"}
                  </Button>
                ) : (
                  <Button
                    tone="primary"
                    icon="deploy"
                    onClick={() => void deploy()}
                    disabled={!allValid || deployAgent.isPending}
                  >
                    {deployAgent.isPending ? "Publishing…" : "Create & publish"}
                  </Button>
                )}
              </>
            )}
          </div>
        </footer>
      </div>
    </ModalOverlay>
  );
}

// ---- small atoms (settings-local pattern) ----

function TemplateBrief({ template }: { template: AgentBuilderTemplate }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1.2fr 1fr 1fr",
        gap: 12,
        padding: 12,
        background: "var(--panel-2)",
        border: `1px solid color-mix(in srgb, ${template.color} 35%, var(--border))`,
        borderLeft: `3px solid ${template.color}`,
        borderRadius: 5,
      }}
    >
      <div>
        <div style={{ color: "var(--text)", fontSize: 12.5, fontWeight: 500 }}>
          {template.name}
        </div>
        <div
          style={{
            color: "var(--text-2)",
            fontSize: 11,
            lineHeight: 1.55,
            marginTop: 4,
          }}
        >
          {template.outcome}
        </div>
      </div>
      <div>
        <div
          className="mono"
          style={{
            color: "var(--text-3)",
            fontSize: 9.5,
            textTransform: "uppercase",
            marginBottom: 5,
          }}
        >
          Best for
        </div>
        {template.bestFor.map((item) => (
          <div
            key={item}
            style={{ color: "var(--text-2)", fontSize: 10.5, lineHeight: 1.55 }}
          >
            • {item}
          </div>
        ))}
      </div>
      <div>
        <div
          className="mono"
          style={{
            color: "var(--text-3)",
            fontSize: 9.5,
            textTransform: "uppercase",
            marginBottom: 5,
          }}
        >
          Built-in safeguards
        </div>
        {template.safeguards.map((item) => (
          <div
            key={item}
            style={{ color: "var(--text-2)", fontSize: 10.5, lineHeight: 1.55 }}
          >
            • {item}
          </div>
        ))}
      </div>
    </div>
  );
}

function DeepSearchModePicker({
  value,
  onChange,
}: {
  value: DeepSearchMode;
  onChange: (value: DeepSearchMode) => void;
}) {
  const modes: Array<{
    id: DeepSearchMode;
    title: string;
    time: string;
    description: string;
  }> = [
    {
      id: "answer",
      title: "Answer",
      time: "seconds",
      description: "Focused retrieval and a concise cited response.",
    },
    {
      id: "investigate",
      title: "Investigate",
      time: "minutes",
      description: "Iterative search, gap analysis, and evidence synthesis.",
    },
    {
      id: "deep_research",
      title: "Deep Research",
      time: "background",
      description:
        "Reviewable plan, parallel workstreams, evidence ledger, and citation verification.",
    },
  ];
  return (
    <div style={{ marginBottom: 12 }}>
      <SectionLabel>Research depth</SectionLabel>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gap: 7,
        }}
      >
        {modes.map((mode) => {
          const selected = mode.id === value;
          return (
            <button
              type="button"
              key={mode.id}
              onClick={() => onChange(mode.id)}
              style={{
                padding: "9px 10px",
                background: selected
                  ? "rgba(181,148,255,0.08)"
                  : "var(--panel-2)",
                border: `1px solid ${selected ? "var(--violet)" : "var(--border)"}`,
                borderRadius: 5,
                textAlign: "left",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span
                  style={{
                    color: "var(--text)",
                    fontSize: 11.5,
                    fontWeight: 500,
                  }}
                >
                  {mode.title}
                </span>
                <span
                  className="mono"
                  style={{
                    color: selected ? "var(--violet)" : "var(--text-3)",
                    fontSize: 9,
                    marginLeft: "auto",
                  }}
                >
                  {mode.time}
                </span>
              </div>
              <div
                style={{
                  color: "var(--text-3)",
                  fontSize: 10.25,
                  lineHeight: 1.45,
                  marginTop: 4,
                }}
              >
                {mode.description}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ExecutionPlanEditor({
  template,
  steps,
  fleet,
  selectedModel,
  modelChoice,
  modelReason,
  onModelChange,
}: {
  template: AgentBuilderTemplate;
  steps: AgentBuilderStep[];
  fleet: FleetEntry[];
  selectedModel: string;
  modelChoice: string;
  modelReason: string;
  onModelChange: (stepId: string, value: string) => void;
}) {
  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: 10,
          padding: 10,
          marginBottom: 10,
          background: "var(--panel-2)",
          border: "1px solid var(--border)",
          borderRadius: 5,
        }}
      >
        <Icon
          name="spark"
          size={12}
          style={{ color: "var(--signal)", marginTop: 2 }}
        />
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              flexWrap: "wrap",
            }}
          >
            <Badge tone={modelChoice === AUTO_MODEL ? "signal" : "blue"}>
              {modelChoice === AUTO_MODEL ? "Auto model" : "Fixed model"}
            </Badge>
            <span
              className="mono"
              style={{ color: "var(--text)", fontSize: 11.5 }}
            >
              {selectedModel}
            </span>
          </div>
          <div
            style={{
              color: "var(--text-3)",
              fontSize: 10.5,
              lineHeight: 1.5,
              marginTop: 5,
            }}
          >
            {modelReason}
          </div>
        </div>
      </div>
      <SectionLabel>
        {template.name} plan · {steps.length} steps
      </SectionLabel>
      <div style={{ display: "grid", gap: 7 }}>
        {steps.map((item, index) => {
          const usesModel = item.execution === "llm";
          return (
            <div
              key={item.id}
              style={{
                display: "grid",
                gridTemplateColumns: "32px minmax(0, 1fr) 260px",
                gap: 10,
                alignItems: "center",
                padding: "9px 10px",
                background: "var(--panel-2)",
                border: "1px solid var(--border)",
                borderRadius: 5,
              }}
            >
              <span
                className="mono"
                style={{
                  width: 24,
                  height: 24,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  borderRadius: "50%",
                  border: "1px solid var(--border-2)",
                  color: "var(--text-3)",
                  fontSize: 10,
                }}
              >
                {index + 1}
              </span>
              <div style={{ minWidth: 0 }}>
                <div
                  style={{
                    color: "var(--text)",
                    fontSize: 11.5,
                    fontWeight: 500,
                  }}
                >
                  {item.title}
                </div>
                <div
                  style={{
                    color: "var(--text-3)",
                    fontSize: 10.5,
                    lineHeight: 1.45,
                    marginTop: 2,
                  }}
                >
                  {item.description}
                </div>
              </div>
              {!usesModel ? (
                <div
                  style={{
                    color: "var(--violet)",
                    fontSize: 11,
                    textAlign: "right",
                  }}
                >
                  Human checkpoint · no LLM
                </div>
              ) : (
                <select
                  aria-label={`Model for ${item.title}`}
                  value={item.modelOverride ?? INHERIT_MODEL}
                  onChange={(event) =>
                    onModelChange(item.id, event.target.value)
                  }
                  style={editSelectStyle}
                >
                  <option value={INHERIT_MODEL}>
                    Inherit agent model · {selectedModel}
                  </option>
                  {fleet.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.alias || entry.modelName} · {entry.provider}
                    </option>
                  ))}
                </select>
              )}
            </div>
          );
        })}
      </div>
      <InlineMessage tone="signal">
        Override only the steps that need a different cost, latency, context, or
        reasoning profile. Other steps inherit the agent model.
      </InlineMessage>
    </div>
  );
}

function OntologyCapability({
  isLoading,
  tools,
}: {
  isLoading: boolean;
  tools: ToolCatalogEntry[];
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 10,
        padding: 11,
        marginBottom: 8,
        background: "rgba(181,148,255,0.06)",
        border: "1px solid rgba(181,148,255,0.30)",
        borderRadius: 5,
      }}
    >
      <Icon
        name="workflow"
        size={13}
        style={{ color: "var(--violet)", marginTop: 2 }}
      />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
          <span style={{ color: "var(--text)", fontSize: 12, fontWeight: 500 }}>
            Ontology API
          </span>
          <Badge tone="violet">Included</Badge>
        </div>
        <div
          style={{
            color: "var(--text-2)",
            fontSize: 10.75,
            lineHeight: 1.55,
            marginTop: 4,
          }}
        >
          Every agent can discover the graph schema, resolve entities, and run
          tenant-scoped Neo4j reads through approved tools. The runtime supplies
          credentials; prompts never see them.
        </div>
        <div
          className="mono"
          style={{ color: "var(--text-3)", fontSize: 9.75, marginTop: 6 }}
        >
          {isLoading
            ? "Loading graph capabilities…"
            : tools.length > 0
              ? tools.map((tool) => tool.name).join(" · ")
              : "Ontology binding will be resolved when the agent is published."}
        </div>
      </div>
    </div>
  );
}

function PublishedAgentSummary({
  result,
  tenant,
}: {
  result: DeployAuthoredAgentResponse;
  tenant: string;
}) {
  return (
    <div style={{ maxWidth: 680, margin: "20px auto" }}>
      <div
        style={{
          width: 42,
          height: 42,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          marginBottom: 14,
          borderRadius: "50%",
          background: "rgba(101,224,163,0.10)",
          border: "1px solid rgba(101,224,163,0.35)",
          color: "var(--green)",
        }}
      >
        <Icon name="check" size={20} />
      </div>
      <div style={{ color: "var(--text)", fontSize: 21, fontWeight: 500 }}>
        {result.agent.title} is live
      </div>
      <div
        style={{
          color: "var(--text-2)",
          fontSize: 12,
          lineHeight: 1.65,
          marginTop: 6,
        }}
      >
        The agent is published in <span className="mono">{tenant}</span>,
        registered with the runtime, and ready to run whenever one of its
        trigger events arrives.
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 8,
          marginTop: 18,
        }}
      >
        <Panel title="Runtime" padded>
          <ValidationLine
            ok
            label="Function registered"
            hint={result.runtime.functionId}
          />
          <ValidationLine ok label="Workflow version" hint={result.version} />
          <ValidationLine
            ok
            label="Live deployment"
            hint={result.deploymentId}
          />
        </Panel>
        <Panel title="Next step" padded>
          <div
            style={{ color: "var(--text-2)", fontSize: 11, lineHeight: 1.6 }}
          >
            Open the agent to test it with a message or send one of its trigger
            events. Live runs, steps, logs, and emitted events will appear in
            Agent Studio.
          </div>
          {result.events.created.length > 0 && (
            <div
              className="mono"
              style={{ color: "var(--green)", fontSize: 10, marginTop: 8 }}
            >
              {result.events.created.length} event type
              {result.events.created.length === 1 ? "" : "s"} created
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 11,
        fontFamily: "var(--mono)",
        textTransform: "uppercase",
        color: "var(--text-3)",
        letterSpacing: "0.08em",
        marginBottom: 10,
      }}
    >
      {children}
    </div>
  );
}

function PromptGenerationProgress({ compact = false }: { compact?: boolean }) {
  return (
    <div
      className={`new-agent-prompt-progress${compact ? " new-agent-prompt-progress--compact" : ""}`}
      role="status"
      aria-live="polite"
    >
      <span className="new-agent-prompt-progress__orb" aria-hidden="true">
        <Icon name="spark" size={compact ? 12 : 14} />
      </span>
      <span className="new-agent-prompt-progress__copy">
        <strong>Generating system prompt</strong>
        <span>
          Analyzing purpose, event contract, execution plan, tools, and model
          policy…
        </span>
      </span>
      <span className="new-agent-prompt-progress__dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
    </div>
  );
}

function EditField({
  className,
  htmlFor,
  label,
  hint,
  children,
}: {
  className?: string;
  htmlFor?: string;
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`new-agent-edit-field${className ? ` ${className}` : ""}`}
      style={{ padding: "10px 0", borderBottom: "1px solid var(--border)" }}
    >
      {htmlFor ? (
        <label
          className="new-agent-edit-field-label"
          htmlFor={htmlFor}
          style={{
            fontSize: 11,
            color: "var(--text)",
            marginBottom: 3,
            fontWeight: 500,
          }}
        >
          {label}
        </label>
      ) : (
        <div
          className="new-agent-edit-field-label"
          style={{
            fontSize: 11,
            color: "var(--text)",
            marginBottom: 3,
            fontWeight: 500,
          }}
        >
          {label}
        </div>
      )}
      {hint && (
        <div
          className="new-agent-edit-field-hint"
          style={{
            fontSize: 11,
            color: "var(--text-3)",
            marginBottom: 6,
            lineHeight: 1.5,
          }}
        >
          {hint}
        </div>
      )}
      {children}
    </div>
  );
}

function EditText({
  id,
  value,
  onChange,
  mono,
  suffix,
}: {
  id?: string;
  value: string;
  onChange: (v: string) => void;
  mono?: boolean;
  suffix?: string;
}) {
  return (
    <div
      className="new-agent-edit-control new-agent-edit-text"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        background: "var(--panel-2)",
        border: "1px solid var(--border-2)",
        borderRadius: 4,
        padding: "5px 8px",
      }}
    >
      <input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{
          flex: 1,
          background: "transparent",
          border: "none",
          outline: "none",
          color: "var(--text)",
          fontFamily: mono ? "var(--mono)" : "var(--sans)",
          fontSize: mono ? 11.5 : 12,
        }}
      />
      {suffix && (
        <span
          style={{
            fontSize: 10.5,
            color: "var(--text-3)",
            fontFamily: "var(--mono)",
          }}
        >
          {suffix}
        </span>
      )}
    </div>
  );
}

function EditTextarea({
  id,
  className,
  ariaLabel,
  value,
  onChange,
  rows = 3,
  mono,
  readOnly,
}: {
  id?: string;
  className?: string;
  ariaLabel?: string;
  value: string;
  onChange: (v: string) => void;
  rows?: number;
  mono?: boolean;
  readOnly?: boolean;
}) {
  return (
    <textarea
      id={id}
      className={`new-agent-edit-control new-agent-edit-textarea${className ? ` ${className}` : ""}`}
      aria-label={ariaLabel}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      rows={rows}
      readOnly={readOnly}
      style={{
        width: "100%",
        background: "var(--panel-2)",
        border: "1px solid var(--border-2)",
        borderRadius: 4,
        padding: "6px 8px",
        color: "var(--text)",
        fontFamily: mono ? "var(--mono)" : "var(--sans)",
        fontSize: mono ? 11.5 : 12,
        outline: "none",
        resize: "vertical",
        lineHeight: 1.55,
      }}
    />
  );
}

function EventPicker({
  inputId,
  selected,
  onAdd,
  onRemove,
  tone,
  all,
  newEvents,
}: {
  inputId?: string;
  selected: string[];
  onAdd: (v: string) => void;
  onRemove: (v: string) => void;
  tone: "blue" | "green";
  all: string[];
  newEvents: string[];
}) {
  const [input, setInput] = useState("");
  const colorMap = {
    blue: {
      fg: "var(--blue)",
      bg: "rgba(132,169,255,0.10)",
      bd: "rgba(132,169,255,0.32)",
    },
    green: {
      fg: "var(--green)",
      bg: "rgba(101,224,163,0.08)",
      bd: "rgba(101,224,163,0.30)",
    },
  } as const;
  const c = colorMap[tone] ?? colorMap.blue;
  const normalizedInput = normalizeAuthoredEventName(input);
  const suggestions = input
    ? all
        .filter(
          (e) =>
            e.toLowerCase().includes(input.toLowerCase()) &&
            e !== normalizedInput &&
            !selected.includes(e),
        )
        .slice(0, 6)
    : [];
  const canAddInput =
    Boolean(normalizedInput) && !selected.includes(normalizedInput);
  const isNewInput = canAddInput && !all.includes(normalizedInput);

  function commitInput(value = input) {
    if (!normalizeAuthoredEventName(value)) return;
    onAdd(value);
    setInput("");
  }

  return (
    <div className="new-agent-event-picker">
      <div
        className="new-agent-event-picker__tokens"
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 4,
          marginBottom: 6,
        }}
      >
        {selected.length === 0 && (
          <span style={{ fontSize: 11, color: "var(--text-3)" }}>
            None yet — type a name below to add.
          </span>
        )}
        {selected.map((t) => (
          <span
            key={t}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              padding: "2px 4px 2px 7px",
              fontSize: 10.5,
              fontFamily: "var(--mono)",
              textTransform: "uppercase",
              color: c.fg,
              background: c.bg,
              border: `1px solid ${c.bd}`,
              borderRadius: 3,
            }}
          >
            {t}
            {newEvents.includes(t) && (
              <span
                style={{
                  fontSize: 8,
                  fontWeight: 700,
                  letterSpacing: "0.06em",
                  opacity: 0.75,
                }}
              >
                NEW
              </span>
            )}
            <button
              onClick={() => onRemove(t)}
              aria-label={`Remove ${t}`}
              style={{ color: "currentColor", opacity: 0.6, padding: 1 }}
            >
              <Icon name="x" size={8} />
            </button>
          </span>
        ))}
      </div>
      <div style={{ position: "relative" }}>
        <input
          id={inputId}
          className="new-agent-edit-control new-agent-event-picker__input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && input.trim()) {
              e.preventDefault();
              commitInput();
            }
          }}
          placeholder="Search or name a new event…"
          style={{
            width: "100%",
            background: "var(--panel-2)",
            border: "1px solid var(--border-2)",
            borderRadius: 4,
            padding: "5px 8px",
            color: "var(--text)",
            fontFamily: "var(--mono)",
            fontSize: 11.5,
            outline: "none",
          }}
        />
        {(suggestions.length > 0 || canAddInput) && (
          <div
            style={{
              position: "absolute",
              top: "100%",
              left: 0,
              right: 0,
              marginTop: 2,
              background: "var(--panel)",
              border: "1px solid var(--border-2)",
              borderRadius: 4,
              boxShadow: "0 8px 20px rgba(0,0,0,0.4)",
              zIndex: "var(--z-overlay)" as unknown as number,
              maxHeight: 180,
              overflow: "auto",
            }}
          >
            {canAddInput && (
              <button
                type="button"
                onClick={() => commitInput()}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 7,
                  width: "100%",
                  padding: "7px 8px",
                  fontSize: 11.5,
                  color: isNewInput ? "var(--signal)" : "var(--text-2)",
                  textAlign: "left",
                  borderBottom:
                    suggestions.length > 0 ? "1px solid var(--border)" : "none",
                  background: isNewInput
                    ? "rgba(203,255,0,0.05)"
                    : "transparent",
                }}
              >
                <Icon name="plus" size={10} />
                <span>{isNewInput ? "Create new event" : "Use event"}</span>
                <span
                  className="mono"
                  style={{ marginLeft: "auto", color: "var(--text)" }}
                >
                  {normalizedInput}
                </span>
              </button>
            )}
            {suggestions.map((s) => (
              <button
                type="button"
                key={s}
                onClick={() => {
                  commitInput(s);
                }}
                style={{
                  display: "flex",
                  width: "100%",
                  padding: "5px 8px",
                  fontSize: 11.5,
                  fontFamily: "var(--mono)",
                  color: "var(--text-2)",
                  textAlign: "left",
                }}
              >
                {s}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ValidationLine({
  ok,
  warn,
  label,
  hint,
}: {
  ok?: boolean;
  warn?: boolean;
  label: string;
  hint?: string;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "5px 0",
        fontSize: 11.5,
      }}
    >
      <Icon
        name={ok ? "check" : warn ? "alert" : "x"}
        size={11}
        style={{
          color: ok ? "var(--green)" : warn ? "var(--amber)" : "var(--red)",
        }}
      />
      <span style={{ color: "var(--text-2)" }}>{label}</span>
      {hint && (
        <span
          style={{
            marginLeft: "auto",
            color: "var(--text-3)",
            fontFamily: "var(--mono)",
            fontSize: 10.5,
          }}
        >
          {hint}
        </span>
      )}
    </div>
  );
}

function InlineMessage({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone: "signal" | "green" | "amber" | "red";
}) {
  const color =
    tone === "signal"
      ? "var(--signal)"
      : tone === "green"
        ? "var(--green)"
        : tone === "amber"
          ? "var(--amber)"
          : "var(--red)";
  return (
    <div
      style={{
        marginTop: 6,
        padding: "6px 8px",
        background: "var(--bg-2)",
        border: `1px solid color-mix(in srgb, ${color} 35%, transparent)`,
        borderRadius: 4,
        color,
        fontSize: 11,
        lineHeight: 1.5,
      }}
    >
      {children}
    </div>
  );
}

const editSelectStyle = {
  background: "var(--panel-2)",
  border: "1px solid var(--border-2)",
  borderRadius: 4,
  padding: "5px 8px",
  color: "var(--text)",
  fontFamily: "var(--mono)",
  fontSize: 12,
  outline: "none",
  width: "100%",
} as const;
