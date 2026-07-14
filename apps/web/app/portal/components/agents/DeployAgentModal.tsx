"use client";

/**
 * DeployAgentModal — 6-step wizard for adding a new agent to the workflow.
 *
 * Live data via canonical TanStack hooks. Prompt generation and deployment
 * are server-backed; the prompt remains fully editable before deployment.
 */

import { useEffect, useMemo, useState } from "react";
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
import { useFleet } from "@/lib/hooks/useModelFleet";
import { useTools, type ToolCatalogEntry } from "@/lib/hooks/useTools";
import {
  useDeployAuthoredAgent,
  useGenerateAgentPrompt,
  type GenerateAgentPromptBody,
} from "@/lib/hooks/useAgentAuthoring";
import { useTenant } from "@/app/portal/lib/use-tenant";
import { useToast } from "@/app/portal/components/toast";
import { normalizeAuthoredEventName } from "./event-name";

// Static workflow ontology labels — mirrors the dashboard funnel.
const STAGE_LABELS: Record<number, string> = {
  0: "Intake",
  1: "Analyze",
  2: "JD",
  3: "Publish",
  4: "Resume",
  5: "Match & Interview",
  6: "Package",
  7: "Submit",
};

const AGENT_TEMPLATES = [
  { id: "blank", actor: "Agent" as const, name: "Blank agent", desc: "Empty handler. Bring your own steps + prompt.", color: "var(--text-3)" },
  { id: "classify", actor: "Agent" as const, name: "Classifier", desc: "Single LLM call, returns one of N labels. Cheap and fast.", color: "var(--blue)" },
  { id: "extract", actor: "Agent" as const, name: "Extractor", desc: "Pulls structured JSON from unstructured input. JSON schema enforced.", color: "var(--blue)" },
  { id: "rag", actor: "Agent" as const, name: "RAG retriever", desc: "Embeds question, fetches top-k chunks, answers with citations.", color: "var(--violet)" },
  { id: "loop", actor: "Agent" as const, name: "Tool-loop agent", desc: "Iterates tool calls until done. Use for research, browsing, data lookups.", color: "var(--signal)" },
  { id: "human", actor: "Human" as const, name: "Human approval", desc: "Pauses the workflow for an operator to approve, reject, or supplement.", color: "var(--violet)" },
] as const;

type Template = (typeof AGENT_TEMPLATES)[number];

