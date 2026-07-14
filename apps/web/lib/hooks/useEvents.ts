/**
 * useEvents — TanStack Query wrappers around `/v1/events` and event replay.
 *
 * Cache invalidation driven by `useStream()` (see useStream.ts) on
 * `event.emitted` SSE events.
 */
"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";
import { EVENT_KEYS, COUNT_KEYS } from "./useStream";
import { tenantHeader } from "./tenant-header";

interface ApiOk<T> {
  ok: true;
  data: T;
}
interface ApiErr {
  ok: false;
  error: { code: string; message: string };
}

async function callV1<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { headers: initHeaders, ...rest } = init;
  const res = await fetch(path, {
    credentials: "same-origin",
    ...rest,
    headers: {
      Accept: "application/json",
      ...tenantHeader(),
      ...(initHeaders as Record<string, string> | undefined),
    },
  });
  const body = (await res.json()) as ApiOk<T> | ApiErr;
  if (!body.ok) {
    throw new Error(`${path}: ${body.error.code} — ${body.error.message}`);
  }
  return body.data;
}

export interface EventListFilter {
  name?: string;
  subject?: string;
  limit?: number;
}

function buildQuery(f: EventListFilter | undefined): string {
  if (!f) return "";
  const sp = new URLSearchParams();
  if (f.name) sp.set("name", f.name);
  if (f.subject) sp.set("subject", f.subject);
  if (f.limit) sp.set("limit", String(f.limit));
  const s = sp.toString();
  return s ? `?${s}` : "";
}

export interface EventRow {
  id: string;
  name: string;
  subject: string | null;
  category: string | null;
  color: string | null;
  receivedAt: string | null;
  sourceAgentName: string | null;
  sourceAgentTitle: string | null;
  payloadRef: string | null;
  /** Runs whose trigger_event_id == this event.id. Empty if no subscriber
   * picked it up yet. Optional so legacy responses that omit it still
   * decode cleanly. */
  consumers?: Array<{
    runId: string;
    agentName: string | null;
    agentTitle: string | null;
    status: string;
  }>;
}

/** Field descriptor from `/v1/events/catalog` — drives typed form inputs. */
export interface EventCatalogField {
  name: string;
  type: string;
  target_object?: string | null;
  required?: boolean;
  enum?: string[];
}

/** One row from `/v1/events/catalog`. */
export interface EventCatalogEntry {
  name: string;
  description?: string | null;
  category?: string | null;
  color?: string | null;
  source_action?: string | null;
  fields: EventCatalogField[];
  raw_payload_schema: unknown;
}

/** One run in the exact event → run causality graph. */
export interface EventCausalityRun {
  id: string;
  agentName: string | null;
  status: string;
  triggerEventId: string | null;
  emittedEventId: string | null;
  parentRunId: string | null;
}

export interface EventCausalityResponse {
  events: EventRow[];
  runs: EventCausalityRun[];
  edges: Array<{
    from: string;
    to: string;
    kind: "triggered_run" | "emitted_event";
  }>;
}

/**
 * Event-type catalog for the current tenant — name + description + typed
 * field schema. Used by the Publish-event modal so it can render typed
 * inputs instead of a raw JSON blob.
 */
export function useEventCatalog(): UseQueryResult<EventCatalogEntry[]> {
  return useQuery({
    queryKey: ["events", "catalog"],
    queryFn: async () => {
      const data = await callV1<{ events: EventCatalogEntry[] }>(
        "/v1/events/catalog",
      );
      return data.events;
    },
    staleTime: 60_000,
  });
}

export function useEvents(
  filter?: EventListFilter,
): UseQueryResult<EventRow[]> {
  const query = buildQuery(filter);
  return useQuery({
    queryKey: filter
      ? EVENT_KEYS.list(filter as Record<string, unknown>)
      : EVENT_KEYS.list(),
    queryFn: () => callV1<EventRow[]>(`/v1/events${query}`),
    staleTime: 2_000,
  });
}

/**
 * Follow one published event into the run(s) that consumed it.
 *
 * The causal endpoint joins on `runs.trigger_event_id`, rather than the
 * non-unique event name/subject pair. Polling while the dialog is open closes
 * the short gap between Inngest accepting the event and the runtime creating
 * its run row, and also keeps the displayed run status current.
 */
export function useEventCausality(
  eventId: string | null | undefined,
): UseQueryResult<EventCausalityResponse> {
  return useQuery({
    queryKey: ["events", "causality", eventId ?? "__none__"] as const,
    queryFn: () =>
      callV1<EventCausalityResponse>(
        `/v1/events/recent?causality=1&seed=${encodeURIComponent(eventId!)}`,
      ),
    enabled: Boolean(eventId),
    staleTime: 0,
    refetchInterval: eventId ? 1_000 : false,
  });
}

/** Emit a new event: `POST /v1/events`. */
export function useEmitEvent() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      name: string;
      subject?: string;
      payload?: Record<string, unknown>;
      test?: boolean;
      source?: "operator" | "system" | "external";
      targetAgent?: string;
    }) =>
      callV1<{ event_id: string; name: string }>("/v1/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: EVENT_KEYS.all });
      void client.invalidateQueries({ queryKey: COUNT_KEYS.tenant });
    },
  });
}

/** Replay an event: `POST /v1/events/:id/replay`. */
export function useReplayEvent() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      callV1<{ replayed: string; new_event_id: string }>(
        `/v1/events/${encodeURIComponent(id)}/replay`,
        { method: "POST" },
      ),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: EVENT_KEYS.all });
    },
  });
}
