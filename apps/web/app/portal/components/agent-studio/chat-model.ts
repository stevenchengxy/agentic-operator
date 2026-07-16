import type {
  AgentRunHistoryRow,
  GetRunSessionResponse,
  RunMessage,
} from "@agentic/contracts";

export type ChatMessageState =
  | "complete"
  | "working"
  | "failed"
  | "cancelled"
  | "empty";

export interface ChatMessageView {
  id: string;
  role: "user" | "assistant";
  runId: string | null;
  content: unknown;
  state: ChatMessageState;
  createdAt: Date | null;
}

function runFallback(
  run: AgentRunHistoryRow,
  fallbackOutputs: ReadonlyMap<string, unknown>,
): ChatMessageView {
  if (["queued", "running", "waiting"].includes(run.status)) {
    return {
      id: `status-${run.id}`,
      role: "assistant",
      runId: run.id,
      content:
        run.status === "waiting"
          ? "The agent is waiting before it can continue."
          : "The agent is working on this request…",
      state: "working",
      createdAt: null,
    };
  }
  if (run.status === "failed") {
    return {
      id: `status-${run.id}`,
      role: "assistant",
      runId: run.id,
      content: run.error || "The agent could not complete this request.",
      state: "failed",
      createdAt: run.endedAt,
    };
  }
  if (run.status === "cancelled") {
    return {
      id: `status-${run.id}`,
      role: "assistant",
      runId: run.id,
      content: "This response was cancelled.",
      state: "cancelled",
      createdAt: run.endedAt,
    };
  }
  if (fallbackOutputs.has(run.id)) {
    const content = normalizeAssistantContent(fallbackOutputs.get(run.id));
    return {
      id: `status-${run.id}`,
      role: "assistant",
      runId: run.id,
      content,
      state: content == null ? "empty" : "complete",
      createdAt: run.endedAt,
    };
  }
  return {
    id: `status-${run.id}`,
    role: "assistant",
    runId: run.id,
    content: "The run completed without returning a result.",
    state: "empty",
    createdAt: run.endedAt,
  };
}

/**
 * Older/compatibility agents can persist a JSON object as a string even though
 * newer agents persist the parsed value. Normalize only objects and arrays so
 * the same result renders consistently without rewriting ordinary prose (or a
 * user's message). JSON fenced by a provider is accepted as well.
 */
export function normalizeAssistantContent(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i);
  const candidate = (fenced?.[1] ?? trimmed).trim();
  if (!candidate.startsWith("{") && !candidate.startsWith("[")) return value;
  try {
    const parsed: unknown = JSON.parse(candidate);
    return isStructuredChatValue(parsed) ? parsed : value;
  } catch {
    return value;
  }
}

function visibleMessage(message: RunMessage): ChatMessageView | null {
  if (message.role !== "user" && message.role !== "assistant") return null;
  const rawContent =
    message.role === "user" &&
    isPlainRecord(message.content) &&
    typeof message.content.prompt === "string"
      ? message.content.prompt
      : message.content;
  const content =
    message.role === "assistant"
      ? normalizeAssistantContent(rawContent)
      : rawContent;
  const error =
    message.role === "assistant" && isPlainRecord(content)
      ? content.error
      : null;
  const errorRecord = isPlainRecord(error) ? error : null;
  const cancelled = errorRecord?.code === "run_cancelled";
  const displayContent =
    errorRecord && typeof errorRecord.message === "string"
      ? errorRecord.message
      : content;
  return {
    id: message.id,
    role: message.role,
    runId: message.runId,
    content: displayContent,
    state:
      content == null
        ? "empty"
        : cancelled
          ? "cancelled"
          : errorRecord
            ? "failed"
            : "complete",
    createdAt: message.createdAt,
  };
}

/**
 * Build the accessible transcript shown by Test Lab.
 *
 * The API stores system/tool records alongside conversation messages. Test Lab
 * intentionally presents only user/assistant turns, then synthesizes one
 * assistant status bubble while a run has not persisted its terminal message.
 */
export function buildChatTranscript(
  session: GetRunSessionResponse | null | undefined,
  fallbackOutputs: ReadonlyMap<string, unknown> = new Map(),
): ChatMessageView[] {
  if (!session) return [];
  const runs = new Map(session.runs.map((run) => [run.id, run]));
  const hasAssistant = new Set(
    session.messages
      .filter((message) => message.role === "assistant" && message.runId)
      .map((message) => message.runId as string),
  );
  const transcript: ChatMessageView[] = [];

  for (const message of [...session.messages].sort((a, b) => a.ord - b.ord)) {
    const visible = visibleMessage(message);
    if (!visible) continue;
    transcript.push(visible);
    if (
      visible.role === "user" &&
      visible.runId &&
      !hasAssistant.has(visible.runId)
    ) {
      const run = runs.get(visible.runId);
      if (run) transcript.push(runFallback(run, fallbackOutputs));
    }
  }
  return transcript;
}

export function isPlainRecord(
  value: unknown,
): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function prettyChatValue(value: unknown): string {
  if (value == null) return "The agent completed without returning a result.";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function isStructuredChatValue(value: unknown): boolean {
  return Array.isArray(value) || isPlainRecord(value);
}
