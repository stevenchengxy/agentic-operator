/**
 * Structured trace seam for manifest and Studio execution.
 *
 * The runtime deliberately does not own trace persistence. A caller supplies
 * a sink that atomically allocates `id`, `seq`, and `createdAt` (normally in
 * the API/database layer). Runtime events contain only safe summaries and
 * bounded structured attributes; rendered prompts and raw model bodies are
 * included only when an explicit observability policy enables them.
 */

export type RuntimeTraceKind =
  | "run"
  | "input"
  | "prompt"
  | "step"
  | "llm"
  | "tool"
  | "output_validation"
  | "artifact"
  | "event";

export type RuntimeTraceLevel = "minimal" | "standard" | "debug";
export type RuntimeTraceVisibility = "user" | "operator" | "debug";
export type RuntimeTraceStatus =
  | "pending"
  | "running"
  | "ok"
  | "failed"
  | "skipped";

/**
 * Persistence-ready trace event before storage-owned fields are allocated.
 * Field names intentionally match `RunTraceEventSchema` in
 * `@agentic/contracts` except for `id`, `seq`, and `createdAt`.
 */
export interface RuntimeTraceEventDraft {
  runId: string;
  stepId?: string;
  parentId?: string;
  kind: RuntimeTraceKind;
  level: RuntimeTraceLevel;
  name: string;
  status: RuntimeTraceStatus;
  startedAt?: Date;
  endedAt?: Date;
  durationMs?: number;
  summary?: string;
  data?: Record<string, unknown>;
  artifactId?: string;
  visibility: RuntimeTraceVisibility;
}

export interface RuntimeTraceSink {
  /**
   * Persist one event. Implementations must allocate a monotonically ordered
   * sequence and should make replayed inserts idempotent.
   */
  append(event: RuntimeTraceEventDraft): Promise<void> | void;
}

export interface RuntimeTracePolicy {
  /** Maximum detail persisted for this run. Defaults to `standard`. */
  traceLevel?: RuntimeTraceLevel;
  /**
   * Whether a user-visible LLM event may carry a generated reasoning summary.
   * This never enables or exposes model chain-of-thought; it only controls
   * optional, deliberately authored summaries.
   */
  reasoningSummary?: boolean;
}

const TRACE_LEVEL_RANK: Readonly<Record<RuntimeTraceLevel, number>> = {
  minimal: 0,
  standard: 1,
  debug: 2,
};

/** Return whether an event at `level` belongs in the configured trace. */
export function shouldPersistRuntimeTrace(
  level: RuntimeTraceLevel,
  configuredLevel: RuntimeTraceLevel = "standard",
): boolean {
  return TRACE_LEVEL_RANK[level] <= TRACE_LEVEL_RANK[configuredLevel];
}

/**
 * Apply one agent's observability policy at the persistence boundary.
 * Callers can safely share their underlying sink; filtering is per wrapper.
 */
export function createFilteredTraceSink(
  sink: RuntimeTraceSink,
  policy: RuntimeTracePolicy = {},
): RuntimeTraceSink {
  const traceLevel = policy.traceLevel ?? "standard";
  const reasoningSummary = policy.reasoningSummary ?? true;
  return {
    append(event) {
      if (!shouldPersistRuntimeTrace(event.level, traceLevel)) return;
      if (
        reasoningSummary ||
        event.kind !== "llm" ||
        event.visibility !== "user"
      ) {
        return sink.append(event);
      }

      const data = omitReasoningSummaryFields(event.data);
      return sink.append({
        ...event,
        summary: undefined,
        ...(data ? { data } : { data: undefined }),
      });
    },
  };
}

function omitReasoningSummaryFields(
  data: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!data) return undefined;
  const scrubbed = { ...data };
  for (const key of [
    "reasoning",
    "reasoningSummary",
    "reasoning_summary",
    "thinking",
    "thinkingSummary",
    "thinking_summary",
  ]) {
    delete scrubbed[key];
  }
  return scrubbed;
}

/** Best-effort is opt-in at each call site; this primitive preserves errors. */
export async function appendRuntimeTrace(
  sink: RuntimeTraceSink | undefined,
  event: RuntimeTraceEventDraft,
): Promise<void> {
  if (!sink) return;
  await sink.append(event);
}

/** Small in-memory sink useful to Studio previews and focused unit tests. */
export function createBufferedTraceSink(): RuntimeTraceSink & {
  readonly events: RuntimeTraceEventDraft[];
} {
  const events: RuntimeTraceEventDraft[] = [];
  return {
    events,
    append(event) {
      events.push(structuredClone(event));
    },
  };
}
