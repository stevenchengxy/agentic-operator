"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  PROVIDER_MODEL_CATALOG,
  type CatalogModel,
  type ProviderId,
  type ReasoningConfig,
  type ReasoningContext,
  type ReasoningEffort,
  type ReasoningMode,
  type ReasoningSummary,
  type TextVerbosity,
} from "@agentic/contracts";
import { Badge, Button, Empty } from "@/app/portal/components";
import { useTenant } from "@/app/portal/lib/use-tenant";
import {
  useAgentRunHistory,
  useCreateAgentRun,
  useRunOutput,
  useRunSession,
  useRunTrace,
  formatAgentStudioError,
  type AgentStudioRunRow,
  type CreateAgentRunRequest,
  type RunTraceEvent,
} from "@/lib/hooks/useAgentStudio";
import { useCancelRun, useRunArtifacts } from "@/lib/hooks/useRuns";
import { useRunLogStream } from "@/lib/hooks/useRunLogStream";
import {
  Field,
  InlineNotice,
  JsonValueEditor,
  Segmented,
  SelectInput,
  TextInput,
} from "./fields";
import {
  asRecord,
  isRecord,
  isTerminalStatus,
  toPrettyJson,
  type StudioDefinition,
  type StudioInputPort,
} from "./model";
import {
  buildChatTranscript,
  isStructuredChatValue,
  prettyChatValue,
  type ChatMessageView,
} from "./chat-model";
import { buildStudioChatRunRequest } from "./chat-request";

type ResultTab = "chat" | "trace" | "output" | "logs" | "artifacts";
const RUN_PROVIDERS = [
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
const DEFAULT_FILE_MAX_BYTES = 10_000_000;

function selectedCatalogModel(
  provider: string,
  model: string,
): CatalogModel | undefined {
  if (!(provider in PROVIDER_MODEL_CATALOG) || !model) return undefined;
  return PROVIDER_MODEL_CATALOG[provider as ProviderId].find(
    (candidate) => candidate.name === model.replace(/^~/, ""),
  );
}

interface StudioFilePolicy {
  mediaTypes: string[];
  maxBytes: number;
  multiple: boolean;
}

interface StudioFileValue {
  name: string;
  type: string;
  size: number;
  dataUrl: string;
}

interface StudioDraftTarget {
  id: string;
  revision: number;
}

interface PendingChatTurn {
  prompt: string;
  state: "publishing" | "queued";
  runId: string | null;
  eventId: string | null;
  eventName: string | null;
}

interface ChatDispatchReceipt {
  runId: string;
  eventId: string;
  eventName: string;
}

function filePolicyFor(input: StudioInputPort): StudioFilePolicy {
  const policy = asRecord(input.file);
  const maxBytes = policy.max_bytes;
  return {
    mediaTypes: Array.isArray(policy.media_types)
      ? policy.media_types
          .filter((value): value is string => typeof value === "string")
          .map((value) => value.trim())
          .filter(Boolean)
      : [],
    maxBytes:
      typeof maxBytes === "number" && Number.isFinite(maxBytes) && maxBytes > 0
        ? maxBytes
        : DEFAULT_FILE_MAX_BYTES,
    multiple: policy.multiple === true,
  };
}

function mediaTypeAllowed(contentType: string, allowed: string[]): boolean {
  if (allowed.length === 0) return true;
  return allowed.some((candidate) =>
    candidate.endsWith("/*")
      ? contentType.startsWith(candidate.slice(0, -1))
      : candidate === contentType,
  );
}

function formatFileBytes(bytes: number): string {
  if (bytes < 1_000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(1)} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

function readFileValue(file: File): Promise<StudioFileValue> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        reject(new Error(`Could not encode ${file.name}.`));
        return;
      }
      const encodedType = reader.result.match(/^data:([^;,]+)/)?.[1];
      resolve({
        name: file.name,
        type: file.type || encodedType || "application/octet-stream",
        size: file.size,
        dataUrl: reader.result,
      });
    };
    reader.readAsDataURL(file);
  });
}

function statusTone(
  status: string,
): "green" | "red" | "amber" | "blue" | "muted" {
  if (status === "ok") return "green";
  if (status === "failed" || status === "cancelled") return "red";
  if (status === "running" || status === "queued") return "blue";
  if (status === "waiting" || status === "paused") return "amber";
  return "muted";
}

function valueForInput(input: StudioInputPort): unknown {
  if (input.default !== undefined) return input.default;
  if (input.example !== undefined) return input.example;
  if (input.kind === "file") return filePolicyFor(input).multiple ? [] : null;
  if (input.schema.type === "boolean") return false;
  if (input.schema.type === "number" || input.schema.type === "integer")
    return 0;
  if (input.schema.type === "array") return [];
  if (input.schema.type === "object") return {};
  return "";
}

function displayTime(value: Date | string | null | undefined): string {
  if (!value) return "—";
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

function TraceRow({ event }: { event: RunTraceEvent }) {
  const color =
    event.status === "ok"
      ? "var(--green)"
      : event.status === "failed"
        ? "var(--red)"
        : event.status === "running"
          ? "var(--signal)"
          : "var(--text-3)";
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "28px minmax(0, 1fr) auto",
        gap: 9,
        padding: "10px 4px",
        borderBottom: "1px solid var(--border)",
      }}
    >
      <div className="mono" style={{ color: "var(--text-3)", fontSize: 10 }}>
        {event.seq}
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: color,
              flexShrink: 0,
            }}
          />
          <span
            style={{ color: "var(--text)", fontSize: 11.5, fontWeight: 500 }}
          >
            {event.name}
          </span>
          <Badge tone="muted">{event.kind}</Badge>
        </div>
        {event.summary && (
          <div
            style={{
              marginTop: 5,
              color: "var(--text-2)",
              fontSize: 10.5,
              lineHeight: 1.5,
            }}
          >
            {event.summary}
          </div>
        )}
      </div>
      <span className="mono" style={{ color: "var(--text-3)", fontSize: 10 }}>
        {event.durationMs == null ? "" : `${event.durationMs}ms`}
      </span>
    </div>
  );
}

