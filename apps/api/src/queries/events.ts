/**
 * Read-side queries for the Event Tester surface (FR-1, FR-5, FR-6).
 *
 *   - listEventCatalog(tenantSlug)
 *       Snapshot of every event declared in the tenant's manifest. Sourced
 *       from `eventTypes.payloadJson` (populated by `upsertEventTypes` at
 *       bootstrap). Each row's `event_data[]` array becomes a typed
 *       `EventCatalogField` so the UI can render schema-driven inputs.
 *
 *   - fetchEventsSince(tenantSlug, since, names?)
 *       Live-tail polling primitive. Called by the SSE handler every 250ms;
 *       returns rows received after `since` (unix-ms), optionally filtered
 *       by a name allowlist.
 *
 *   - fetchCausality(tenantSlug, seedEventId, maxDepth = 3)
 *       BFS over `events.id -> runs.triggerEventId -> runs.emittedEventId ->
 *       events.id` starting from `seedEventId`. Every row read is
 *       tenant-checked. Fanout is capped at 50 per node so a runaway DAG
 *       can't drag the SSE thread.
 *
 * Tenant isolation: every row read here filters on `events.tenantId` /
 * `runs.tenantId`. Routes resolve `tenantSlug -> tenantId` via the same
 * helper used by queries/runs.ts so callers can't address a foreign tenant
 * even by guessing slugs.
 */

import { and, desc, eq, gt, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import {
  agents,
  events,
  eventTypes,
  getDb,
  runs,
  tenants,
} from "@agentic/db";
import { resolvePayloadRef } from "./runs";
import type {
  EventCatalogEntry,
  EventCatalogField,
  EventCausalityEdge,
  EventCausalityRun,
  EventRow,
} from "@agentic/contracts";

async function resolveTenantId(slug: string): Promise<string | null> {
  const db = getDb();
  const row = db.select().from(tenants).where(eq(tenants.slug, slug)).all()[0];
  return row?.id ?? null;
}

/**
 * Parse the manifest's `payload` object (stored as `payloadJson` on the
 * `event_types` row) into a typed `fields[]` array.
 *
 * The manifest shape is `{ source_action, event_data: [{ name, type,
 * target_object, enum?, required? }], state_mutations: [...] }`. Anything
 * we don't recognise we leave alone — `raw_payload_schema` passes through
 * untouched for the UI's expert/Monaco fallback.
 *
 * Robust to null / shape drift: returns `{ fields: [], raw_payload_schema:
 * null, source_action: null }` rather than throwing if the JSON is missing
 * or malformed.
 */
function extractCatalogFields(payloadJson: unknown): {
  fields: EventCatalogField[];
  source_action: string | null;
  raw_payload_schema: unknown;
} {
  if (!payloadJson || typeof payloadJson !== "object") {
    return { fields: [], source_action: null, raw_payload_schema: null };
  }
  const obj = payloadJson as Record<string, unknown>;
  const rawData = obj.event_data;
  if (!Array.isArray(rawData)) {
    return {
      fields: [],
      source_action: typeof obj.source_action === "string" ? obj.source_action : null,
      raw_payload_schema: payloadJson,
    };
  }
  const fields: EventCatalogField[] = [];
  for (const entry of rawData) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.name !== "string") continue;
    const field: EventCatalogField = {
      name: e.name,
      type: typeof e.type === "string" ? e.type : "String",
    };
    if (typeof e.target_object === "string") {
      field.target_object = e.target_object;
    } else if (e.target_object === null) {
      field.target_object = null;
    }
    if (typeof e.required === "boolean") field.required = e.required;
    if (Array.isArray(e.enum)) {
      const enumVals = e.enum.filter((v): v is string => typeof v === "string");
      if (enumVals.length > 0) field.enum = enumVals;
    }
    fields.push(field);
  }
  return {
    fields,
    source_action: typeof obj.source_action === "string" ? obj.source_action : null,
    raw_payload_schema: payloadJson,
  };
}

