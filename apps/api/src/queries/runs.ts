import { readFile } from "node:fs/promises";
import { alias } from "drizzle-orm/sqlite-core";
import { and, desc, eq, isNull, like, or, sql } from "drizzle-orm";
import {
  agents,
  events,
  eventTypes,
  getDb,
  runs,
  steps,
  tenants,
} from "@agentic/db";
import type { RunRow, StepRow, EventRow } from "@agentic/contracts";

/**
 * Resolve a stored payload reference to its real JSON, for the run-detail
 * IO/Events tabs. Two ref formats coexist:
 *   - event ledger: "<file>#<byteOffset>" → the NDJSON line's `.data`
 *   - step artifact: "<file>"             → the whole JSON file
 * Bounded to MAX_PAYLOAD_BYTES so a base64 résumé can't bloat the response;
 * an oversized payload collapses to a small preview marker. Best-effort —
 * a missing/garbled file resolves to null rather than throwing.
 */
const MAX_PAYLOAD_BYTES = 24_000;

function capPayload(value: unknown): unknown {
  if (value == null) return value;
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return null;
  }
  if (serialized.length <= MAX_PAYLOAD_BYTES) return value;
  return {
    _truncated: true,
    _bytes: serialized.length,
    _preview: serialized.slice(0, 4000),
  };
}

export async function resolvePayloadRef(
  ref: string | null | undefined,
): Promise<unknown> {
  if (!ref) return null;
  const hashIdx = ref.lastIndexOf("#");
  try {
    if (hashIdx === -1) {
      // step artifact — the whole file is the payload
      return capPayload(JSON.parse(await readFile(ref, "utf8")));
    }
    // event ledger ref "<file>#<offset>" → the line's `.data`
    const filePath = ref.slice(0, hashIdx);
    const offset = Number(ref.slice(hashIdx + 1));
    if (!Number.isFinite(offset)) return null;
    const buf = await readFile(filePath);
    const nl = buf.indexOf(0x0a, offset);
    const line = buf.toString("utf8", offset, nl === -1 ? undefined : nl);
    const parsed = JSON.parse(line) as { data?: unknown };
    return capPayload(parsed.data ?? parsed);
  } catch {
    return null;
  }
}

// UC-V11-21 / AR-GAP-06 — two `events` joins on the same query (the
// trigger event AND the emitted event) need aliases or Drizzle's
// JOIN-builder collapses them to the same table reference. The trigger
// join keeps the bare `events` table for backwards compat with the
// existing `triggerEvent: events.name` selection.
const emittedEventsAlias = alias(events, "emitted_events");

async function resolveTenantId(slug: string): Promise<string | null> {
  const db = getDb();
  const row = db.select().from(tenants).where(eq(tenants.slug, slug)).all()[0];
  return row?.id ?? null;
}

/**
 * Hydrate the current-step + step-count fields on a list of runs.
 * Issues two batched queries (1 for step counts per run, 1 for running step
 * name+ord per active run). Much cheaper than N+1 lookups.
 */
function hydrateStepInfo(rows: Array<RunRow & { id: string }>): RunRow[] {
  if (rows.length === 0) return rows;
  const db = getDb();
  const runIds = rows.map((r) => r.id);

  // Total step count per run
  const countMap = new Map<string, number>();
  for (const row of db
    .select({ runId: steps.runId, c: sql<number>`count(*)` })
    .from(steps)
    .where(sql`${steps.runId} IN (${sql.join(runIds.map((id) => sql`${id}`), sql`, `)})`)
    .groupBy(steps.runId)
    .all()) {
    countMap.set(row.runId, Number(row.c));
  }

  // For runs in "running"/"waiting"/"queued" status: find current in-flight step.
  const liveIds = rows
    .filter((r) => r.status === "running" || r.status === "waiting" || r.status === "queued")
    .map((r) => r.id);
  const currentMap = new Map<string, { name: string; ord: number }>();
  if (liveIds.length > 0) {
    // Pick highest ord still in non-terminal state
    for (const row of db
      .select({
        runId: steps.runId,
        name: steps.name,
        ord: steps.ord,
        status: steps.status,
      })
      .from(steps)
      .where(
        sql`${steps.runId} IN (${sql.join(liveIds.map((id) => sql`${id}`), sql`, `)})`,
      )
      .orderBy(steps.runId, desc(steps.ord))
      .all()) {
      if (!currentMap.has(row.runId)) {
        currentMap.set(row.runId, { name: row.name, ord: row.ord });
      }
    }
  }

  return rows.map((r) => {
    const cur = currentMap.get(r.id);
    return {
      ...r,
      currentStepName: cur?.name ?? null,
      currentStepOrd: cur?.ord ?? null,
      stepCount: countMap.get(r.id) ?? null,
    };
  });
}

