"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { findCatalogModel, type ProviderId } from "@agentic/contracts";
import {
  Badge,
  Button,
  Empty,
  Icon,
  MonacoEditor,
  useToast,
} from "@/app/portal/components";
import { useDirty } from "@/app/portal/lib/dirty-context";
import { useTenant } from "@/app/portal/lib/use-tenant";
import { useAgents } from "@/lib/hooks/useAgents";
import {
  useAgentEditor,
  useAgentVersions,
  useCreateAgentDraft,
  useGenerateDraftInstructions,
  usePublishAgentDraft,
  useSaveAgentDraft,
  useValidateAgentDraft,
  AgentStudioApiError,
  formatAgentStudioError,
  type StudioValidationIssue as ContractValidationIssue,
} from "@/lib/hooks/useAgentStudio";
import {
  Field,
  InlineNotice,
  JsonValueEditor,
  Segmented,
  SelectInput,
  StudioPanel,
  TextArea,
  TextInput,
  Toggle,
} from "./fields";
import {
  asRecord,
  cloneDefinition,
  csvToList,
  localValidation,
  normalizeStudioDefinition,
  parseLooseJson,
  toPrettyJson,
  type StudioDefinition,
  type StudioValidationIssue,
} from "./model";
import { PortsEditor } from "./PortsEditor";
import { StepsEditor } from "./StepsEditor";
import { TestLab } from "./TestLab";
import { ToolsEditor } from "./ToolsEditor";
import { AgentStudioHelp, type AgentStudioHelpTopic } from "./AgentStudioHelp";
import { workflowCanvasHref } from "../workflows/workflow-navigation";

type SectionId =
  | "overview"
  | "instructions"
  | "inputs"
  | "outputs"
  | "steps"
  | "tools"
  | "runtime"
  | "workflow"
  | "test"
  | "versions"
  | "advanced";
type EditorMode = "guided" | "advanced";

const SECTIONS: Array<{
  id: SectionId;
  label: string;
  icon:
    | "agent"
    | "spark"
    | "chevron-right"
    | "external"
    | "workflow"
    | "settings"
    | "event"
    | "play"
    | "git"
    | "code";
}> = [
  { id: "overview", label: "Overview", icon: "agent" },
  { id: "instructions", label: "Instructions", icon: "spark" },
  { id: "inputs", label: "Inputs", icon: "chevron-right" },
  { id: "outputs", label: "Outputs", icon: "external" },
  { id: "steps", label: "Steps", icon: "workflow" },
  { id: "tools", label: "Tools", icon: "settings" },
  { id: "runtime", label: "Runtime", icon: "settings" },
  { id: "workflow", label: "Workflow", icon: "event" },
  { id: "test", label: "Test Lab", icon: "play" },
  { id: "versions", label: "Versions", icon: "git" },
  { id: "advanced", label: "Advanced", icon: "code" },
];

const PROVIDERS = [
  "",
  "mock",
  "anthropic",
  "openai",
  "openrouter",
  "gemini",
  "azure",
  "groq",
  "together",
  "mistral",
  "deepseek",
  "moonshot",
  "zai",
  "qwen",
  "bedrock",
  "vertex",
  "custom",
];

function withReasoningControl(
  definition: StudioDefinition,
  key: "mode" | "effort" | "summary" | "context",
  value: string,
): StudioDefinition {
  const reasoning = { ...asRecord(definition.reasoning) };
  if (value) reasoning[key] = value;
  else delete reasoning[key];
  const next = { ...definition };
  delete next.reasoning;
  if (Object.keys(reasoning).length > 0) next.reasoning = reasoning;
  return next;
}
const INSTRUCTION_ACTIONS = [
  { value: "generate" as const, label: "Write for me" },
  { value: "improve" as const, label: "Improve" },
  { value: "shorten" as const, label: "Make shorter" },
  { value: "add_guardrails" as const, label: "Add safety rules" },
];
const TEMPLATES = [
  { value: "blank", label: "Blank — start from scratch" },
  { value: "classify", label: "Classify — sort into categories" },
  { value: "extract", label: "Extract — read structured facts" },
  { value: "rag", label: "Deep Search" },
  { value: "loop", label: "Repeat until complete" },
  { value: "human", label: "Human task" },
];

function errorMessage(error: unknown): string {
  return formatAgentStudioError(error);
}

function issueTone(
  severity: StudioValidationIssue["severity"],
): "red" | "amber" | "blue" {
  return severity === "error"
    ? "red"
    : severity === "warning"
      ? "amber"
      : "blue";
}

function sectionForIssue(path: string): SectionId {
  const value = path.toLowerCase();
  if (value.includes("input")) return "inputs";
  if (value.includes("output_config") || value.includes("output"))
    return "outputs";
  if (value.includes("action") || value.includes("step")) return "steps";
  if (value.includes("tool")) return "tools";
  if (value.includes("trigger") || value.includes("binding")) return "workflow";
  if (value.includes("instruction") || value.includes("prompt"))
    return "instructions";
  if (
    /provider|model|temperature|max_tokens|timeout|retr|concurr|cron|observability|retention/.test(
      value,
    )
  )
    return "runtime";
  return "overview";
}

function friendlyIssuePath(path: string, definition: StudioDefinition): string {
  const labels: Record<string, string> = {
    title: "Display name",
    name: "Programmatic name",
    description: "Purpose",
    actor: "Owner type",
    stage: "Stage",
    template: "Starting template",
    ontology_instructions: "Agent instructions",
    user_prompt_template: "Extra user-message context",
    inputs: "Inputs",
    outputs: "Outputs",
    actions: "Steps",
    tool_use: "Tools",
    output_config: "Output file settings",
    schema: "Data format",
    trigger: "Incoming events",
    trigger_bindings: "Incoming event mapping",
    triggered_event: "Outgoing events",
    output_bindings: "Outgoing event mapping",
    provider: "AI provider",
    model: "AI model",
    temperature: "Creativity",
    max_tokens: "Maximum answer length",
    timeout_s: "Run time limit",
    retries: "Retry attempts",
    concurrency: "Simultaneous-run limits",
    cron: "Schedule",
    cron_timezone: "Schedule timezone",
    observability: "Run details",
  };
  const segments = path
    .replace(/^\$?\.?\/?/, "")
    .split(/[/.\[\]]+/)
    .filter(Boolean);
  if (segments.length === 0) return "Agent setup";
  return segments
    .map((segment, index) => {
      if (/^\d+$/.test(segment)) {
        const itemIndex = Number(segment);
        const parent = segments[index - 1];
        if (parent === "inputs")
          return (
            definition.inputs[itemIndex]?.label ?? `Input ${itemIndex + 1}`
          );
        if (parent === "outputs")
          return (
            definition.outputs[itemIndex]?.label ?? `Output ${itemIndex + 1}`
          );
        if (parent === "actions")
          return definition.actions[itemIndex]?.name ?? `Step ${itemIndex + 1}`;
        if (parent === "tool_use")
          return (
            definition.tool_use[itemIndex]?.name ?? `Tool ${itemIndex + 1}`
          );
        return `Item ${itemIndex + 1}`;
      }
      return (
        labels[segment] ??
        segment
          .replaceAll("_", " ")
          .replace(/^./, (letter) => letter.toUpperCase())
      );
    })
    .join(" › ");
}

function RawDefinitionEditor({
  value,
  onChange,
  disabled,
}: {
  value: StudioDefinition;
  onChange: (next: StudioDefinition) => void;
  disabled?: boolean;
}) {
  const serialized = toPrettyJson(value);
  const [text, setText] = useState(serialized);
  const [error, setError] = useState<string | null>(null);
  const lastValid = useRef(serialized);

  useEffect(() => {
    if (serialized !== lastValid.current) {
      lastValid.current = serialized;
      setText(serialized);
      setError(null);
    }
  }, [serialized]);

  return (
    <div>
      <div
        style={{
          display: "flex",
          gap: 8,
          alignItems: "center",
          marginBottom: 8,
        }}
      >
        <Badge tone={error ? "red" : "green"}>
          {error ? "Invalid JSON" : "Valid definition"}
        </Badge>
        <span
          style={{
            color: "var(--text-2)",
            fontSize: 11.5,
            lineHeight: 1.5,
          }}
        >
          Unknown extension fields are preserved on round-trip.
        </span>
      </div>
      <div
        style={{
          pointerEvents: disabled ? "none" : "auto",
        }}
      >
        <MonacoEditor
          value={text}
          language="json"
          height={620}
          readOnly={disabled}
          onChange={(next) => {
            setText(next);
            const parsed = parseLooseJson(next);
            if (parsed.error) return setError(parsed.error);
            if (
              !parsed.value ||
              typeof parsed.value !== "object" ||
              Array.isArray(parsed.value)
            )
              return setError("The agent definition must be a JSON object.");
            setError(null);
            lastValid.current = toPrettyJson(parsed.value);
            onChange(normalizeStudioDefinition(parsed.value, value));
          }}
        />
      </div>
      {error && (
        <div
          className="mono"
          style={{ marginTop: 7, color: "var(--red)", fontSize: 11 }}
        >
          {error}
        </div>
      )}
    </div>
  );
}

