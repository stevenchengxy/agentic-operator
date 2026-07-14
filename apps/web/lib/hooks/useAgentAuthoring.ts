"use client";

import {
  DeployAuthoredAgentResponse,
  GenerateAgentPromptResponse,
  type DeployAuthoredAgentBody,
  type GenerateAgentPromptBody,
} from "@agentic/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AGENT_KEYS, COUNT_KEYS, DEPLOYMENT_KEYS, EVENT_KEYS } from "./useStream";
import { tenantHeader } from "./tenant-header";

interface ApiOk<T> {
  ok: true;
  data: T;
}

interface ApiErr {
  ok: false;
  error: { code: string; message: string };
}

async function callV1<T>(path: string, init: RequestInit): Promise<T> {
  const { headers: initHeaders, ...rest } = init;
  const response = await fetch(path, {
    credentials: "same-origin",
    ...rest,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...tenantHeader(),
      ...(initHeaders as Record<string, string> | undefined),
    },
  });
  const body = (await response.json()) as ApiOk<T> | ApiErr;
  if (!body.ok) {
    throw new Error(body.error.message || `${path} failed`);
  }
  return body.data;
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

export type {
  DeployAuthoredAgentBody,
  GenerateAgentPromptBody,
};