export async function listRecentRuns(
  tenantSlug: string,
  opts: {
    limit?: number;
    status?: string;
    agentName?: string;
    query?: string;
    parentRunId?: string;
  } = {},
): Promise<RunRow[]> {
  const db = getDb();
  const tenantId = await resolveTenantId(tenantSlug);
  if (!tenantId) return [];

  const whereParts = [eq(runs.tenantId, tenantId)];
  if (opts.parentRunId) {
    whereParts.push(eq(runs.parentRunId, opts.parentRunId));
  }
  const VALID_STATUSES = [
    "queued",
    "running",
    "ok",
    "failed",
    "waiting",
    "cancelled",
  ] as const;
  if (
    opts.status &&
    opts.status !== "all" &&
    (VALID_STATUSES as readonly string[]).includes(opts.status)
  ) {
    whereParts.push(eq(runs.status, opts.status as (typeof VALID_STATUSES)[number]));
  }
  if (opts.agentName) {
    whereParts.push(eq(agents.name, opts.agentName));
  }
  if (opts.query) {
    const q = `%${opts.query}%`;
    whereParts.push(
      or(like(runs.id, q), like(runs.subject, q), like(agents.name, q))!,
    );
  }

  const rows = db
    .select({
      id: runs.id,
      status: runs.status,
      agentName: agents.name,
      agentTitle: agents.title,
      subject: runs.subject,
      triggerEvent: events.name,
      emittedEvent: emittedEventsAlias.name,
      startedAt: runs.startedAt,
      endedAt: runs.endedAt,
      durationMs: runs.durationMs,
      tokensIn: runs.tokensIn,
      tokensOut: runs.tokensOut,
      model: runs.model,
      correlationId: runs.correlationId,
      errorMessage: runs.errorMessage,
      logPath: runs.logPath,
      // Surfacing parentRunId lets the list render a REPLAY/child badge and
      // lets the trace tree fetch a run's children via ?parentRunId=.
      parentRunId: runs.parentRunId,
      // P2-FE-18 — `testRun` lets cold-loaded views render the TEST badge
      // without a follow-up SSE roundtrip. The column is non-null in the
      // schema (default false) but we still coerce defensively.
      isTest: runs.isTest,
    })
    .from(runs)
    .innerJoin(agents, eq(agents.id, runs.agentId))
    .leftJoin(events, eq(events.id, runs.triggerEventId))
    .leftJoin(
      emittedEventsAlias,
      eq(emittedEventsAlias.id, runs.emittedEventId),
    )
    .where(and(...whereParts))
    .orderBy(desc(runs.startedAt))
    .limit(opts.limit ?? 50)
    .all()
    .map((r) => ({
      ...r,
      // P2-FE-18 — surface both spellings; `errorMessage` is the legacy field
      // hit by tc-18 fixtures, `error` is the shorter alias the portal reads.
      error: r.errorMessage,
      testRun: r.isTest === true,
      currentStepName: null,
      currentStepOrd: null,
      stepCount: null,
    })) as RunRow[];

  return hydrateStepInfo(rows);
}

export async function getRun(
  tenantSlug: string,
  runId: string,
): Promise<RunRow | null> {
  const db = getDb();
  const tenantId = await resolveTenantId(tenantSlug);
  if (!tenantId) return null;
  const row = db
    .select({
      id: runs.id,
      status: runs.status,
      agentName: agents.name,
      agentTitle: agents.title,
      subject: runs.subject,
      triggerEvent: events.name,
      emittedEvent: emittedEventsAlias.name,
      startedAt: runs.startedAt,
      endedAt: runs.endedAt,
      durationMs: runs.durationMs,
      tokensIn: runs.tokensIn,
      tokensOut: runs.tokensOut,
      model: runs.model,
      correlationId: runs.correlationId,
      errorMessage: runs.errorMessage,
      logPath: runs.logPath,
      parentRunId: runs.parentRunId,
      isTest: runs.isTest,
      // Real payloads for the run-detail IO/Events tabs: the trigger event is
      // the run's INPUT, the emitted event its OUTPUT. Resolved below.
      triggerPayloadRef: events.payloadRef,
      emittedPayloadRef: emittedEventsAlias.payloadRef,
    })
    .from(runs)
    .innerJoin(agents, eq(agents.id, runs.agentId))
    .leftJoin(events, eq(events.id, runs.triggerEventId))
    .leftJoin(
      emittedEventsAlias,
      eq(emittedEventsAlias.id, runs.emittedEventId),
    )
    .where(and(eq(runs.tenantId, tenantId), eq(runs.id, runId)))
    .all()[0];
  if (!row) return null;
  const { triggerPayloadRef, emittedPayloadRef, ...runFields } = row;
  // Resolve the real input (trigger) + output (emitted) payloads from the
  // ledger — detail-only (the list endpoint never reads files).
  const [inputPayload, outputPayload] = await Promise.all([
    resolvePayloadRef(triggerPayloadRef),
    resolvePayloadRef(emittedPayloadRef),
  ]);
  // P2-FE-18 — mirror errorMessage→error and surface isTest→testRun so the
  // detail surface matches the list surface and cold-loads paint the badge.
  const enriched = {
    ...runFields,
    error: runFields.errorMessage,
    testRun: runFields.isTest === true,
    currentStepName: null,
    currentStepOrd: null,
    stepCount: null,
    inputPayload,
    outputPayload,
  } as RunRow;
  const hydrated = hydrateStepInfo([enriched]);
  return hydrated[0] ?? null;
}

