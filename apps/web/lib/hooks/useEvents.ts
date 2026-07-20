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
import { readApiData } from "@/lib/api-response";
import { tenantHeader } from "./tenant-header";

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
  return readApiData<T>(res, path);
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
  /** Resolved REAL payload — populated only by GET /v1/events/:id (useEvent). */
  payload?: unknown;
}

/**
 * Single event with its REAL resolved payload + actual consumers
 * (GET /v1/events/:id). Used by the Events detail panel to show what actually
 * fired instead of a reconstructed envelope.
 */
export function useEvent(
  id: string | null | undefined,
): UseQueryResult<EventRow> {
  return useQuery({
    queryKey: ["events", "detail", id] as const,
    queryFn: () => callV1<EventRow>(`/v1/events/${encodeURIComponent(id!)}`),
    enabled: Boolean(id),
    staleTime: 30_000,
  });
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
    // SSE invalidation is primary; polling keeps the ledger live when a proxy
    // or browser temporarily drops the stream.
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
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
    }) =>
      callV1<{ event_id: string; name: string }>("/v1/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, source: "operator" }),
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
