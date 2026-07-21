"use client";

import { useEffect, useRef } from "react";
import {
  GetOperatorCheckResponseSchema,
  ListOperatorChecksResponseSchema,
  StartOperatorCheckResponseSchema,
  type GetOperatorCheckResponse,
  type ListOperatorChecksResponse,
  type StartOperatorCheckResponse,
} from "@agentic/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiResponseError, fetchApiData } from "@/lib/api-response";
import { tenantHeader } from "./tenant-header";

const TERMINAL_STATUSES = new Set(["passed", "failed"]);

async function parseResponse<T>(
  parse: () => T | Promise<T>,
  path: string,
  status: number,
): Promise<T> {
  try {
    return await parse();
  } catch {
    throw new ApiResponseError(path, status, "invalid_response", "", {
      clientKind: "invalidEnvelope",
    });
  }
}

async function callV1<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { headers: initHeaders, ...rest } = init;
  return fetchApiData<T>(path, {
    credentials: "same-origin",
    ...rest,
    headers: {
      Accept: "application/json",
      ...tenantHeader(),
      ...(initHeaders as Record<string, string> | undefined),
    },
  });
}

export const OPERATOR_CHECK_KEYS = {
  all: ["operator-checks"] as const,
  lists: ["operator-checks", "list"] as const,
  list: (limit: number, cursor?: string) =>
    ["operator-checks", "list", { limit, cursor: cursor ?? null }] as const,
  detail: (id: string) => ["operator-checks", "detail", id] as const,
};

async function invalidateOperatorCheckDependents(
  client: ReturnType<typeof useQueryClient>,
) {
  await Promise.all([
    client.invalidateQueries({ queryKey: ["agents"] }),
    client.invalidateQueries({ queryKey: ["workflows"] }),
    client.invalidateQueries({ queryKey: ["deployments"] }),
    client.invalidateQueries({ queryKey: ["runs"] }),
    client.invalidateQueries({ queryKey: ["events"] }),
    client.invalidateQueries({ queryKey: ["counts"] }),
    client.invalidateQueries({ queryKey: OPERATOR_CHECK_KEYS.lists }),
  ]);
}

/** Start the complete two-agent production reliability check. */
export function useStartOperatorCheck() {
  const client = useQueryClient();
  return useMutation<StartOperatorCheckResponse, Error>({
    mutationFn: async () => {
      const path = "/v1/operator-checks";
      const value = await callV1<unknown>(path, { method: "POST" });
      return parseResponse(
        () => StartOperatorCheckResponseSchema.parse(value),
        path,
        202,
      );
    },
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: OPERATOR_CHECK_KEYS.lists });
    },
  });
}

/**
 * Read one reliability check and poll only while it is queued/running.
 * Once it reaches a terminal state, refresh every portal surface changed by
 * the check so agents, deployments, runs, events, and counts all agree.
 */
export function useOperatorCheck(id: string | null | undefined) {
  const client = useQueryClient();
  const invalidatedTerminal = useRef<string | null>(null);
  const query = useQuery<GetOperatorCheckResponse, Error>({
    queryKey: id
      ? OPERATOR_CHECK_KEYS.detail(id)
      : (["operator-checks", "detail", "__none__"] as const),
    queryFn: async () => {
      const path = `/v1/operator-checks/${encodeURIComponent(id!)}`;
      const value = await callV1<unknown>(path);
      return parseResponse(
        () => GetOperatorCheckResponseSchema.parse(value),
        path,
        200,
      );
    },
    enabled: Boolean(id),
    staleTime: 0,
    refetchInterval: (state) => {
      // A temporary rate limit or network interruption must not strand the
      // automatic run screen. Back off, then resume polling until the saved
      // check reaches a terminal state.
      if (state.state.status === "error") return 5_000;
      const response = state.state.data as GetOperatorCheckResponse | undefined;
      return response && TERMINAL_STATUSES.has(response.check.status)
        ? false
        : 2_000;
    },
    refetchIntervalInBackground: true,
  });

  useEffect(() => {
    const check = query.data?.check;
    if (!check || !TERMINAL_STATUSES.has(check.status)) return;
    const terminalKey = `${check.id}:${check.status}`;
    if (invalidatedTerminal.current === terminalKey) return;
    invalidatedTerminal.current = terminalKey;
    void invalidateOperatorCheckDependents(client);
  }, [client, query.data?.check]);

  return query;
}

/** Load saved reliability checks, newest first. */
export function useOperatorCheckHistory(
  input: { limit?: number; cursor?: string } = {},
) {
  const limit = input.limit ?? 20;
  const params = new URLSearchParams({ limit: String(limit) });
  if (input.cursor) params.set("cursor", input.cursor);

  return useQuery<ListOperatorChecksResponse, Error>({
    queryKey: OPERATOR_CHECK_KEYS.list(limit, input.cursor),
    queryFn: async () => {
      const path = `/v1/operator-checks?${params.toString()}`;
      const value = await callV1<unknown>(path);
      return parseResponse(
        () => ListOperatorChecksResponseSchema.parse(value),
        path,
        200,
      );
    },
    staleTime: 2_000,
  });
}
