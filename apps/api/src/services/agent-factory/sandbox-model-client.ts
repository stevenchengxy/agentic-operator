import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  SANDBOX_MODEL_USAGE_SCHEMA,
  sandboxModelUsageEvidenceHash,
  type SandboxModelUsageEvidence,
} from "@agentic/agent-factory";
import type { ChatRequest, ChatResponse, LLMGateway } from "@agentic/llm-gateway";
import {
  SANDBOX_MODEL_MAX_CALLS_HEADER,
  SANDBOX_MODEL_MAX_TOTAL_HEADER,
  SANDBOX_MODEL_RESERVATION_HEADER,
  SANDBOX_MODEL_RESPONSE_SIGNATURE_HEADER,
  sandboxModelRequestDigest,
  verifySandboxModelResponseSignature,
} from "./sandbox-model-protocol";

interface SandboxModelExecutionContext {
  sandboxTenantSlug: string;
  attemptId: string;
  bundleHash: string;
  targetTenantId: string;
  targetTenantSlug: string;
  maxCalls: number;
  maxTotalTokens: number;
}

interface ActiveSandboxModelExecutionContext extends SandboxModelExecutionContext {
  startedAt: string;
  calls: Array<{
    status: "succeeded" | "failed" | "rejected";
    reservation: number;
    agentRef: string;
    reasonCode?: string;
    response?: ChatResponse;
  }>;
}

const contexts = new Map<string, ActiveSandboxModelExecutionContext>();
function agentRef(request: ChatRequest): string {
  const match = request.purpose?.match(/^agent:([^/]{1,200})\//);
  const value = match?.[1]?.replace(/[^A-Za-z0-9._:-]/g, "-").slice(0, 200);
  return value || "unattributed";
}

function responseErrorCode(body: unknown, fallback: string): string {
  const value = body && typeof body === "object" && !Array.isArray(body)
    ? (body as { error?: { code?: unknown } }).error?.code
    : undefined;
  return (typeof value === "string" ? value : fallback)
    .replace(/[^A-Za-z0-9_:-]/g, "_")
    .slice(0, 100);
}

function requiredSecret(env: NodeJS.ProcessEnv): string {
  const direct = env.SANDBOX_MODEL_PROXY_TOKEN?.trim();
  const file = env.SANDBOX_MODEL_PROXY_TOKEN_FILE?.trim();
  if (direct && file) throw new Error("SANDBOX_MODEL_PROXY_TOKEN and *_FILE cannot both be set");
  const value = direct || (file ? readFileSync(file, "utf8").trim() : "");
  if (Buffer.byteLength(value, "utf8") < 32) {
    throw new Error("SANDBOX_MODEL_PROXY_TOKEN(_FILE) must contain at least 32 bytes");
  }
  return value;
}

function requiredOrigin(env: NodeJS.ProcessEnv): string {
  const raw = env.SANDBOX_MODEL_PROXY_ORIGIN?.trim();
  if (!raw) throw new Error("SANDBOX_MODEL_PROXY_ORIGIN is required for semantic sandbox execution");
  const url = new URL(raw);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("SANDBOX_MODEL_PROXY_ORIGIN must be a credential-free origin");
  }
  const trustedPlainHttpRole = env.AGENTIC_PROCESS_ROLE === "sandbox-runner-workload"
    && env.SANDBOX_RUNNER_EGRESS_MODE === "deny_all";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && (
    env.NODE_ENV === "test" || trustedPlainHttpRole
  ))) {
    throw new Error("Plain HTTP model proxy is allowed only inside the deny-all sandbox workload network");
  }
  if (url.protocol === "http:" && trustedPlainHttpRole) {
    const allowed = new Set((env.SANDBOX_MODEL_PROXY_HTTP_ALLOWED_HOSTS ?? "")
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean));
    if (!allowed.size || !allowed.has(url.hostname.toLowerCase())) {
      throw new Error("Plain HTTP model proxy host is not in SANDBOX_MODEL_PROXY_HTTP_ALLOWED_HOSTS");
    }
  }
  return url.origin;
}

function validateResponse(value: unknown): ChatResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Sandbox model proxy returned an invalid response");
  }
  const row = value as Record<string, unknown>;
  if (
    typeof row.text !== "string"
    || Buffer.byteLength(row.text, "utf8") > 2 * 1024 * 1024
    || typeof row.provider !== "string"
    || !row.provider.trim()
    || row.provider.length > 100
    || typeof row.model !== "string"
    || !row.model.trim()
    || row.model.length > 300
    || typeof row.latencyMs !== "number"
    || !Number.isFinite(row.latencyMs)
    || row.latencyMs < 0
    || ![row.tokensIn, row.tokensOut].every((token) =>
      token === null || (Number.isSafeInteger(token) && (token as number) >= 0))
    || !["stop", "length", "tool_calls", "error", "unknown"].includes(String(row.finishReason))
  ) {
    throw new Error("Sandbox model proxy response contract is invalid");
  }
  if (row.toolCalls !== undefined) {
    if (!Array.isArray(row.toolCalls)) throw new Error("Sandbox model proxy tool-call contract is invalid");
    let encoded: string;
    try {
      encoded = JSON.stringify(row.toolCalls);
    } catch {
      throw new Error("Sandbox model proxy tool-call contract is invalid");
    }
    if (Buffer.byteLength(encoded, "utf8") > 2 * 1024 * 1024) {
      throw new Error("Sandbox model proxy tool-call contract is too large");
    }
  }
  return {
    text: row.text,
    provider: row.provider as ChatResponse["provider"],
    model: row.model,
    tokensIn: row.tokensIn as number | null,
    tokensOut: row.tokensOut as number | null,
    finishReason: row.finishReason as ChatResponse["finishReason"],
    latencyMs: row.latencyMs,
    ...(row.toolCalls !== undefined
      ? { toolCalls: row.toolCalls as NonNullable<ChatResponse["toolCalls"]> }
      : {}),
  };
}