export function DeployAgentModal({
  onClose,
}: {
  onClose: () => void;
}) {
  const tenant = useTenant();
  const toast = useToast();
  const { data: dag } = useDag();
  const { data: liveEvents = [] } = useEvents({ limit: 100 });
  const { data: eventCatalog = [] } = useEventCatalog();
  const { data: fleet = [], isLoading: fleetLoading } = useFleet();
  const { data: toolCatalog, isLoading: toolsLoading } = useTools();
  const generatePrompt = useGenerateAgentPrompt();
  const deployAgent = useDeployAuthoredAgent();
  // Derive stages from the live DAG (set of stage indices in use).
  const stages = useMemo(() => {
    const used = new Set<number>();
    for (const a of dag?.agents ?? []) used.add(a.stage);
    for (const id of Object.keys(STAGE_LABELS)) used.add(Number(id));
    return Array.from(used)
      .sort((a, b) => a - b)
      .map((id) => ({ id, label: STAGE_LABELS[id] ?? `Stage ${id}` }));
  }, [dag]);
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
  const [template, setTemplate] = useState<Template | null>(null);
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [desc, setDesc] = useState("");
  const [stage, setStage] = useState(5);
  const [fleetId, setFleetId] = useState("");
  const [tools, setTools] = useState<string[]>([]);
  const [triggers, setTriggers] = useState<string[]>([]);
  const [emits, setEmits] = useState<string[]>([]);
  const [retries, setRetries] = useState(3);
  const [timeout, setTimeoutVal] = useState(120);
  const [concurrency, setConcurrency] = useState(8);
  const [implTab, setImplTab] = useState<"prompt" | "code" | "tools" | "bind">("prompt");
  const [tsCode, setTsCode] = useState("");
  const [toolUse, setToolUse] = useState<ToolUseSchema[]>([]);
  const [systemPrompt, setSystemPrompt] = useState("");
  const [promptError, setPromptError] = useState<string | null>(null);
  const [deployError, setDeployError] = useState<string | null>(null);

  const steps = ["Template", "Identity", "Events", "Implementation", "Behavior", "Review"];

  const selectedModel = fleet.find((entry) => entry.id === fleetId);
  const availableTools = toolCatalog?.tools ?? [];
  const nameValid = /^[a-z][A-Za-z0-9]*$/.test(name);
  const identityValid = nameValid && title.trim().length > 0 && desc.trim().length >= 10;
  const eventsValid = triggers.length > 0;
  const implementationValid = systemPrompt.trim().length >= 40;
  const behaviorValid = retries >= 0 && retries <= 10 && timeout >= 1 && timeout <= 3600 && concurrency >= 1 && concurrency <= 100;
  const allValid = Boolean(template) && identityValid && eventsValid && implementationValid && behaviorValid;

  useEffect(() => {
    if (fleetId || fleet.length === 0) return;
    setFleetId((fleet.find((entry) => entry.role === "primary") ?? fleet[0])!.id);
  }, [fleet, fleetId]);

  function pickTemplate(t: Template) {
    setTemplate(t);
    setStep(1);
  }

  function promptBody(): GenerateAgentPromptBody {
    return {
      name,
      title: title.trim(),
      description: desc.trim(),
      actor: template?.actor ?? "Agent",
      template: template?.id ?? "blank",
      stage,
      triggers,
      emits,
      tools: authoredTools(),
      ...(selectedModel
        ? { provider: selectedModel.provider as GenerateAgentPromptBody["provider"], model: selectedModel.modelName }
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

  async function requestSystemPrompt() {
    if (!identityValid || !eventsValid || !template) return;
    setPromptError(null);
    try {
      const result = await generatePrompt.mutateAsync(promptBody());
      setSystemPrompt(result.systemPrompt);
    } catch (error) {
      setPromptError(error instanceof Error ? error.message : "Could not generate the system prompt");
    }
  }

  function next() {
    if (step === 2) {
      setStep(3);
      if (!systemPrompt.trim()) void requestSystemPrompt();
      return;
    }
    setStep((s) => Math.min(steps.length - 1, s + 1));
  }
  function back() {
    setStep((s) => Math.max(0, s - 1));
  }
  function toToolUse(tool: ToolCatalogEntry): ToolUseSchema {
    const fields = tool.argsSchema ?? {};
    return {
      name: tool.name,
      description: tool.description ?? tool.summary,
      input_schema: {
        type: "object",
        properties: Object.fromEntries(
          Object.entries(fields).map(([key, field]) => [
            key,
            { type: field.type || "string", ...(field.description ? { description: field.description } : {}) },
          ]),
        ),
        required: Object.entries(fields).filter(([, field]) => field.required).map(([key]) => key),
      },
    };
  }

  function toggleTool(tool: ToolCatalogEntry) {
    const isSelected = tools.includes(tool.name);
    setTools((current) => isSelected ? current.filter((name) => name !== tool.name) : [...current, tool.name]);
    setToolUse((current) => isSelected
      ? current.filter((entry) => entry.name !== tool.name)
      : current.some((entry) => entry.name === tool.name) ? current : [...current, toToolUse(tool)]);
  }
  function addEvent(set: React.Dispatch<React.SetStateAction<string[]>>, val: string) {
    const v = normalizeAuthoredEventName(val);
    if (!v) return;
    if (!existingEvents.includes(v)) {
      setCreatedEvents((current) => current.includes(v) ? current : [...current, v]);
    }
    set((arr) => (arr.includes(v) ? arr : [...arr, v]));
  }
  function removeEvent(set: React.Dispatch<React.SetStateAction<string[]>>, v: string) {
    set((arr) => arr.filter((x) => x !== v));
  }
  function addSingleEmit(val: string) {
    const v = normalizeAuthoredEventName(val);
    if (!v) return;
    if (!existingEvents.includes(v)) {
      setCreatedEvents((current) => current.includes(v) ? current : [...current, v]);
    }
    setEmits([v]);
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
        stage: context.stage,
        triggers: context.triggers,
        emits: context.emits,
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
        title: `${result.agent.title} deployed`,
        description: `${result.runtime.functionId} is loaded in the live runtime.${result.events.created.length > 0 ? ` ${result.events.created.length} new event type${result.events.created.length === 1 ? "" : "s"} created.` : ""}`,
      });
      onClose();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Agent deployment failed";
      setDeployError(message);
      toast({ tone: "red", title: "Deploy failed", description: message });
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
        <header style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px 18px", borderBottom: "1px solid var(--border)" }}>
          <Icon name="agent" size={14} style={{ color: "var(--signal)" }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, color: "var(--text)", fontWeight: 500 }}>Deploy new agent</div>
            <div style={{ fontSize: 11, color: "var(--text-3)" }}>
              Saves a new manifest version for <span className="mono">{tenant}</span> and loads the agent into the live runtime.
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close deploy agent modal"
            style={{ color: "var(--text-3)" }}
          >
            <Icon name="x" size={13} />
          </button>
        </header>

        <div
          style={{
            display: "flex",
            gap: 6,
            padding: "10px 18px",
            borderBottom: "1px solid var(--border)",
            background: "var(--bg-2)",
          }}
        >
          {steps.map((s, i) => (
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
                  color: i < step ? "#000" : i === step ? "var(--signal)" : "var(--text-3)",
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
              {i < steps.length - 1 && (
                <span style={{ width: 14, height: 1, background: "var(--border)", marginLeft: 4 }} />
              )}
            </div>
          ))}
        </div>

        <div style={{ padding: 20, overflow: "auto", flex: 1, minHeight: 0 }}>
          {step === 0 && (
            <div>
              <SectionLabel>Pick a template</SectionLabel>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
                {AGENT_TEMPLATES.map((t) => (
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
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
                      <ActorTag actor={t.actor} />
                    </div>
                    <div style={{ fontSize: 13, color: "var(--text)", fontWeight: 500, marginBottom: 3 }}>{t.name}</div>
                    <div style={{ fontSize: 11.5, color: "var(--text-2)", lineHeight: 1.5 }}>{t.desc}</div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {step === 1 && template && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, maxWidth: 760 }}>
              <EditField label="Name (id)" hint="lowercase camelCase, used in events & logs">
                <EditText value={name} onChange={setName} mono />
                {name.length > 0 && !nameValid && (
                  <InlineMessage tone="red">Start with a lowercase letter and use letters or numbers only.</InlineMessage>
                )}
              </EditField>
              <EditField label="Title" hint="Shown in the operator UI">
                <EditText value={title} onChange={setTitle} />
              </EditField>
              <div style={{ gridColumn: "1 / -1" }}>
                <EditField label="Description" hint="One paragraph. Shown in the workflow graph inspector.">
                  <EditTextarea value={desc} onChange={setDesc} rows={3} />
                  {desc.length > 0 && desc.trim().length < 10 && (
                    <InlineMessage tone="red">Describe the agent in at least 10 characters.</InlineMessage>
                  )}
                </EditField>
              </div>
              <EditField label="Workflow stage" hint="Column on the workflow canvas.">
                <select
                  value={stage}
                  onChange={(e) => setStage(parseInt(e.target.value, 10))}
                  style={editSelectStyle}
                >
                  {stages.map((s) => (
                    <option key={s.id} value={s.id}>
                      {String(s.id).padStart(2, "0")} · {s.label}
                    </option>
                  ))}
                </select>
              </EditField>
              <EditField label="Actor" hint={template.actor === "Human" ? "Pauses for operator input" : "Runs automatically"}>
                <Seg
                  value={template.actor}
                  onChange={() => {}}
                  options={[
                    { value: "Agent", label: "Agent" },
                    { value: "Human", label: "Human task" },
                  ]}
                />
              </EditField>
            </div>
          )}

          {step === 2 && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, maxWidth: 760 }}>
              <EditField label="Listens to (triggers)" hint="Pick an existing event or create a new event type. New types are saved when the agent is deployed.">
                <EventPicker
                  selected={triggers}
                  onAdd={(v) => addEvent(setTriggers, v)}
                  onRemove={(v) => removeEvent(setTriggers, v)}
                  tone="blue"
                  all={events}
                  newEvents={draftNewEvents}
                />
                {triggers.length === 0 && (
                  <InlineMessage tone="amber">At least one trigger is required so the runtime can start this agent.</InlineMessage>
                )}
              </EditField>
              <EditField label="Emits (outbound)" hint="Pick or create the event this agent publishes. Downstream agents can listen to it.">
                <EventPicker
                  selected={emits}
                  onAdd={addSingleEmit}
                  onRemove={(v) => removeEvent(setEmits, v)}
                  tone="green"
                  all={events}
                  newEvents={draftNewEvents}
                />
              </EditField>
            </div>
          )}

          {step === 3 && (
            <div>
              <div
                style={{
                  display: "flex",
                  gap: 0,
                  borderBottom: "1px solid var(--border)",
                  marginBottom: 14,
                }}
              >
                {([
                  { id: "prompt", label: "System prompt", icon: "logs" as const },
                  { id: "code", label: "TypeScript code", icon: "code" as const },
                  { id: "tools", label: "tool_use", icon: "spark" as const },
                  { id: "bind", label: "Tool bindings", icon: "git" as const },
                ] as const).map((t) => (
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
                <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8, padding: "4px 0" }}>
                  <span style={{ fontSize: 11, color: "var(--text-3)" }}>Model</span>
                  <select
                    value={fleetId}
                    onChange={(e) => setFleetId(e.target.value)}
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
                    {fleetLoading ? (
                      <option value="">Loading models…</option>
                    ) : fleet.length === 0 ? (
                      <option value="">Workspace default</option>
                    ) : (
                      fleet.map((entry) => (
                        <option key={entry.id} value={entry.id}>
                          {entry.alias || entry.modelName} · {entry.provider}
                        </option>
                      ))
                    )}
                  </select>
                </div>
              </div>

              {implTab === "prompt" && (
                <div>
                  <div style={{ display: "flex", alignItems: "end", gap: 10 }}>
                    <div style={{ flex: 1 }}>
                      <EditField
                        label="System prompt"
                        hint="Generated from the description, events, and tools. Review and edit it before deployment."
                      >
                        <EditTextarea
                          value={systemPrompt}
                          onChange={setSystemPrompt}
                          rows={18}
                          mono
                        />
                      </EditField>
                    </div>
                    <Button
                      tone="default"
                      icon="spark"
                      onClick={() => void requestSystemPrompt()}
                      disabled={generatePrompt.isPending || !identityValid || !eventsValid}
                      style={{ marginBottom: 11 }}
                    >
                      {generatePrompt.isPending ? "Generating…" : systemPrompt ? "Regenerate" : "Generate"}
                    </Button>
                  </div>
                  {generatePrompt.isPending && (
                    <InlineMessage tone="signal">Building a comprehensive prompt from the agent description…</InlineMessage>
                  )}
                  {promptError && <InlineMessage tone="red">{promptError}</InlineMessage>}
                  {!generatePrompt.isPending && !promptError && systemPrompt.trim().length > 0 && systemPrompt.trim().length < 40 && (
                    <InlineMessage tone="red">The system prompt must contain at least 40 characters.</InlineMessage>
                  )}
                </div>
              )}

              {implTab === "code" && (
                <EditField
                  label="TypeScript source (optional)"
                  hint="Stored with the manifest as implementation metadata. Generated manifest agents execute through the system prompt and runtime tool loop."
                >
                  <EditTextarea value={tsCode} onChange={setTsCode} rows={18} mono />
                </EditField>
              )}
              {implTab === "tools" && (
                toolUse.length > 0 ? (
                  <AgentToolUseEditPanel tools={toolUse} onChange={setToolUse} />
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
                    No tools selected. Choose workspace tools under <span className="mono" style={{ color: "var(--text-2)" }}>Tool bindings</span>; their live schemas will appear here for editing.
                  </div>
                )
              )}

              {implTab === "bind" && (
                <EditField
                  label={`Tool bindings · ${tools.length} selected`}
                  hint="Workspace tools this agent's code may invoke at runtime."
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
                      <div style={{ color: "var(--text-3)", fontSize: 11.5 }}>Loading workspace tools…</div>
                    )}
                    {!toolsLoading && availableTools.length === 0 && (
                      <div style={{ color: "var(--text-3)", fontSize: 11.5 }}>No workspace tools are registered.</div>
                    )}
                    {availableTools.map((tool) => {
                      const on = tools.includes(tool.name);
                      return (
                        <button
                          key={tool.name}
                          onClick={() => toggleTool(tool)}
                          title={tool.description ?? tool.summary}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                            padding: "7px 9px",
                            background: on ? "rgba(208,255,0,0.06)" : "var(--panel-2)",
                            border: `1px solid ${on ? "var(--signal)" : "var(--border)"}`,
                            borderRadius: 4,
                            textAlign: "left",
                          }}
                        >
                          <span
                            style={{
                              width: 12,
                              height: 12,
                              borderRadius: 2,
                              background: on ? "var(--signal)" : "transparent",
                              border: `1px solid ${on ? "var(--signal)" : "var(--border-3)"}`,
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                            }}
                          >
                            {on && <Icon name="check" size={9} style={{ color: "#000" }} />}
                          </span>
                          <span className="mono" style={{ fontSize: 11.5, color: "var(--text)" }}>{tool.name}</span>
                          <Badge tone="muted" style={{ marginLeft: "auto" }}>{tool.category}</Badge>
                        </button>
                      );
                    })}
                  </div>
                </EditField>
              )}
            </div>
          )}

          {step === 4 && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, maxWidth: 760 }}>
              <EditField label="Retries" hint="On tool/model errors. Exponential backoff.">
                <EditText
                  value={String(retries)}
                  onChange={(v) => setRetries(parseInt(v, 10) || 0)}
                  mono
                  suffix="attempts"
                />
              </EditField>
              <EditField label="Per-run timeout">
                <EditText
                  value={String(timeout)}
                  onChange={(v) => setTimeoutVal(parseInt(v, 10) || 0)}
                  mono
                  suffix="seconds"
                />
              </EditField>
              <EditField label="Concurrency" hint="Max simultaneous runs.">
                <EditText
                  value={String(concurrency)}
                  onChange={(v) => setConcurrency(parseInt(v, 10) || 0)}
                  mono
                  suffix="runs"
                />
              </EditField>
              <div style={{ gridColumn: "1 / -1" }}>
                <InlineMessage tone="signal">
                  Concurrency is partitioned by the runtime event subject. Exhausted retries are recorded in the run and audit logs.
                </InlineMessage>
              </div>
            </div>
          )}

          {step === 5 && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
              <Panel title="Manifest" padded={false}>
                <CodeBlock>
                  {JSON.stringify(
                    {
                      id: `${stage}-${name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase() || "new-agent"}`,
                      name: name || "newAgent",
                      title: title || "New agent",
                      description: desc,
                      actor: [template?.actor || "Agent"],
                      trigger: triggers,
                      actions: [
                        {
                          order: "1",
                          name: name || "newAgent",
                          description: desc,
                          type: template?.actor === "Human" ? "manual" : "logic",
                        },
                      ],
                      triggered_event: emits,
                      generated: template?.actor !== "Human",
                      ontology_instructions: systemPrompt,
                      tool_use: toolUse,
                      model: selectedModel?.modelName,
                      retries,
                      concurrency: { enabled: true, max_concurrent_executions: concurrency },
                      timeout_s: timeout,
                      ...(tsCode.trim() ? { typescript_code: `<inline · ${tsCode.split("\n").length} lines>` } : {}),
                    },
                    null,
                    2,
                  )}
                </CodeBlock>
              </Panel>
              <div>
                <Panel title="Pre-flight" padded>
                  <ValidationLine ok={identityValid} label="Identity valid" hint={identityValid ? "ready" : "name, title, description required"} />
                  <ValidationLine ok={triggers.length > 0} label={`${triggers.length} trigger event(s)`} />
                  <ValidationLine ok={emits.length > 0} warn={emits.length === 0} label={`${emits.length} emit event(s)`} />
                  <ValidationLine ok={implementationValid} label="System prompt ready" hint={`${systemPrompt.trim().length} chars`} />
                  <ValidationLine ok label={`${tools.length} live tool binding(s)`} />
                  {template?.actor !== "Human" && (
                    <ValidationLine ok label={tsCode.trim() ? `typescript_code metadata · ${tsCode.split("\n").length} lines` : "No TypeScript metadata"} />
                  )}
                  {template?.actor !== "Human" && (
                    <ValidationLine
                      ok
                      warn={toolUse.length === 0}
                      label={`tool_use · ${toolUse.length} defined`}
                      hint={toolUse.length ? "live catalog schemas" : "optional"}
                    />
                  )}
                  <ValidationLine ok label="Model selection" hint={selectedModel ? `${selectedModel.provider}/${selectedModel.modelName}` : "workspace default"} />
                  <ValidationLine ok={behaviorValid} label="Runtime limits valid" />
                </Panel>
                <Panel title="Deploy target" padded style={{ marginTop: 12 }}>
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
                    <Icon name="deploy" size={12} style={{ color: "var(--signal)" }} />
                    <div>
                      <div style={{ fontSize: 12, color: "var(--text)" }}>Live runtime · <span className="mono">{tenant}</span></div>
                      <div style={{ fontSize: 10.5, color: "var(--text-3)" }}>Persist manifest, create a workflow version, and hot-load the runtime function</div>
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
                    Deployment succeeds only after the API confirms <span className="mono" style={{ color: "var(--text-2)" }}>{tenant}.{name || "agentName"}</span> is registered and running.
                  </div>
                </Panel>
                {deployError && <InlineMessage tone="red">{deployError}</InlineMessage>}
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
          {step > 0 && (
            <Button tone="ghost" icon="chevron-left" onClick={back}>
              Back
            </Button>
          )}
          <span style={{ fontSize: 11, color: "var(--text-3)" }}>
            Step {step + 1} of {steps.length}
          </span>
          <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
            <Button tone="ghost" onClick={onClose}>Cancel</Button>
            {step < steps.length - 1 ? (
              <Button tone="primary" onClick={next} disabled={!canContinue()}>
                {step === 2 && generatePrompt.isPending ? "Generating…" : "Continue"}
              </Button>
            ) : (
              <Button tone="primary" icon="deploy" onClick={() => void deploy()} disabled={!allValid || deployAgent.isPending}>
                {deployAgent.isPending ? "Deploying…" : "Deploy agent"}
              </Button>
            )}
          </div>
        </footer>
      </div>
    </ModalOverlay>
  );
}

