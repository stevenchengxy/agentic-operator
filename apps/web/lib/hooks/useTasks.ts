/**
 * useTasks — TanStack Query wrappers around `/v1/tasks`.
 *
 * Cache invalidation driven by `useStream()` (see useStream.ts) on
 * `task.created` / `task.resolved` SSE events.
 */
"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";
import { TASK_KEYS, COUNT_KEYS } from "./useStream";
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

export interface TaskRow {
  id: string;
  type: string;
  title: string;
  priority: string | null;
  status: string;
  createdAt: string | null;
  resolvedAt: string | null;
  runId: string | null;
  awaitingRole: string | null;
  payloadJson: unknown;
  resolutionJson: unknown;
}

export function useTasks(): UseQueryResult<TaskRow[]> {
  return useQuery({
    queryKey: TASK_KEYS.list,
    queryFn: () => callV1<TaskRow[]>("/v1/tasks"),
    staleTime: 2_000,
  });
}

export function useTask(
  id: string | null | undefined,
): UseQueryResult<TaskRow> {
  return useQuery({
    queryKey: id
      ? TASK_KEYS.detail(id)
      : (["tasks", "detail", "__none__"] as const),
    queryFn: () => callV1<TaskRow>(`/v1/tasks/${encodeURIComponent(id!)}`),
    enabled: Boolean(id),
  });
}

/** Resolve a task: `POST /v1/tasks/:id/resolve`. */
export function useResolveTask() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      id: string;
      decision: "approve" | "reject" | "supplement";
      payload?: unknown;
    }) =>
      callV1<{ task_id: string; decision: string }>(
        `/v1/tasks/${encodeURIComponent(vars.id)}/resolve`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            decision: vars.decision,
            payload: vars.payload,
          }),
        },
      ),
    onSettled: (_data, _err, vars) => {
      void client.invalidateQueries({ queryKey: TASK_KEYS.all });
      void client.invalidateQueries({ queryKey: TASK_KEYS.detail(vars.id) });
      void client.invalidateQueries({ queryKey: COUNT_KEYS.tenant });
    },
  });
}
