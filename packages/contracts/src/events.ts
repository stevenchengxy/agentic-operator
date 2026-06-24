import { z } from "zod";

/**
 * POST /v1/events ingest body. Additive shape:
 *   - `test`   — when true the ingest endpoint stamps `__test: true` onto the
 *                Inngest payload so downstream runs are flagged as test runs.
 *   - `source` — provenance of this publish. "external" (default) is the
 *                legacy webhook/CLI path and is not audited here. Any other
 *                value writes an `event.publish` audit row.
 *
 * Both fields are optional → existing callers (CLI, webhooks) keep working
 * with their pre-Event-Tester bodies.
 */
export const IngestEventBody = z.object({
  name: z.string().min(1),
  subject: z.string().optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
  test: z.boolean().optional(),
  source: z.enum(["operator", "system", "external"]).optional(),
});
export type IngestEventBody = z.infer<typeof IngestEventBody>;

export const IngestEventResponse = z.object({
  event_id: z.string(),
  name: z.string(),
});

export const ReplayEventResponse = z.object({
  replayed: z.string(),
  new_event_id: z.string(),
});

/**
 * A run that consumed an event (joined via runs.trigger_event_id). Surfaced
 * in EventRow.consumers so the dashboard ticker can show "consumed by X"
 * inline without a second round-trip.
 */
export const EventConsumer = z.object({
  runId: z.string(),
  agentName: z.string().nullable(),
  agentTitle: z.string().nullable(),
  status: z.string(),
});
export type EventConsumer = z.infer<typeof EventConsumer>;

export const EventRow = z.object({
  id: z.string(),
  name: z.string(),
  subject: z.string().nullable(),
  category: z.string().nullable(),
  color: z.string().nullable(),
  receivedAt: z.coerce.date().nullable(),
  sourceAgentName: z.string().nullable(),
  sourceAgentTitle: z.string().nullable(),
  payloadRef: z.string().nullable(),
  /** Runs whose trigger_event_id == this event.id. Empty when no
   * subscribers fired (e.g. a dead-letter event). Optional so older
   * tests / callers that don't populate it keep validating. */
  consumers: z.array(EventConsumer).optional(),
  /** Resolved REAL payload (detail endpoint only — GET /v1/events/:id reads
   * the ledger file). Bounded server-side. Undefined on list endpoints. */
  payload: z.unknown().optional(),
});
export type EventRow = z.infer<typeof EventRow>;

export const ListEventsQuery = z.object({
  limit: z.coerce.number().int().positive().max(500).optional(),
  name: z.string().optional(),
});

// ─── Event catalog (GET /v1/events/catalog) ──────────────────────────────────
//
// One row per `eventTypes` entry. `fields` is derived from the manifest's
// `payload.event_data[]` so the Tester UI can render typed inputs without
// re-reading the manifest JSON on the client.

export const EventCatalogField = z.object({
  name: z.string(),
  type: z.string(),
  target_object: z.string().nullable().optional(),
  required: z.boolean().optional(),
  enum: z.array(z.string()).optional(),
});
export type EventCatalogField = z.infer<typeof EventCatalogField>;

export const EventCatalogEntry = z.object({
  name: z.string(),
  description: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
  color: z.string().nullable().optional(),
  source_action: z.string().nullable().optional(),
  fields: z.array(EventCatalogField),
  raw_payload_schema: z.unknown().nullable(),
});
export type EventCatalogEntry = z.infer<typeof EventCatalogEntry>;

export const EventCatalogResponse = z.object({
  events: z.array(EventCatalogEntry),
});
export type EventCatalogResponse = z.infer<typeof EventCatalogResponse>;

// ─── Recent + causality envelope (GET /v1/events/recent?causality=1) ─────────
//
// A sibling response to the existing `GET /v1/events` list. When the caller
// passes `causality=1&seed=<event-id>`, the server returns the seed event
// plus the runs it triggered and the events those runs emitted (BFS to a
// bounded depth). Edges describe the directed graph between them.

export const EventCausalityEdge = z.object({
  from: z.string(),
  to: z.string(),
  kind: z.enum(["triggered_run", "emitted_event"]),
});
export type EventCausalityEdge = z.infer<typeof EventCausalityEdge>;

export const EventCausalityRun = z.object({
  id: z.string(),
  agentName: z.string().nullable(),
  status: z.string(),
  triggerEventId: z.string().nullable(),
  emittedEventId: z.string().nullable(),
  parentRunId: z.string().nullable(),
});
export type EventCausalityRun = z.infer<typeof EventCausalityRun>;

export const EventRecentResponse = z.object({
  events: z.array(EventRow),
  edges: z.array(EventCausalityEdge).optional(),
  runs: z.array(EventCausalityRun).optional(),
});
export type EventRecentResponse = z.infer<typeof EventRecentResponse>;
