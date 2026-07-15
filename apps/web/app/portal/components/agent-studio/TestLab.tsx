"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ProviderId } from "@agentic/contracts";
import { Badge, Button, Empty } from "@/app/portal/components";
import { useTenant } from "@/app/portal/lib/use-tenant";
import {
  useAgentRunHistory,
  useCreateAgentRun,
  useRunOutput,
  useRunTrace,
  type AgentStudioRunRow,
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
  TextArea,
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

type ResultTab = "trace" | "output" | "logs" | "artifacts";
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
  "qwen",
  "bedrock",
  "vertex",
  "custom",
];
const DEFAULT_FILE_MAX_BYTES = 10_000_000;

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
  const [prompt, setPrompt] = useState(
    String(promptInput?.default ?? promptInput?.example ?? ""),
  );
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
  const [resultTab, setResultTab] = useState<ResultTab>("trace");
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | undefined>();
  const [runtimeOpen, setRuntimeOpen] = useState(false);
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [temperature, setTemperature] = useState("");
  const [maxTokens, setMaxTokens] = useState("");
  const [timeoutSeconds, setTimeoutSeconds] = useState("");
  const createRun = useCreateAgentRun(agentId);
  const history = useAgentRunHistory(agentId, { limit: 100 });
  const selectedHistory = history.data?.items.find(
    (row) => row.id === selectedRunId,
  );
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
  const artifactFilename = String(
    asRecord(definition.output_config.artifact).filename ?? "output.json",
  );
  const hasPreviewSteps = definition.actions.some(
    (action) => action.type === "delay" || action.type === "subflow",
  );

  useEffect(() => {
    if (draft && !hadDraft.current) setTarget("draft");
    hadDraft.current = Boolean(draft);
    if (!draft && target === "draft") setTarget("live");
    if (!liveVersionId && target === "live" && draft) setTarget("draft");
  }, [draft, liveVersionId, target]);

  const activeStatus = isTerminalStatus(selectedHistory?.status)
    ? selectedHistory!.status
    : (output.data?.status ??
      selectedHistory?.status ??
      (selectedRunId ? "queued" : null));
  const reasoningSummaries = useMemo(
    () =>
      (trace.data?.events ?? []).filter(
        (event) =>
          (event.kind === "llm" || event.kind === "prompt") && event.summary,
      ),
    [trace.data],
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
  const draftNotReady = target === "draft" && draftHasUnsavedChanges;

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
    try {
      const response = await createRun.mutateAsync({
        ...(sessionId ? { sessionId } : {}),
        target:
          target === "draft" && draft
            ? { kind: "draft", draftId: draft.id, revision: draft.revision }
            : {
                kind: "live",
                ...(liveVersionId ? { agentVersionId: liveVersionId } : {}),
              },
        prompt,
        inputs,
        toolPolicy,
        runtimeOverrides: {
          ...(provider ? { provider: provider as ProviderId } : {}),
          ...(modelOverride ? { model: modelOverride } : {}),
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
      });
      setSelectedRunId(response.runId);
      setSessionId(response.sessionId);
      setResultTab("trace");
    } catch {
      // The mutation exposes its typed error below the controls. Absorb the
      // rejected mutateAsync promise so a failed dispatch is never unhandled.
    }
  }

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <InlineNotice tone="signal" title="Test Lab uses the real runtime">
        Your chat message is inserted automatically as the agent&apos;s prompt
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
            <div>
              <div
                style={{ color: "var(--text)", fontSize: 12, fontWeight: 600 }}
              >
                Conversation
              </div>
              <div
                style={{ color: "var(--text-3)", fontSize: 10.5, marginTop: 2 }}
              >
                {sessionId
                  ? `Session ${sessionId.slice(0, 12)}…`
                  : "New test session"}
              </div>
            </div>
            <div style={{ display: "flex", gap: 7, alignItems: "center" }}>
              {sessionId && (
                <Button
                  small
                  onClick={() => {
                    setSessionId(undefined);
                    setSelectedRunId(null);
                    setPrompt("");
                    createRun.reset();
                  }}
                >
                  New chat
                </Button>
              )}
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
            </div>
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
            {target === "draft"
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
            <div
              style={{
                padding: 10,
                border: "1px solid var(--border)",
                borderRadius: 6,
                background: "var(--panel-2)",
              }}
            >
              <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
                <Badge tone="blue">Chat request</Badge>
                <Badge tone="muted">{promptInput?.id ?? "prompt"}</Badge>
              </div>
              <Field
                label="What should the agent do?"
                required
                hint="Write the request exactly as an end user would. Agent Studio automatically sends it as the model's user message."
                example="Read this support message, choose a category, and draft a helpful reply."
              >
                <TextArea
                  value={prompt}
                  onChange={setPrompt}
                  rows={7}
                  placeholder="Tell the agent what you want it to do…"
                />
              </Field>
            </div>
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
          <div
            style={{
              padding: 12,
              borderTop: "1px solid var(--border)",
              display: "flex",
              gap: 8,
            }}
          >
            <Button
              tone="primary"
              icon="play"
              disabled={
                !canRun ||
                !prompt.trim() ||
                missingRequired.length > 0 ||
                runtimeOverridesInvalid ||
                draftNotReady ||
                createRun.isPending ||
                (target === "draft" ? !draft : !liveVersionId)
              }
              onClick={() => void run()}
              style={{ flex: 1, justifyContent: "center" }}
            >
              {createRun.isPending ? "Starting…" : `Run ${target}`}
            </Button>
            {activeStatus && !isTerminalStatus(activeStatus) && (
              <Button
                tone="danger"
                icon="x"
                disabled={!selectedRunId || cancelRun.isPending}
                onClick={() => selectedRunId && cancelRun.mutate(selectedRunId)}
              >
                Stop
              </Button>
            )}
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
          {createRun.isError && (
            <div
              style={{
                padding: "0 12px 12px",
                color: "var(--red)",
                fontSize: 11,
              }}
            >
              {createRun.error.message}
            </div>
          )}
          {cancelRun.isError && (
            <div
              style={{
                padding: "0 12px 12px",
                color: "var(--red)",
                fontSize: 11,
              }}
            >
              Could not stop the run: {cancelRun.error.message}
            </div>
          )}
        </section>

        <section
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
            <div style={{ display: "flex", gap: 7, alignItems: "center" }}>
              <span
                style={{ color: "var(--text)", fontSize: 12, fontWeight: 600 }}
              >
                Run inspector
              </span>
              {activeStatus && (
                <Badge tone={statusTone(activeStatus)}>{activeStatus}</Badge>
              )}
              {output.data?.outputValid != null && (
                <Badge tone={output.data.outputValid ? "green" : "red"}>
                  {output.data.outputValid ? "Schema valid" : "Invalid output"}
                </Badge>
              )}
            </div>
            {selectedRunId && (
              <Link
                href={`/portal/${tenant}/runs/${selectedRunId}`}
                style={{ color: "var(--blue)", fontSize: 10.5 }}
              >
                Open full run ↗
              </Link>
            )}
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
            {(["trace", "output", "logs", "artifacts"] as const).map((tab) => (
              <button
                type="button"
                role="tab"
                aria-selected={resultTab === tab}
                key={tab}
                onClick={() => setResultTab(tab)}
                style={{
                  padding: "5px 8px",
                  color: resultTab === tab ? "var(--signal)" : "var(--text-3)",
                  borderBottom: `2px solid ${resultTab === tab ? "var(--signal)" : "transparent"}`,
                  fontFamily: "var(--mono)",
                  fontSize: 10.5,
                }}
              >
                {tab}
              </button>
            ))}
          </div>
          <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: 12 }}>
            {!selectedRunId ? (
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
                    setSelectedRunId(row.id);
                    setSessionId(row.sessionId ?? undefined);
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
