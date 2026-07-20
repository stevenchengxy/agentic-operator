/**
 * Canonical parent -> child invoke envelope.
 *
 * Keep this helper free of runtime dependencies: the manifest runtime and both
 * generated-code renderers use the same merge order and the exported vectors
 * guard their embedded implementations against drift.
 */
export interface InvokeContractInput {
  eventData?: Record<string, unknown>;
  invokeInput?: Record<string, unknown>;
  /** Defaults to true for backwards compatibility. */
  forwardLastResult?: boolean;
  /** Defaults to false: the complete step-result map is never leaked implicitly. */
  forwardResults?: boolean;
  lastResult?: unknown;
  results?: Record<string, unknown>;
  subject?: unknown;
  correlationId?: string;
  timeoutS?: number;
}

export function materializeInvokePayload(
  input: InvokeContractInput,
): Record<string, unknown> {
  const forwardedLast =
    input.forwardLastResult === false || input.lastResult == null
      ? {}
      : typeof input.lastResult === "object" && !Array.isArray(input.lastResult)
        ? (input.lastResult as Record<string, unknown>)
        : { _lastResult: input.lastResult };
  const resolvedSubject =
    input.subject ?? input.eventData?.subject ?? input.eventData?._subject;
  const subject =
    resolvedSubject == null
      ? {}
      : { subject: resolvedSubject, _subject: resolvedSubject };
  const resolvedCorrelationId =
    input.correlationId?.trim() ||
    (typeof input.eventData?.__correlationId === "string"
      ? input.eventData.__correlationId
      : typeof input.eventData?._correlationId === "string"
        ? input.eventData._correlationId
        : undefined);
  const correlation =
    resolvedCorrelationId == null || resolvedCorrelationId === ""
      ? {}
      : {
          __correlationId: resolvedCorrelationId,
          _correlationId: resolvedCorrelationId,
        };
  return {
    ...(input.eventData ?? {}),
    ...(input.invokeInput ?? {}),
    ...forwardedLast,
    ...(input.forwardResults ? { _results: { ...(input.results ?? {}) } } : {}),
    ...subject,
    ...correlation,
  };
}

export function invokeTimeoutMs(timeoutS: number | undefined): number | undefined {
  if (timeoutS === undefined) return undefined;
  if (!Number.isInteger(timeoutS) || timeoutS <= 0) {
    throw new Error("invoke timeoutS must be a positive integer number of seconds");
  }
  return timeoutS * 1000;
}

export interface InvokeContractTestVector {
  name: string;
  input: InvokeContractInput;
  expectedPayload: Record<string, unknown>;
  expectedTimeoutMs: number | undefined;
}

/** Shared black-box vectors consumed by runtime and renderer tests. */
export const INVOKE_CONTRACT_TEST_VECTORS: readonly InvokeContractTestVector[] = [
  {
    name: "default-forwards-last-but-not-results",
    input: {
      eventData: { requestId: "req-1", shared: "event" },
      invokeInput: { fixed: true, shared: "invoke" },
      lastResult: { parsed: true, shared: "last" },
      results: { secretStep: { token: "must-not-leak" } },
      subject: "candidate-1",
      correlationId: "corr-1",
      timeoutS: 7,
    } satisfies InvokeContractInput,
    expectedPayload: {
      requestId: "req-1",
      fixed: true,
      parsed: true,
      shared: "last",
      subject: "candidate-1",
      _subject: "candidate-1",
      __correlationId: "corr-1",
      _correlationId: "corr-1",
    },
    expectedTimeoutMs: 7_000,
  },
  {
    name: "explicit-results-and-no-last",
    input: {
      eventData: {
        requestId: "req-2",
        _subject: "candidate-2",
        _correlationId: "corr-2",
      },
      invokeInput: { mode: "audit" },
      forwardLastResult: false,
      forwardResults: true,
      lastResult: { ok: true },
      results: { parse: { ok: true } },
    } satisfies InvokeContractInput,
    expectedPayload: {
      requestId: "req-2",
      mode: "audit",
      _results: { parse: { ok: true } },
      subject: "candidate-2",
      _subject: "candidate-2",
      __correlationId: "corr-2",
      _correlationId: "corr-2",
    },
    expectedTimeoutMs: undefined,
  },
  {
    name: "primitive-last-uses-reserved-field",
    input: {
      eventData: { requestId: "req-3" },
      lastResult: "ready",
      results: { hidden: true },
      timeoutS: 2,
    } satisfies InvokeContractInput,
    expectedPayload: { requestId: "req-3", _lastResult: "ready" },
    expectedTimeoutMs: 2_000,
  },
] as const;