function positiveHeader(response: Response, name: string): number | null {
  const raw = response.headers.get(name);
  if (!raw || !/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function finishEvidence(context: ActiveSandboxModelExecutionContext): SandboxModelUsageEvidence {
  const succeeded = context.calls.filter((call) => call.status === "succeeded");
  const failed = context.calls.filter((call) => call.status === "failed");
  const rejected = context.calls.filter((call) => call.status === "rejected");
  const measured = succeeded.every((call) =>
    Number.isSafeInteger(call.response?.tokensIn)
    && (call.response?.tokensIn ?? -1) >= 0
    && Number.isSafeInteger(call.response?.tokensOut)
    && (call.response?.tokensOut ?? -1) >= 0);
  const providerModels = [...new Map(succeeded.map((call) => [
    `${call.response!.provider}\u0000${call.response!.model}`,
    { provider: call.response!.provider, model: call.response!.model },
  ])).values()].sort((left, right) =>
    `${left.provider}\u0000${left.model}`.localeCompare(`${right.provider}\u0000${right.model}`));
  const sum = (field: "tokensIn" | "tokensOut") => succeeded.reduce(
    (total, call) => total + (call.response?.[field] ?? 0),
    0,
  );
  const inputTokens = measured ? sum("tokensIn") : null;
  const outputTokens = measured ? sum("tokensOut") : null;
  const byAgent = new Map<string, typeof context.calls>();
  for (const call of context.calls) {
    const bucket = byAgent.get(call.agentRef) ?? [];
    bucket.push(call);
    byAgent.set(call.agentRef, bucket);
  }
  const agentCalls = [...byAgent.entries()].map(([ref, calls]) => ({
    agentRef: ref,
    calls: calls.length,
    successfulCalls: calls.filter((call) => call.status === "succeeded").length,
    failedCalls: calls.filter((call) => call.status === "failed").length,
    rejectedCalls: calls.filter((call) => call.status === "rejected").length,
  })).sort((left, right) => left.agentRef.localeCompare(right.agentRef));
  const rejectedMap = new Map<string, { agentRef: string; reasonCode: string; count: number }>();
  for (const call of rejected) {
    const reasonCode = call.reasonCode ?? "rejected";
    const key = `${call.agentRef}\u0000${reasonCode}`;
    const existing = rejectedMap.get(key);
    rejectedMap.set(key, existing
      ? { ...existing, count: existing.count + 1 }
      : { agentRef: call.agentRef, reasonCode, count: 1 });
  }
  const body: Omit<SandboxModelUsageEvidence, "evidenceHash"> = {
    schema: SANDBOX_MODEL_USAGE_SCHEMA,
    sandboxAttemptId: context.attemptId,
    bundleHash: context.bundleHash,
    targetTenantId: context.targetTenantId,
    targetTenantSlug: context.targetTenantSlug,
    calls: context.calls.length,
    successfulCalls: succeeded.length,
    failedCalls: failed.length,
    rejectedCalls: rejected.length,
    agentCalls,
    rejectedReasons: [...rejectedMap.values()].sort((left, right) =>
      `${left.agentRef}\u0000${left.reasonCode}`.localeCompare(`${right.agentRef}\u0000${right.reasonCode}`)),
    providerModels,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens === null || outputTokens === null
      ? null
      : inputTokens + outputTokens,
    budget: {
      enforced: true,
      maxCalls: context.maxCalls,
      maxTotalTokens: context.maxTotalTokens,
      reservedTotalTokens: context.calls.reduce((total, call) => total + call.reservation, 0),
    },
    startedAt: context.startedAt,
    completedAt: new Date().toISOString(),
  };
  return { ...body, evidenceHash: sandboxModelUsageEvidenceHash(body) };
}

export function installSandboxModelExecutionContext(input: SandboxModelExecutionContext): () => SandboxModelUsageEvidence {
  if (contexts.has(input.sandboxTenantSlug)) throw new Error("sandbox model context collision");
  if (
    !Number.isSafeInteger(input.maxCalls)
    || input.maxCalls < 1
    || !Number.isSafeInteger(input.maxTotalTokens)
    || input.maxTotalTokens < 1
  ) {
    throw new Error("sandbox model context has no bounded call/token budget");
  }
  const context: ActiveSandboxModelExecutionContext = {
    ...input,
    startedAt: new Date().toISOString(),
    calls: [],
  };
  contexts.set(input.sandboxTenantSlug, context);
  return () => {
    if (contexts.get(input.sandboxTenantSlug) !== context) {
      throw new Error("sandbox model context is no longer active");
    }
    contexts.delete(input.sandboxTenantSlug);
    return finishEvidence(context);
  };
}

export function clearSandboxModelExecutionContexts(): void {
  contexts.clear();
}

export function createSandboxModelProxyGateway(
  env: NodeJS.ProcessEnv = process.env,
  fetchFn: typeof fetch = fetch,
): LLMGateway {
  const origin = requiredOrigin(env);
  const token = requiredSecret(env);
  return {
    async chat(request: ChatRequest): Promise<ChatResponse> {
      const sandboxSlug = request.tenantSlug?.trim();
      const context = sandboxSlug ? contexts.get(sandboxSlug) : undefined;
      if (!context) throw new Error("No active model grant exists for this sandbox tenant");
      const signal = request.signal
        ? AbortSignal.any([request.signal, AbortSignal.timeout(65_000)])
        : AbortSignal.timeout(65_000);
      const ref = agentRef(request);
      const requestId = randomUUID();
      const proxyRequest = {
        messages: request.messages,
        purpose: request.purpose,
        tools: request.tools,
        maxTokens: request.maxTokens,
        temperature: request.temperature,
        jsonMode: request.jsonMode,
        stop: request.stop,
        timeoutMs: request.timeoutMs,
      };
      const requestDigest = sandboxModelRequestDigest({
        attemptId: context.attemptId,
        bundleHash: context.bundleHash,
        targetTenantId: context.targetTenantId,
        targetTenantSlug: context.targetTenantSlug,
        requestId,
        request: proxyRequest,
      });
      let response: Response;
      try {
        response = await fetchFn(`${origin}/internal/factory-sandbox/model/chat`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            attemptId: context.attemptId,
            bundleHash: context.bundleHash,
            tenantId: context.targetTenantId,
            tenantSlug: context.targetTenantSlug,
            requestId,
            request: proxyRequest,
          }),
          signal,
        });
      } catch (error) {
        context.calls.push({ status: "rejected", reservation: 0, agentRef: ref, reasonCode: "proxy_unreachable" });
        throw error;
      }
      const reservation = positiveHeader(response, SANDBOX_MODEL_RESERVATION_HEADER);
      const maxCalls = positiveHeader(response, SANDBOX_MODEL_MAX_CALLS_HEADER);
      const maxTotalTokens = positiveHeader(response, SANDBOX_MODEL_MAX_TOTAL_HEADER);
      const admitted = reservation !== null
        && maxCalls === context.maxCalls
        && maxTotalTokens === context.maxTotalTokens;
      let body: unknown;
      try {
        body = await response.json() as unknown;
      } catch {
        context.calls.push({
          status: admitted ? "failed" : "rejected",
          reservation: reservation ?? 0,
          agentRef: ref,
          reasonCode: "invalid_proxy_response",
        });
        throw new Error("model proxy returned non-JSON data");
      }
      const signatureValid = maxCalls !== null
        && maxTotalTokens !== null
        && verifySandboxModelResponseSignature(
          response.headers.get(SANDBOX_MODEL_RESPONSE_SIGNATURE_HEADER),
          token,
          {
            attemptId: context.attemptId,
            bundleHash: context.bundleHash,
            targetTenantId: context.targetTenantId,
            targetTenantSlug: context.targetTenantSlug,
            requestDigest,
            statusCode: response.status,
            reservation,
            maxCalls,
            maxTotalTokens,
            body,
          },
        );
      if (!signatureValid) {
        context.calls.push({
          status: admitted ? "failed" : "rejected",
          reservation: reservation ?? 0,
          agentRef: ref,
          reasonCode: "response_signature_invalid",
        });
        throw new Error("model proxy response signature is missing or invalid");
      }
      if (!response.ok) {
        context.calls.push({
          status: admitted ? "failed" : "rejected",
          reservation: reservation ?? 0,
          agentRef: ref,
          reasonCode: responseErrorCode(body, admitted ? "model_call_failed" : "rejected"),
        });
        const message = body && typeof body === "object" && !Array.isArray(body)
          ? String((body as { error?: { message?: unknown } }).error?.message ?? "model proxy rejected request")
          : "model proxy rejected request";
        throw new Error(message.slice(0, 300));
      }
      if (!admitted) {
        context.calls.push({ status: "rejected", reservation: 0, agentRef: ref, reasonCode: "budget_identity_missing" });
        throw new Error("model proxy omitted or changed the signed sandbox budget identity");
      }
      let validated: ChatResponse;
      try {
        validated = validateResponse(body);
      } catch (error) {
        context.calls.push({ status: "failed", reservation, agentRef: ref, reasonCode: "invalid_proxy_response" });
        throw error;
      }
      context.calls.push({ status: "succeeded", reservation, agentRef: ref, response: validated });
      return validated;
    },
  } as LLMGateway;
}
