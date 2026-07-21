/**
 * useTools — TanStack Query wrapper around GET /v1/tools.
 *
 * Returns the catalog of every globally-registered tool in
 * @agentic/tools, including per-tenant config schema + a copy-paste
 * config example. Used by the portal's Tools view so manifest authors
 * can browse what's available without grepping the codebase.
 */
"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";
import { fetchApiData } from "@/lib/api-response";
import { tenantHeader } from "./tenant-header";

export interface ToolFieldSchema {
  type: string;
  required?: boolean;
  description?: string;
  default?: unknown;
}

export interface ToolCatalogEntry {
  name: string;
  category: string;
  summary: string;
  description?: string;
  /** Shape of the LLM-supplied arguments. */
  argsSchema?: Record<string, ToolFieldSchema>;
  argsExample?: Record<string, unknown>;
  /** Per-tenant config keys from manifest tool_use[].config. */
  configSchema?: Record<string, ToolFieldSchema>;
  configExample?: Record<string, unknown>;
  /** Shape of the success return value. */
  returnsSchema?: Record<string, ToolFieldSchema>;
  returnsExample?: unknown;
  /** Tools this one chains with via ctx.lastResult. */
  chainsWith?: string[];
  aliases?: string[];
  sourcePath: string;
  /** "global" = built-in @agentic/tools; "created" = a persisted declarative 造工具 tool. */
  origin?: "global" | "created";
  /** #SCALE-TOOLS — empirical sandbox effectiveness from tool_stats (present once the tool has run). */
  invoked?: number;
  succeeded?: number;
  successRate?: number;
}

export interface ToolCatalogPayload {
  tools: ToolCatalogEntry[];
  count: number;
  createdCount?: number;
  categories: string[];
}

/** A draft HTTP-tool contract returned by POST /v1/tools/generate-from-doc. */
export interface ToolDraft {
  name?: string;
  method?: string;
  url_template?: string;
  headers?: Record<string, string>;
  body_template?: string;
  side_effect?: string;
  params_schema?: Record<string, unknown>;
  returns_schema?: Record<string, unknown>;
  auth_hint?: string;
  confidence?: number;
  notes?: string;
}

export interface SaveToolBody {
  name: string;
  description?: string;
  method?: string;
  url_template?: string;
  headers?: Record<string, string>;
  body_template?: string;
  side_effect?: string;
  params_schema?: Record<string, unknown>;
  returns_schema?: Record<string, unknown>;
  shared?: boolean;
}

async function callV1<T>(path: string): Promise<T> {
  return fetchApiData<T>(path, {
    credentials: "same-origin",
    headers: { Accept: "application/json", ...tenantHeader() },
  });
}

async function sendV1<T>(
  path: string,
  method: "POST" | "DELETE",
  payload?: unknown,
): Promise<T> {
  return fetchApiData<T>(path, {
    method,
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      ...(payload !== undefined ? { "Content-Type": "application/json" } : {}),
      ...tenantHeader(),
    },
    body: payload !== undefined ? JSON.stringify(payload) : undefined,
  });
}

export function useTools(): UseQueryResult<ToolCatalogPayload> {
  return useQuery({
    queryKey: ["tools", "catalog"] as const,
    queryFn: () => callV1<ToolCatalogPayload>("/v1/tools"),
    // The catalog is process-stable (boot-time registry) — refetch on
    // window focus is wasteful. 5 minutes is generous; the operator can
    // hard-refresh if the api ships a new tool.
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
}

/** Tool-Smith: fetch a public API doc (or take pasted text) and LLM-extract a draft contract. */
export function useGenerateToolFromDoc() {
  return useMutation({
    mutationFn: (body: { url?: string; text?: string; intent: string }) =>
      sendV1<{ draft: ToolDraft }>("/v1/tools/generate-from-doc", "POST", body),
  });
}

/** Save a declarative tool to the shared library (then refresh the catalog). */
export function useSaveTool() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: SaveToolBody) =>
      sendV1<{ saved: boolean; name: string }>("/v1/tools", "POST", body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tools", "catalog"] }),
  });
}

/** Delete a created tool (built-in globals are not deletable). */
export function useDeleteTool() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      sendV1<{ deleted: boolean }>(
        `/v1/tools/${encodeURIComponent(name)}`,
        "DELETE",
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tools", "catalog"] }),
  });
}
