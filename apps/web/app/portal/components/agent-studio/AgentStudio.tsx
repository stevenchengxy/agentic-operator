"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge, Button, Empty, Icon, MonacoEditor, useToast } from "@/app/portal/components";
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
  type StudioValidationIssue as ContractValidationIssue,
} from "@/lib/hooks/useAgentStudio";
import { Field, InlineNotice, JsonValueEditor, Segmented, SelectInput, StudioPanel, TextArea, TextInput, Toggle } from "./fields";
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

type SectionId = "overview" | "instructions" | "inputs" | "outputs" | "steps" | "tools" | "runtime" | "workflow" | "test" | "versions" | "advanced";
type EditorMode = "guided" | "advanced";

const SECTIONS: Array<{ id: SectionId; label: string; icon: "agent" | "spark" | "chevron-right" | "external" | "workflow" | "settings" | "event" | "play" | "git" | "code" }> = [
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

const PROVIDERS = ["", "mock", "anthropic", "openai", "openrouter", "gemini", "azure", "groq", "together", "mistral", "deepseek", "qwen", "bedrock", "vertex", "custom"];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function issueTone(severity: StudioValidationIssue["severity"]): "red" | "amber" | "blue" {
  return severity === "error" ? "red" : severity === "warning" ? "amber" : "blue";
}

function RawDefinitionEditor({ value, onChange, disabled }: { value: StudioDefinition; onChange: (next: StudioDefinition) => void; disabled?: boolean }) {
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
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
        <Badge tone={error ? "red" : "green"}>{error ? "Invalid JSON" : "Valid definition"}</Badge>
        <span style={{ color: "var(--text-3)", fontSize: 10.5 }}>Unknown extension fields are preserved on round-trip.</span>
      </div>
      <div style={{ opacity: disabled ? 0.65 : 1, pointerEvents: disabled ? "none" : "auto" }}>
        <MonacoEditor value={text} language="json" height={620} onChange={(next) => {
          setText(next);
          const parsed = parseLooseJson(next);
          if (parsed.error) return setError(parsed.error);
          if (!parsed.value || typeof parsed.value !== "object" || Array.isArray(parsed.value)) return setError("The agent definition must be a JSON object.");
          setError(null);
          lastValid.current = toPrettyJson(parsed.value);
          onChange(normalizeStudioDefinition(parsed.value, value));
        }} />
      </div>
      {error && <div className="mono" style={{ marginTop: 7, color: "var(--red)", fontSize: 10.5 }}>{error}</div>}
    </div>
  );
}

