/**
 * OntoCode — thin API layer over the factory endpoints.
 *
 * Same transport rules as the factory page: tenant header on every call, the
 * shared `decodeFactoryResponse` envelope decoder, and no JSON content-type on
 * empty bodies (Fastify rejects `content-type: application/json` + empty body).
 */

import type { Translate } from "@/app/portal/lib/preferences-context";
import { tenantHeader } from "@/lib/hooks/tenant-header";
import {
  buildHumanInteractionSubmission,
  decodeFactoryResponse,
  factoryNetworkFailure,
  type FactoryApiResult,
  type HumanInteractionKind,
} from "../factory/factory-api";
import {
  isFactoryRunStartReceipt,
  type FactoryRunStartReceipt,
} from "../factory/factory-run-start";
import type { RunRow } from "../factory/model";

function tenantHeaders(tenant: string): Record<string, string> {
  return { ...tenantHeader(), "x-agentic-tenant": tenant };
}

export async function ocGet<T>(
  t: Translate,
  tenant: string,
  path: string,
): Promise<FactoryApiResult<T>> {
  try {
    const response = await fetch(path, {
      credentials: "same-origin",
      headers: { Accept: "application/json", ...tenantHeaders(tenant) },
    });
    return await decodeFactoryResponse<T>(t, response);
  } catch (error) {
    return factoryNetworkFailure(t, error);
  }
}

export async function ocSend<T>(
  t: Translate,
  tenant: string,
  path: string,
  method: "POST" | "PUT" | "PATCH" | "DELETE",
  body?: unknown,
): Promise<FactoryApiResult<T>> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...tenantHeaders(tenant),
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  try {
    const response = await fetch(path, {
      method,
      credentials: "same-origin",
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return await decodeFactoryResponse<T>(t, response);
  } catch (error) {
    return factoryNetworkFailure(t, error);
  }
}

export async function startFactoryRun(
  t: Translate,
  tenant: string,
  input: { domain: string; goal: string; conversation?: string },
): Promise<FactoryApiResult<FactoryRunStartReceipt>> {
  const result = await ocSend<FactoryRunStartReceipt>(
    t,
    tenant,
    "/v1/agent-factory/runs/start",
    "POST",
    {
      domain: input.domain,
      goal: input.goal,
      ...(input.conversation ? { conversation: input.conversation } : {}),
    },
  );
  if (result.ok && !isFactoryRunStartReceipt(result.data)) {
    return { ok: false, status: result.status, message: "start receipt malformed" };
  }
  return result;
}

/** Answer a parked gate. The wire tags live in oc-model (byte-identical to factory). */
export async function injectGateAnswer(
  t: Translate,
  tenant: string,
  input: {
    conversation: string;
    interactionId: string;
    kind: HumanInteractionKind;
    text: string;
  },
): Promise<FactoryApiResult<unknown>> {
  const submission = buildHumanInteractionSubmission(t, input);
  return ocSend(t, tenant, "/v1/agent-factory/inject", "POST", submission);
}

export async function fetchFactoryRuns(
  t: Translate,
  tenant: string,
  domain: string,
): Promise<FactoryApiResult<{ runs: RunRow[] }>> {
  return ocGet<{ runs: RunRow[] }>(
    t,
    tenant,
    `/v1/agent-factory/runs?domain=${encodeURIComponent(domain)}`,
  );
}
