"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ApiTokenSecret,
  ListApiTokensResponse,
  RevokeApiTokenResponse,
  type ApiTokenPublic,
  type CreateApiTokenBody,
} from "@agentic/contracts";
import type { ZodType } from "zod";
import { tenantHeader } from "./tenant-header";

interface ApiOk {
  ok: true;
  data: unknown;
}

interface ApiErr {
  ok: false;
  error: { code: string; message: string };
}

async function callV1<T>(
  path: string,
  schema: ZodType<T>,
  init: RequestInit = {},
): Promise<T> {
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
  const body = (await response.json()) as ApiOk | ApiErr;
  if (!body.ok) {
    throw new Error(`${body.error.code}: ${body.error.message}`);
  }
  return schema.parse(body.data);
}

function listKey() {
  const tenant = tenantHeader()["x-agentic-tenant"] ?? "session-tenant";
  return ["api-tokens", "list", tenant] as const;
}

const API_TOKEN_KEYS = {
  lists: ["api-tokens", "list"] as const,
};

export function useApiTokens() {
  return useQuery({
    queryKey: listKey(),
    queryFn: () => callV1("/v1/api-tokens", ListApiTokensResponse),
    staleTime: 10_000,
  });
}

export function useCreateApiToken() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateApiTokenBody) =>
      callV1("/v1/api-tokens", ApiTokenSecret, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: API_TOKEN_KEYS.lists });
    },
  });
}

export function useRotateApiToken() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: ApiTokenPublic["id"]) =>
      callV1(
        `/v1/api-tokens/${encodeURIComponent(id)}/rotate`,
        ApiTokenSecret,
        { method: "POST" },
      ),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: API_TOKEN_KEYS.lists });
    },
  });
}

export function useRevokeApiToken() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: ApiTokenPublic["id"]) =>
      callV1(
        `/v1/api-tokens/${encodeURIComponent(id)}`,
        RevokeApiTokenResponse,
        { method: "DELETE" },
      ),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: API_TOKEN_KEYS.lists });
    },
  });
}

export type { ApiTokenPublic };