function VariableControl({
  input,
  value,
  onChange,
}: {
  input: StudioInputPort;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const [fileError, setFileError] = useState<string | null>(null);
  const [readingFiles, setReadingFiles] = useState(false);

  if (input.kind === "file") {
    const policy = filePolicyFor(input);
    return (
      <div style={{ display: "grid", gap: 5 }}>
        <input
          type="file"
          accept={
            policy.mediaTypes.length > 0
              ? policy.mediaTypes.join(",")
              : undefined
          }
          multiple={policy.multiple}
          disabled={readingFiles}
          onChange={(event) => {
            const element = event.currentTarget;
            const files = Array.from(element.files ?? []);
            if (files.length === 0) {
              setFileError(null);
              onChange(policy.multiple ? [] : null);
              return;
            }

            const oversized = files.find((file) => file.size > policy.maxBytes);
            if (oversized) {
              setFileError(
                `${oversized.name} is ${formatFileBytes(oversized.size)}; the limit is ${formatFileBytes(policy.maxBytes)} per file.`,
              );
              element.value = "";
              onChange(policy.multiple ? [] : null);
              return;
            }

            const disallowed = files.find(
              (file) =>
                !mediaTypeAllowed(
                  file.type || "application/octet-stream",
                  policy.mediaTypes,
                ),
            );
            if (disallowed) {
              setFileError(
                `${disallowed.name} has media type ${disallowed.type || "application/octet-stream"}. Choose ${policy.mediaTypes.join(", ")}.`,
              );
              element.value = "";
              onChange(policy.multiple ? [] : null);
              return;
            }

            setFileError(null);
            setReadingFiles(true);
            onChange(policy.multiple ? [] : null);
            void Promise.all(files.map(readFileValue))
              .then((encoded) =>
                onChange(policy.multiple ? encoded : (encoded[0] ?? null)),
              )
              .catch((error: unknown) => {
                setFileError(
                  error instanceof Error
                    ? error.message
                    : "Could not read the selected file.",
                );
                element.value = "";
                onChange(policy.multiple ? [] : null);
              })
              .finally(() => setReadingFiles(false));
          }}
          style={{
            width: "100%",
            padding: 8,
            border: "1px dashed var(--border-2)",
            borderRadius: 5,
            color: "var(--text-2)",
            fontSize: 11,
          }}
        />
        <div
          style={{
            color: fileError ? "var(--red)" : "var(--text-3)",
            fontSize: 10,
            lineHeight: 1.4,
          }}
        >
          {fileError ??
            (readingFiles
              ? `Preparing ${policy.multiple ? "files" : "file"}…`
              : `${policy.mediaTypes.length > 0 ? policy.mediaTypes.join(", ") : "Any media type"} · ${formatFileBytes(policy.maxBytes)} max per file${policy.multiple ? " · Multiple files allowed" : ""}`)}
        </div>
      </div>
    );
  }
  if (input.schema.type === "boolean") {
    return (
      <SelectInput
        value={value === true ? "true" : "false"}
        onChange={(next) => onChange(next === "true")}
        options={[
          { value: "false", label: "No" },
          { value: "true", label: "Yes" },
        ]}
      />
    );
  }
  if (["object", "array"].includes(String(input.schema.type))) {
    return (
      <JsonValueEditor
        value={value}
        onChange={onChange}
        height={120}
        label={input.label}
      />
    );
  }
  return (
    <TextInput
      value={
        typeof value === "string" || typeof value === "number" ? value : ""
      }
      type={
        ["number", "integer"].includes(String(input.schema.type))
          ? "number"
          : "text"
      }
      onChange={(next) =>
        onChange(
          ["number", "integer"].includes(String(input.schema.type))
            ? next.trim()
              ? Number(next)
              : undefined
            : next,
        )
      }
      placeholder={String(
        asRecord(input.ui).placeholder ?? input.description ?? "",
      )}
    />
  );
}

function ChatBubble({
  message,
  selected,
  onInspectRun,
}: {
  message: ChatMessageView;
  selected: boolean;
  onInspectRun: (runId: string) => void;
}) {
  const structured = isStructuredChatValue(message.content);
  const stateLabel =
    message.state === "working"
      ? "Working"
      : message.state === "failed"
        ? "Failed"
        : message.state === "cancelled"
          ? "Cancelled"
          : message.state === "empty"
            ? "No result"
            : null;
  return (
    <article
      className={`agent-studio-chat-message agent-studio-chat-message--${message.role}${selected ? " agent-studio-chat-message--selected" : ""}`}
      aria-label={`${message.role === "user" ? "You" : "Agent"} message`}
    >
      <div className="agent-studio-chat-avatar" aria-hidden="true">
        {message.role === "user" ? "YOU" : "AI"}
      </div>
      <div className="agent-studio-chat-body">
        <div className="agent-studio-chat-byline">
          <span>{message.role === "user" ? "You" : "Agent"}</span>
          {stateLabel && (
            <span
              className={`agent-studio-chat-state agent-studio-chat-state--${message.state}`}
            >
              {message.state === "working" && (
                <span className="live-dot" aria-hidden="true" />
              )}
              {stateLabel}
            </span>
          )}
        </div>
        {structured ? (
          <pre className="agent-studio-chat-json">
            {prettyChatValue(message.content)}
          </pre>
        ) : (
          <div className="agent-studio-chat-text">
            {prettyChatValue(message.content)}
          </div>
        )}
        <div className="agent-studio-chat-meta">
          {message.createdAt && <span>{displayTime(message.createdAt)}</span>}
          {message.runId && (
            <button
              type="button"
              className="agent-studio-chat-run-link"
              aria-pressed={selected}
              onClick={() => onInspectRun(message.runId!)}
            >
              {selected ? "Inspecting this run" : "Inspect run"}
            </button>
          )}
        </div>
      </div>
    </article>
  );
}

export function TestLab({
  agentId,
  definition,
  draft,
  liveVersionId,
  canRun,
  draftHasUnsavedChanges,
}: {
  agentId: string;
  definition: StudioDefinition;
  draft: StudioDraftTarget | null;
  liveVersionId: string | null;
  canRun: boolean;
  draftHasUnsavedChanges: boolean;
}) {
  const tenant = useTenant();
  const promptInput = definition.inputs.find(
    (input) => input.kind === "prompt",
  );
  const variableInputs = definition.inputs.filter(
    (input) => input.kind !== "prompt",
  );
  // A chat turn must always be authored by the operator. Legacy manifest
  // agents receive a synthetic prompt default ("Process the incoming workflow
  // event…") during normalization; pre-filling it here makes Send look ready
  // even though no user message has been entered. Keep defaults/examples in
  // the definition for non-chat runtimes, but start the conversation composer
  // empty and let its placeholder explain what belongs here.
  const [prompt, setPrompt] = useState("");
  const [inputs, setInputs] = useState<Record<string, unknown>>(() =>
    Object.fromEntries(
      variableInputs.map((input) => [input.id, valueForInput(input)]),
    ),
  );
  const [inputMode, setInputMode] = useState<"form" | "json">("form");
  const [target, setTarget] = useState<"draft" | "live">(
    draft ? "draft" : "live",
  );
  const [toolPolicy, setToolPolicy] = useState<"safe" | "simulate" | "live">(
    "safe",
  );
  const [resultTab, setResultTab] = useState<ResultTab>("chat");
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | undefined>();
  const [conversationTarget, setConversationTarget] = useState<
    CreateAgentRunRequest["target"] | null
  >(null);
  const [triggerEvent, setTriggerEvent] = useState(definition.trigger[0] ?? "");
  const [conversationTriggerEvent, setConversationTriggerEvent] = useState<
    string | undefined
  >();
  const [pendingTurn, setPendingTurn] = useState<PendingChatTurn | null>(null);
  const [lastDispatch, setLastDispatch] = useState<ChatDispatchReceipt | null>(
    null,
  );
  const [runtimeOpen, setRuntimeOpen] = useState(false);
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [reasoningMode, setReasoningMode] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState("");
  const [reasoningSummary, setReasoningSummary] = useState("");
  const [reasoningContext, setReasoningContext] = useState("");
  const [verbosity, setVerbosity] = useState("");
  const [storeResponse, setStoreResponse] = useState("");
  const [temperature, setTemperature] = useState("");
  const [maxTokens, setMaxTokens] = useState("");
  const [timeoutSeconds, setTimeoutSeconds] = useState("");
  const createRun = useCreateAgentRun(agentId);
  const history = useAgentRunHistory(agentId, { limit: 100 });
  const session = useRunSession(sessionId);
  const selectedHistory =
    session.data?.runs.find((row) => row.id === selectedRunId) ??
    history.data?.items.find((row) => row.id === selectedRunId);
  const runIsLive = Boolean(
    selectedRunId && !isTerminalStatus(selectedHistory?.status),
  );
  const trace = useRunTrace(selectedRunId, 0, runIsLive);
  const output = useRunOutput(selectedRunId, runIsLive);
  const artifacts = useRunArtifacts(selectedRunId);
  const logs = useRunLogStream(selectedRunId, {
    follow: runIsLive,
    maxLines: 2000,
  });
  const cancelRun = useCancelRun();
  const hadDraft = useRef(Boolean(draft));
  const dispatchInFlightRef = useRef(false);
  const hydratedSessionRef = useRef<string | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const artifactFilename = String(
    asRecord(definition.output_config.artifact).filename ?? "output.json",
  );
  const hasPreviewSteps = definition.actions.some(
    (action) => action.type === "delay" || action.type === "subflow",
  );
  const triggerEvents = useMemo(
    () =>
      conversationTriggerEvent &&
      !definition.trigger.includes(conversationTriggerEvent)
        ? [conversationTriggerEvent, ...definition.trigger]
        : definition.trigger,
    [conversationTriggerEvent, definition.trigger],
  );

  useEffect(() => {
    if (sessionId) return;
    if (draft && !hadDraft.current) setTarget("draft");
    hadDraft.current = Boolean(draft);
    if (!draft && target === "draft") setTarget("live");
    if (!liveVersionId && target === "live" && draft) setTarget("draft");
  }, [draft, liveVersionId, sessionId, target]);

  useEffect(() => {
    if (sessionId) return;
    setTriggerEvent((current) =>
      definition.trigger.includes(current)
        ? current
        : (definition.trigger[0] ?? ""),
    );
  }, [definition.trigger, sessionId]);

  useEffect(() => {
    const continuation = session.data?.continuation;
    if (
      !sessionId ||
      !continuation ||
      hydratedSessionRef.current === sessionId
    ) {
      return;
    }
    // A saved chat owns its execution target, trigger and structured inputs.
    // Hydrate from the server instead of guessing from the current editor,
    // which may now point at another draft revision or trigger.
    hydratedSessionRef.current = sessionId;
    setConversationTarget(continuation.target);
    setConversationTriggerEvent(continuation.triggerEvent);
    setTarget(continuation.target.kind);
    setInputs(continuation.inputs);
    setToolPolicy(continuation.toolPolicy);
  }, [session.data?.continuation, sessionId]);

  const activeStatus = isTerminalStatus(selectedHistory?.status)
    ? selectedHistory!.status
    : (output.data?.status ??
      selectedHistory?.status ??
      (selectedRunId ? "queued" : null));
  const reasoningSummaries = useMemo(
    () =>
      (trace.data?.events ?? []).filter(
        (event) => event.name === "llm.reasoning_summary" && event.summary,
      ),
    [trace.data],
  );
  const chatTranscript = useMemo(() => {
    const fallbackOutputs = new Map<string, unknown>();
    if (selectedRunId && output.data?.status === "ok") {
      fallbackOutputs.set(selectedRunId, output.data.output);
    }
    return buildChatTranscript(session.data, fallbackOutputs);
  }, [output.data, selectedRunId, session.data]);
  const pendingTurnIsPersisted = Boolean(
    pendingTurn?.runId &&
    session.data?.messages.some(
      (message) =>
        message.role === "user" && message.runId === pendingTurn.runId,
    ),
  );
  const missingRequired = variableInputs.filter((input) => {
    if (!input.required) return false;
    const value = inputs[input.id];
    if (input.kind === "file") {
      if (Array.isArray(value)) return value.length === 0;
      if (isRecord(value)) {
        return (
          typeof value.dataUrl !== "string" &&
          typeof value.artifactId !== "string"
        );
      }
    }
    return value == null || value === "";
  });
  const parsedTemperature = Number(temperature);
  const parsedMaxTokens = Number(maxTokens);
  const parsedTimeoutSeconds = Number(timeoutSeconds);
  const modelOverride = model.trim();
  const effectiveProvider = provider || definition.provider;
  const effectiveModel = modelOverride || definition.model;
  const modelCapabilities = selectedCatalogModel(
    effectiveProvider,
    effectiveModel,
  );
  const reasoningOverride: ReasoningConfig = {
    ...(reasoningMode ? { mode: reasoningMode as ReasoningMode } : {}),
    ...(reasoningEffort ? { effort: reasoningEffort as ReasoningEffort } : {}),
    ...(reasoningSummary
      ? { summary: reasoningSummary as ReasoningSummary }
      : {}),
    ...(reasoningContext
      ? { context: reasoningContext as ReasoningContext }
      : {}),
  };
  const hasReasoningOverride = Object.keys(reasoningOverride).length > 0;
  const runtimeOverridesInvalid = Boolean(
    (temperature.trim() &&
      (!Number.isFinite(parsedTemperature) ||
        parsedTemperature < 0 ||
        parsedTemperature > 2)) ||
    (maxTokens.trim() &&
      (!Number.isInteger(parsedMaxTokens) || parsedMaxTokens <= 0)) ||
    (timeoutSeconds.trim() &&
      (!Number.isInteger(parsedTimeoutSeconds) || parsedTimeoutSeconds <= 0)),
  );
  const draftNotReady =
    !sessionId && target === "draft" && draftHasUnsavedChanges;
  const sessionHasActiveRun = Boolean(
    session.data?.runs.some((run) => !isTerminalStatus(run.status)),
  );
  const conversationBusy =
    createRun.isPending ||
    sessionHasActiveRun ||
    Boolean(selectedRunId && activeStatus && !isTerminalStatus(activeStatus));
  const targetUnavailable = sessionId
    ? !conversationTarget
    : target === "draft"
      ? !draft
      : !liveVersionId;
  const submitDisabled =
    !canRun ||
    !prompt.trim() ||
    missingRequired.length > 0 ||
    runtimeOverridesInvalid ||
    draftNotReady ||
    targetUnavailable ||
    conversationBusy;

  useEffect(() => {
    if (resultTab !== "chat") return;
    chatEndRef.current?.scrollIntoView({
      block: "end",
    });
  }, [
    activeStatus,
    chatTranscript.length,
    pendingTurn?.runId,
    pendingTurn?.state,
    resultTab,
  ]);

  useEffect(() => {
    if (pendingTurnIsPersisted) setPendingTurn(null);
  }, [pendingTurnIsPersisted]);

  useEffect(() => {
    if (!isTerminalStatus(selectedHistory?.status)) return;
    void trace.refetch();
    void output.refetch();
    void artifacts.refetch();
  }, [
    selectedHistory?.status,
    trace.refetch,
    output.refetch,
    artifacts.refetch,
  ]);

  async function run() {
    if (submitDisabled || dispatchInFlightRef.current) return;
    dispatchInFlightRef.current = true;
    const submittedPrompt = prompt;
    const requestedTarget: CreateAgentRunRequest["target"] | null = sessionId
      ? conversationTarget
      : target === "draft" && draft
        ? { kind: "draft", draftId: draft.id, revision: draft.revision }
        : target === "live" && liveVersionId
          ? { kind: "live", agentVersionId: liveVersionId }
          : null;
    if (!requestedTarget) {
      dispatchInFlightRef.current = false;
      return;
    }
    const requestedTriggerEvent = sessionId
      ? conversationTriggerEvent
      : triggerEvent || undefined;
    setPendingTurn({
      prompt: submittedPrompt,
      state: "publishing",
      runId: null,
      eventId: null,
      eventName: requestedTriggerEvent ?? null,
    });
    try {
      const response = await createRun.mutateAsync(
        buildStudioChatRunRequest({
          ...(sessionId ? { sessionId } : {}),
          target: requestedTarget,
          ...(requestedTriggerEvent
            ? { triggerEvent: requestedTriggerEvent }
            : {}),
          prompt: submittedPrompt,
          inputs,
          toolPolicy,
          runtimeOverrides: {
            ...(provider ? { provider: provider as ProviderId } : {}),
            ...(modelOverride ? { model: modelOverride } : {}),
            ...(hasReasoningOverride ? { reasoning: reasoningOverride } : {}),
            ...(verbosity ? { verbosity: verbosity as TextVerbosity } : {}),
            ...(storeResponse ? { store: storeResponse === "true" } : {}),
            ...(temperature.trim() && Number.isFinite(parsedTemperature)
              ? { temperature: parsedTemperature }
              : {}),
            ...(maxTokens.trim() &&
            Number.isInteger(parsedMaxTokens) &&
            parsedMaxTokens > 0
              ? { maxTokens: parsedMaxTokens }
              : {}),
            ...(timeoutSeconds.trim() &&
            Number.isInteger(parsedTimeoutSeconds) &&
            parsedTimeoutSeconds > 0
              ? { timeoutS: parsedTimeoutSeconds }
              : {}),
          },
        }),
      );
      setSelectedRunId(response.runId);
      setSessionId(response.sessionId);
      setConversationTarget(requestedTarget);
      setConversationTriggerEvent(response.eventName);
      setLastDispatch({
        runId: response.runId,
        eventId: response.eventId,
        eventName: response.eventName,
      });
      setPendingTurn({
        prompt: submittedPrompt,
        state: "queued",
        runId: response.runId,
        eventId: response.eventId,
        eventName: response.eventName,
      });
      setPrompt("");
      setResultTab("chat");
    } catch {
      setPendingTurn(null);
      // The mutation exposes its typed error below the controls. Absorb the
      // rejected mutateAsync promise so a failed dispatch is never unhandled.
    } finally {
      dispatchInFlightRef.current = false;
    }
  }

  function newChat() {
    hydratedSessionRef.current = null;
    setSessionId(undefined);
    setSelectedRunId(null);
    setConversationTarget(null);
    setConversationTriggerEvent(undefined);
    setTriggerEvent(definition.trigger[0] ?? "");
    setPendingTurn(null);
    setLastDispatch(null);
    setPrompt("");
    setResultTab("chat");
    createRun.reset();
  }

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <InlineNotice tone="signal" title="Test Lab uses the real runtime">
        Send publishes a runtime event that triggers this agent. Your chat
        message is copied exactly into the event as the agent&apos;s prompt
        input. Structured variables stay separate, and every run, trace event,
        log, and JSON artifact is retained in history.
      </InlineNotice>
      {hasPreviewSteps && (
        <InlineNotice tone="amber" title="Preview steps in this definition">
          Delay and subflow steps are recorded in the trace, but delays do not
          wait and subflows are not invoked by the production runtime yet.
        </InlineNotice>
      )}
      <div
        className="agent-studio-test-grid"
        style={{
          display: "grid",
          minHeight: 600,
          border: "1px solid var(--border)",
          borderRadius: 7,
          overflow: "hidden",
          background: "var(--panel)",
        }}
      >
        <section
          className="agent-studio-test-setup"
          style={{
            display: "flex",
            flexDirection: "column",
            borderRight: "1px solid var(--border)",
            minWidth: 0,
          }}
        >
          <div
            style={{
              padding: 12,
              borderBottom: "1px solid var(--border)",
              display: "flex",
              gap: 8,
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div
                style={{ color: "var(--text)", fontSize: 12, fontWeight: 600 }}
              >
                Test setup
              </div>
              <div
                style={{ color: "var(--text-3)", fontSize: 10.5, marginTop: 2 }}
              >
                Structured inputs and runtime settings
              </div>
            </div>
            {sessionId ? (
              <Badge tone="blue">{target} · locked</Badge>
            ) : (
              <Segmented
                ariaLabel="Version to test"
                value={target}
                onChange={setTarget}
                options={[
                  ...(draft
                    ? [{ value: "draft" as const, label: "Draft" }]
                    : []),
                  ...(liveVersionId
                    ? [{ value: "live" as const, label: "Live" }]
                    : []),
                ]}
              />
            )}
          </div>
          <div
            style={{
              padding: "7px 12px",
              borderBottom: "1px solid var(--border)",
              color: "var(--text-3)",
              fontSize: 10,
              lineHeight: 1.4,
            }}
          >
            {sessionId
              ? `${target === "draft" ? "Draft" : "Live"} is pinned for this conversation. Start a new chat to change it.`
              : target === "draft"
                ? "Draft runs test your saved changes without changing the live agent."
                : "Live runs use the currently published version—the same version production callers use."}
          </div>
          <div
            style={{
              flex: 1,
              overflow: "auto",
              padding: 12,
              display: "grid",
              gap: 14,
              alignContent: "start",
            }}
          >
            {variableInputs.length > 0 && (
              <div>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    marginBottom: 8,
                  }}
                >
                  <span
                    style={{
                      color: "var(--text)",
                      fontSize: 11.5,
                      fontWeight: 500,
                    }}
                  >
                    Input variables
                  </span>
                  <Segmented
                    ariaLabel="Input editor view"
                    value={inputMode}
                    onChange={setInputMode}
                    options={[
                      { value: "form", label: "Form" },
                      { value: "json", label: "JSON" },
                    ]}
                  />
                </div>
                {inputMode === "json" ? (
                  <JsonValueEditor
                    value={inputs}
                    onChange={(value) => setInputs(asRecord(value))}
                    height={230}
                    label="All test inputs"
                    hint="Advanced view of the same form fields. Each key must match an input's internal field name."
                    example={'{"customer_tier":"gold","language":"en"}'}
                  />
                ) : (
                  <div style={{ display: "grid", gap: 12 }}>
                    {variableInputs.map((input) => (
                      <Field
                        key={input.id}
                        label={input.label}
                        required={input.required}
                        hint={
                          input.description ||
                          `Enter the ${input.label.toLowerCase()} expected by this agent.`
                        }
                        example={
                          input.example == null
                            ? undefined
                            : typeof input.example === "string"
                              ? input.example
                              : toPrettyJson(input.example)
                        }
                      >
                        <VariableControl
                          input={input}
                          value={inputs[input.id]}
                          onChange={(value) =>
                            setInputs((current) => ({
                              ...current,
                              [input.id]: value,
                            }))
                          }
                        />
                      </Field>
                    ))}
                  </div>
                )}
              </div>
            )}
            {triggerEvents.length > 0 && (
              <Field
                label="Trigger event"
                hint={
                  sessionId
                    ? "Pinned for every message in this conversation."
                    : "Pressing Send publishes this event to start the agent."
                }
              >
                <SelectInput
                  value={
                    sessionId
                      ? (conversationTriggerEvent ?? triggerEvent)
                      : triggerEvent
                  }
                  onChange={setTriggerEvent}
                  disabled={Boolean(sessionId)}
                  options={triggerEvents.map((name) => ({
                    value: name,
                    label: name,
                  }))}
                />
              </Field>
            )}
            <details
              open={runtimeOpen}
              onToggle={(event) => setRuntimeOpen(event.currentTarget.open)}
              style={{ borderTop: "1px solid var(--border)", paddingTop: 9 }}
            >
              <summary
                className="mono"
                style={{
                  cursor: "pointer",
                  color: "var(--text-3)",
                  fontSize: 10.5,
                }}
              >
                ADVANCED TEST SETTINGS
              </summary>
              <div style={{ display: "grid", gap: 10, marginTop: 10 }}>
                <Field
                  label="What tools may change"
                  hint="Safe is recommended and runs only tools explicitly approved for tests. Read-only permits approved reads but blocks writes. Live can change connected systems."
                >
                  <SelectInput
                    value={toolPolicy}
                    onChange={(value) =>
                      setToolPolicy(value as typeof toolPolicy)
                    }
                    options={[
                      {
                        value: "safe",
                        label: "Safe test — approved test tools only",
                      },
                      {
                        value: "simulate",
                        label: "Read-only — approved reads, writes blocked",
                      },
                      {
                        value: "live",
                        label: "Live effects — allow configured changes",
                      },
                    ]}
                  />
                </Field>
                {toolPolicy === "live" && (
                  <InlineNotice
                    tone="amber"
                    title="External side effects enabled"
                  >
                    This run may write files, call third-party services, or
                    change downstream systems through the agent&apos;s allowed
                    tools.
                  </InlineNotice>
                )}
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr",
                    gap: 9,
                  }}
                >
                  <Field
                    label="Temporary AI provider"
                    hint="Only changes this test run. Leave inherited to test the agent exactly as configured."
                  >
                    <SelectInput
                      value={provider}
                      onChange={setProvider}
                      options={RUN_PROVIDERS.map((value) => ({
                        value,
                        label:
                          value ||
                          `Use agent / workspace${definition.provider ? ` (${definition.provider})` : ""}`,
                      }))}
                    />
                  </Field>
                  <Field
                    label="Temporary AI model"
                    hint="Only changes this test run. Leave blank to use the agent or workspace model."
                    example="gpt-5-mini"
                  >
                    <TextInput
                      value={model}
                      mono
                      placeholder={definition.model || "Use agent / workspace"}
                      onChange={setModel}
                    />
                  </Field>
                </div>
                {(modelCapabilities?.reasoningModes?.length ||
                  modelCapabilities?.reasoningEfforts?.length ||
                  modelCapabilities?.reasoningSummaries?.length ||
                  modelCapabilities?.reasoningContexts?.length ||
                  modelCapabilities?.textVerbosities?.length ||
                  effectiveProvider === "openai" ||
                  effectiveProvider === "openrouter") && (
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "1fr 1fr",
                      gap: 9,
                    }}
                  >
                    {modelCapabilities?.reasoningModes?.length ? (
                      <Field
                        label="Temporary reasoning mode"
                        hint="Standard balances quality and latency; Pro uses the model's highest-compute execution path."
                      >
                        <SelectInput
                          value={reasoningMode}
                          onChange={setReasoningMode}
                          options={[
                            {
                              value: "",
                              label: `Use agent / model${asRecord(definition.reasoning).mode ? ` (${String(asRecord(definition.reasoning).mode)})` : " default"}`,
                            },
                            ...modelCapabilities.reasoningModes.map(
                              (value) => ({
                                value,
                                label: value,
                              }),
                            ),
                          ]}
                        />
                      </Field>
                    ) : null}
                    {modelCapabilities?.reasoningEfforts?.length ? (
                      <Field
                        label="Temporary reasoning effort"
                        hint="Higher effort may improve difficult reasoning while increasing latency and reasoning-token cost."
                      >
                        <SelectInput
                          value={reasoningEffort}
                          onChange={setReasoningEffort}
                          options={[
                            {
                              value: "",
                              label: `Use agent / model${asRecord(definition.reasoning).effort ? ` (${String(asRecord(definition.reasoning).effort)})` : " default"}`,
                            },
                            ...modelCapabilities.reasoningEfforts.map(
                              (value) => ({
                                value,
                                label: value,
                              }),
                            ),
                          ]}
                        />
                      </Field>
                    ) : null}
                    {modelCapabilities?.reasoningSummaries?.length ? (
                      <Field
                        label="Temporary reasoning summary"
                        hint="Requests a safe provider-generated summary; raw chain-of-thought is never recorded."
                      >
                        <SelectInput
                          value={reasoningSummary}
                          onChange={setReasoningSummary}
                          options={[
                            { value: "", label: "Use agent / model default" },
                            ...modelCapabilities.reasoningSummaries.map(
                              (value) => ({
                                value,
                                label: value,
                              }),
                            ),
                          ]}
                        />
                      </Field>
                    ) : null}
                    {modelCapabilities?.reasoningContexts?.length ? (
                      <Field
                        label="Temporary reasoning context"
                        hint="Controls which persisted reasoning items may be reused on later conversation turns."
                      >
                        <SelectInput
                          value={reasoningContext}
                          onChange={setReasoningContext}
                          options={[
                            { value: "", label: "Use agent / model default" },
                            ...modelCapabilities.reasoningContexts.map(
                              (value) => ({
                                value,
                                label: value.replaceAll("_", " "),
                              }),
                            ),
                          ]}
                        />
                      </Field>
                    ) : null}
                    {modelCapabilities?.textVerbosities?.length ? (
                      <Field
                        label="Temporary answer verbosity"
                        hint="Controls how concise or detailed the model's visible answer should be."
                      >
                        <SelectInput
                          value={verbosity}
                          onChange={setVerbosity}
                          options={[
                            {
                              value: "",
                              label: `Use agent / model${definition.verbosity ? ` (${definition.verbosity})` : " default"}`,
                            },
                            ...modelCapabilities.textVerbosities.map(
                              (value) => ({
                                value,
                                label: value,
                              }),
                            ),
                          ]}
                        />
                      </Field>
                    ) : null}
                    {effectiveProvider === "openai" ||
                    effectiveProvider === "openrouter" ? (
                      <Field
                        label="Temporary provider storage"
                        hint="Controls upstream response retention for this test. Local run logs and usage accounting are separate."
                      >
                        <SelectInput
                          value={storeResponse}
                          onChange={setStoreResponse}
                          options={[
                            { value: "", label: "Use agent / service default" },
                            { value: "false", label: "Do not store upstream" },
                            ...(effectiveProvider === "openai"
                              ? [{ value: "true", label: "Store upstream" }]
                              : []),
                          ]}
                        />
                      </Field>
                    ) : null}
                  </div>
                )}
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(3, 1fr)",
                    gap: 9,
                  }}
                >
                  <Field
                    label="Temporary creativity"
                    hint="0 is consistent; higher values are more varied. Leave blank to use the agent setting."
                    example="0.2"
                  >
                    <TextInput
                      value={temperature}
                      type="number"
                      min={0}
                      max={2}
                      placeholder={`Agent: ${definition.temperature}`}
                      onChange={setTemperature}
                    />
                  </Field>
                  <Field
                    label="Temporary answer length"
                    hint="Maximum tokens for this test. Leave blank to use the agent setting."
                    example="2000"
                  >
                    <TextInput
                      value={maxTokens}
                      type="number"
                      min={1}
                      placeholder={`Agent: ${definition.max_tokens}`}
                      onChange={setMaxTokens}
                    />
                  </Field>
                  <Field
                    label="Temporary time limit"
                    hint="Stop this test after this many seconds. Leave blank to use the agent setting."
                    example="120"
                  >
                    <TextInput
                      value={timeoutSeconds}
                      type="number"
                      min={1}
                      placeholder={`Agent: ${definition.timeout_s}`}
                      onChange={setTimeoutSeconds}
                    />
                  </Field>
                </div>
                {runtimeOverridesInvalid && (
                  <div style={{ color: "var(--red)", fontSize: 10.5 }}>
                    Temperature must be between 0 and 2; max tokens and timeout
                    must be positive whole numbers.
                  </div>
                )}
              </div>
            </details>
          </div>
          {draftNotReady && (
            <div
              style={{
                padding: "0 12px 10px",
                color: "var(--amber)",
                fontSize: 10.5,
              }}
            >
              Save the current draft changes before running so the test is
              pinned to this exact revision.
            </div>
          )}
          {missingRequired.length > 0 && (
            <div
              style={{
                padding: "0 12px 10px",
                color: "var(--amber)",
                fontSize: 10.5,
              }}
            >
              Complete required inputs:{" "}
              {missingRequired.map((input) => input.label).join(", ")}
            </div>
          )}
        </section>

        <section
          className="agent-studio-test-conversation"
          style={{
            minWidth: 0,
            display: "flex",
            flexDirection: "column",
            borderRight: "1px solid var(--border)",
          }}
        >
          <div
            style={{
              minHeight: 54,
              padding: "10px 12px",
              borderBottom: "1px solid var(--border)",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div style={{ display: "flex", gap: 7, alignItems: "center" }}>
                <span
                  style={{
                    color: "var(--text)",
                    fontSize: 12,
                    fontWeight: 600,
                  }}
                >
                  Conversation
                </span>
                {activeStatus && (
                  <Badge tone={statusTone(activeStatus)}>{activeStatus}</Badge>
                )}
                {output.data?.outputValid != null && (
                  <Badge tone={output.data.outputValid ? "green" : "red"}>
                    {output.data.outputValid
                      ? "Schema valid"
                      : "Invalid output"}
                  </Badge>
                )}
                {lastDispatch?.runId === selectedRunId && (
                  <Link
                    href={`/portal/${tenant}/events?eventId=${encodeURIComponent(lastDispatch.eventId)}`}
                    title={`Trigger event ${lastDispatch.eventId}`}
                    style={{ display: "inline-flex" }}
                  >
                    <Badge tone="muted">event · {lastDispatch.eventName}</Badge>
                  </Link>
                )}
              </div>
              <div
                style={{ color: "var(--text-3)", fontSize: 10, marginTop: 3 }}
              >
                {sessionId
                  ? session.data?.session.title ||
                    `Session ${sessionId.slice(0, 12)}…`
                  : "Start a chat to test the agent"}
              </div>
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "flex-end",
                flexWrap: "wrap",
                gap: 7,
              }}
            >
              {sessionId && (
                <Button small disabled={conversationBusy} onClick={newChat}>
                  New chat
                </Button>
              )}
              {activeStatus && !isTerminalStatus(activeStatus) && (
                <Button
                  small
                  tone="danger"
                  icon="x"
                  disabled={!selectedRunId || cancelRun.isPending}
                  onClick={() =>
                    selectedRunId && cancelRun.mutate(selectedRunId)
                  }
                >
                  Stop
                </Button>
              )}
              {selectedRunId && (
                <Link
                  href={`/portal/${tenant}/runs/${selectedRunId}`}
                  style={{ color: "var(--blue)", fontSize: 10.5 }}
                >
                  Open full run ↗
                </Link>
              )}
            </div>
          </div>
          <div
            role="tablist"
            aria-label="Run details"
            style={{
              padding: "8px 12px",
              display: "flex",
              gap: 6,
              borderBottom: "1px solid var(--border)",
            }}
          >
            {(["chat", "trace", "output", "logs", "artifacts"] as const).map(
              (tab) => (
                <button
                  type="button"
                  role="tab"
                  aria-selected={resultTab === tab}
                  key={tab}
                  onClick={() => setResultTab(tab)}
                  style={{
                    padding: "5px 8px",
                    color:
                      resultTab === tab ? "var(--signal)" : "var(--text-3)",
                    borderBottom: `2px solid ${resultTab === tab ? "var(--signal)" : "transparent"}`,
                    fontFamily: "var(--mono)",
                    fontSize: 10.5,
                  }}
                >
                  {tab}
                </button>
              ),
            )}
          </div>
          <div
            role="tabpanel"
            className={
              resultTab === "chat" ? "agent-studio-chat-scroll" : undefined
            }
            style={{
              flex: 1,
              minHeight: 0,
              overflow: "auto",
              padding: resultTab === "chat" ? 0 : 12,
            }}
          >
            {resultTab === "chat" ? (
              <div
                className="agent-studio-chat-log"
                role="log"
                aria-label="Test Lab conversation"
                aria-live="polite"
                aria-relevant="additions text"
                aria-busy={conversationBusy}
              >
                {session.isLoading ? (
                  <Empty title="Loading conversation…" />
                ) : session.isError ? (
                  <Empty
                    title="Conversation unavailable"
                    hint={session.error.message}
                  />
                ) : chatTranscript.length ? (
                  chatTranscript.map((message) => (
                    <ChatBubble
                      key={message.id}
                      message={message}
                      selected={message.runId === selectedRunId}
                      onInspectRun={setSelectedRunId}
                    />
                  ))
                ) : !pendingTurn ? (
                  <div className="agent-studio-chat-welcome">
                    <div className="agent-studio-chat-welcome-mark">AI</div>
                    <h3>Test your agent in a conversation</h3>
                    <p>
                      Send an end-user prompt below. The result appears here,
                      and follow-up messages continue with the same session
                      context.
                    </p>
                  </div>
                ) : null}
                {pendingTurn && !pendingTurnIsPersisted && (
                  <>
                    <ChatBubble
                      message={{
                        id: "pending-user-message",
                        role: "user",
                        runId: pendingTurn.runId,
                        content: pendingTurn.prompt,
                        state: "complete",
                        createdAt: null,
                      }}
                      selected={Boolean(
                        pendingTurn.runId &&
                        pendingTurn.runId === selectedRunId,
                      )}
                      onInspectRun={setSelectedRunId}
                    />
                    <ChatBubble
                      message={{
                        id: "pending-agent-message",
                        role: "assistant",
                        runId: pendingTurn.runId,
                        content:
                          pendingTurn.state === "publishing"
                            ? "Publishing the trigger event to the agent runtime…"
                            : `${pendingTurn.eventName ?? "The trigger event"}${pendingTurn.eventId ? ` (${pendingTurn.eventId})` : ""} was accepted. The agent is working on this request…`,
                        state: "working",
                        createdAt: null,
                      }}
                      selected={Boolean(
                        pendingTurn.runId &&
                        pendingTurn.runId === selectedRunId,
                      )}
                      onInspectRun={setSelectedRunId}
                    />
                  </>
                )}
                <div ref={chatEndRef} aria-hidden="true" />
              </div>
            ) : !selectedRunId ? (
              <Empty
                title="Run the agent to inspect it"
                hint="The live sequence, reasoning summaries, logs, and output appear here."
              />
            ) : resultTab === "trace" ? (
              <div>
                <InlineNotice title="Reasoning visibility">
                  The studio shows concise model reasoning summaries and tool
                  decisions when enabled. Hidden chain-of-thought is never
                  exposed.
                </InlineNotice>
                {reasoningSummaries.length > 0 && (
                  <div
                    style={{
                      marginTop: 12,
                      padding: 10,
                      border: "1px solid rgba(181,148,255,0.3)",
                      background: "rgba(181,148,255,0.05)",
                      borderRadius: 5,
                    }}
                  >
                    <div
                      className="mono"
                      style={{
                        color: "var(--violet)",
                        fontSize: 10,
                        marginBottom: 6,
                      }}
                    >
                      REASONING SUMMARY
                    </div>
                    {reasoningSummaries.map((event) => (
                      <div
                        key={event.id}
                        style={{
                          color: "var(--text-2)",
                          fontSize: 11,
                          lineHeight: 1.55,
                          marginTop: 4,
                        }}
                      >
                        {event.summary}
                      </div>
                    ))}
                  </div>
                )}
                <div style={{ marginTop: 10 }}>
                  {trace.isLoading ? (
                    <Empty title="Loading trace…" />
                  ) : trace.isError ? (
                    <Empty
                      title="Trace unavailable"
                      hint={trace.error.message}
                    />
                  ) : trace.data?.events.length ? (
                    trace.data.events.map((event) => (
                      <TraceRow key={event.id} event={event} />
                    ))
                  ) : (
                    <Empty title="Waiting for the first trace event…" />
                  )}
                </div>
              </div>
            ) : resultTab === "output" ? (
              output.isLoading ? (
                <Empty title="Waiting for output…" />
              ) : output.isError ? (
                <Empty
                  title="Output is not ready"
                  hint={output.error.message}
                />
              ) : output.data && !isTerminalStatus(output.data.status) ? (
                <Empty
                  title="Run is still producing output…"
                  hint="The validated JSON artifact will appear when the run completes."
                />
              ) : output.data?.output == null ? (
                <Empty
                  title="No validated output"
                  hint={
                    selectedHistory?.error ??
                    `The run finished with status ${output.data?.status ?? activeStatus ?? "unknown"}.`
                  }
                />
              ) : (
                <div>
                  <div style={{ display: "flex", gap: 7, marginBottom: 8 }}>
                    <Badge tone="green">
                      {output.data.artifact?.logicalName ?? artifactFilename}
                    </Badge>
                    {output.data.artifact && (
                      <Badge tone="muted">
                        {output.data.artifact.size} bytes
                      </Badge>
                    )}
                  </div>
                  <pre
                    style={{
                      margin: 0,
                      padding: 12,
                      border: "1px solid var(--border)",
                      borderRadius: 5,
                      background: "var(--bg-2)",
                      color: "var(--text-2)",
                      fontFamily: "var(--mono)",
                      fontSize: 11,
                      lineHeight: 1.55,
                      overflow: "auto",
                    }}
                  >
                    {toPrettyJson(output.data.output)}
                  </pre>
                </div>
              )
            ) : resultTab === "logs" ? (
              <div>
                <div style={{ display: "flex", gap: 7, marginBottom: 8 }}>
                  <Badge tone={logs.connected ? "green" : "muted"}>
                    {logs.connected ? "Live" : "Closed"}
                  </Badge>
                  {logs.error && (
                    <span style={{ color: "var(--amber)", fontSize: 10.5 }}>
                      {logs.error}
                    </span>
                  )}
                </div>
                <pre
                  style={{
                    minHeight: 300,
                    margin: 0,
                    padding: 12,
                    background: "#080a0b",
                    color: "var(--text-2)",
                    border: "1px solid var(--border)",
                    borderRadius: 5,
                    fontFamily: "var(--mono)",
                    fontSize: 10.5,
                    lineHeight: 1.6,
                    whiteSpace: "pre-wrap",
                  }}
                >
                  {logs.lines.map((line) => line.text).join("\n") ||
                    "Waiting for runtime logs…"}
                </pre>
              </div>
            ) : artifacts.isLoading ? (
              <Empty title="Loading artifacts…" />
            ) : artifacts.isError ? (
              <Empty
                title="Artifacts unavailable"
                hint={artifacts.error.message}
              />
            ) : artifacts.data?.length ? (
              <div style={{ display: "grid", gap: 7 }}>
                {artifacts.data.map((artifact) => (
                  <a
                    key={artifact.id}
                    href={artifact.downloadPath}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "minmax(0, 1fr) auto",
                      gap: 8,
                      padding: 10,
                      border: "1px solid var(--border)",
                      borderRadius: 5,
                      background: "var(--panel-2)",
                    }}
                  >
                    <span style={{ minWidth: 0 }}>
                      <span
                        style={{
                          display: "block",
                          color: "var(--text)",
                          fontSize: 11.5,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                      >
                        {artifact.logicalName ?? artifact.kind}
                      </span>
                      {artifact.role && (
                        <span
                          className="mono"
                          style={{
                            display: "block",
                            marginTop: 3,
                            color: "var(--text-3)",
                            fontSize: 9.5,
                          }}
                        >
                          {artifact.role}
                        </span>
                      )}
                    </span>
                    <span
                      className="mono"
                      style={{ color: "var(--text-3)", fontSize: 10 }}
                    >
                      {artifact.size} B
                    </span>
                  </a>
                ))}
              </div>
            ) : (
              <Empty
                title="No artifacts yet"
                hint="Every completed Studio run stores its aggregate JSON output as an artifact."
              />
            )}
          </div>
          {resultTab === "chat" && (
            <form
              className="agent-studio-chat-composer"
              onSubmit={(event) => {
                event.preventDefault();
                void run();
              }}
            >
              <div className="agent-studio-chat-composer-box">
                <textarea
                  value={prompt}
                  aria-label={`Message for the agent (${promptInput?.id ?? "prompt"})`}
                  placeholder={
                    sessionId
                      ? "Ask a follow-up…"
                      : "Message the agent to start a test…"
                  }
                  rows={3}
                  disabled={createRun.isPending || targetUnavailable}
                  onChange={(event) => setPrompt(event.target.value)}
                  onKeyDown={(event) => {
                    if (
                      event.key === "Enter" &&
                      !event.shiftKey &&
                      !event.nativeEvent.isComposing
                    ) {
                      event.preventDefault();
                      void run();
                    }
                  }}
                />
                <Button
                  type="submit"
                  tone="primary"
                  disabled={submitDisabled}
                  style={{ alignSelf: "flex-end" }}
                >
                  {createRun.isPending
                    ? "Sending event…"
                    : conversationBusy
                      ? "Agent running…"
                      : "Send"}
                </Button>
              </div>
              <div className="agent-studio-chat-composer-meta">
                <span>
                  {createRun.isPending
                    ? "Publishing the agent trigger event…"
                    : sessionHasActiveRun
                      ? "Wait for this response before sending a follow-up"
                      : "Enter to send · Shift+Enter for a new line"}
                </span>
                <span>
                  {sessionId
                    ? `${target} target · session context`
                    : `${target} target · new conversation`}
                </span>
              </div>
              {draftNotReady && (
                <div className="agent-studio-chat-composer-error">
                  Save the draft before starting this conversation.
                </div>
              )}
              {missingRequired.length > 0 && (
                <div className="agent-studio-chat-composer-error">
                  Complete required inputs in Test setup:{" "}
                  {missingRequired.map((input) => input.label).join(", ")}
                </div>
              )}
              {sessionId && targetUnavailable && (
                <div className="agent-studio-chat-composer-error">
                  This saved conversation cannot safely reuse its pinned target.
                  Start a new chat to continue.
                </div>
              )}
              {createRun.isError && (
                <div className="agent-studio-chat-composer-error">
                  {formatAgentStudioError(createRun.error)}
                </div>
              )}
              {cancelRun.isError && (
                <div className="agent-studio-chat-composer-error">
                  Could not stop the run: {cancelRun.error.message}
                </div>
              )}
            </form>
          )}
        </section>

        <aside
          className="agent-studio-test-history"
          style={{ minWidth: 0, display: "flex", flexDirection: "column" }}
        >
          <div style={{ padding: 12, borderBottom: "1px solid var(--border)" }}>
            <div
              style={{ color: "var(--text)", fontSize: 12, fontWeight: 600 }}
            >
              Run history
            </div>
            <div
              style={{ color: "var(--text-3)", fontSize: 10.5, marginTop: 2 }}
            >
              Saved for this agent
            </div>
          </div>
          <div style={{ flex: 1, overflow: "auto" }}>
            {history.isLoading ? (
              <Empty title="Loading history…" />
            ) : history.isError ? (
              <Empty title="History unavailable" hint={history.error.message} />
            ) : history.data?.items.length ? (
              history.data.items.map((row: AgentStudioRunRow) => (
                <button
                  type="button"
                  key={row.id}
                  onClick={() => {
                    const sameConversation =
                      Boolean(row.sessionId) && row.sessionId === sessionId;
                    setSelectedRunId(row.id);
                    setTarget(row.target.kind);
                    if (!sameConversation) {
                      setConversationTriggerEvent(undefined);
                      setLastDispatch(null);
                      setConversationTarget(
                        row.target.kind === "live" && row.target.agentVersionId
                          ? {
                              kind: "live",
                              agentVersionId: row.target.agentVersionId,
                            }
                          : null,
                      );
                    }
                    setSessionId(row.sessionId ?? undefined);
                    setResultTab("chat");
                  }}
                  style={{
                    width: "100%",
                    padding: "10px 12px",
                    textAlign: "left",
                    borderBottom: "1px solid var(--border)",
                    background:
                      selectedRunId === row.id
                        ? "rgba(208,255,0,0.05)"
                        : "transparent",
                  }}
                >
                  <div
                    style={{ display: "flex", gap: 6, alignItems: "center" }}
                  >
                    <Badge tone={statusTone(row.status)}>{row.status}</Badge>
                    <Badge tone="muted">{row.target.kind}</Badge>
                  </div>
                  <div
                    style={{
                      marginTop: 7,
                      color: "var(--text-2)",
                      fontSize: 10.5,
                      lineHeight: 1.4,
                      overflow: "hidden",
                      display: "-webkit-box",
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: "vertical",
                    }}
                  >
                    {row.promptPreview || row.subject || "No prompt preview"}
                  </div>
                  <div
                    className="mono"
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      marginTop: 7,
                      color: "var(--text-3)",
                      fontSize: 9.5,
                    }}
                  >
                    <span>{displayTime(row.startedAt ?? row.queuedAt)}</span>
                    <span>
                      {row.durationMs == null ? "" : `${row.durationMs}ms`}
                    </span>
                  </div>
                </button>
              ))
            ) : (
              <Empty
                title="No runs yet"
                hint="Your first test run will be retained here."
              />
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