export async function listEventCatalog(
  tenantSlug: string,
): Promise<EventCatalogEntry[]> {
  const db = getDb();
  const tenantId = await resolveTenantId(tenantSlug);
  if (!tenantId) return [];

  const rows = db
    .select({
      name: eventTypes.name,
      category: eventTypes.category,
      color: eventTypes.color,
      description: eventTypes.description,
      payloadJson: eventTypes.payloadJson,
    })
    .from(eventTypes)
    .where(eq(eventTypes.tenantId, tenantId))
    .orderBy(eventTypes.name)
    .all();

  return rows.map((r) => {
    const { fields, source_action, raw_payload_schema } = extractCatalogFields(
      r.payloadJson,
    );
    return {
      name: r.name,
      description: r.description ?? null,
      category: r.category ?? null,
      color: r.color ?? null,
      source_action,
      fields,
      raw_payload_schema,
    };
  });
}

/**
 * Live-tail step. Returns events newer than `since` (unix-ms, exclusive)
 * for the tenant, oldest-first so the SSE handler can stream them in
 * arrival order. Optional `names` allowlist filters at the SQL level.
 *
 * Soft-deleted rows (deletedAt set) are excluded — they shouldn't show up
 * in a "what just happened" live tail.
 */
export async function fetchEventsSince(
  tenantSlug: string,
  since: number,
  names?: string[] | null,
): Promise<EventRow[]> {
  const db = getDb();
  const tenantId = await resolveTenantId(tenantSlug);
  if (!tenantId) return [];

  const whereParts = [
    eq(events.tenantId, tenantId),
    gt(events.receivedAt, new Date(since)),
    sql`${events.deletedAt} IS NULL`,
  ];
  if (names && names.length > 0) {
    whereParts.push(
      sql`${events.name} IN (${sql.join(
        names.map((n) => sql`${n}`),
        sql`, `,
      )})`,
    );
  }

  return db
    .select({
      id: events.id,
      name: events.name,
      subject: events.subject,
      category: events.category,
      color: eventTypes.color,
      receivedAt: events.receivedAt,
      sourceAgentName: agents.name,
      sourceAgentTitle: agents.title,
      payloadRef: events.payloadRef,
    })
    .from(events)
    .leftJoin(agents, eq(agents.id, events.sourceAgentId))
    .leftJoin(
      eventTypes,
      and(
        eq(eventTypes.tenantId, events.tenantId),
        eq(eventTypes.name, events.name),
      ),
    )
    .where(and(...whereParts))
    .orderBy(events.receivedAt)
    .limit(200)
    .all();
}

const CAUSALITY_FANOUT_CAP = 50;

/**
 * BFS over the seed event's causal graph:
 *
 *   events.id ──triggered_run──> runs.id ──emitted_event──> events.id ──…
 *
 * `maxDepth` counts *edges* away from the seed (default 3, so we walk
 * seed -> children -> grandchildren). Fanout per node is capped at 50
 * (newest first by start time / receivedAt) so a wide DAG can't run away
 * with the request thread.
 */