export function AgentStudio({ agentId }: { agentId: string }) {
  const tenant = useTenant();
  const router = useRouter();
  const toast = useToast();
  const dirtyStore = useDirty();
  const editor = useAgentEditor(agentId);
  const agents = useAgents();
  const [section, setSection] = useState<SectionId>("overview");
  const [mode, setMode] = useState<EditorMode>("guided");
  const [definition, setDefinition] = useState<StudioDefinition | null>(null);
  const [baseline, setBaseline] = useState("");
  const [revision, setRevision] = useState(1);
  const [autoSave, setAutoSave] = useState(true);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [serverIssues, setServerIssues] = useState<ContractValidationIssue[]>([]);
  const loadedSource = useRef("");
  const saveInFlight = useRef(false);
  const definitionRef = useRef<StudioDefinition | null>(null);
  const createDraft = useCreateAgentDraft(agentId);
  const saveDraft = useSaveAgentDraft(editor.data?.draft?.id);
  const validateDraft = useValidateAgentDraft(agentId, editor.data?.draft?.id);
  const generateInstructions = useGenerateDraftInstructions(editor.data?.draft?.id);
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
  }, [editor.data]);

  const dirty = Boolean(definition && editor.data?.draft && JSON.stringify(definition) !== baseline);
  const localIssues = useMemo(() => definition ? localValidation(definition) : [], [definition]);
  const allIssues = useMemo(() => {
    const seen = new Set<string>();
    return [...localIssues, ...serverIssues].filter((issue) => {
      const key = `${issue.path}:${issue.code}:${issue.message}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [localIssues, serverIssues]);
  const errorCount = allIssues.filter((issue) => issue.severity === "error").length;

  useEffect(() => {
    definitionRef.current = definition;
  }, [definition]);

  useEffect(() => {
    dirtyStore.setDirty("agent-studio", dirty ? `${definition?.title ?? "agent"} draft` : null);
    return () => dirtyStore.setDirty("agent-studio", null);
  }, [dirty, definition?.title, dirtyStore]);

  const persist = useCallback(async (quiet = false) => {
    if (!definition || !editor.data?.draft || saveInFlight.current) return null;
    saveInFlight.current = true;
    setSaveState("saving");
    const submitted = definition;
    try {
      const result = await saveDraft.mutateAsync({ definition: submitted, revision });
      const saved = normalizeStudioDefinition(result.draft.definition, submitted);
      if (JSON.stringify(definitionRef.current) === JSON.stringify(submitted)) {
        setDefinition(saved);
      }
      setRevision(result.draft.revision);
      setBaseline(JSON.stringify(saved));
      loadedSource.current = `draft:${result.draft.id}:${result.draft.revision}`;
      setServerIssues(result.draft.validation.status === "stale" ? [] : result.draft.validation.issues);
      setSaveState("saved");
      if (!quiet) toast({ tone: "green", title: "Draft saved", description: `Revision ${result.draft.revision}` });
      return result.draft;
    } catch (error) {
      setSaveState("error");
      if (!quiet) toast({ tone: "red", title: "Save failed", description: errorMessage(error) });
      return null;
    } finally {
      saveInFlight.current = false;
    }
  }, [definition, editor.data?.draft, revision, saveDraft, toast]);

  useEffect(() => {
    if (!autoSave || !dirty || saveInFlight.current) return;
    const timer = window.setTimeout(() => void persist(true), 1_300);
    return () => window.clearTimeout(timer);
  }, [autoSave, dirty, definition, persist]);

  async function makeDraft() {
    if (!definition) return;
    try {
      const result = await createDraft.mutateAsync({
        definition,
        ...(editor.data?.live?.agentVersionId ? { baseAgentVersionId: editor.data.live.agentVersionId } : {}),
        ...(editor.data?.live?.workflowVersionId ? { baseWorkflowVersionId: editor.data.live.workflowVersionId } : {}),
      });
      const next = normalizeStudioDefinition(result.draft.definition, definition);
      loadedSource.current = `draft:${result.draft.id}:${result.draft.revision}`;
      setDefinition(next);
      setRevision(result.draft.revision);
      setBaseline(JSON.stringify(next));
      toast({ tone: "green", title: "Editable draft created", description: "Changes now autosave without affecting the live version." });
      await editor.refetch();
    } catch (error) {
      toast({ tone: "red", title: "Could not create draft", description: errorMessage(error) });
    }
  }

  async function validate() {
    if (dirty && !(await persist(true))) return;
    try {
      const result = await validateDraft.mutateAsync();
      setServerIssues(result.validation.issues);
      toast({ tone: result.validation.status === "valid" ? "green" : "red", title: result.validation.status === "valid" ? "Draft is valid" : "Validation found blocking issues", description: `${result.validation.issues.length} issue${result.validation.issues.length === 1 ? "" : "s"}` });
    } catch (error) {
      toast({ tone: "red", title: "Validation failed", description: errorMessage(error) });
    }
  }

  async function publish() {
    if (errorCount > 0) {
      setSection("overview");
      toast({ tone: "red", title: "Fix validation errors first", description: `${errorCount} blocking issue${errorCount === 1 ? "" : "s"}` });
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
      if (validation.validation.status !== "valid") return toast({ tone: "red", title: "Draft is not publishable", description: "Resolve the server validation issues and retry." });
      if (typeof window !== "undefined" && !window.confirm("Publish this draft as a new immutable live version? Existing in-flight runs will continue on their pinned definition.")) return;
      const note = `Published from Agent Studio revision ${publishRevision}`;
      let result;
      try {
        result = await publishDraft.mutateAsync({ confirmImpact: false, note });
      } catch (error) {
        if (!(error instanceof AgentStudioApiError) || error.code !== "impact_confirmation_required") throw error;
        const impacts = asRecord(error.details).impacts;
        const labels = Array.isArray(impacts) ? impacts.filter((item): item is string => typeof item === "string") : [];
        const accepted = typeof window !== "undefined" && window.confirm(
          `This version changes ${labels.length ? labels.join(", ") : "runtime-facing contracts"}. Downstream events, tools, or callers may be affected. Publish anyway?`,
        );
        if (!accepted) return;
        result = await publishDraft.mutateAsync({ confirmImpact: true, note });
      }
      toast({ tone: "green", title: `Published ${result.version}`, description: `Runtime ${result.runtime.registered ? "registered" : "pending registration"}` });
      await editor.refetch();
    } catch (error) {
      toast({ tone: "red", title: "Publish failed", description: errorMessage(error) });
    }
  }

  if (editor.isLoading) return <Empty title="Loading Agent Studio…" hint="Resolving the live version and your latest draft." />;
  if (editor.isError) return <Empty title="Agent Studio could not load" hint={editor.error.message} />;
  if (!editor.data || !definition) return <Empty title="No editable definition found" hint="This agent has neither a live version nor an existing draft." />;

  const draft = editor.data.draft;
  const editable = Boolean(draft && editor.data.capabilities.canEdit);
  const update = (next: StudioDefinition) => {
    if (!editable) return;
    setServerIssues([]);
    setDefinition(next);
  };

  function renderGuidedSection() {
    if (!definition || !editor.data) return null;
    if (section === "overview") return (
      <StudioPanel title="Agent identity" subtitle="How people find and understand this agent.">
        <div style={{ display: "grid", gap: 14 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Field label="Display name" required><TextInput value={definition.title} disabled={!editable} onChange={(title) => update({ ...definition, title })} /></Field>
            <Field label="Programmatic name" required hint="Immutable identifier used by manifests, APIs, and historical runs."><TextInput value={definition.name} mono disabled onChange={() => undefined} /></Field>
          </div>
          <Field label="Purpose" hint="A concise plain-language explanation shown across the operator portal."><TextArea value={definition.description} rows={4} disabled={!editable} onChange={(description) => update({ ...definition, description })} /></Field>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
            <Field label="Owner type"><SelectInput value={definition.actor[0] ?? "Agent"} disabled={!editable} onChange={(actor) => update({ ...definition, actor: [actor as "Agent" | "Human"] })} options={[{ value: "Agent", label: "AI agent" }, { value: "Human", label: "Human task" }]} /></Field>
            <Field label="Stage"><TextInput value={definition.stage} type="number" min={0} disabled={!editable} onChange={(stage) => update({ ...definition, stage: Number(stage) })} /></Field>
            <Field label="Template"><SelectInput value={definition.template} disabled={!editable} onChange={(template) => update({ ...definition, template })} options={["blank", "classify", "extract", "rag", "loop", "human"].map((value) => ({ value, label: value }))} /></Field>
          </div>
          <InlineNotice title="Version-safe editing">You are {draft ? `editing draft revision ${revision}` : "viewing the immutable live definition"}. Publishing creates a new version; it never mutates historical runs.</InlineNotice>
        </div>
      </StudioPanel>
    );
    if (section === "instructions") return (
      <div style={{ display: "grid", gap: 14 }}>
        <StudioPanel title="System instructions" subtitle="Define the agent's role, objective, operating rules, and guardrails." action={<div style={{ display: "flex", gap: 6 }}>{(["generate", "improve", "shorten", "add_guardrails"] as const).map((modeValue) => <Button key={modeValue} small icon={modeValue === "generate" ? "spark" : undefined} disabled={!editable || generateInstructions.isPending} onClick={async () => {
          try {
            const result = await generateInstructions.mutateAsync({ mode: modeValue, instructions: definition.ontology_instructions });
            update({ ...definition, ontology_instructions: result.proposedInstructions, prompt_provenance: result.provenance });
            toast({ tone: "signal", title: "AI proposal applied to the draft", description: result.explanation ?? "Review and edit it before publishing." });
          } catch (error) { toast({ tone: "red", title: "Instruction generation failed", description: errorMessage(error) }); }
        }}>{modeValue.replace("_", " ")}</Button>)}</div>}>
          <TextArea value={definition.ontology_instructions} rows={18} mono disabled={!editable} placeholder="You are… Your objective is… Follow these rules…" onChange={(ontology_instructions) => update({ ...definition, ontology_instructions })} />
          <div style={{ display: "flex", justifyContent: "space-between", color: "var(--text-3)", fontSize: 10.5, marginTop: 6 }}><span>Used as the LLM system prompt</span><span className="mono">{definition.ontology_instructions.length.toLocaleString()} chars</span></div>
        </StudioPanel>
        <StudioPanel title="User prompt template" subtitle="The Test Lab and runtime automatically insert the prompt input as the user message.">
          <TextArea value={definition.user_prompt_template} rows={7} mono disabled={!editable} placeholder={'Supporting context:\n{{json inputs.context}}\n\nReplace “context” with a declared input ID.'} onChange={(user_prompt_template) => update({ ...definition, user_prompt_template })} />
          <InlineNotice tone="blue" title="Automatic prompt binding">The single input marked “Prompt” becomes the user role message. You do not need to copy user text into the system instructions.</InlineNotice>
        </StudioPanel>
      </div>
    );
    if (section === "inputs") return <StudioPanel title="Input contract" subtitle="One prompt plus any number of typed variables or files."><PortsEditor kind="input" ports={definition.inputs} disabled={!editable} onChange={(inputs) => update({ ...definition, inputs: inputs as StudioDefinition["inputs"] })} /></StudioPanel>;
    if (section === "outputs") return (
      <div style={{ display: "grid", gap: 14 }}>
        <StudioPanel title="Output contract" subtitle="Every completed run produces one aggregate JSON document and validates its named outputs."><PortsEditor kind="output" ports={definition.outputs} disabled={!editable} onChange={(outputs) => update({ ...definition, outputs: outputs as StudioDefinition["outputs"] })} /></StudioPanel>
        <StudioPanel title="JSON artifact policy" subtitle="The aggregate output is always persisted as a JSON artifact.">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Field label="Artifact filename"><TextInput value={String(asRecord(definition.output_config.artifact).filename ?? "output.json")} mono disabled={!editable} onChange={(filename) => update({ ...definition, output_config: { ...definition.output_config, artifact: { ...asRecord(definition.output_config.artifact), filename } } })} /></Field>
            <Field label="Repair attempts"><TextInput value={Number(definition.output_config.repair_attempts ?? 1)} type="number" min={0} max={3} disabled={!editable} onChange={(repair_attempts) => update({ ...definition, output_config: { ...definition.output_config, repair_attempts: Number(repair_attempts) } })} /></Field>
          </div>
          <Toggle checked={Boolean(definition.output_config.strict)} disabled={!editable} onChange={(strict) => update({ ...definition, output_config: { ...definition.output_config, strict } })} label="Strict schema validation" hint="Fail the run when the model cannot produce the declared JSON shape after repair." />
          <Toggle checked={Boolean(definition.output_config.unwrap_single_output)} disabled={!editable} onChange={(unwrap_single_output) => update({ ...definition, output_config: { ...definition.output_config, unwrap_single_output } })} label="Unwrap a single output" hint="Return the named output value directly while still retaining the aggregate output.json artifact." />
          <Toggle checked={Boolean(asRecord(definition.output_config.artifact).persist_individual_outputs)} disabled={!editable} onChange={(persist_individual_outputs) => update({ ...definition, output_config: { ...definition.output_config, artifact: { ...asRecord(definition.output_config.artifact), persist_individual_outputs } } })} label="Also persist each named output" hint="Useful for downstream integrations that consume one output port at a time." />
          <Toggle checked={Boolean(asRecord(definition.output_config.artifact).persist_run_input ?? true)} disabled={!editable} onChange={(persist_run_input) => update({ ...definition, output_config: { ...definition.output_config, artifact: { ...asRecord(definition.output_config.artifact), persist_run_input } } })} label="Persist validated run input" hint="Retain the exact structured inputs for reproducibility, subject to redaction policy." />
          <Toggle checked disabled onChange={() => undefined} label="Persist run record" hint="Required for reproducibility: stores the version pin, timing, validation, model usage, artifacts, and emitted events." />
          <Toggle checked={Boolean(asRecord(definition.output_config.artifact).persist_raw_response)} disabled={!editable} onChange={(persist_raw_response) => update({ ...definition, output_config: { ...definition.output_config, artifact: { ...asRecord(definition.output_config.artifact), persist_raw_response } } })} label="Persist raw model response" hint="Debug-only; may contain sensitive content not present in the validated output." />
        </StudioPanel>
      </div>
    );
    if (section === "steps") return <StudioPanel title="Execution sequence" subtitle="An ordered, traceable plan. Steps can call the model, tools, people, conditions, delays, or subflows."><StepsEditor actions={definition.actions} disabled={!editable} onChange={(actions) => update({ ...definition, actions })} /></StudioPanel>;
    if (section === "tools") return <StudioPanel title="Tool permissions" subtitle="Choose from the Agentic Operator catalog. Only allowed tools can be called by this agent."><ToolsEditor tools={definition.tool_use} disabled={!editable} onChange={(tool_use) => update({ ...definition, tool_use })} /></StudioPanel>;
    if (section === "runtime") return (
      <div style={{ display: "grid", gap: 14 }}>
        <StudioPanel title="Model and generation" subtitle="Leave provider and model inherited to use workspace defaults.">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Field label="Provider"><SelectInput value={definition.provider} disabled={!editable} onChange={(provider) => update({ ...definition, provider })} options={PROVIDERS.map((value) => ({ value, label: value || "Inherit workspace provider" }))} /></Field>
            <Field label="Model"><TextInput value={definition.model} mono disabled={!editable} placeholder="Inherit workspace model" onChange={(model) => update({ ...definition, model })} /></Field>
            <Field label="Temperature"><TextInput value={definition.temperature} type="number" min={0} max={2} disabled={!editable} onChange={(temperature) => update({ ...definition, temperature: Number(temperature) })} /></Field>
            <Field label="Maximum tokens"><TextInput value={definition.max_tokens} type="number" min={1} disabled={!editable} onChange={(max_tokens) => update({ ...definition, max_tokens: Number(max_tokens) })} /></Field>
          </div>
        </StudioPanel>
        <StudioPanel title="Reliability and capacity">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
            <Field label="Timeout (seconds)"><TextInput value={definition.timeout_s} type="number" min={1} disabled={!editable} onChange={(timeout_s) => update({ ...definition, timeout_s: Number(timeout_s) })} /></Field>
            <Field label="Retries"><TextInput value={definition.retries} type="number" min={0} max={10} disabled={!editable} onChange={(retries) => update({ ...definition, retries: Number(retries) })} /></Field>
            <Field label="Tool loop limit"><TextInput value={Number(definition.tool_loop.max_iterations ?? 8)} type="number" min={1} max={100} disabled={!editable} onChange={(max_iterations) => update({ ...definition, tool_loop: { ...definition.tool_loop, max_iterations: Number(max_iterations) } })} /></Field>
            <Field label="Concurrent runs"><TextInput value={Number(definition.concurrency.max_concurrent_executions ?? 8)} type="number" min={1} disabled={!editable} onChange={(max_concurrent_executions) => update({ ...definition, concurrency: { ...definition.concurrency, max_concurrent_executions: Number(max_concurrent_executions) } })} /></Field>
            <Field label="Concurrency key"><TextInput value={String(definition.concurrency.key ?? "")} mono disabled={!editable} onChange={(key) => update({ ...definition, concurrency: { ...definition.concurrency, key } })} /></Field>
            <Field label="Trace level"><SelectInput value={String(definition.observability.trace_level ?? "standard")} disabled={!editable} onChange={(trace_level) => update({ ...definition, observability: { ...definition.observability, trace_level } })} options={[{ value: "minimal", label: "Minimal" }, { value: "standard", label: "Standard" }, { value: "debug", label: "Debug" }]} /></Field>
          </div>
          <Toggle checked={Boolean(definition.observability.reasoning_summary)} disabled={!editable} onChange={(reasoning_summary) => update({ ...definition, observability: { ...definition.observability, reasoning_summary } })} label="Capture reasoning summaries" hint="Store concise user-visible summaries, never hidden chain-of-thought." />
          <Toggle checked={Boolean(definition.concurrency.enabled)} disabled={!editable} onChange={(enabled) => update({ ...definition, concurrency: { ...definition.concurrency, enabled } })} label="Apply concurrency limit" hint="Protect shared providers and downstream tools from burst traffic." />
          <Toggle checked={Boolean(definition.observability.persist_rendered_prompts)} disabled={!editable} onChange={(persist_rendered_prompts) => update({ ...definition, observability: { ...definition.observability, persist_rendered_prompts } })} label="Persist rendered prompts" hint="Useful for debugging; sensitivity and retention rules still apply." />
          <div style={{ maxWidth: 260, marginTop: 8 }}>
            <Field label="Retention days"><TextInput value={Number(definition.observability.retention_days ?? 30)} type="number" min={1} disabled={!editable} onChange={(retention_days) => update({ ...definition, observability: { ...definition.observability, retention_days: Number(retention_days) } })} /></Field>
          </div>
        </StudioPanel>
        <StudioPanel title="Schedule" subtitle="Optional cron execution; event and manual triggers continue to work independently.">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Field label="Cron expression"><TextInput value={definition.cron ?? ""} mono disabled={!editable} placeholder="0 9 * * 1-5" onChange={(cron) => update({ ...definition, cron: cron || null })} /></Field>
            <Field label="Timezone"><TextInput value={definition.cron_timezone ?? ""} mono disabled={!editable} placeholder="Asia/Singapore" onChange={(cron_timezone) => update({ ...definition, cron_timezone: cron_timezone || null })} /></Field>
          </div>
        </StudioPanel>
      </div>
    );
    if (section === "workflow") return (
      <div style={{ display: "grid", gap: 14 }}>
        <StudioPanel title="Incoming events" subtitle="Events can start this agent; input bindings map event payloads into typed inputs.">
          <Field label="Trigger event names" hint="Comma- or line-separated names."><TextArea value={definition.trigger.join("\n")} rows={5} mono disabled={!editable} onChange={(value) => update({ ...definition, trigger: csvToList(value) })} /></Field>
          <JsonValueEditor value={definition.trigger_bindings ?? {}} onChange={(trigger_bindings) => update({ ...definition, trigger_bindings })} height={210} label="Trigger input bindings" readOnly={!editable} />
        </StudioPanel>
        <StudioPanel title="Outgoing events" subtitle="Emit events after success and bind their payloads from named outputs.">
          <Field label="Emitted event names"><TextArea value={definition.triggered_event.join("\n")} rows={5} mono disabled={!editable} onChange={(value) => update({ ...definition, triggered_event: csvToList(value) })} /></Field>
          <JsonValueEditor value={definition.output_bindings} onChange={(output_bindings) => update({ ...definition, output_bindings: asRecord(output_bindings) })} height={210} label="Output event bindings" readOnly={!editable} />
          <InlineNotice action={<Link href={`/portal/${tenant}/workflows`} style={{ color: "var(--blue)" }}>Open workflow editor ↗</Link>}>Use the workflow editor to see downstream impact before publishing trigger or output changes.</InlineNotice>
        </StudioPanel>
      </div>
    );
    if (section === "test") return <TestLab agentId={agentId} definition={definition} draft={draft ? { id: draft.id, revision } : null} liveVersionId={editor.data.live?.agentVersionId ?? null} canRun={editor.data.capabilities.canRun} draftHasUnsavedChanges={dirty || saveState === "saving"} />;
    if (section === "versions") return (
      <StudioPanel title="Immutable versions" subtitle="Past runs stay pinned to the exact definition that produced them.">
        {versions.isLoading ? <Empty title="Loading versions…" /> : versions.isError ? <Empty title="Versions unavailable" hint={versions.error.message} /> : versions.data?.items.length ? <div style={{ display: "grid", gap: 7 }}>{versions.data.items.map((version) => <div key={version.id} style={{ display: "grid", gridTemplateColumns: "120px 1fr auto", gap: 12, padding: 12, border: "1px solid var(--border)", borderRadius: 5, background: "var(--panel-2)" }}><div><Badge tone={version.live ? "green" : "muted"}>{version.live ? "Live" : version.workflowVersion}</Badge></div><div><div className="mono" style={{ color: "var(--text)", fontSize: 11 }}>{version.definitionHash?.slice(0, 16) ?? "no hash"}</div><div style={{ color: "var(--text-3)", fontSize: 10.5, marginTop: 4 }}>{version.changeNote ?? "No change note"}</div></div><div className="mono" style={{ color: "var(--text-3)", fontSize: 10 }}>{(version.publishedAt ?? version.createdAt).toLocaleString()}</div></div>)}</div> : <Empty title="No published versions" hint="Publish the draft to create version 1." />}
      </StudioPanel>
    );
    return (
      <div style={{ display: "grid", gap: 14 }}>
        <StudioPanel title="Raw agent definition" subtitle="Expert mode edits the same source of truth as Guided mode."><RawDefinitionEditor value={definition} onChange={update} disabled={!editable} /></StudioPanel>
        <StudioPanel title="Optional TypeScript extension" subtitle="For code-defined agents and advanced runtime hooks."><MonacoEditor value={definition.typescript_code} language="typescript" height={420} readOnly={!editable} onChange={(typescript_code) => update({ ...definition, typescript_code })} /></StudioPanel>
      </div>
    );
  }

  const activeSection = mode === "advanced" ? "advanced" : section;
  return (
    <div style={{ height: "100%", minHeight: 0, display: "flex", flexDirection: "column", background: "var(--bg)" }}>
      <header style={{ flexShrink: 0, borderBottom: "1px solid var(--border)", background: "var(--panel)", padding: "10px 16px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <Link href={`/portal/${tenant}/agents`} style={{ display: "inline-flex", color: "var(--text-3)" }} aria-label="Back to agents"><Icon name="chevron-left" size={14} /></Link>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <h1 style={{ margin: 0, color: "var(--text)", fontSize: 16, fontWeight: 600 }}>{definition.title}</h1>
              <Badge tone={draft ? "amber" : "green"}>{draft ? "Draft" : "Live"}</Badge>
              <Badge tone="muted">{editor.data.agent.actor}</Badge>
              {errorCount > 0 && <Badge tone="red">{errorCount} error{errorCount === 1 ? "" : "s"}</Badge>}
            </div>
            <div className="mono" style={{ marginTop: 3, color: "var(--text-3)", fontSize: 10 }}>{definition.name} · {editor.data.live?.version ?? "unpublished"} · {definition.inputs.length} inputs · {definition.outputs.length} outputs · {definition.tool_use.length} tools</div>
          </div>
          <select value={agentId} aria-label="Open another agent" onChange={(event) => router.push(`/portal/${tenant}/agents/${event.target.value}` as never)} style={{ maxWidth: 190, padding: "5px 8px", color: "var(--text-2)", background: "var(--panel-2)", border: "1px solid var(--border-2)", borderRadius: 4, fontFamily: "var(--mono)", fontSize: 10.5 }}>
            {(agents.data ?? []).map((agent) => <option key={agent.kebabId} value={agent.kebabId}>{agent.title} · {agent.kebabId}</option>)}
          </select>
          <Segmented value={mode} onChange={(next) => { setMode(next); if (next === "advanced") setSection("advanced"); }} options={[{ value: "guided", label: "Guided" }, { value: "advanced", label: "Advanced" }]} />
          {!draft ? <>
            <Button small icon="play" disabled={!editor.data.capabilities.canRun} onClick={() => { setMode("guided"); setSection("test"); }}>Run</Button>
            <Button tone="primary" icon="plus" disabled={!editor.data.capabilities.canEdit || createDraft.isPending} onClick={() => void makeDraft()}>{createDraft.isPending ? "Creating…" : "Edit as draft"}</Button>
          </> : <>
            <span className="mono" style={{ color: saveState === "error" ? "var(--red)" : "var(--text-3)", fontSize: 10 }}>{saveState === "saving" ? "saving…" : dirty ? "unsaved" : saveState === "saved" ? "saved" : `rev ${revision}`}</span>
            <Button small disabled={!dirty || saveDraft.isPending} onClick={() => void persist(false)}>Save</Button>
            <Button small icon="check" disabled={validateDraft.isPending || dirty} onClick={() => void validate()}>Validate</Button>
            <Button small icon="play" disabled={!editor.data.capabilities.canRun} onClick={() => { setMode("guided"); setSection("test"); }}>Run</Button>
            <Button tone="primary" small icon="deploy" disabled={!editor.data.capabilities.canPublish || publishDraft.isPending || errorCount > 0} onClick={() => void publish()}>{publishDraft.isPending ? "Publishing…" : "Publish"}</Button>
          </>}
        </div>
      </header>

      {!draft && <div style={{ padding: "8px 16px", borderBottom: "1px solid var(--border)", background: "rgba(132,169,255,0.06)" }}><InlineNotice tone="blue" title="Live definition is read-only" action={<Button small tone="primary" disabled={!editor.data.capabilities.canEdit || createDraft.isPending} onClick={() => void makeDraft()}>Create draft</Button>}>Create a draft to edit safely. You can still run the live version and inspect history.</InlineNotice></div>}

      <div className={`agent-studio-layout${activeSection === "test" ? " agent-studio-layout--test" : ""}`} style={{ flex: 1, minHeight: 0, display: "grid" }}>
        <nav aria-label="Agent editor sections" style={{ overflow: "auto", borderRight: "1px solid var(--border)", background: "var(--panel)", padding: "12px 8px" }}>
          <div className="mono" style={{ padding: "0 8px 8px", color: "var(--text-4)", fontSize: 9.5, letterSpacing: ".08em" }}>BUILD</div>
          {SECTIONS.map((item) => {
            const active = activeSection === item.id;
            return <button type="button" key={item.id} onClick={() => { setMode(item.id === "advanced" ? "advanced" : "guided"); setSection(item.id); }} style={{ width: "100%", display: "flex", alignItems: "center", gap: 9, padding: "8px 9px", marginBottom: 2, borderRadius: 4, color: active ? "var(--text)" : "var(--text-3)", background: active ? "var(--panel-3)" : "transparent", borderLeft: `2px solid ${active ? "var(--signal)" : "transparent"}`, textAlign: "left", fontSize: 11.5 }}><Icon name={item.icon} size={11} /><span style={{ flex: 1 }}>{item.label}</span>{item.id === "inputs" && <span className="mono" style={{ fontSize: 9 }}>{definition.inputs.length}</span>}{item.id === "outputs" && <span className="mono" style={{ fontSize: 9 }}>{definition.outputs.length}</span>}{item.id === "tools" && <span className="mono" style={{ fontSize: 9 }}>{definition.tool_use.length}</span>}</button>;
          })}
          {draft && <div style={{ marginTop: 16, padding: "9px 8px", borderTop: "1px solid var(--border)" }}><Toggle checked={autoSave} onChange={setAutoSave} label="Autosave" hint="After 1.3 seconds" /></div>}
        </nav>

        <main style={{ minWidth: 0, overflow: "auto", padding: "18px 20px 40px" }}>
          <div style={{ maxWidth: activeSection === "test" ? 1500 : 1040, margin: "0 auto" }}>
            <div style={{ marginBottom: 14 }}><div className="mono" style={{ color: "var(--signal)", fontSize: 9.5, letterSpacing: ".08em", textTransform: "uppercase" }}>Agent Studio / {SECTIONS.find((item) => item.id === activeSection)?.label}</div><h2 style={{ margin: "4px 0 0", fontSize: 19, color: "var(--text)", fontWeight: 500 }}>{SECTIONS.find((item) => item.id === activeSection)?.label}</h2></div>
            <div style={{ opacity: !editable && !["test", "versions"].includes(activeSection) ? 0.78 : 1 }}>{renderGuidedSection()}</div>
          </div>
        </main>

        <aside className="agent-studio-context" style={{ overflow: "auto", borderLeft: "1px solid var(--border)", background: "var(--panel)", padding: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 9 }}><span style={{ color: "var(--text)", fontSize: 11.5, fontWeight: 600 }}>Definition health</span><Badge tone={errorCount ? "red" : "green"}>{errorCount ? `${errorCount} blocking` : "Ready"}</Badge></div>
          <div style={{ display: "grid", gap: 7 }}>
            {allIssues.length ? allIssues.map((issue, index) => <button type="button" key={`${issue.path}-${issue.code}-${index}`} onClick={() => {
              const match = SECTIONS.find((item) => issue.path.includes(item.id));
              if (match) { setMode("guided"); setSection(match.id); }
            }} style={{ padding: 9, textAlign: "left", border: "1px solid var(--border)", borderRadius: 5, background: "var(--panel-2)" }}><div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}><Badge tone={issueTone(issue.severity)}>{issue.severity}</Badge><code style={{ color: "var(--text-3)", fontSize: 9.5, overflowWrap: "anywhere" }}>{issue.path}</code></div><div style={{ marginTop: 6, color: "var(--text-2)", fontSize: 10.5, lineHeight: 1.45 }}>{issue.message}</div></button>) : <InlineNotice tone="green">No local or server validation issues.</InlineNotice>}
          </div>
          <div style={{ borderTop: "1px solid var(--border)", marginTop: 16, paddingTop: 12 }}>
            <div className="mono" style={{ color: "var(--text-4)", fontSize: 9.5, marginBottom: 8 }}>QUICK FACTS</div>
            {[
              ["Definition", (draft?.definitionHash ?? editor.data.live?.definitionHash ?? "—").slice(0, 12)],
              ["Runtime", `${definition.timeout_s}s / ${definition.retries} retries`],
              ["Model", definition.model || "workspace default"],
              ["Output", String(asRecord(definition.output_config.artifact).filename ?? "output.json")],
              ["Trace", String(definition.observability.trace_level ?? "standard")],
            ].map(([label, value]) => <div key={label} style={{ display: "grid", gridTemplateColumns: "75px 1fr", gap: 6, padding: "5px 0", borderBottom: "1px solid var(--border)", fontSize: 10.5 }}><span style={{ color: "var(--text-3)" }}>{label}</span><span className="mono" style={{ color: "var(--text-2)", overflow: "hidden", textOverflow: "ellipsis" }}>{value}</span></div>)}
          </div>
        </aside>
      </div>
    </div>
  );
}
