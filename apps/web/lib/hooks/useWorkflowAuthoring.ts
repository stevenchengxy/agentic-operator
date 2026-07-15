"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  GenerateWorkflowResponseSchema,
  ManifestImportCommit,
  WorkflowDetailSchema,
  WorkflowDocumentFoldersResponseSchema,
  WorkflowListResponseSchema,
  WorkflowTemplateCatalogResponseSchema,
  WorkflowValidationResponseSchema,
  type CreateWorkflowBody,
  type GenerateWorkflowBody,
  type SaveWorkflowBody,
  type ValidateWorkflowBody,
  type WorkflowDetail,
} from "@agentic/contracts";
import { z, type ZodType } from "zod";
import { tenantHeader } from "./tenant-header";

interface ApiOk {
  ok: true;
  data: unknown;
}

interface ApiErr {
  ok: false;
  error: { code: string; message: string; hint?: string };
}

async function callV1<T>(
  path: string,
  schema: ZodType<T>,
  init: RequestInit = {},
): Promise<T> {
  const { headers: initialHeaders, ...rest } = init;
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...tenantHeader(),
    ...(initialHeaders as Record<string, string> | undefined),
  };
  if (rest.body != null && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  const response = await fetch(path, {
    credentials: "same-origin",
    ...rest,
    headers,
  });
  const body = (await response.json().catch(() => null)) as
    | ApiOk
    | ApiErr
    | null;
  if (!response.ok || !body || body.ok !== true) {
    const error = body && body.ok === false ? body.error : null;
    throw new Error(
      `${error?.code ?? `HTTP ${response.status}`}: ${error?.message ?? "Request failed"}${error?.hint ? ` — ${error.hint}` : ""}`,
    );
  }
  return schema.parse(body.data);
}

export const WORKFLOW_AUTHORING_KEYS = {
  all: ["workflow-authoring"] as const,
  list: ["workflow-authoring", "list"] as const,
  templates: ["workflow-authoring", "templates"] as const,
  detail: (slug: string) => ["workflow-authoring", "detail", slug] as const,
  folders: ["workflow-authoring", "document-folders"] as const,
};

async function refreshWorkflowQueries(
  client: ReturnType<typeof useQueryClient>,
) {
  await Promise.all([
    client.invalidateQueries({ queryKey: WORKFLOW_AUTHORING_KEYS.all }),
    client.invalidateQueries({ queryKey: ["workflows"] }),
    client.invalidateQueries({ queryKey: ["agents"] }),
    client.invalidateQueries({ queryKey: ["deployments"] }),
  ]);
}

export function useWorkflowTemplates() {
  return useQuery({
    queryKey: WORKFLOW_AUTHORING_KEYS.templates,
    queryFn: () =>
      callV1("/v1/workflow-templates", WorkflowTemplateCatalogResponseSchema),
    staleTime: 60_000,
  });
}

export function useWorkflowCatalog() {
  return useQuery({
    queryKey: WORKFLOW_AUTHORING_KEYS.list,
    queryFn: () => callV1("/v1/workflows", WorkflowListResponseSchema),
    staleTime: 5_000,
  });
}

export function useWorkflowDetail(slug?: string | null) {
  return useQuery({
    queryKey: WORKFLOW_AUTHORING_KEYS.detail(slug ?? "__none__"),
    queryFn: () =>
      callV1(
        `/v1/workflows/${encodeURIComponent(slug!)}`,
        WorkflowDetailSchema,
      ),
    enabled: Boolean(slug),
    staleTime: 3_000,
  });
}

export function useWorkflowDocumentFolders() {
  return useQuery({
    queryKey: WORKFLOW_AUTHORING_KEYS.folders,
    queryFn: () =>
      callV1(
        "/v1/workflow-document-folders",
        WorkflowDocumentFoldersResponseSchema,
      ),
    staleTime: 15_000,
  });
}

export function useGenerateWorkflow() {
  return useMutation({
    mutationFn: (body: GenerateWorkflowBody) =>
      callV1("/v1/workflows/generate", GenerateWorkflowResponseSchema, {
        method: "POST",
        body: JSON.stringify(body),
      }),
  });
}

export function useCreateWorkflow() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateWorkflowBody) =>
      callV1("/v1/workflows", WorkflowDetailSchema, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: async () => refreshWorkflowQueries(client),
  });
}

export function useSaveWorkflow(slug?: string | null) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: SaveWorkflowBody) => {
      if (!slug) throw new Error("workflow slug is required");
      return callV1(
        `/v1/workflows/${encodeURIComponent(slug)}`,
        WorkflowDetailSchema,
        { method: "PUT", body: JSON.stringify(body) },
      );
    },
    onSuccess: async () => refreshWorkflowQueries(client),
  });
}

export function useValidateWorkflow(slug?: string | null) {
  return useMutation({
    mutationFn: (body: ValidateWorkflowBody = {}) => {
      if (!slug) throw new Error("workflow slug is required");
      return callV1(
        `/v1/workflows/${encodeURIComponent(slug)}/validate`,
        WorkflowValidationResponseSchema,
        { method: "POST", body: JSON.stringify(body) },
      );
    },
  });
}

export function usePublishWorkflow(slug?: string | null) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: { versionId?: string; note?: string } = {}) => {
      if (!slug) throw new Error("workflow slug is required");
      return callV1(
        `/v1/workflows/${encodeURIComponent(slug)}/publish`,
        ManifestImportCommit,
        { method: "POST", body: JSON.stringify(body) },
      );
    },
    onSuccess: async () => refreshWorkflowQueries(client),
  });
}

export function useDeleteWorkflow() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (slug: string) =>
      callV1(
        `/v1/workflows/${encodeURIComponent(slug)}`,
        // Keep the tiny response local; no domain contract is needed.
        WorkflowDeleteResponse,
        { method: "DELETE" },
      ),
    onSuccess: async () => refreshWorkflowQueries(client),
  });
}

const WorkflowDeleteResponse = z.object({
  deleted: z.literal(true),
  slug: z.string(),
});

export type { WorkflowDetail };