export async function listSteps(runId: string): Promise<StepRow[]> {
  const db = getDb();
  const rows = db
    .select({
      id: steps.id,
      ord: steps.ord,
      name: steps.name,
      type: steps.type,
      status: steps.status,
      startedAt: steps.startedAt,
      endedAt: steps.endedAt,
      durationMs: steps.durationMs,
      error: steps.error,
      provider: steps.provider,
      model: steps.model,
      tokensIn: steps.tokensIn,
      tokensOut: steps.tokensOut,
      attempts: steps.attempts,
      inputRef: steps.inputRef,
      outputRef: steps.outputRef,
    })
    .from(steps)
    .where(eq(steps.runId, runId))
    .orderBy(steps.ord)
    .all();
  // Resolve each step's real input/output artifact for the Timeline/Trace/IO
  // tabs (Inngest-style per-step 📥/📤). Detail-only file reads.
  return Promise.all(
    rows.map(async ({ inputRef, outputRef, ...step }) => ({
      ...step,
      input: await resolvePayloadRef(inputRef),
      output: await resolvePayloadRef(outputRef),
    })),
  ) as Promise<StepRow[]>;
}

export async function listRecentEvents(
  tenantSlug: string,
  opts: { limit?: number; name?: string } = {},
): Promise<EventRow[]> {
  const db = getDb();
  const tenantId = await resolveTenantId(tenantSlug);
  if (!tenantId) return [];

  // Soft-deleted events are invisible to operator views. The SSE live tail
  // (fetchEventsSince) applies the same filter — both surfaces must agree
  // or the catch-up GET and the live socket disagree on what's "current".
  const whereParts = [eq(events.tenantId, tenantId), isNull(events.deletedAt)];
  if (opts.name) whereParts.push(eq(events.name, opts.name));

  const rows = db
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
    .orderBy(desc(events.receivedAt))
    .limit(opts.limit ?? 30)
    .all();

  return hydrateEventConsumers(rows);
}

/**
 * Attach `consumers[]` to each event by looking up `runs` whose
 * `trigger_event_id` matches an event id in the page. One batched IN query
 * regardless of page size, so the cost is O(events + runs-for-this-page),
 * not O(events × runs).
 *
 * Why join through trigger_event_id instead of (name, subject)? The
 * (name, subject) pair is non-unique: when a workflow runs the same agent
 * for the same subject twice (replay, retry-with-new-event), each instance
 * gets its own (event_id, run_id) pair — joining on name/subject would
 * fold them all into one event and misattribute consumer chips. The FK is
 * exact and respects test/replay semantics.
 */
function hydrateEventConsumers(
  rows: Array<
    Omit<EventRow, "consumers"> & { id: string }
  >,
): EventRow[] {
  if (rows.length === 0) return rows;
  const db = getDb();
  const ids = rows.map((r) => r.id);

  const consumerRows = db
    .select({
      eventId: runs.triggerEventId,
      runId: runs.id,
      status: runs.status,
      agentName: agents.name,
      agentTitle: agents.title,
    })
    .from(runs)
    .leftJoin(agents, eq(agents.id, runs.agentId))
    .where(
      sql`${runs.triggerEventId} IN (${sql.join(
        ids.map((i) => sql`${i}`),
        sql`, `,
      )})`,
    )
    .all();

  const byEvent = new Map<
    string,
    Array<{
      runId: string;
      agentName: string | null;
      agentTitle: string | null;
      status: string;
    }>
  >();
  for (const c of consumerRows) {
    if (!c.eventId) continue;
    const arr = byEvent.get(c.eventId) ?? [];
    arr.push({
      runId: c.runId,
      agentName: c.agentName ?? null,
      agentTitle: c.agentTitle ?? null,
      status: c.status,
    });
    byEvent.set(c.eventId, arr);
  }

  return rows.map((r) => ({ ...r, consumers: byEvent.get(r.id) ?? [] }));
}