export async function fetchCausality(
  tenantSlug: string,
  seedEventId: string,
  maxDepth: number = 3,
): Promise<{
  events: EventRow[];
  runs: EventCausalityRun[];
  edges: EventCausalityEdge[];
}> {
  const db = getDb();
  const tenantId = await resolveTenantId(tenantSlug);
  if (!tenantId) return { events: [], runs: [], edges: [] };

  const seenEventIds = new Set<string>();
  const seenRunIds = new Set<string>();
  const eventRows: EventRow[] = [];
  const runRows: EventCausalityRun[] = [];
  const edges: EventCausalityEdge[] = [];

  const loadEvent = (id: string): EventRow | null => {
    const row = db
      .select({
        id: events.id,
        name: events.name,
        subject: events.subject,
        category: events.category,
        color: eventTypes.color,
        receivedAt: events.receivedAt,
        sourceAgentName: agents.name,
        sourceAgentTitle: agents.title,
        payloadRef: events.payloadRef,
        tenantId: events.tenantId,
      })
      .from(events)
      .leftJoin(agents, eq(agents.id, events.sourceAgentId))
      .leftJoin(
        eventTypes,
        and(
          eq(eventTypes.tenantId, events.tenantId),
          eq(eventTypes.name, events.name),
        ),
      )
      .where(eq(events.id, id))
      .all()[0];
    if (!row || row.tenantId !== tenantId) return null;
    const { tenantId: _t, ...rest } = row;
    return rest;
  };

  const seedRow = loadEvent(seedEventId);
  if (!seedRow) return { events: [], runs: [], edges: [] };
  seenEventIds.add(seedRow.id);
  eventRows.push(seedRow);

  // Frontier is the set of event ids whose downstream we haven't expanded yet.
  let frontier: string[] = [seedRow.id];

  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const nextFrontier: string[] = [];

    for (const eventId of frontier) {
      // Find runs triggered by this event (tenant-scoped, newest-first,
      // capped at CAUSALITY_FANOUT_CAP).
      const childRuns = db
        .select({
          id: runs.id,
          agentName: agents.name,
          status: runs.status,
          triggerEventId: runs.triggerEventId,
          emittedEventId: runs.emittedEventId,
          parentRunId: runs.parentRunId,
        })
        .from(runs)
        .leftJoin(agents, eq(agents.id, runs.agentId))
        .where(
          and(eq(runs.tenantId, tenantId), eq(runs.triggerEventId, eventId)),
        )
        .orderBy(desc(runs.startedAt))
        .limit(CAUSALITY_FANOUT_CAP)
        .all();

      for (const r of childRuns) {
        if (seenRunIds.has(r.id)) continue;
        seenRunIds.add(r.id);
        runRows.push({
          id: r.id,
          agentName: r.agentName ?? null,
          status: r.status,
          triggerEventId: r.triggerEventId ?? null,
          emittedEventId: r.emittedEventId ?? null,
          parentRunId: r.parentRunId ?? null,
        });
        edges.push({ from: eventId, to: r.id, kind: "triggered_run" });

        // Walk the emitted event (if any) into the next frontier.
        if (r.emittedEventId && !seenEventIds.has(r.emittedEventId)) {
          const childEvent = loadEvent(r.emittedEventId);
          if (childEvent) {
            seenEventIds.add(childEvent.id);
            eventRows.push(childEvent);
            edges.push({
              from: r.id,
              to: childEvent.id,
              kind: "emitted_event",
            });
            nextFrontier.push(childEvent.id);
          }
        }
      }
    }

    frontier = nextFrontier;
  }

  return { events: eventRows, runs: runRows, edges };
}

/**
 * Single event with its REAL resolved payload + actual consumers (the runs
 * this event triggered). Powers the Events view detail panel — replaces the
 * old reconstructed-envelope fake payload with what actually fired, and the
 * DAG-declared "listeners" with who really consumed this instance.
 */
export async function getEventDetail(
  tenantSlug: string,
  eventId: string,
): Promise<(EventRow & { payload: unknown }) | null> {
  const db = getDb();
  const tenantId = await resolveTenantId(tenantSlug);
  if (!tenantId) return null;

  const row = db
    .select({
      id: events.id,
      name: events.name,
      subject: events.subject,
      category: events.category,
      color: eventTypes.color,
      receivedAt: events.receivedAt,
      sourceAgentName: agents.name,
      sourceAgentTitle: agents.title,
      payloadRef: events.payloadRef,
    })
    .from(events)
    .leftJoin(agents, eq(agents.id, events.sourceAgentId))
    .leftJoin(
      eventTypes,
      and(
        eq(eventTypes.tenantId, events.tenantId),
        eq(eventTypes.name, events.name),
      ),
    )
    .where(and(eq(events.id, eventId), eq(events.tenantId, tenantId)))
    .all()[0];
  if (!row) return null;

  // Consumers: every run this event triggered (tenant-scoped via the event).
  const consumerAgents = alias(agents, "consumer_agents");
  const consumers = db
    .select({
      runId: runs.id,
      agentName: consumerAgents.name,
      agentTitle: consumerAgents.title,
      status: runs.status,
    })
    .from(runs)
    .leftJoin(consumerAgents, eq(consumerAgents.id, runs.agentId))
    .where(eq(runs.triggerEventId, eventId))
    .orderBy(desc(runs.startedAt))
    .all();

  const payload = await resolvePayloadRef(row.payloadRef);
  return { ...row, payload, consumers };
}
