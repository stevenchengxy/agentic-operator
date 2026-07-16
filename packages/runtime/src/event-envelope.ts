/**
 * Canonical logical event envelope shared by every manifest-agent ingress.
 *
 * The returned object is safe to persist in the public event ledger and safe
 * to expose to an agent. Inngest-only routing metadata (the `__*` fields) is
 * deliberately excluded; callers may add it to a delivery copy after this
 * payload has been written to the ledger.
 */

export interface BuildCanonicalEventPayloadInput {
  /** Bare event name, without the tenant namespace. */
  eventName: string;
  /** Durable event identity used by the event ledger / events table. */
  eventId: string;
  /** Caller-authored fields. Non-reserved fields are preserved verbatim. */
  payload?: unknown;
  /** Runtime-owned subject. Omitted from the logical payload when absent. */
  subject?: string | null;
  /** Correlation identity used as the request-id fallback when available. */
  correlationId?: string | null;
  /** Exact user prompt. Never trim or otherwise normalize this value. */
  prompt?: string;
}

const RUNTIME_OWNED_FIELDS = new Set([
  "event_type",
  "event_name",
  "event_id",
  "subject",
  "prompt",
  "input",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Remove transport/control metadata from an event payload without mutating
 * the supplied object. This is intentionally a top-level operation: nested
 * domain objects may legitimately define keys beginning with `__`.
 */
export function stripPrivateEventMetadata(
  payload: unknown,
): Record<string, unknown> {
  if (!isRecord(payload)) return {};
  const logical: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (key.startsWith("__")) continue;
    logical[key] = value;
  }
  return logical;
}

/**
 * Build the public event shape consumed by live manifest agents.
 *
 * Runtime identity fields always win over caller-authored lookalikes. A
 * non-empty authored `request_id` is retained for upstream traceability;
 * otherwise the correlation id (or, finally, event id) becomes request_id.
 * When a prompt is available it is copied exactly to the `prompt` and
 * `input` aliases, and becomes `context` only when the caller did not supply
 * a context value of its own.
 */
export function buildCanonicalEventPayload(
  input: BuildCanonicalEventPayloadInput,
): Record<string, unknown> {
  const authored = stripPrivateEventMetadata(input.payload);
  const logical: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(authored)) {
    if (RUNTIME_OWNED_FIELDS.has(key)) continue;
    logical[key] = value;
  }

  const requestId = nonEmptyString(authored.request_id)
    ? authored.request_id
    : nonEmptyString(input.correlationId)
      ? input.correlationId
      : input.eventId;
  const exactPrompt =
    typeof input.prompt === "string"
      ? input.prompt
      : typeof authored.prompt === "string"
        ? authored.prompt
        : undefined;

  logical.event_type = input.eventName;
  logical.event_name = input.eventName;
  logical.event_id = input.eventId;
  logical.request_id = requestId;
  if (typeof input.subject === "string") logical.subject = input.subject;

  if (exactPrompt !== undefined) {
    logical.prompt = exactPrompt;
    logical.input = exactPrompt;
    if (logical.context === undefined) logical.context = exactPrompt;
  }

  return logical;
}
