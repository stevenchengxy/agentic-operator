"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AgentDraftResponseSchema,
  AgentEditorResponseSchema,
  CreateAgentDraftBodySchema,
  CreateAgentRunBodySchema,
  CreateAgentRunResponseSchema,
  GenerateDraftInstructionsBodySchema,
  GenerateDraftInstructionsResponseSchema,
  GetRunTraceResponseSchema,
  ListAgentRunsResponseSchema,
  ListAgentVersionsResponseSchema,
  PatchAgentDraftBodySchema,
  PublishAgentDraftBodySchema,
  PublishAgentDraftResponseSchema,
  RunOutputResponseSchema,
  ValidateAgentDraftResponseSchema,
  type AgentDraftRecord,
  type AgentEditorResponse as ContractAgentEditorResponse,
  type AgentRunHistoryRow,
  type AgentValidationIssue,
  type AgentVersionSummary,
  type CreateAgentRunBody as ContractCreateAgentRunBody,
  type CreateAgentRunResponse as ContractCreateAgentRunResponse,
  type GenerateDraftInstructionsBody as ContractGenerateDraftInstructionsBody,
  type GenerateDraftInstructionsResponse as ContractGenerateDraftInstructionsResponse,
  type GetRunTraceResponse as ContractGetRunTraceResponse,
  type PublishAgentDraftResponse as ContractPublishAgentDraftResponse,
  type RunOutputResponse as ContractRunOutputResponse,
  type RunTraceEvent as ContractRunTraceEvent,
} from "@agentic/contracts";
import { tenantHeader } from "./tenant-header";
import type { StudioDefinition } from "@/app/portal/components/agent-studio/model";

interface ApiOk<T> {
  ok: true;
  data: T;
}

interface ApiErr {
  ok: false;
  error: {
    code: string;
    message: string;
    hint?: string;
    details?: unknown;
  };
}

export class AgentStudioApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly hint?: string;
  readonly details?: unknown;

  constructor(args: {
    status: number;
    code: string;
    message: string;
    hint?: string;
    details?: unknown;
  }) {
    super(args.message);
    this.name = "AgentStudioApiError";
    this.status = args.status;
    this.code = args.code;
    this.hint = args.hint;
    this.details = args.details;
  }
}

async function callV1<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { headers: initHeaders, ...rest } = init;
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...tenantHeader(),
    ...(initHeaders as Record<string, string> | undefined),
  };
  if (
    rest.body !== undefined &&
    rest.body !== null &&
    !headers["Content-Type"]
  ) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(path, {
    credentials: "same-origin",
    ...rest,
    headers,
  });
  let body: ApiOk<T> | ApiErr | null = null;
  try {
    body = (await response.json()) as ApiOk<T> | ApiErr;
  } catch {
    if (!response.ok) {
      throw new AgentStudioApiError({
        status: response.status,
        code: `http_${response.status}`,
        message: `${path}: HTTP ${response.status}`,
      });
    }
  }

  if (!response.ok || (body && !body.ok)) {
    const error = body && !body.ok ? body.error : null;
    throw new AgentStudioApiError({
      status: response.status,
      code: error?.code ?? `http_${response.status}`,
      message: error?.message ?? `${path}: HTTP ${response.status}`,
      hint: error?.hint,
      details: error?.details,
    });
  }

  if (!body || !body.ok) {
    throw new AgentStudioApiError({
      status: response.status,
      code: "invalid_response",
      message: `${path}: expected a JSON API envelope`,
    });
  }
  return body.data;
}

export type AgentEditorResponse = ContractAgentEditorResponse;
export type AgentStudioDraft = AgentDraftRecord;
export type StudioValidationIssue = AgentValidationIssue;
export type GenerateInstructionsRequest = ContractGenerateDraftInstructionsBody;
export type GenerateInstructionsResponse =
  ContractGenerateDraftInstructionsResponse;
export type PublishDraftResponse = ContractPublishAgentDraftResponse;
export type CreateAgentRunRequest = ContractCreateAgentRunBody;
export type CreateAgentRunResponse = ContractCreateAgentRunResponse;

export type AgentStudioRunRow = AgentRunHistoryRow;

export interface AgentRunHistoryPage {
  items: AgentStudioRunRow[];
  nextCursor: string | null;
}

export type AgentVersionRow = AgentVersionSummary;

export interface AgentVersionPage {
  items: AgentVersionRow[];
  nextCursor: string | null;
}

export type RunTraceEvent = ContractRunTraceEvent;
export type RunTracePage = ContractGetRunTraceResponse;
export type RunOutputResponse = ContractRunOutputResponse;

