"use client";

import {
  AgentNameAvailabilityResponse,
  DeployAuthoredAgentResponse,
  GenerateAgentPromptResponse,
  type DeployAuthoredAgentBody,
  type GenerateAgentPromptBody,
} from "@agentic/contracts";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AGENT_KEYS,
  COUNT_KEYS,
  DEPLOYMENT_KEYS,
  EVENT_KEYS,
} from "./useStream";
import { tenantHeader } from "./tenant-header";
import { readAgentAuthoringResponse } from "./agent-authoring-response";

async function callV1<T>(path: string, init: RequestInit): Promise<T> {
  const { headers: initHeaders, ...rest } = init;
  let response: Response;
  try {
    response = await fetch(path, {
      credentials: "same-origin",
      ...rest,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...tenantHeader(),
        ...(initHeaders as Record<string, string> | undefined),
      },
    });
  } catch {
    throw new Error(
      "Could not reach the agent authoring service. Check the connection and retry.",
    );
  }
  return readAgentAuthoringResponse<T>(response, path);
}

export const AGENT_NAME_AVAILABILITY_DEBOUNCE_MS = 400;

/**
 * Check the canonical tenant manifest before the user leaves Identity.
 *
 * The returned `isChecking` includes the debounce window as well as the
 * network request, so callers never briefly enable progression for a name
 * that has not actually been checked yet.
 */
export function useAgentNameAvailability(name: string, enabled: boolean) {
  const requestedName = enabled ? name.trim() : "";
  const [debouncedName, setDebouncedName] = useState("");

  useEffect(() => {
    if (!requestedName) {
      setDebouncedName("");
      return;
    }
    const timer = window.setTimeout(
      () => setDebouncedName(requestedName),
      AGENT_NAME_AVAILABILITY_DEBOUNCE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [requestedName]);

  const query = useQuery({
    queryKey: ["agents", "availability", debouncedName] as const,
    queryFn: async () =>
      AgentNameAvailabilityResponse.parse(
        await callV1<unknown>(
          `/v1/agents/availability?name=${encodeURIComponent(debouncedName)}`,
          { method: "GET" },
        ),
      ),
    enabled: debouncedName.length > 0,
    // Availability is a pre-flight invariant, not durable catalog data. Mark
    // every cached result stale so revisiting a name rechecks the live
    // manifest instead of trusting an earlier answer.
    staleTime: 0,
    retry: 1,
  });

  const isCurrent = requestedName.length > 0 && requestedName === debouncedName;
  const data =
    isCurrent && query.data?.name === requestedName ? query.data : undefined;
  const isChecking =
    requestedName.length > 0 &&
    (!isCurrent || query.isPending || query.isFetching);

  return {
    ...query,
    data,
    isChecking,
    // An error for a stale, superseded name must not flash under the current
    // value while its debounce timer is still running.
    isError: isCurrent && query.isError,
    error: isCurrent ? query.error : null,
  };
}

export function useGenerateAgentPrompt() {
  return useMutation({
    mutationFn: async (body: GenerateAgentPromptBody) =>
      GenerateAgentPromptResponse.parse(
        await callV1<unknown>("/v1/agents/system-prompt", {
          method: "POST",
          body: JSON.stringify(body),
        }),
      ),
  });
}

export function useDeployAuthoredAgent() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (body: DeployAuthoredAgentBody) =>
      DeployAuthoredAgentResponse.parse(
        await callV1<unknown>("/v1/agents/deploy", {
          method: "POST",
          body: JSON.stringify(body),
        }),
      ),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: AGENT_KEYS.all });
      void client.invalidateQueries({ queryKey: COUNT_KEYS.tenant });
      void client.invalidateQueries({ queryKey: ["workflows"] as const });
      void client.invalidateQueries({ queryKey: DEPLOYMENT_KEYS.list });
      void client.invalidateQueries({ queryKey: EVENT_KEYS.all });
    },
  });
}

export type { DeployAuthoredAgentBody, GenerateAgentPromptBody };