export interface AgentStudioProps {
  agentId: string;
  initialSection?: "overview" | "test";
  initialDraftId?: string;
  initialEditing?: boolean;
  workflowSlug?: string;
  resumeToken?: string;
}

export function AgentStudio({
  agentId,
  initialSection,
  initialDraftId,
  initialEditing = false,
  workflowSlug,
  resumeToken,
}: AgentStudioProps) {
  const tenant = useTenant();
  const router = useRouter();
  const toast = useToast();
  const dirtyStore = useDirty();
  const editor = useAgentEditor(agentId, initialDraftId);
  const agents = useAgents();
  const [section, setSection] = useState<SectionId>(
    initialSection ?? "overview",
  );
  const [mode, setMode] = useState<EditorMode>("guided");
  const [definition, setDefinition] = useState<StudioDefinition | null>(null);
  const [baseline, setBaseline] = useState("");
  const [revision, setRevision] = useState(1);
  const [editing, setEditing] = useState(false);
  const [autoSave, setAutoSave] = useState(true);
  const [helpOpen, setHelpOpen] = useState(false);
  const [helpTopic, setHelpTopic] = useState<AgentStudioHelpTopic>("start");
  const [saveState, setSaveState] = useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");
  const [serverIssues, setServerIssues] = useState<ContractValidationIssue[]>(
    [],
  );
  const loadedSource = useRef("");
  const saveInFlight = useRef(false);
  const definitionRef = useRef<StudioDefinition | null>(null);
  const editSessionStart = useRef<StudioDefinition | null>(null);
  const initialEditHandled = useRef("");
  const [navigationPending, setNavigationPending] = useState(false);
  const createDraft = useCreateAgentDraft(agentId);
  const saveDraft = useSaveAgentDraft(editor.data?.draft?.id);
  const validateDraft = useValidateAgentDraft(agentId, editor.data?.draft?.id);
  const generateInstructions = useGenerateDraftInstructions(
    editor.data?.draft?.id,
  );
  const publishDraft = usePublishAgentDraft(agentId, editor.data?.draft?.id);
  const versions = useAgentVersions(agentId);

  useEffect(() => {
    const source = editor.data?.draft ?? editor.data?.live;
    if (!source) return;
    const sourceKey = editor.data?.draft
      ? `draft:${editor.data.draft.id}:${editor.data.draft.revision}`
      : `live:${editor.data?.live?.agentVersionId}:${editor.data?.live?.definitionHash}`;
    if (loadedSource.current === sourceKey) return;
    const next = normalizeStudioDefinition(source.definition, {
      id: editor.data?.agent.kebabId,
      name: editor.data?.agent.name,
      title: editor.data?.agent.title ?? editor.data?.agent.name,
      actor: editor.data?.agent.actor ? [editor.data.agent.actor] : ["Agent"],
    });
    loadedSource.current = sourceKey;
    setDefinition(next);
    setBaseline(JSON.stringify(next));
    setRevision(editor.data?.draft?.revision ?? 1);
    setServerIssues(editor.data?.draft?.validation.issues ?? []);
    setSaveState("idle");
    setEditing(false);
    editSessionStart.current = null;
  }, [editor.data]);

  const dirty = Boolean(
    definition && editor.data?.draft && JSON.stringify(definition) !== baseline,
  );
  const localIssues = useMemo(
    () => (definition ? localValidation(definition) : []),
    [definition],
  );
  const allIssues = useMemo(() => {
    const seen = new Set<string>();
    return [...localIssues, ...serverIssues].filter((issue) => {
      const key = `${issue.path}:${issue.code}:${issue.message}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [localIssues, serverIssues]);
  const errorCount = allIssues.filter(
    (issue) => issue.severity === "error",
  ).length;
  const runtimeModelCapabilities = definition
    ? findCatalogModel(definition.provider as ProviderId, definition.model)
    : undefined;
  const runtimeTemperatureRange = runtimeModelCapabilities?.temperatureRange;
  const runtimeTemperatureUnsupported = runtimeTemperatureRange === null;

  useEffect(() => {
    definitionRef.current = definition;
  }, [definition]);

  useEffect(() => {
    dirtyStore.setDirty(
      "agent-studio",
      dirty ? `${definition?.title ?? "agent"} draft` : null,
    );
    return () => dirtyStore.setDirty("agent-studio", null);
  }, [dirty, definition?.title, dirtyStore]);

  const persist = useCallback(
    async (quiet = false, override?: StudioDefinition) => {
      if (!definition || !editor.data?.draft || saveInFlight.current)
        return null;
      saveInFlight.current = true;
      setSaveState("saving");
      const submitted = override ?? definition;
      try {
        const result = await saveDraft.mutateAsync({
          definition: submitted,
          revision,
        });
        const saved = normalizeStudioDefinition(
          result.draft.definition,
          submitted,
        );
        if (
          override ||
          JSON.stringify(definitionRef.current) === JSON.stringify(submitted)
        ) {
          setDefinition(saved);
        }
        setRevision(result.draft.revision);
        setBaseline(JSON.stringify(saved));
        loadedSource.current = `draft:${result.draft.id}:${result.draft.revision}`;
        setServerIssues(
          result.draft.validation.status === "stale"
            ? []
            : result.draft.validation.issues,
        );
        setSaveState("saved");
        if (!quiet)
          toast({
            tone: "green",
            title: "Draft saved",
            description: `Revision ${result.draft.revision}`,
          });
        return result.draft;
      } catch (error) {
        setSaveState("error");
        if (!quiet)
          toast({
            tone: "red",
            title: "Save failed",
            description: errorMessage(error),
          });
        return null;
      } finally {
        saveInFlight.current = false;
      }
    },
    [definition, editor.data?.draft, revision, saveDraft, toast],
  );

  useEffect(() => {
    if (!editing || !autoSave || !dirty || saveInFlight.current) return;
    const timer = window.setTimeout(() => void persist(true), 1_300);
    return () => window.clearTimeout(timer);
  }, [autoSave, dirty, definition, editing, persist]);

  async function makeDraft(enterEditMode = false) {
    if (!definition) return;
    try {
      const result = await createDraft.mutateAsync({
        definition,
        ...(editor.data?.live?.agentVersionId
          ? { baseAgentVersionId: editor.data.live.agentVersionId }
          : {}),
        ...(editor.data?.live?.workflowVersionId
          ? { baseWorkflowVersionId: editor.data.live.workflowVersionId }
          : {}),
      });
      const next = normalizeStudioDefinition(
        result.draft.definition,
        definition,
      );
      loadedSource.current = `draft:${result.draft.id}:${result.draft.revision}`;
      setDefinition(next);
      setRevision(result.draft.revision);
      setBaseline(JSON.stringify(next));
      if (enterEditMode) {
        editSessionStart.current = cloneDefinition(next);
        setEditing(true);
      }
      toast({
        tone: "green",
        title: "Editable draft created",
        description: "Changes now autosave without affecting the live version.",
      });
      await editor.refetch();
    } catch (error) {
      toast({
        tone: "red",
        title: "Could not create draft",
        description: errorMessage(error),
      });
    }
  }

  async function startEditing() {
    if (
      !definition ||
      !editor.data?.capabilities.canEdit ||
      editor.data.agent.kind === "code"
    )
      return;
    if (!editor.data.draft) {
      await makeDraft(true);
      return;
    }
    editSessionStart.current = cloneDefinition(definition);
    setEditing(true);
    setSaveState("idle");
  }

  useEffect(() => {
    const initialEditKey = `${agentId}:${initialDraftId ?? "current"}`;
    if (
      !initialEditing ||
      initialEditHandled.current === initialEditKey ||
      !definition ||
      !editor.data ||
      editor.data.agent.kebabId !== agentId
    )
      return;

    initialEditHandled.current = initialEditKey;
    void startEditing();
  }, [
    agentId,
    definition,
    editor.data,
    initialDraftId,
    initialEditing,
    startEditing,
  ]);

  async function openAnotherAgent(nextAgentId: string) {
    if (nextAgentId === agentId || navigationPending || saveInFlight.current)
      return;
    if (workflowSlug) {
      toast({
        tone: "amber",
        title: "This workflow agent is pinned",
        description:
          "Return to the workflow canvas before choosing another agent. This keeps the saved workflow version and agent draft paired correctly.",
      });
      return;
    }
    setNavigationPending(true);
    if (dirty && !(await persist(true))) {
      setNavigationPending(false);
      toast({
        tone: "red",
        title: "Could not switch agents",
        description:
          "Your unsaved changes are still open. Save them before opening another agent.",
      });
      return;
    }

    const href = `/portal/${encodeURIComponent(
      tenant,
    )}/agents/${encodeURIComponent(nextAgentId)}${
      initialEditing ? "?edit=1" : ""
    }`;
    router.push(href as never);
  }

  async function returnToWorkflow() {
    if (!workflowSlug || navigationPending || saveInFlight.current) return;
    setNavigationPending(true);

    let agentDraftId = editor.data?.draft?.id ?? initialDraftId ?? null;
    if (dirty) {
      const saved = await persist(true);
      if (!saved) {
        setNavigationPending(false);
        toast({
          tone: "red",
          title: "Could not return to workflow",
          description:
            "Your changes are still open in Agent Studio. Retry Save, then return to the workflow.",
        });
        return;
      }
      agentDraftId = saved.id;
    }

    router.push(
      workflowCanvasHref({
        tenant,
        workflowSlug,
        agentId,
        resumeToken,
        agentDraftId,
      }) as never,
    );
  }

  async function finishEditing() {
    if (saveInFlight.current) return;
    if (dirty && !(await persist(true))) {
      toast({
        tone: "red",
        title: "Could not finish editing",
        description:
          "Your changes are still open in the editor. Retry Save or Done; nothing has been discarded.",
      });
      return;
    }
    setEditing(false);
    editSessionStart.current = null;
    toast({
      tone: "green",
      title: "Editing complete",
      description:
        "Your draft is saved and protected in view mode. It has not been published.",
    });
  }

  async function cancelEditing() {
    if (!definition || saveInFlight.current) return;
    const original = editSessionStart.current;
    if (!original) {
      setEditing(false);
      return;
    }
    const changedDuringSession =
      JSON.stringify(definition) !== JSON.stringify(original);
    if (!changedDuringSession) {
      setEditing(false);
      editSessionStart.current = null;
      return;
    }
    const confirmed =
      typeof window === "undefined" ||
      window.confirm(
        "Cancel this edit session and restore the draft to how it was when you clicked Edit? Changes already saved by autosave will also be safely restored.",
      );
    if (!confirmed) return;

    const savedDuringSession = baseline !== JSON.stringify(original);
    if (savedDuringSession) {
      const restored = await persist(true, cloneDefinition(original));
      if (!restored) {
        toast({
          tone: "red",
          title: "Could not cancel editing",
          description:
            "The editor remains open with all current changes. Nothing has been discarded.",
        });
        return;
      }
    } else {
      setDefinition(cloneDefinition(original));
      definitionRef.current = original;
      setServerIssues(editor.data?.draft?.validation.issues ?? []);
      setSaveState("idle");
    }
    setEditing(false);
    editSessionStart.current = null;
    toast({
      tone: "amber",
      title: "Edit session cancelled",
      description:
        "The draft was restored to its state before you clicked Edit. The live agent was never changed.",
    });
  }

  async function validate() {
    if (dirty && !(await persist(true))) return;
    try {
      const result = await validateDraft.mutateAsync();
      setServerIssues(result.validation.issues);
      toast({
        tone: result.validation.status === "valid" ? "green" : "red",
        title:
          result.validation.status === "valid"
            ? "Draft is valid"
            : "Validation found blocking issues",
        description: `${result.validation.issues.length} issue${result.validation.issues.length === 1 ? "" : "s"}`,
      });
    } catch (error) {
      toast({
        tone: "red",
        title: "Validation failed",
        description: errorMessage(error),
      });
    }
  }

  async function publish() {
    if (errorCount > 0) {
      setSection("overview");
      toast({
        tone: "red",
        title: "Fix validation errors first",
        description: `${errorCount} blocking issue${errorCount === 1 ? "" : "s"}`,
      });
      return;
    }
    let publishRevision = revision;
    if (dirty) {
      const saved = await persist(true);
      if (!saved) return;
      publishRevision = saved.revision;
    }
    try {
      const validation = await validateDraft.mutateAsync();
      setServerIssues(validation.validation.issues);
      if (validation.validation.status !== "valid")
        return toast({
          tone: "red",
          title: "Draft is not publishable",
          description: "Resolve the server validation issues and retry.",
        });
      if (
        typeof window !== "undefined" &&
        !window.confirm(
          "Publish this draft as a new immutable live version? Existing in-flight runs will continue on their pinned definition.",
        )
      )
        return;
      const note = `Published from Agent Studio revision ${publishRevision}`;
      let result;
      try {
        result = await publishDraft.mutateAsync({ confirmImpact: false, note });
      } catch (error) {
        if (
          !(error instanceof AgentStudioApiError) ||
          error.code !== "impact_confirmation_required"
        )
          throw error;
        const impacts = asRecord(error.details).impacts;
        const labels = Array.isArray(impacts)
          ? impacts.filter((item): item is string => typeof item === "string")
          : [];
        const accepted =
          typeof window !== "undefined" &&
          window.confirm(
            `This version changes ${labels.length ? labels.join(", ") : "runtime-facing contracts"}. Downstream events, tools, or callers may be affected. Publish anyway?`,
          );
        if (!accepted) return;
        result = await publishDraft.mutateAsync({ confirmImpact: true, note });
      }
      toast({
        tone: "green",
        title: `Published ${result.version}`,
        description: `Runtime ${result.runtime.registered ? "registered" : "pending registration"}`,
      });
      setEditing(false);
      editSessionStart.current = null;
      await editor.refetch();
    } catch (error) {
      toast({
        tone: "red",
        title: "Publish failed",
        description: errorMessage(error),
      });
    }
  }

  if (editor.isLoading)
    return (
      <Empty
        title="Loading Agent Studio…"
        hint="Resolving the live version and your latest draft."
      />
    );
  if (editor.isError)
    return (
      <Empty title="Agent Studio could not load" hint={editor.error.message} />
    );
  if (!editor.data || !definition)
    return (
      <Empty
        title="No editable definition found"
        hint="This agent has neither a live version nor an existing draft."
      />
    );

  const draft = editor.data.draft;
  const compatibility = asRecord(definition.extensions);
  const compatibilityMode = String(compatibility.compatibility_mode ?? "");
  const compatibilitySource = String(compatibility.compatibility_source ?? "");
  const codeCompatibility =
    editor.data.agent.kind === "code" || compatibilityMode === "code";
  const editable = Boolean(
    editing && draft && editor.data.capabilities.canEdit && !codeCompatibility,
  );
  const generatedCompatibility = compatibilityMode === "generated";
  const upgradedCompatibility =
    compatibilityMode === "v1" || compatibilityMode === "historical";
  const update = (next: StudioDefinition) => {
    if (!editable) return;
    setServerIssues([]);
    setDefinition(next);
  };

  function renderGuidedSection() {
    if (!definition || !editor.data) return null;
    if (section === "overview")
      return (
        <StudioPanel
          title="Agent identity"
          subtitle="How people find and understand this agent."
        >
          <div style={{ display: "grid", gap: 14 }}>
            <div
              className="agent-studio-form-grid agent-studio-form-grid--2"
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 12,
              }}
            >
              <Field
                label="Display name"
                required
                hint="The friendly name people see in the agent list and run history."
                example="Support Ticket Classifier"
              >
                <TextInput
                  value={definition.title}
                  disabled={!editable}
                  onChange={(title) => update({ ...definition, title })}
                />
              </Field>
              <Field
                label="Programmatic name"
                required
                hint="The permanent internal name used by workflows and APIs. It cannot be changed after creation."
                example="supportTicketClassifier"
              >
                <TextInput
                  value={definition.name}
                  mono
                  disabled
                  onChange={() => undefined}
                />
              </Field>
            </div>
            <Field
              label="Purpose"
              hint="A concise plain-language explanation shown across the operator portal."
            >
              <TextArea
                value={definition.description}
                rows={4}
                disabled={!editable}
                onChange={(description) =>
                  update({ ...definition, description })
                }
              />
            </Field>
            <div
              className="agent-studio-overview-settings-grid"
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr 1fr",
                gap: 12,
              }}
            >
              <Field
                label="Owner type"
                hint="Choose AI agent for automated work, or Human task when a person must complete this step."
              >
                <SelectInput
                  value={definition.actor[0] ?? "Agent"}
                  disabled={!editable}
                  onChange={(actor) =>
                    update({
                      ...definition,
                      actor: [actor as "Agent" | "Human"],
                    })
                  }
                  options={[
                    { value: "Agent", label: "AI agent" },
                    { value: "Human", label: "Human task" },
                  ]}
                />
              </Field>
              <Field
                label="Stage"
                hint="A simple ordering number used when showing the agent in a workflow. Lower numbers appear earlier."
                example="Use 10, 20, 30 so you can insert steps later."
              >
                <TextInput
                  value={definition.stage}
                  type="number"
                  min={0}
                  disabled={!editable}
                  onChange={(stage) =>
                    update({ ...definition, stage: Number(stage) })
                  }
                />
              </Field>
              <Field
                label="Starting template"
                hint="Pick the pattern closest to the job. This is descriptive and does not lock what you can edit."
                example="Classify for routing tickets; Extract for reading invoices"
              >
                <SelectInput
                  value={definition.template}
                  disabled={!editable}
                  onChange={(template) => update({ ...definition, template })}
                  options={TEMPLATES}
                />
              </Field>
            </div>
            <InlineNotice title="Version-safe editing">
              You are{" "}
              {editable
                ? `editing draft revision ${revision}`
                : draft
                  ? `viewing draft revision ${revision}`
                  : "viewing the immutable live definition"}
              . Publishing creates a new version; it never mutates historical
              runs.
            </InlineNotice>
          </div>
        </StudioPanel>
      );
    if (section === "instructions")
      return (
        <div style={{ display: "grid", gap: 14 }}>
          <StudioPanel
            title="Agent instructions"
            subtitle="Define the agent's role, objective, operating rules, and safety boundaries."
            action={
              <div style={{ display: "flex", gap: 6 }}>
                {INSTRUCTION_ACTIONS.map((action) => (
                  <Button
                    key={action.value}
                    small
                    icon={action.value === "generate" ? "spark" : undefined}
                    disabled={!editable || generateInstructions.isPending}
                    onClick={async () => {
                      try {
                        const result = await generateInstructions.mutateAsync({
                          mode: action.value,
                          instructions: definition.ontology_instructions,
                        });
                        update({
                          ...definition,
                          ontology_instructions: result.proposedInstructions,
                          prompt_provenance: result.provenance,
                        });
                        toast({
                          tone: "signal",
                          title: "AI proposal applied to the draft",
                          description:
                            result.explanation ??
                            "Review and edit it before publishing.",
                        });
                      } catch (error) {
                        toast({
                          tone: "red",
                          title: "Instruction generation failed",
                          description: errorMessage(error),
                        });
                      }
                    }}
                  >
                    {action.label}
                  </Button>
                ))}
              </div>
            }
          >
            <Field
              label="Agent instructions"
              required
              hint="Tell the agent who it is, what result it must produce, the rules it must follow, and when it should stop or ask for help."
              example="You classify support tickets. Return one category and a short reason. Never invent account details."
            >
              <TextArea
                value={definition.ontology_instructions}
                rows={18}
                mono
                disabled={!editable}
                placeholder="You are… Your objective is… Follow these rules…"
                onChange={(ontology_instructions) =>
                  update({ ...definition, ontology_instructions })
                }
              />
            </Field>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                color: "var(--text-2)",
                fontSize: 11.5,
                lineHeight: 1.5,
                marginTop: 6,
              }}
            >
              <span>Used as the LLM system prompt</span>
              <span className="mono">
                {definition.ontology_instructions.length.toLocaleString()} chars
              </span>
            </div>
          </StudioPanel>
          <StudioPanel
            title="User prompt template"
            subtitle="The Test Lab and runtime automatically insert the prompt input as the user message."
          >
            <Field
              label="Extra user-message context"
              hint="Optional. Add structured inputs beside the user's request. The chat prompt is inserted automatically, so do not repeat it here."
              example={"Customer tier: {{inputs.customer_tier}}"}
            >
              <TextArea
                value={definition.user_prompt_template}
                rows={7}
                mono
                disabled={!editable}
                placeholder={
                  "Supporting context:\n{{json inputs.context}}\n\nReplace “context” with a declared input ID."
                }
                onChange={(user_prompt_template) =>
                  update({ ...definition, user_prompt_template })
                }
              />
            </Field>
            <InlineNotice tone="blue" title="Automatic prompt binding">
              The single input marked “Prompt” becomes the user role message.
              You do not need to copy user text into the system instructions.
            </InlineNotice>
          </StudioPanel>
        </div>
      );
    if (section === "inputs")
      return (
        <StudioPanel
          title="Input contract"
          subtitle="One prompt plus any number of typed variables or files."
        >
          <PortsEditor
            kind="input"
            ports={definition.inputs}
            disabled={!editable}
            onChange={(inputs) =>
              update({
                ...definition,
                inputs: inputs as StudioDefinition["inputs"],
              })
            }
          />
        </StudioPanel>
      );
    if (section === "outputs")
      return (
        <div style={{ display: "grid", gap: 14 }}>
          <StudioPanel
            title="Output contract"
            subtitle="Every completed run produces one aggregate JSON document and validates its named outputs."
          >
            <PortsEditor
              kind="output"
              ports={definition.outputs}
              disabled={!editable}
              onChange={(outputs) =>
                update({
                  ...definition,
                  outputs: outputs as StudioDefinition["outputs"],
                })
              }
            />
          </StudioPanel>
          <StudioPanel
            title="JSON artifact policy"
            subtitle="The aggregate output is always persisted as a JSON artifact."
          >
            <div
              className="agent-studio-form-grid agent-studio-form-grid--2"
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 12,
              }}
            >
              <Field
                label="Output file name"
                hint="The name of the downloadable JSON file saved after each successful run. Keep the .json ending."
                example="ticket-classification.json"
              >
                <TextInput
                  value={String(
                    asRecord(definition.output_config.artifact).filename ??
                      "output.json",
                  )}
                  mono
                  disabled={!editable}
                  onChange={(filename) =>
                    update({
                      ...definition,
                      output_config: {
                        ...definition.output_config,
                        artifact: {
                          ...asRecord(definition.output_config.artifact),
                          filename,
                        },
                      },
                    })
                  }
                />
              </Field>
              <Field
                label="Automatic correction attempts"
                hint="How many times the model may fix an answer that does not match your output fields. Start with 1."
                example="1"
              >
                <TextInput
                  value={Number(definition.output_config.repair_attempts ?? 1)}
                  type="number"
                  min={0}
                  max={3}
                  disabled={!editable}
                  onChange={(repair_attempts) =>
                    update({
                      ...definition,
                      output_config: {
                        ...definition.output_config,
                        repair_attempts: Number(repair_attempts),
                      },
                    })
                  }
                />
              </Field>
            </div>
            <Toggle
              checked={Boolean(definition.output_config.strict)}
              disabled={!editable}
              onChange={(strict) =>
                update({
                  ...definition,
                  output_config: { ...definition.output_config, strict },
                })
              }
              label="Require the declared output format"
              hint="Fail the run when the model cannot produce your output fields after the allowed correction attempts."
            />
            <Toggle
              checked={Boolean(definition.output_config.unwrap_single_output)}
              disabled={!editable}
              onChange={(unwrap_single_output) =>
                update({
                  ...definition,
                  output_config: {
                    ...definition.output_config,
                    unwrap_single_output,
                  },
                })
              }
              label="Return a single output directly"
              hint="When there is one named output, callers receive its value directly. The complete JSON file is still saved."
            />
            <Toggle
              checked={Boolean(
                asRecord(definition.output_config.artifact)
                  .persist_individual_outputs,
              )}
              disabled={!editable}
              onChange={(persist_individual_outputs) =>
                update({
                  ...definition,
                  output_config: {
                    ...definition.output_config,
                    artifact: {
                      ...asRecord(definition.output_config.artifact),
                      persist_individual_outputs,
                    },
                  },
                })
              }
              label="Save each output as a separate file"
              hint="Useful when another system downloads or processes one output at a time."
            />
            <Toggle
              checked={Boolean(
                asRecord(definition.output_config.artifact).persist_run_input ??
                true,
              )}
              disabled={!editable}
              onChange={(persist_run_input) =>
                update({
                  ...definition,
                  output_config: {
                    ...definition.output_config,
                    artifact: {
                      ...asRecord(definition.output_config.artifact),
                      persist_run_input,
                    },
                  },
                })
              }
              label="Save the run's inputs"
              hint="Retain the validated inputs so a result can be reproduced. Privacy and redaction rules still apply."
            />
            <Toggle
              checked
              disabled
              onChange={() => undefined}
              label="Always save run details"
              hint="Required for reproducibility. Stores the version, timing, validation, model usage, artifacts, and emitted events."
            />
            <Toggle
              checked={Boolean(
                asRecord(definition.output_config.artifact)
                  .persist_raw_response,
              )}
              disabled={!editable}
              onChange={(persist_raw_response) =>
                update({
                  ...definition,
                  output_config: {
                    ...definition.output_config,
                    artifact: {
                      ...asRecord(definition.output_config.artifact),
                      persist_raw_response,
                    },
                  },
                })
              }
              label="Save the model's unprocessed response"
              hint="Developer troubleshooting only. It may contain sensitive or rejected content that is not present in the validated output."
            />
          </StudioPanel>
        </div>
      );
    if (section === "steps")
      return (
        <StudioPanel
          title="Execution sequence"
          subtitle="An ordered, traceable plan. Steps can call the model, tools, people, conditions, delays, or subflows."
        >
          <StepsEditor
            actions={definition.actions}
            disabled={!editable}
            onChange={(actions) => update({ ...definition, actions })}
          />
        </StudioPanel>
      );
    if (section === "tools")
      return (
        <StudioPanel
          title="Tool permissions"
          subtitle="Choose from the Agentic Operator catalog. Only allowed tools can be called by this agent."
        >
          <ToolsEditor
            tools={definition.tool_use}
            disabled={!editable}
            onChange={(tool_use) => update({ ...definition, tool_use })}
          />
        </StudioPanel>
      );
    if (section === "runtime")
      return (
        <div style={{ display: "grid", gap: 14 }}>
          <StudioPanel
            title="Model and generation"
            subtitle="Leave provider and model inherited to use workspace defaults."
          >
            <div
              className="agent-studio-form-grid agent-studio-form-grid--2"
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 12,
              }}
            >
              <Field
                label="AI provider"
                hint="The company that runs the model. Leave inherited unless your administrator gave you a specific provider."
              >
                <SelectInput
                  value={definition.provider}
                  disabled={!editable}
                  onChange={(provider) => update({ ...definition, provider })}
                  options={PROVIDERS.map((value) => ({
                    value,
                    label: value || "Use workspace default (recommended)",
                  }))}
                />
              </Field>
              <Field
                label="AI model"
                hint="The exact model to use. Leave blank to follow the workspace default and future upgrades."
                example="gpt-5-mini"
              >
                <TextInput
                  value={definition.model}
                  mono
                  disabled={!editable}
                  placeholder="Use workspace default (recommended)"
                  onChange={(model) => update({ ...definition, model })}
                />
              </Field>
              {runtimeModelCapabilities?.reasoningModes?.length ? (
                <Field
                  label="Reasoning mode"
                  hint="Standard balances quality and speed. Pro gives supported frontier models their highest-compute execution path."
                >
                  <SelectInput
                    value={String(asRecord(definition.reasoning).mode ?? "")}
                    disabled={!editable}
                    onChange={(mode) =>
                      update(withReasoningControl(definition, "mode", mode))
                    }
                    options={[
                      { value: "", label: "Use model default" },
                      ...runtimeModelCapabilities.reasoningModes.map(
                        (value) => ({
                          value,
                          label: value,
                        }),
                      ),
                    ]}
                  />
                </Field>
              ) : null}
              {runtimeModelCapabilities?.reasoningEfforts?.length ? (
                <Field
                  label="Reasoning effort"
                  hint="Higher effort can improve difficult reasoning, but usually adds latency and reasoning tokens."
                >
                  <SelectInput
                    value={String(asRecord(definition.reasoning).effort ?? "")}
                    disabled={!editable}
                    onChange={(effort) =>
                      update(withReasoningControl(definition, "effort", effort))
                    }
                    options={[
                      { value: "", label: "Use model default" },
                      ...runtimeModelCapabilities.reasoningEfforts.map(
                        (value) => ({
                          value,
                          label: value,
                        }),
                      ),
                    ]}
                  />
                </Field>
              ) : null}
              {runtimeModelCapabilities?.reasoningSummaries?.length ? (
                <Field
                  label="Reasoning summary"
                  hint="Requests a provider-generated summary for evaluation; raw chain-of-thought is never stored."
                >
                  <SelectInput
                    value={String(asRecord(definition.reasoning).summary ?? "")}
                    disabled={!editable}
                    onChange={(summary) =>
                      update(
                        withReasoningControl(definition, "summary", summary),
                      )
                    }
                    options={[
                      { value: "", label: "Use model default" },
                      ...runtimeModelCapabilities.reasoningSummaries.map(
                        (value) => ({
                          value,
                          label: value,
                        }),
                      ),
                    ]}
                  />
                </Field>
              ) : null}
              {runtimeModelCapabilities?.reasoningContexts?.length ? (
                <Field
                  label="Reasoning context"
                  hint="Controls which persisted reasoning items the provider may reuse on later turns."
                >
                  <SelectInput
                    value={String(asRecord(definition.reasoning).context ?? "")}
                    disabled={!editable}
                    onChange={(context) =>
                      update(
                        withReasoningControl(definition, "context", context),
                      )
                    }
                    options={[
                      { value: "", label: "Use model default" },
                      ...runtimeModelCapabilities.reasoningContexts.map(
                        (value) => ({
                          value,
                          label: value.replaceAll("_", " "),
                        }),
                      ),
                    ]}
                  />
                </Field>
              ) : null}
              {runtimeModelCapabilities?.textVerbosities?.length ? (
                <Field
                  label="Answer verbosity"
                  hint="Controls how concise or detailed the model's visible answer should be."
                >
                  <SelectInput
                    value={definition.verbosity ?? ""}
                    disabled={!editable}
                    onChange={(verbosity) => {
                      const next = { ...definition };
                      delete next.verbosity;
                      if (verbosity) next.verbosity = verbosity;
                      update(next);
                    }}
                    options={[
                      { value: "", label: "Use model default" },
                      ...runtimeModelCapabilities.textVerbosities.map(
                        (value) => ({
                          value,
                          label: value,
                        }),
                      ),
                    ]}
                  />
                </Field>
              ) : null}
              {definition.provider === "openai" ||
              definition.provider === "openrouter" ? (
                <Field
                  label="Provider response storage"
                  hint="Controls provider-side response retention. Local run logs and usage accounting remain independent."
                >
                  <SelectInput
                    value={
                      typeof definition.store === "boolean"
                        ? String(definition.store)
                        : ""
                    }
                    disabled={!editable}
                    onChange={(store) => {
                      const next = { ...definition };
                      delete next.store;
                      if (store) next.store = store === "true";
                      update(next);
                    }}
                    options={[
                      { value: "", label: "Use service default" },
                      { value: "false", label: "Do not store upstream" },
                      ...(definition.provider === "openai"
                        ? [{ value: "true", label: "Store upstream" }]
                        : []),
                    ]}
                  />
                </Field>
              ) : null}
              <Field
                label="Creativity"
                hint={
                  runtimeTemperatureUnsupported
                    ? `${definition.provider}/${definition.model.replace(/^~/, "")} does not support temperature. This saved compatibility value is omitted by the gateway.`
                    : `Controls variation. Use 0–0.3 for consistent extraction/classification and 0.7–1 for creative writing.${runtimeTemperatureRange ? ` Accepted range: ${runtimeTemperatureRange.min}–${runtimeTemperatureRange.max}.` : ""}`
                }
                example={runtimeTemperatureUnsupported ? undefined : "0.2"}
              >
                <TextInput
                  value={
                    runtimeTemperatureUnsupported ? "" : definition.temperature
                  }
                  type="number"
                  min={runtimeTemperatureRange?.min ?? 0}
                  max={runtimeTemperatureRange?.max ?? 2}
                  placeholder={
                    runtimeTemperatureUnsupported
                      ? "Not supported — omitted"
                      : undefined
                  }
                  disabled={!editable || runtimeTemperatureUnsupported}
                  onChange={(temperature) =>
                    update({ ...definition, temperature: Number(temperature) })
                  }
                />
              </Field>
              <Field
                label="Maximum answer length"
                hint="The token budget for one model answer. A token is roughly part of a word; 1,000 tokens is about 750 English words."
                example="2000"
              >
                <TextInput
                  value={definition.max_tokens}
                  type="number"
                  min={1}
                  disabled={!editable}
                  onChange={(max_tokens) =>
                    update({ ...definition, max_tokens: Number(max_tokens) })
                  }
                />
              </Field>
            </div>
          </StudioPanel>
          <StudioPanel title="Reliability and capacity">
            <div
              className="agent-studio-form-grid agent-studio-form-grid--3"
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(3, 1fr)",
                gap: 12,
              }}
            >
              <Field
                label="Run time limit"
                hint="Stop a run that takes longer than this many seconds. Increase it for long documents or slow tools."
                example="120"
              >
                <TextInput
                  value={definition.timeout_s}
                  type="number"
                  min={1}
                  disabled={!editable}
                  onChange={(timeout_s) =>
                    update({ ...definition, timeout_s: Number(timeout_s) })
                  }
                />
              </Field>
              <Field
                label="Retry attempts"
                hint="How many times to try the whole run again after a temporary failure. Tools with side effects are protected from unsafe automatic repeats."
                example="2"
              >
                <TextInput
                  value={definition.retries}
                  type="number"
                  min={0}
                  max={10}
                  disabled={!editable}
                  onChange={(retries) =>
                    update({ ...definition, retries: Number(retries) })
                  }
                />
              </Field>
              <Field
                label="Maximum tool turns"
                hint="The most tool-call rounds the model may use in one logic step. This prevents accidental loops."
                example="8"
              >
                <TextInput
                  value={Number(definition.tool_loop.max_iterations ?? 8)}
                  type="number"
                  min={1}
                  max={100}
                  disabled={!editable}
                  onChange={(max_iterations) =>
                    update({
                      ...definition,
                      tool_loop: {
                        ...definition.tool_loop,
                        max_iterations: Number(max_iterations),
                      },
                    })
                  }
                />
              </Field>
              <Field
                label="Runs at the same time"
                hint="The maximum number of this agent's runs that may execute together when concurrency limiting is enabled."
                example="8"
              >
                <TextInput
                  value={Number(
                    definition.concurrency.max_concurrent_executions ?? 8,
                  )}
                  type="number"
                  min={1}
                  disabled={!editable}
                  onChange={(max_concurrent_executions) =>
                    update({
                      ...definition,
                      concurrency: {
                        ...definition.concurrency,
                        max_concurrent_executions: Number(
                          max_concurrent_executions,
                        ),
                      },
                    })
                  }
                />
              </Field>
              <Field
                label="Group runs by"
                hint="Optional advanced key for limiting related runs together. Leave blank to share one limit for the whole agent."
                example="event.data.customerId"
              >
                <TextInput
                  value={String(definition.concurrency.key ?? "")}
                  mono
                  disabled={!editable}
                  onChange={(key) =>
                    update({
                      ...definition,
                      concurrency: { ...definition.concurrency, key },
                    })
                  }
                />
              </Field>
              <Field
                label="Run detail level"
                hint="Standard is best for normal use. Debug saves more details for troubleshooting; Minimal reduces stored detail."
              >
                <SelectInput
                  value={String(
                    definition.observability.trace_level ?? "standard",
                  )}
                  disabled={!editable}
                  onChange={(trace_level) =>
                    update({
                      ...definition,
                      observability: {
                        ...definition.observability,
                        trace_level,
                      },
                    })
                  }
                  options={[
                    { value: "minimal", label: "Minimal" },
                    { value: "standard", label: "Standard (recommended)" },
                    { value: "debug", label: "Debug" },
                  ]}
                />
              </Field>
            </div>
            <Toggle
              checked={Boolean(definition.observability.reasoning_summary)}
              disabled={!editable}
              onChange={(reasoning_summary) =>
                update({
                  ...definition,
                  observability: {
                    ...definition.observability,
                    reasoning_summary,
                  },
                })
              }
              label="Capture reasoning summaries"
              hint="Store concise user-visible summaries, never hidden chain-of-thought."
            />
            <Toggle
              checked={Boolean(definition.concurrency.enabled)}
              disabled={!editable}
              onChange={(enabled) =>
                update({
                  ...definition,
                  concurrency: { ...definition.concurrency, enabled },
                })
              }
              label="Limit simultaneous runs"
              hint="Protect shared AI providers and connected services from sudden traffic spikes."
            />
            <Toggle
              checked={Boolean(
                definition.observability.persist_rendered_prompts,
              )}
              disabled={!editable}
              onChange={(persist_rendered_prompts) =>
                update({
                  ...definition,
                  observability: {
                    ...definition.observability,
                    persist_rendered_prompts,
                  },
                })
              }
              label="Save final prompts for troubleshooting"
              hint="Leave off unless approved debugging requires it. Final prompts can contain sensitive user data."
            />
            <div style={{ maxWidth: 260, marginTop: 8 }}>
              <Field
                label="Keep run details for"
                hint="How many days to retain trace and debugging information. Follow your organization's privacy policy."
                example="30 days"
              >
                <TextInput
                  value={Number(definition.observability.retention_days ?? 30)}
                  type="number"
                  min={1}
                  disabled={!editable}
                  onChange={(retention_days) =>
                    update({
                      ...definition,
                      observability: {
                        ...definition.observability,
                        retention_days: Number(retention_days),
                      },
                    })
                  }
                />
              </Field>
            </div>
          </StudioPanel>
          <StudioPanel
            title="Schedule"
            subtitle="Optional cron execution; event and manual triggers continue to work independently."
          >
            <div
              className="agent-studio-form-grid agent-studio-form-grid--2"
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 12,
              }}
            >
              <Field
                label="Schedule"
                hint="Optional advanced schedule in cron format. Leave blank unless this agent should run automatically at fixed times."
                example="0 9 * * 1-5 means weekdays at 9:00"
              >
                <TextInput
                  value={definition.cron ?? ""}
                  mono
                  disabled={!editable}
                  placeholder="Leave blank for no schedule"
                  onChange={(cron) =>
                    update({ ...definition, cron: cron || null })
                  }
                />
              </Field>
              <Field
                label="Schedule timezone"
                hint="The location used to interpret the schedule. Use an IANA timezone name."
                example="Asia/Singapore"
              >
                <TextInput
                  value={definition.cron_timezone ?? ""}
                  mono
                  disabled={!editable}
                  placeholder="Asia/Singapore"
                  onChange={(cron_timezone) =>
                    update({
                      ...definition,
                      cron_timezone: cron_timezone || null,
                    })
                  }
                />
              </Field>
            </div>
          </StudioPanel>
        </div>
      );
    if (section === "workflow")
      return (
        <div style={{ display: "grid", gap: 14 }}>
          <StudioPanel
            title="Incoming events"
            subtitle="Events can start this agent; input bindings map event payloads into typed inputs."
          >
            <Field
              label="Events that start this agent"
              hint="Enter one event name per line. Leave empty when the agent is only started manually."
              example="support/ticket.created"
            >
              <TextArea
                value={definition.trigger.join("\n")}
                rows={5}
                mono
                disabled={!editable}
                onChange={(value) =>
                  update({ ...definition, trigger: csvToList(value) })
                }
              />
            </Field>
            <JsonValueEditor
              value={definition.trigger_bindings ?? {}}
              onChange={(trigger_bindings) =>
                update({ ...definition, trigger_bindings })
              }
              height={210}
              label="How event data fills inputs"
              hint="Advanced. Map each input ID to a value in the incoming event. Keep {} when the event payload already uses the same input names."
              example={'{"customer_id":"$.data.customerId"}'}
              readOnly={!editable}
            />
          </StudioPanel>
          <StudioPanel
            title="Outgoing events"
            subtitle="Emit events after success and bind their payloads from named outputs."
          >
            <Field
              label="Events sent after success"
              hint="Enter one event name per line for downstream workflow steps. Leave empty if nothing else needs to start."
              example="support/ticket.classified"
            >
              <TextArea
                value={definition.triggered_event.join("\n")}
                rows={5}
                mono
                disabled={!editable}
                onChange={(value) =>
                  update({ ...definition, triggered_event: csvToList(value) })
                }
              />
            </Field>
            <JsonValueEditor
              value={definition.output_bindings}
              onChange={(output_bindings) =>
                update({
                  ...definition,
                  output_bindings: asRecord(output_bindings),
                })
              }
              height={210}
              label="What each outgoing event contains"
              hint="Advanced. Choose which named outputs become the outgoing event payload. Keep {} to send the aggregate output."
              example={
                '{"support/ticket.classified":{"category":"$.outputs.category"}}'
              }
              readOnly={!editable}
            />
            <InlineNotice
              action={
                <Link
                  href={`/portal/${tenant}/workflows`}
                  style={{ color: "var(--blue)" }}
                >
                  Open workflow editor ↗
                </Link>
              }
            >
              Use the workflow editor to see downstream impact before publishing
              trigger or output changes.
            </InlineNotice>
          </StudioPanel>
        </div>
      );
    if (section === "test")
      return (
        <TestLab
          agentId={agentId}
          definition={definition}
          draft={draft ? { id: draft.id, revision } : null}
          liveVersionId={editor.data.live?.agentVersionId ?? null}
          canRun={editor.data.capabilities.canRun}
          draftHasUnsavedChanges={dirty || saveState === "saving"}
        />
      );
    if (section === "versions")
      return (
        <StudioPanel
          title="Immutable versions"
          subtitle="Past runs stay pinned to the exact definition that produced them."
        >
          {versions.isLoading ? (
            <Empty title="Loading versions…" />
          ) : versions.isError ? (
            <Empty title="Versions unavailable" hint={versions.error.message} />
          ) : versions.data?.items.length ? (
            <div style={{ display: "grid", gap: 7 }}>
              {versions.data.items.map((version) => (
                <div
                  className="agent-studio-version-row"
                  key={version.id}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "120px 1fr auto",
                    gap: 12,
                    padding: 12,
                    border: "1px solid var(--border)",
                    borderRadius: 5,
                    background: "var(--panel-2)",
                  }}
                >
                  <div>
                    <Badge tone={version.live ? "green" : "muted"}>
                      {version.live ? "Live" : version.workflowVersion}
                    </Badge>
                  </div>
                  <div>
                    <div
                      className="mono"
                      style={{
                        color: "var(--text)",
                        fontSize: 12,
                        fontWeight: 600,
                      }}
                    >
                      {version.definitionHash?.slice(0, 16) ?? "no hash"}
                    </div>
                    <div
                      style={{
                        color: "var(--text-2)",
                        fontSize: 11.5,
                        lineHeight: 1.5,
                        marginTop: 4,
                      }}
                    >
                      {version.changeNote ?? "No change note"}
                    </div>
                  </div>
                  <div
                    className="mono"
                    style={{
                      color: "var(--text-2)",
                      fontSize: 11,
                      lineHeight: 1.5,
                    }}
                  >
                    {(
                      version.publishedAt ?? version.createdAt
                    ).toLocaleString()}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <Empty
              title="No published versions"
              hint="Publish the draft to create version 1."
            />
          )}
        </StudioPanel>
      );
    return (
      <div style={{ display: "grid", gap: 14 }}>
        <StudioPanel
          title="Complete definition (developer JSON)"
          subtitle="Advanced: edits the same fields as Guided mode. Invalid JSON is not applied, and unknown extension fields are preserved."
        >
          <RawDefinitionEditor
            value={definition}
            onChange={update}
            disabled={!editable}
          />
        </StudioPanel>
        <StudioPanel
          title="TypeScript reference (documentation only)"
          subtitle="Stored with the definition for developers. Publishing this text does not deploy or run code; executable agents use the code-defined agent deployment workflow."
        >
          <MonacoEditor
            value={definition.typescript_code}
            language="typescript"
            height={420}
            readOnly={!editable}
            onChange={(typescript_code) =>
              update({ ...definition, typescript_code })
            }
          />
        </StudioPanel>
      </div>
    );
  }

  const activeSection = mode === "advanced" ? "advanced" : section;
  return (
    <div
      className="agent-studio-shell"
      style={{
        height: "100%",
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        background: "var(--bg)",
      }}
    >
      <header
        className="agent-studio-header"
        style={{
          flexShrink: 0,
          borderBottom: "1px solid var(--border)",
          background: "var(--panel)",
          padding: "10px 16px",
        }}
      >
        <div
          className="agent-studio-header-row"
          style={{
            display: "flex",
            alignItems: "center",
            flexWrap: "wrap",
            gap: 12,
          }}
        >
          {workflowSlug ? (
            <Button
              small
              icon="chevron-left"
              disabled={navigationPending || saveState === "saving"}
              title="Save this agent draft and return to the workflow canvas"
              onClick={() => void returnToWorkflow()}
            >
              {navigationPending ? "Returning…" : "Back to workflow"}
            </Button>
          ) : (
            <Link
              href={`/portal/${tenant}/agents`}
              style={{ display: "inline-flex", color: "var(--text-2)" }}
              aria-label="Back to agents"
            >
              <Icon name="chevron-left" size={14} />
            </Link>
          )}
          <div style={{ minWidth: 0, flex: 1 }}>
            <div
              className="agent-studio-header-identity"
              style={{ display: "flex", alignItems: "center", gap: 8 }}
            >
              <h1
                className="agent-studio-title"
                style={{
                  margin: 0,
                }}
              >
                {definition.title}
              </h1>
              <Badge
                tone={draft ? "amber" : codeCompatibility ? "muted" : "green"}
              >
                {draft ? "Draft" : codeCompatibility ? "Compatibility" : "Live"}
              </Badge>
              <Badge
                tone={editing ? "solid" : "muted"}
                style={editing ? undefined : { color: "var(--text-2)" }}
              >
                {codeCompatibility
                  ? "Read only"
                  : editing
                    ? "Editing"
                    : "View mode"}
              </Badge>
              <Badge tone="muted" style={{ color: "var(--text-2)" }}>
                {editor.data.agent.actor}
              </Badge>
              {codeCompatibility && (
                <Badge tone="muted" style={{ color: "var(--text-2)" }}>
                  Code-defined
                </Badge>
              )}
              {generatedCompatibility && (
                <Badge tone="amber">Generated manifest</Badge>
              )}
              {upgradedCompatibility && (
                <Badge tone="blue">Upgraded format</Badge>
              )}
              {errorCount > 0 && (
                <Badge tone="red">
                  {errorCount} error{errorCount === 1 ? "" : "s"}
                </Badge>
              )}
            </div>
            <div
              className="mono agent-studio-header-meta"
              style={{ marginTop: 3 }}
            >
              {definition.name} · {editor.data.live?.version ?? "unpublished"} ·{" "}
              {definition.inputs.length} inputs · {definition.outputs.length}{" "}
              outputs · {definition.tool_use.length} tools
            </div>
          </div>
          {workflowSlug ? (
            <div
              className="agent-studio-agent-select"
              role="status"
              aria-label={`Workflow handoff for ${workflowSlug}. ${definition.title} is pinned until you return to the workflow canvas.`}
              title="Return to the workflow canvas to choose another agent. This agent and its exact workflow version are pinned together."
              style={{
                minWidth: 0,
                maxWidth: 260,
                padding: "5px 8px",
                border: "1px solid rgba(132,169,255,0.32)",
                borderRadius: 4,
                display: "flex",
                alignItems: "center",
                gap: 7,
                fontFamily: "var(--mono)",
              }}
            >
              <Icon name="workflow" size={14} />
              <span
                style={{
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {workflowSlug} · {definition.title}
              </span>
              <Badge tone="blue" style={{ marginLeft: "auto" }}>
                Pinned
              </Badge>
            </div>
          ) : (
            <select
              className="agent-studio-agent-select"
              value={agentId}
              aria-label="Open another agent"
              disabled={navigationPending || saveState === "saving"}
              onChange={(event) => void openAnotherAgent(event.target.value)}
              style={{
                maxWidth: 190,
                padding: "5px 8px",
                border: "1px solid var(--border-2)",
                borderRadius: 4,
                fontFamily: "var(--mono)",
              }}
            >
              {(agents.data ?? []).map((agent) => (
                <option key={agent.kebabId} value={agent.kebabId}>
                  {agent.title} · {agent.kebabId}
                </option>
              ))}
            </select>
          )}
          <Segmented
            ariaLabel="Editor view"
            value={mode}
            onChange={(next) => {
              setMode(next);
              if (next === "advanced") setSection("advanced");
            }}
            options={[
              { value: "guided", label: "Guided" },
              { value: "advanced", label: "Developer view" },
            ]}
          />
          <Button
            small
            icon="task"
            title="Learn how to create, edit, test, publish, and operate an agent"
            onClick={() => {
              setHelpTopic(activeSection === "test" ? "testing" : "start");
              setHelpOpen(true);
            }}
          >
            Help & examples
          </Button>
          {codeCompatibility ? (
            <Button
              small
              disabled
              title="Code-defined agents are edited in their source implementation."
            >
              Edit unavailable
            </Button>
          ) : !draft ? (
            <>
              {editor.data.capabilities.canRun && (
                <Button
                  small
                  icon="play"
                  title="Open the Test Lab without starting a run"
                  onClick={() => {
                    setMode("guided");
                    setSection("test");
                  }}
                >
                  Open Test Lab
                </Button>
              )}
              <Button
                tone="primary"
                icon="plus"
                disabled={
                  !editor.data.capabilities.canEdit || createDraft.isPending
                }
                title="Create a safe draft and enter Edit mode"
                onClick={() => void startEditing()}
              >
                {createDraft.isPending ? "Creating draft…" : "Edit"}
              </Button>
            </>
          ) : editing ? (
            <>
              <span
                className="mono agent-studio-revision-status"
                role="status"
                style={{
                  color:
                    saveState === "error"
                      ? "var(--red)"
                      : dirty
                        ? "var(--amber)"
                        : "var(--text-2)",
                }}
              >
                {saveState === "saving"
                  ? "saving…"
                  : dirty
                    ? "unsaved"
                    : saveState === "saved"
                      ? "saved"
                      : `rev ${revision}`}
              </span>
              <Button
                small
                disabled={
                  !dirty || saveDraft.isPending || saveState === "saving"
                }
                onClick={() => void persist(false)}
              >
                Save
              </Button>
              <Button
                small
                disabled={saveState === "saving"}
                title="Restore the draft to how it was when Edit mode started"
                onClick={() => void cancelEditing()}
              >
                Cancel
              </Button>
              <Button
                small
                icon="check"
                disabled={saveState === "saving"}
                title="Save any remaining changes and return to protected view mode"
                onClick={() => void finishEditing()}
              >
                Done
              </Button>
              <Button
                small
                icon="check"
                title="Check required fields, links, schemas, tools, and runtime settings"
                disabled={validateDraft.isPending || dirty}
                onClick={() => void validate()}
              >
                Check setup
              </Button>
              <Button
                small
                icon="play"
                title="Open the Test Lab without starting a run"
                disabled={!editor.data.capabilities.canRun}
                onClick={() => {
                  setMode("guided");
                  setSection("test");
                }}
              >
                Open Test Lab
              </Button>
              <Button
                tone="primary"
                small
                icon="deploy"
                disabled={
                  !editor.data.capabilities.canPublish ||
                  publishDraft.isPending ||
                  saveState === "saving" ||
                  errorCount > 0
                }
                onClick={() => void publish()}
              >
                {publishDraft.isPending ? "Publishing…" : "Publish"}
              </Button>
            </>
          ) : (
            <>
              <span className="mono agent-studio-revision-status">
                rev {revision} · protected
              </span>
              <Button
                small
                icon="check"
                title="Check required fields, links, schemas, tools, and runtime settings"
                disabled={validateDraft.isPending}
                onClick={() => void validate()}
              >
                Check setup
              </Button>
              <Button
                small
                icon="play"
                title="Open the Test Lab without starting a run"
                disabled={!editor.data.capabilities.canRun}
                onClick={() => {
                  setMode("guided");
                  setSection("test");
                }}
              >
                Open Test Lab
              </Button>
              <Button
                small
                icon="deploy"
                disabled={
                  !editor.data.capabilities.canPublish ||
                  publishDraft.isPending ||
                  errorCount > 0
                }
                onClick={() => void publish()}
              >
                {publishDraft.isPending ? "Publishing…" : "Publish"}
              </Button>
              <Button
                tone="primary"
                disabled={!editor.data.capabilities.canEdit}
                title="Enter Edit mode for this draft"
                onClick={() => void startEditing()}
              >
                Edit
              </Button>
            </>
          )}
        </div>
      </header>

      {codeCompatibility && !draft && (
        <div
          style={{
            padding: "8px 16px",
            borderBottom: "1px solid var(--border)",
            background: "rgba(132,169,255,0.06)",
          }}
        >
          <InlineNotice
            tone="blue"
            title="Code-defined agent — read-only compatibility view"
          >
            This older agent runs from source code, so Agent Studio cannot
            safely recreate or replace its behavior with a manifest. Its saved
            metadata has been adjusted to the current format for viewing.
            Continue editing the source implementation, or create a new manifest
            agent when you want Studio-managed behavior.
          </InlineNotice>
        </div>
      )}

      {!codeCompatibility && !draft && (
        <div
          style={{
            padding: "8px 16px",
            borderBottom: "1px solid var(--border)",
            background: "rgba(132,169,255,0.06)",
          }}
        >
          <InlineNotice
            tone="blue"
            title={
              upgradedCompatibility
                ? "Older agent upgraded — view mode"
                : "Live definition — view mode"
            }
            action={
              <Button
                small
                tone="primary"
                disabled={
                  !editor.data.capabilities.canEdit || createDraft.isPending
                }
                onClick={() => void startEditing()}
              >
                {createDraft.isPending ? "Creating…" : "Edit"}
              </Button>
            }
          >
            {upgradedCompatibility
              ? "Agent Studio translated the older manifest into the current editor format without changing its published history. Edit creates a safe draft for review and updates."
              : "The live definition is protected. Edit creates a safe draft; you can still run the live version and inspect history."}
          </InlineNotice>
        </div>
      )}

      {draft &&
        (editing || generatedCompatibility || upgradedCompatibility) && (
          <div
            className={`agent-studio-notice-grid${
              editing && (generatedCompatibility || upgradedCompatibility)
                ? " agent-studio-notice-grid--split"
                : ""
            }`}
            style={{
              background: editing
                ? "rgba(208,255,0,0.035)"
                : "rgba(132,169,255,0.035)",
            }}
          >
            {editing && (
              <InlineNotice tone="signal" title="Edit mode is on">
                Make changes across any section. Autosave creates checkpoints;
                Save stores one immediately, Done saves and exits, and Cancel
                restores the draft to the start of this edit session.
              </InlineNotice>
            )}
            {(generatedCompatibility || upgradedCompatibility) && (
              <InlineNotice
                tone={generatedCompatibility ? "amber" : "blue"}
                title={
                  generatedCompatibility
                    ? "Starter manifest created for this older agent"
                    : "Older definition converted to the current format"
                }
              >
                {generatedCompatibility
                  ? "No usable manifest was saved, so Agent Studio created a safe starting draft from the agent's identity and known event triggers. Review the instructions, inputs, steps, and outputs; then test before publishing."
                  : `Agent Studio recovered this draft from ${compatibilitySource.includes("action-catalog") ? "the older action catalog" : "an earlier saved version"}. The original version remains unchanged for historical runs. Review and test this draft before publishing.`}
              </InlineNotice>
            )}
          </div>
        )}

      <div
        className={`agent-studio-layout${activeSection === "test" ? " agent-studio-layout--test" : ""}`}
        style={{ flex: 1, minHeight: 0, display: "grid" }}
      >
        <nav
          className="agent-studio-section-nav"
          aria-label="Agent editor sections"
          style={{
            overflow: "auto",
            borderRight: "1px solid var(--border)",
            background: "var(--panel)",
            padding: "12px 8px",
          }}
        >
          <div
            className="mono agent-studio-section-nav-label"
            style={{
              padding: "0 8px 8px",
            }}
          >
            BUILD
          </div>
          {SECTIONS.map((item) => {
            const active = activeSection === item.id;
            return (
              <button
                className={`agent-studio-section-nav-item${
                  active ? " agent-studio-section-nav-item--active" : ""
                }`}
                type="button"
                key={item.id}
                aria-current={active ? "page" : undefined}
                onClick={() => {
                  setMode(item.id === "advanced" ? "advanced" : "guided");
                  setSection(item.id);
                }}
                style={{
                  width: "100%",
                  display: "flex",
                  alignItems: "center",
                  gap: 9,
                  padding: "8px 9px",
                  marginBottom: 2,
                  borderRadius: 4,
                  background: active ? "var(--panel-3)" : "transparent",
                  borderLeft: `2px solid ${active ? "var(--signal)" : "transparent"}`,
                  textAlign: "left",
                }}
              >
                <Icon name={item.icon} size={11} />
                <span style={{ flex: 1 }}>{item.label}</span>
                {item.id === "inputs" && (
                  <span className="mono agent-studio-section-nav-count">
                    {definition.inputs.length}
                  </span>
                )}
                {item.id === "outputs" && (
                  <span className="mono agent-studio-section-nav-count">
                    {definition.outputs.length}
                  </span>
                )}
                {item.id === "tools" && (
                  <span className="mono agent-studio-section-nav-count">
                    {definition.tool_use.length}
                  </span>
                )}
              </button>
            );
          })}
          {draft && (
            <div
              style={{
                marginTop: 16,
                padding: "9px 8px",
                borderTop: "1px solid var(--border)",
              }}
            >
              <Toggle
                checked={autoSave}
                disabled={!editing}
                onChange={setAutoSave}
                label="Autosave"
                hint={
                  editing
                    ? "Saves the draft shortly after you stop typing. It never publishes automatically."
                    : "Available in Edit mode. It never publishes automatically."
                }
              />
            </div>
          )}
        </nav>

        <main
          className="agent-studio-main"
          style={{ minWidth: 0, overflow: "auto", padding: "18px 20px 40px" }}
        >
          <div
            className="agent-studio-main-inner"
            style={{
              maxWidth: activeSection === "test" ? 1500 : 1040,
              margin: "0 auto",
            }}
          >
            <div style={{ marginBottom: 14 }}>
              <div className="mono agent-studio-section-eyebrow" style={{}}>
                Agent Studio /{" "}
                {SECTIONS.find((item) => item.id === activeSection)?.label}
              </div>
              <h2
                className="agent-studio-section-title"
                style={{
                  margin: "4px 0 0",
                }}
              >
                {SECTIONS.find((item) => item.id === activeSection)?.label}
              </h2>
            </div>
            <div className="agent-studio-section-content">
              {renderGuidedSection()}
            </div>
          </div>
        </main>

        <aside
          className="agent-studio-context"
          aria-live="polite"
          style={{
            overflow: "auto",
            borderLeft: "1px solid var(--border)",
            background: "var(--panel)",
            padding: 12,
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: 9,
            }}
          >
            <span className="agent-studio-context-title">
              Definition health
            </span>
            <Badge tone={errorCount ? "red" : "green"}>
              {errorCount ? `${errorCount} blocking` : "Ready"}
            </Badge>
          </div>
          <div style={{ display: "grid", gap: 7 }}>
            {allIssues.length ? (
              allIssues.map((issue, index) => (
                <button
                  type="button"
                  key={`${issue.path}-${issue.code}-${index}`}
                  onClick={() => {
                    setMode("guided");
                    setSection(sectionForIssue(issue.path));
                  }}
                  style={{
                    padding: 9,
                    textAlign: "left",
                    border: "1px solid var(--border)",
                    borderRadius: 5,
                    background: "var(--panel-2)",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      gap: 6,
                      alignItems: "center",
                    }}
                  >
                    <Badge tone={issueTone(issue.severity)}>
                      {issue.severity}
                    </Badge>
                    <span
                      className="agent-studio-issue-path"
                      style={{
                        overflowWrap: "anywhere",
                      }}
                    >
                      {friendlyIssuePath(issue.path, definition)}
                    </span>
                  </div>
                  <div
                    className="agent-studio-issue-message"
                    style={{
                      marginTop: 6,
                    }}
                  >
                    {issue.message}
                  </div>
                  {issue.suggestion && (
                    <div
                      className="agent-studio-issue-suggestion"
                      style={{
                        marginTop: 5,
                      }}
                    >
                      Try this: {issue.suggestion}
                    </div>
                  )}
                </button>
              ))
            ) : (
              <InlineNotice tone="green">
                No local or server validation issues.
              </InlineNotice>
            )}
          </div>
          <div
            style={{
              borderTop: "1px solid var(--border)",
              marginTop: 16,
              paddingTop: 12,
            }}
          >
            <div
              className="mono agent-studio-quick-facts-title"
              style={{ marginBottom: 8 }}
            >
              QUICK FACTS
            </div>
            {[
              [
                "Definition",
                (
                  draft?.definitionHash ??
                  editor.data.live?.definitionHash ??
                  "—"
                ).slice(0, 12),
              ],
              [
                "Runtime",
                `${definition.timeout_s}s / ${definition.retries} retries`,
              ],
              ["Model", definition.model || "workspace default"],
              [
                "Output",
                String(
                  asRecord(definition.output_config.artifact).filename ??
                    "output.json",
                ),
              ],
              [
                "Trace",
                String(definition.observability.trace_level ?? "standard"),
              ],
            ].map(([label, value]) => (
              <div
                className="agent-studio-quick-fact"
                key={label}
                style={{
                  display: "grid",
                  gridTemplateColumns: "75px 1fr",
                  gap: 6,
                  padding: "5px 0",
                  borderBottom: "1px solid var(--border)",
                }}
              >
                <span className="agent-studio-quick-fact-label">{label}</span>
                <span
                  className="mono agent-studio-quick-fact-value"
                  style={{
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {value}
                </span>
              </div>
            ))}
          </div>
        </aside>
      </div>
      <AgentStudioHelp
        open={helpOpen}
        initialTopic={helpTopic}
        onClose={() => setHelpOpen(false)}
      />
    </div>
  );
}