export const AGENT_STUDIO_KEYS = {
  all: ["agent-studio"] as const,
  editor: (id: string, draftId?: string | null) =>
    ["agent-studio", "editor", id, draftId ?? "current"] as const,
  history: (id: string, query: string) =>
    ["agent-studio", "history", id, query] as const,
  versions: (id: string, query: string) =>
    ["agent-studio", "versions", id, query] as const,
  trace: (runId: string, after: number) =>
    ["agent-studio", "trace", runId, after] as const,
  output: (runId: string) => ["agent-studio", "output", runId] as const,
};

function prepareDefinition(definition: StudioDefinition): unknown {
  const value = JSON.parse(JSON.stringify(definition)) as Record<
    string,
    unknown
  >;
  if (value.provider === "") delete value.provider;
  if (value.model === "") delete value.model;
  if (value.cron === "") value.cron = null;
  if (value.cron_timezone === "") value.cron_timezone = null;
  return value;
}

export function useAgentEditor(
  agentId: string | null | undefined,
  draftId?: string | null,
) {
  const query = draftId ? `?draftId=${encodeURIComponent(draftId)}` : "";
  return useQuery({
    queryKey: agentId
      ? AGENT_STUDIO_KEYS.editor(agentId, draftId)
      : (["agent-studio", "editor", "__none__"] as const),
    queryFn: async () =>
      AgentEditorResponseSchema.parse(
        await callV1<unknown>(
          `/v1/agents/${encodeURIComponent(agentId!)}/editor${query}`,
        ),
      ),
    enabled: Boolean(agentId),
    staleTime: 2_000,
  });
}

export function useCreateAgentDraft(agentId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (body: {
      definition?: StudioDefinition;
      baseAgentVersionId?: string;
      baseWorkflowVersionId?: string;
    }) => {
      const payload = CreateAgentDraftBodySchema.parse({
        ...body,
        ...(body.definition
          ? { definition: prepareDefinition(body.definition) }
          : {}),
      });
      return AgentDraftResponseSchema.parse(
        await callV1<unknown>(
          `/v1/agents/${encodeURIComponent(agentId)}/drafts`,
          {
            method: "POST",
            body: JSON.stringify(payload),
          },
        ),
      );
    },
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: AGENT_STUDIO_KEYS.all });
    },
  });
}

export function useSaveAgentDraft(draftId: string | null | undefined) {
  return useMutation({
    mutationFn: async (vars: {
      definition: StudioDefinition;
      revision: number;
    }) => {
      if (!draftId) throw new Error("Create a draft before saving changes.");
      const payload = PatchAgentDraftBodySchema.parse({
        definition: prepareDefinition(vars.definition),
      });
      return AgentDraftResponseSchema.parse(
        await callV1<unknown>(
          `/v1/agent-drafts/${encodeURIComponent(draftId)}`,
          {
            method: "PATCH",
            headers: { "If-Match": String(vars.revision) },
            body: JSON.stringify(payload),
          },
        ),
      );
    },
  });
}

export function useValidateAgentDraft(
  agentId: string,
  draftId: string | null | undefined,
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => {
      if (!draftId) throw new Error("Create a draft before validating it.");
      return callV1<unknown>(
        `/v1/agent-drafts/${encodeURIComponent(draftId)}/validate`,
        { method: "POST" },
      ).then((value) => ValidateAgentDraftResponseSchema.parse(value));
    },
    onSuccess: async () => {
      await client.invalidateQueries({
        queryKey: ["agent-studio", "editor", agentId],
      });
    },
  });
}

export function useGenerateDraftInstructions(
  draftId: string | null | undefined,
) {
  return useMutation({
    mutationFn: async (body: GenerateInstructionsRequest) => {
      if (!draftId)
        throw new Error("Create a draft before generating instructions.");
      const payload = GenerateDraftInstructionsBodySchema.parse(body);
      return GenerateDraftInstructionsResponseSchema.parse(
        await callV1<unknown>(
          `/v1/agent-drafts/${encodeURIComponent(draftId)}/generate-instructions`,
          { method: "POST", body: JSON.stringify(payload) },
        ),
      );
    },
  });
}