// ---- small atoms (settings-local pattern) ----

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

function EditField({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ padding: "10px 0", borderBottom: "1px solid var(--border)" }}>
      <div style={{ fontSize: 11, color: "var(--text)", marginBottom: 3, fontWeight: 500 }}>{label}</div>
      {hint && <div style={{ fontSize: 11, color: "var(--text-3)", marginBottom: 6, lineHeight: 1.5 }}>{hint}</div>}
      {children}
    </div>
  );
}

function EditText({
  value,
  onChange,
  mono,
  suffix,
}: {
  value: string;
  onChange: (v: string) => void;
  mono?: boolean;
  suffix?: string;
}) {
  return (
    <div
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
        <span style={{ fontSize: 10.5, color: "var(--text-3)", fontFamily: "var(--mono)" }}>{suffix}</span>
      )}
    </div>
  );
}

function EditTextarea({
  value,
  onChange,
  rows = 3,
  mono,
}: {
  value: string;
  onChange: (v: string) => void;
  rows?: number;
  mono?: boolean;
}) {
  return (
    <textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      rows={rows}
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

function Seg({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <div
      style={{
        display: "inline-flex",
        border: "1px solid var(--border-2)",
        borderRadius: 4,
        overflow: "hidden",
      }}
    >
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          style={{
            padding: "5px 12px",
            fontSize: 11.5,
            background: value === o.value ? "var(--panel-3)" : "var(--panel-2)",
            color: value === o.value ? "var(--text)" : "var(--text-3)",
            borderRight: "1px solid var(--border-2)",
            borderBottom: value === o.value ? "2px solid var(--signal)" : "2px solid transparent",
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function EventPicker({
  selected,
  onAdd,
  onRemove,
  tone,
  all,
  newEvents,
}: {
  selected: string[];
  onAdd: (v: string) => void;
  onRemove: (v: string) => void;
  tone: "blue" | "green";
  all: string[];
  newEvents: string[];
}) {
  const [input, setInput] = useState("");
  const colorMap = {
    blue: { fg: "var(--blue)", bg: "rgba(132,169,255,0.10)", bd: "rgba(132,169,255,0.32)" },
    green: { fg: "var(--green)", bg: "rgba(101,224,163,0.08)", bd: "rgba(101,224,163,0.30)" },
  } as const;
  const c = colorMap[tone] ?? colorMap.blue;
  const normalizedInput = normalizeAuthoredEventName(input);
  const suggestions = input
    ? all.filter((e) => e.toLowerCase().includes(input.toLowerCase()) && e !== normalizedInput && !selected.includes(e)).slice(0, 6)
    : [];
  const canAddInput = Boolean(normalizedInput) && !selected.includes(normalizedInput);
  const isNewInput = canAddInput && !all.includes(normalizedInput);

  function commitInput(value = input) {
    if (!normalizeAuthoredEventName(value)) return;
    onAdd(value);
    setInput("");
  }

  return (
    <div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 6, minHeight: 22 }}>
        {selected.length === 0 && (
          <span style={{ fontSize: 11, color: "var(--text-3)" }}>None yet — type a name below to add.</span>
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
              <span style={{ fontSize: 8, fontWeight: 700, letterSpacing: "0.06em", opacity: 0.75 }}>NEW</span>
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
                  borderBottom: suggestions.length > 0 ? "1px solid var(--border)" : "none",
                  background: isNewInput ? "rgba(203,255,0,0.05)" : "transparent",
                }}
              >
                <Icon name="plus" size={10} />
                <span>{isNewInput ? "Create new event" : "Use event"}</span>
                <span className="mono" style={{ marginLeft: "auto", color: "var(--text)" }}>{normalizedInput}</span>
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
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 0", fontSize: 11.5 }}>
      <Icon
        name={ok ? "check" : warn ? "alert" : "x"}
        size={11}
        style={{ color: ok ? "var(--green)" : warn ? "var(--amber)" : "var(--red)" }}
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
  tone: "signal" | "amber" | "red";
}) {
  const color = tone === "signal" ? "var(--signal)" : tone === "amber" ? "var(--amber)" : "var(--red)";
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