export function usePublishAgentDraft(
  agentId: string,
  draftId: string | null | undefined,
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (
      body: { note?: string; confirmImpact?: boolean } = {},
    ) => {
      if (!draftId) throw new Error("Create a draft before publishing it.");
      const payload = PublishAgentDraftBodySchema.parse(body);
      return PublishAgentDraftResponseSchema.parse(
        await callV1<unknown>(
          `/v1/agent-drafts/${encodeURIComponent(draftId)}/publish`,
          { method: "POST", body: JSON.stringify(payload) },
        ),
      );
    },
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: AGENT_STUDIO_KEYS.all }),
        client.invalidateQueries({ queryKey: ["agents"] }),
        client.invalidateQueries({ queryKey: ["workflows"] }),
        client.invalidateQueries({ queryKey: ["deployments"] }),
      ]);
    },
  });
}

export function useCreateAgentRun(agentId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (body: CreateAgentRunRequest) => {
      const payload = CreateAgentRunBodySchema.parse(body);
      return CreateAgentRunResponseSchema.parse(
        await callV1<unknown>(
          `/v1/agents/${encodeURIComponent(agentId)}/runs`,
          {
            method: "POST",
            body: JSON.stringify(payload),
          },
        ),
      );
    },
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({
          queryKey: ["agent-studio", "history", agentId],
        }),
        client.invalidateQueries({ queryKey: ["runs"] }),
      ]);
    },
  });
}

export interface AgentRunHistoryFilter {
  cursor?: string;
  versionId?: string;
  sessionId?: string;
  source?: string;
  status?: string;
  limit?: number;
}

function makeQuery(input: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined && value !== "") params.set(key, String(value));
  }
  return params.toString();
}

export function useAgentRunHistory(
  agentId: string | null | undefined,
  filter: AgentRunHistoryFilter = {},
) {
  const query = makeQuery({ ...filter, limit: filter.limit ?? 30 });
  return useQuery({
    queryKey: agentId
      ? AGENT_STUDIO_KEYS.history(agentId, query)
      : (["agent-studio", "history", "__none__"] as const),
    queryFn: async () => {
      const data = ListAgentRunsResponseSchema.parse(
        await callV1<unknown>(
          `/v1/agents/${encodeURIComponent(agentId!)}/runs${query ? `?${query}` : ""}`,
        ),
      );
      return { items: data.runs, nextCursor: data.nextCursor };
    },
    enabled: Boolean(agentId),
    staleTime: 2_000,
    refetchInterval: (queryState) => {
      const page = queryState.state.data as AgentRunHistoryPage | undefined;
      return page?.items.some(
        (run) => !["ok", "failed", "cancelled"].includes(run.status),
      )
        ? 1_500
        : false;
    },
  });
}

export function useAgentVersions(
  agentId: string | null | undefined,
  cursor?: string,
) {
  const query = makeQuery({ cursor, limit: 30 });
  return useQuery({
    queryKey: agentId
      ? AGENT_STUDIO_KEYS.versions(agentId, query)
      : (["agent-studio", "versions", "__none__"] as const),
    queryFn: async () => {
      const data = ListAgentVersionsResponseSchema.parse(
        await callV1<unknown>(
          `/v1/agents/${encodeURIComponent(agentId!)}/versions${query ? `?${query}` : ""}`,
        ),
      );
      return { items: data.versions, nextCursor: data.nextCursor };
    },
    enabled: Boolean(agentId),
    staleTime: 5_000,
  });
}

export function useRunTrace(
  runId: string | null | undefined,
  after = 0,
  live = false,
) {
  const query = makeQuery({ after, limit: 1_000 });
  return useQuery({
    queryKey: runId
      ? AGENT_STUDIO_KEYS.trace(runId, after)
      : (["agent-studio", "trace", "__none__"] as const),
    queryFn: async () =>
      GetRunTraceResponseSchema.parse(
        await callV1<unknown>(
          `/v1/runs/${encodeURIComponent(runId!)}/trace${query ? `?${query}` : ""}`,
        ),
      ),
    enabled: Boolean(runId),
    staleTime: live ? 0 : 2_000,
    refetchInterval: live ? 1_500 : false,
  });
}

export function useRunOutput(runId: string | null | undefined, live = false) {
  return useQuery({
    queryKey: runId
      ? AGENT_STUDIO_KEYS.output(runId)
      : (["agent-studio", "output", "__none__"] as const),
    queryFn: async () =>
      RunOutputResponseSchema.parse(
        await callV1<unknown>(`/v1/runs/${encodeURIComponent(runId!)}/output`),
      ),
    enabled: Boolean(runId),
    retry: (count, error) => {
      if (error instanceof AgentStudioApiError && error.status === 404)
        return count < 10;
      return count < 2;
    },
    retryDelay: 1_000,
    refetchInterval: live ? 1_500 : false,
  });
}
