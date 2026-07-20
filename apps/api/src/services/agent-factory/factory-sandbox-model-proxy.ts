import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";

import type { FastifyInstance, FastifyReply } from "fastify";
import type { ChatMessage, ChatRequest, ChatResponse, ToolDef } from "@agentic/llm-gateway";
import {
  factorySandboxModelCallUsage,
  factorySandboxModelGrants,
  getDb,
} from "@agentic/db";
import {
  SANDBOX_MODEL_USAGE_SCHEMA,
  sandboxModelUsageEvidenceHash,
  type SandboxModelUsageEvidence,
} from "@agentic/agent-factory";
import { and, eq, gt, lte, or, sql } from "drizzle-orm";

import { assertRealLLMGateway, getLLMGateway } from "../llm";
import {
  SANDBOX_MODEL_MAX_CALLS_HEADER,
  SANDBOX_MODEL_MAX_TOTAL_HEADER,
  SANDBOX_MODEL_RESERVATION_HEADER,
  SANDBOX_MODEL_RESPONSE_SIGNATURE_HEADER,
  sandboxModelRequestDigest,
  sandboxModelResponseSignature,
} from "./sandbox-model-protocol";

type SandboxModelGrant = typeof factorySandboxModelGrants.$inferSelect;

export interface SandboxModelGrantInput {
  attemptId: string;
  bundleHash: string;
  tenantId: string;
  tenantSlug: string;
  expiresAt: number;
  maxCalls: number;
  maxTotalTokens: number;
}

interface SandboxModelProxyBody {
  attemptId?: unknown;
  bundleHash?: unknown;
  tenantId?: unknown;
  tenantSlug?: unknown;
  requestId?: unknown;
  request?: unknown;
}

const MAX_MESSAGES = 64;
const MAX_TOOLS = 64;
const MAX_REQUEST_BYTES = 512 * 1024;
export const SANDBOX_MODEL_DEFAULT_MAX_OUTPUT_TOKENS = 4_096;
export const SANDBOX_MODEL_MAX_OUTPUT_TOKENS_PER_CALL = 8_192;
const MAX_GRANT_TOTAL_TOKENS = 100_000_000;

function readGrant(attemptId: string, bundleHash: string): SandboxModelGrant | undefined {
  return getDb()
    .select()
    .from(factorySandboxModelGrants)
    .where(and(
      eq(factorySandboxModelGrants.attemptId, attemptId),
      eq(factorySandboxModelGrants.bundleHash, bundleHash),
    ))
    .all()[0];
}

function consumeGrant(
  attemptId: string,
  bundleHash: string,
  totalTokenReservation: number,
  now: Date,
): { callOrdinal: number } | undefined {
  // A single UPDATE is the cross-process serialization point. No read/then-
  // write window can admit two callers beyond either allowance.
  return getDb()
    .update(factorySandboxModelGrants)
    .set({
      calls: sql`${factorySandboxModelGrants.calls} + 1`,
      reservedTotalTokens: sql`${factorySandboxModelGrants.reservedTotalTokens} + ${totalTokenReservation}`,
      updatedAt: now,
    })
    .where(and(
      eq(factorySandboxModelGrants.attemptId, attemptId),
      eq(factorySandboxModelGrants.bundleHash, bundleHash),
      eq(factorySandboxModelGrants.status, "active"),
      gt(factorySandboxModelGrants.expiresAt, now),
      sql`${factorySandboxModelGrants.calls} < ${factorySandboxModelGrants.maxCalls}`,
      sql`${factorySandboxModelGrants.reservedTotalTokens} + ${totalTokenReservation} <= ${factorySandboxModelGrants.maxTotalTokens}`,
    ))
    .returning({ callOrdinal: factorySandboxModelGrants.calls })
    .all()[0];
}

function measuredToken(value: number | null | undefined): number | null {
  return Number.isSafeInteger(value) && (value ?? -1) >= 0 ? value! : null;
}

function sandboxAgentRef(rawRequest: unknown): string {
  if (!rawRequest || typeof rawRequest !== "object" || Array.isArray(rawRequest)) return "unattributed";
  const purpose = (rawRequest as { purpose?: unknown }).purpose;
  if (typeof purpose !== "string") return "unattributed";
  const match = purpose.match(/(?:^|:)agent:([^/]{1,200})\//);
  if (!match) return "unattributed";
  const value = match[1]!.replace(/[^A-Za-z0-9._:-]/g, "-").slice(0, 200);
  return value || "unattributed";
}

function rejectedReasonCode(value: string): string {
  return value.replace(/[^a-z0-9_:-]/gi, "_").slice(0, 100) || "rejected";
}

function recordRejectedModelCall(
  grant: SandboxModelGrant,
  rawRequest: unknown,
  reasonCode: string,
): void {
  const now = new Date();
  recordModelCall({
    grant,
    status: "rejected",
    agentRef: sandboxAgentRef(rawRequest),
    reasonCode: rejectedReasonCode(reasonCode),
    startedAt: now,
    completedAt: now,
  });
}

function recordModelCall(input: {
  grant: SandboxModelGrant;
  callOrdinal?: number;
  status: "succeeded" | "failed" | "rejected";
  agentRef: string;
  reasonCode?: string;
  response?: ChatResponse;
  startedAt: Date;
  completedAt: Date;
}): void {
  const tokensIn = input.status === "succeeded" ? measuredToken(input.response?.tokensIn) : null;
  const tokensOut = input.status === "succeeded" ? measuredToken(input.response?.tokensOut) : null;
  const totalTokens = tokensIn === null || tokensOut === null ? null : tokensIn + tokensOut;
  getDb().transaction((tx) => {
    tx.insert(factorySandboxModelCallUsage).values({
      id: randomUUID(),
      attemptId: input.grant.attemptId,
      bundleHash: input.grant.bundleHash,
      callOrdinal: input.callOrdinal,
      status: input.status,
      agentRef: input.agentRef,
      reasonCode: input.reasonCode ?? null,
      provider: input.status === "succeeded" ? input.response?.provider ?? null : null,
      model: input.status === "succeeded" ? input.response?.model ?? null : null,
      tokensIn,
      tokensOut,
      totalTokens,
      createdAt: input.startedAt,
      completedAt: input.completedAt,
    }).run();
    if (input.status === "succeeded") {
      tx.update(factorySandboxModelGrants)
        .set({
          ...(tokensIn === null || tokensOut === null
            ? { unmeasuredUsageCalls: sql`${factorySandboxModelGrants.unmeasuredUsageCalls} + 1` }
            : {
                measuredInputTokens: sql`${factorySandboxModelGrants.measuredInputTokens} + ${tokensIn}`,
                measuredOutputTokens: sql`${factorySandboxModelGrants.measuredOutputTokens} + ${tokensOut}`,
              }),
          updatedAt: input.completedAt,
        })
        .where(and(
          eq(factorySandboxModelGrants.attemptId, input.grant.attemptId),
          eq(factorySandboxModelGrants.bundleHash, input.grant.bundleHash),
        ))
        .run();
    }
  });
}

export function readFactorySandboxModelUsageEvidence(
  attemptId: string,
  bundleHash: string,
): SandboxModelUsageEvidence | undefined {
  const grant = readGrant(attemptId, bundleHash);
  if (!grant) return undefined;
  const rows = getDb().select().from(factorySandboxModelCallUsage).where(and(
    eq(factorySandboxModelCallUsage.attemptId, attemptId),
    eq(factorySandboxModelCallUsage.bundleHash, bundleHash),
  )).all();
  const succeeded = rows.filter((row) => row.status === "succeeded");
  const failed = rows.filter((row) => row.status === "failed");
  const rejected = rows.filter((row) => row.status === "rejected");
  const measured = succeeded.every((row) =>
    measuredToken(row.tokensIn) !== null
    && measuredToken(row.tokensOut) !== null
    && measuredToken(row.totalTokens) !== null);
  const providerModels = [...new Map(succeeded
    .filter((row) => row.provider?.trim() && row.model?.trim())
    .map((row) => [`${row.provider}\u0000${row.model}`, {
      provider: row.provider!,
      model: row.model!,
    }])).values()].sort((left, right) =>
    `${left.provider}\u0000${left.model}`.localeCompare(`${right.provider}\u0000${right.model}`));
  const sum = (field: "tokensIn" | "tokensOut" | "totalTokens") =>
    succeeded.reduce((total, row) => total + (row[field] ?? 0), 0);
  const byAgent = new Map<string, typeof rows>();
  for (const row of rows) {
    const bucket = byAgent.get(row.agentRef) ?? [];
    bucket.push(row);
    byAgent.set(row.agentRef, bucket);
  }
  const agentCalls = [...byAgent.entries()].map(([agentRef, calls]) => ({
    agentRef,
    calls: calls.length,
    successfulCalls: calls.filter((call) => call.status === "succeeded").length,
    failedCalls: calls.filter((call) => call.status === "failed").length,
    rejectedCalls: calls.filter((call) => call.status === "rejected").length,
  })).sort((left, right) => left.agentRef.localeCompare(right.agentRef));
  const rejectedReasonMap = new Map<string, { agentRef: string; reasonCode: string; count: number }>();
  for (const row of rejected) {
    const reasonCode = row.reasonCode ?? "rejected";
    const key = `${row.agentRef}\u0000${reasonCode}`;
    const existing = rejectedReasonMap.get(key);
    rejectedReasonMap.set(key, existing
      ? { ...existing, count: existing.count + 1 }
      : { agentRef: row.agentRef, reasonCode, count: 1 });
  }
  const rejectedReasons = [...rejectedReasonMap.values()].sort((left, right) =>
    `${left.agentRef}\u0000${left.reasonCode}`.localeCompare(`${right.agentRef}\u0000${right.reasonCode}`));
  const startedAt = rows.length
    ? new Date(Math.min(...rows.map((row) => row.createdAt.getTime()))).toISOString()
    : grant.createdAt.toISOString();
  const completedAt = rows.length
    ? new Date(Math.max(...rows.map((row) => row.completedAt.getTime()))).toISOString()
    : grant.createdAt.toISOString();
  const body: Omit<SandboxModelUsageEvidence, "evidenceHash"> = {
    schema: SANDBOX_MODEL_USAGE_SCHEMA,
    sandboxAttemptId: grant.attemptId,
    bundleHash: grant.bundleHash,
    targetTenantId: grant.tenantId,
    targetTenantSlug: grant.tenantSlug,
    calls: rows.length,
    successfulCalls: succeeded.length,
    failedCalls: failed.length,
    rejectedCalls: rejected.length,
    agentCalls,
    rejectedReasons,
    providerModels,
    inputTokens: measured ? sum("tokensIn") : null,
    outputTokens: measured ? sum("tokensOut") : null,
    totalTokens: measured ? sum("totalTokens") : null,
    budget: {
      enforced: true,
      maxCalls: grant.maxCalls,
      maxTotalTokens: grant.maxTotalTokens,
      reservedTotalTokens: grant.reservedTotalTokens,
    },
    startedAt,
    completedAt,
  };
  return { ...body, evidenceHash: sandboxModelUsageEvidenceHash(body) };
}

/** Cross-check the signed workload aggregate against the primary API's
 * durable per-call ledger. Timestamps may differ by a few milliseconds, so
 * only identity, accounting and budget fields participate. */
export function factorySandboxModelUsageLedgerIssues(
  evidence: SandboxModelUsageEvidence | null | undefined,
): string[] {
  if (!evidence) return ["missing workload model-usage evidence"];
  const authoritative = readFactorySandboxModelUsageEvidence(
    evidence.sandboxAttemptId,
    evidence.bundleHash,
  );
  if (!authoritative) return ["primary model-usage grant is missing or expired"];
  const fields = [
    "sandboxAttemptId",
    "bundleHash",
    "targetTenantId",
    "targetTenantSlug",
    "calls",
    "successfulCalls",
    "failedCalls",
    "rejectedCalls",
    "agentCalls",
    "rejectedReasons",
    "providerModels",
    "inputTokens",
    "outputTokens",
    "totalTokens",
    "budget",
  ] as const;
  const issues = fields.flatMap((field) =>
    JSON.stringify(evidence[field]) === JSON.stringify(authoritative[field])
      ? []
      : [`workload model-usage ${field} does not match the primary proxy ledger`]);
  const grant = readGrant(evidence.sandboxAttemptId, evidence.bundleHash);
  if (grant && grant.calls !== authoritative.successfulCalls + authoritative.failedCalls) {
    issues.push("primary proxy admitted a model call without durable terminal usage");
  }
  return issues;
}

function pruneSandboxModelGrants(now = new Date()): void {
  getDb()
    .delete(factorySandboxModelGrants)
    .where(or(
      eq(factorySandboxModelGrants.status, "revoked"),
      lte(factorySandboxModelGrants.expiresAt, now),
    ))
    .run();
}

function nonEmpty(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

function secretValue(env: NodeJS.ProcessEnv = process.env): string | null {
  const direct = env.FACTORY_SB_MODEL_PROXY_TOKEN?.trim();
  const file = env.FACTORY_SB_MODEL_PROXY_TOKEN_FILE?.trim();
  if (direct && file) throw new Error("FACTORY_SB_MODEL_PROXY_TOKEN and *_FILE cannot both be set");
  const value = direct || (file ? readFileSync(file, "utf8").trim() : "");
  if (!value) return null;
  if (Buffer.byteLength(value, "utf8") < 32) {
    throw new Error("Factory sandbox model-proxy token must be at least 32 bytes");
  }
  return value;
}

function tokenMatches(header: string | undefined, expected: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const supplied = header.slice(7).trim();
  const left = createHash("sha256").update(supplied).digest();
  const right = createHash("sha256").update(expected).digest();
  return timingSafeEqual(left, right);
}

function sendSignedModelResponse(input: {
  reply: FastifyReply;
  secret: string;
  grant: SandboxModelGrant;
  statusCode: number;
  reservation?: number;
  requestDigest: string;
  body: unknown;
}) {
  const signed = {
    attemptId: input.grant.attemptId,
    bundleHash: input.grant.bundleHash,
    targetTenantId: input.grant.tenantId,
    targetTenantSlug: input.grant.tenantSlug,
    requestDigest: input.requestDigest,
    statusCode: input.statusCode,
    reservation: input.reservation ?? null,
    maxCalls: input.grant.maxCalls,
    maxTotalTokens: input.grant.maxTotalTokens,
    body: input.body,
  };
  input.reply
    .header(SANDBOX_MODEL_MAX_CALLS_HEADER, String(input.grant.maxCalls))
    .header(SANDBOX_MODEL_MAX_TOTAL_HEADER, String(input.grant.maxTotalTokens))
    .header(
      SANDBOX_MODEL_RESPONSE_SIGNATURE_HEADER,
      sandboxModelResponseSignature(input.secret, signed),
    );
  if (input.reservation !== undefined) {
    input.reply.header(SANDBOX_MODEL_RESERVATION_HEADER, String(input.reservation));
  }
  return input.reply
    .code(input.statusCode)
    .send(input.body);
}

function validMessages(value: unknown): value is ChatMessage[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_MESSAGES) return false;
  return value.every((message) => {
    if (!message || typeof message !== "object" || Array.isArray(message)) return false;
    const row = message as Record<string, unknown>;
    if (!["system", "user", "assistant", "tool"].includes(String(row.role))) return false;
    if (typeof row.content === "string") return Buffer.byteLength(row.content, "utf8") <= 100_000;
    if (!Array.isArray(row.content)) return false;
    try {
      return Buffer.byteLength(JSON.stringify(row.content), "utf8") <= 200_000;
    } catch {
      return false;
    }
  });
}

function validTools(value: unknown): value is ToolDef[] {
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.length > MAX_TOOLS) return false;
  return value.every((tool) => {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) return false;
    const row = tool as Record<string, unknown>;
    return nonEmpty(row.name, 200)
      && (row.description === undefined || typeof row.description === "string")
      && Boolean(row.input_schema)
      && typeof row.input_schema === "object"
      && !Array.isArray(row.input_schema);
  });
}

function boundedNumber(value: unknown, min: number, max: number): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max
    ? value
    : undefined;
}

function validatedRequest(raw: unknown, grant: SandboxModelGrant): ChatRequest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid model request");
  let encoded: string;
  try {
    encoded = JSON.stringify(raw);
  } catch {
    throw new Error("model request is not JSON serializable");
  }
  if (Buffer.byteLength(encoded, "utf8") > MAX_REQUEST_BYTES) throw new Error("model request is too large");
  const request = raw as Record<string, unknown>;
  if (!validMessages(request.messages) || !validTools(request.tools)) {
    throw new Error("model messages/tools contract is invalid");
  }
  const maxTokens = request.maxTokens === undefined
    ? SANDBOX_MODEL_DEFAULT_MAX_OUTPUT_TOKENS
    : boundedNumber(request.maxTokens, 1, SANDBOX_MODEL_MAX_OUTPUT_TOKENS_PER_CALL);
  if (maxTokens === undefined) {
    throw new Error("model maxTokens is outside the sandbox allowance");
  }
  const temperature = request.temperature === undefined
    ? undefined
    : boundedNumber(request.temperature, 0, 2);
  if (request.temperature !== undefined && temperature === undefined) {
    throw new Error("model temperature is outside the sandbox allowance");
  }
  const purpose = nonEmpty(request.purpose, 200)
    ? request.purpose.replace(/[^A-Za-z0-9:._/-]/g, "-")
    : "reason";
  if (
    request.stop !== undefined
    && (!Array.isArray(request.stop)
      || request.stop.length > 8
      || !request.stop.every((entry) =>
        typeof entry === "string" && Buffer.byteLength(entry, "utf8") <= 200))
  ) {
    throw new Error("model stop sequences are outside the sandbox allowance");
  }
  return {
    messages: request.messages,
    tenantId: grant.tenantId,
    tenantSlug: grant.tenantSlug,
    purpose: `factory-sandbox:${grant.attemptId}:${purpose}`,
    ...(request.tools ? { tools: request.tools } : {}),
    maxTokens,
    ...(temperature !== undefined ? { temperature } : {}),
    ...(typeof request.jsonMode === "boolean" ? { jsonMode: request.jsonMode } : {}),
    ...(Array.isArray(request.stop)
      ? { stop: request.stop as string[] }
      : {}),
    timeoutMs: Math.min(60_000, boundedNumber(request.timeoutMs, 1_000, 60_000) ?? 60_000),
  };
}

/** Conservative tokenizer-independent upper bound. Byte-level tokenizers
 * cannot produce more tokens than payload bytes; the fixed/per-item margin
 * covers chat framing and provider control tokens not present in JSON. */
function totalTokenReservation(request: ChatRequest): number {
  const input = JSON.stringify({
    messages: request.messages,
    tools: request.tools ?? [],
    stop: request.stop ?? [],
    jsonMode: request.jsonMode ?? false,
  });
  const inputUpperBound = Buffer.byteLength(input, "utf8")
    + 1_024
    + request.messages.length * 32
    + (request.tools?.length ?? 0) * 64;
  return inputUpperBound + (request.maxTokens ?? SANDBOX_MODEL_DEFAULT_MAX_OUTPUT_TOKENS);
}

export function registerFactorySandboxModelGrant(input: SandboxModelGrantInput): () => void {
  if (
    !nonEmpty(input.attemptId, 200)
    || !nonEmpty(input.bundleHash, 200)
    || !nonEmpty(input.tenantId, 200)
    || !nonEmpty(input.tenantSlug, 200)
    || !Number.isSafeInteger(input.expiresAt)
    || input.expiresAt <= 0
    || !Number.isSafeInteger(input.maxCalls)
    || input.maxCalls < 1
    || input.maxCalls > 1_024
    || !Number.isSafeInteger(input.maxTotalTokens)
    || input.maxTotalTokens < 1
    || input.maxTotalTokens > MAX_GRANT_TOTAL_TOKENS
  ) {
    throw new Error("invalid Factory sandbox model grant");
  }
  const now = new Date();
  pruneSandboxModelGrants(now);
  getDb().insert(factorySandboxModelGrants).values({
    attemptId: input.attemptId,
    bundleHash: input.bundleHash,
    tenantId: input.tenantId,
    tenantSlug: input.tenantSlug,
    status: "active",
    maxCalls: input.maxCalls,
    calls: 0,
    maxTotalTokens: input.maxTotalTokens,
    reservedTotalTokens: 0,
    measuredInputTokens: 0,
    measuredOutputTokens: 0,
    unmeasuredUsageCalls: 0,
    expiresAt: new Date(input.expiresAt),
    createdAt: now,
    updatedAt: now,
  }).run();
  return () => {
    getDb()
      .update(factorySandboxModelGrants)
      .set({ status: "revoked", updatedAt: new Date() })
      .where(and(
        eq(factorySandboxModelGrants.attemptId, input.attemptId),
        eq(factorySandboxModelGrants.bundleHash, input.bundleHash),
      ))
      .run();
  };
}

export function clearFactorySandboxModelGrants(): void {
  getDb().delete(factorySandboxModelGrants).run();
}

export function assertFactorySandboxModelProxyReady(): void {
  if (!secretValue()) {
    throw new Error("Factory sandbox model-proxy token is not configured");
  }
  assertRealLLMGateway("Factory sandbox model proxy", getLLMGateway());
}

export async function factorySandboxModelProxyRoutes(app: FastifyInstance): Promise<void> {
  pruneSandboxModelGrants();
  app.post<{ Body: SandboxModelProxyBody }>(
    "/internal/factory-sandbox/model/chat",
    // Keep transport parsing above the candidate/container protocol ceiling so
    // every authenticated policy rejection reaches the attempt ledger. The
    // much smaller semantic request limit is enforced below.
    {
      bodyLimit: 9 * 1024 * 1024,
      onRequest: async (req, reply) => {
        let token: string | null;
        try {
          token = secretValue();
        } catch {
          return reply.code(503).send({ error: { code: "model_proxy_misconfigured", message: "Sandbox model proxy is not configured safely" } });
        }
        if (!token) {
          return reply.code(503).send({ error: { code: "model_proxy_unavailable", message: "Sandbox model proxy is not configured" } });
        }
        if (!tokenMatches(req.headers.authorization, token)) {
          return reply.code(401).send({ error: { code: "unauthorized", message: "Unauthorized sandbox model request" } });
        }
      },
    },
    async (req, reply) => {
      let token: string | null;
      try {
        token = secretValue();
      } catch {
        return reply.code(503).send({ error: { code: "model_proxy_misconfigured", message: "Sandbox model proxy is not configured safely" } });
      }
      if (!token) {
        return reply.code(503).send({ error: { code: "model_proxy_unavailable", message: "Sandbox model proxy is not configured" } });
      }
      // A bad service token has no trustworthy attempt identity and is logged
      // only by the normal HTTP security audit, never attributed to a grant.
      if (!tokenMatches(req.headers.authorization, token)) {
        return reply.code(401).send({ error: { code: "unauthorized", message: "Unauthorized sandbox model request" } });
      }
      const body = req.body ?? {};
      if (
        !nonEmpty(body.attemptId, 200)
        || !nonEmpty(body.bundleHash, 200)
        || !nonEmpty(body.tenantId, 200)
        || !nonEmpty(body.tenantSlug, 200)
        || !nonEmpty(body.requestId, 200)
      ) {
        return reply.code(400).send({ error: { code: "invalid_request", message: "Sandbox model request identity is incomplete" } });
      }
      const grant = readGrant(body.attemptId, body.bundleHash);
      if (!grant) {
        return reply.code(409).send({ error: { code: "grant_stale", message: "Sandbox model grant is missing or expired" } });
      }
      const requestDigest = sandboxModelRequestDigest({
        attemptId: body.attemptId,
        bundleHash: body.bundleHash,
        targetTenantId: body.tenantId,
        targetTenantSlug: body.tenantSlug,
        requestId: body.requestId,
        request: body.request,
      });
      const reject = (status: number, code: string, message: string) => {
        recordRejectedModelCall(grant, body.request, code);
        return sendSignedModelResponse({
          reply,
          secret: token,
          grant,
          statusCode: status,
          requestDigest,
          body: { error: { code, message } },
        });
      };
      if (grant.tenantId !== body.tenantId || grant.tenantSlug !== body.tenantSlug) {
        return reject(409, "grant_identity_mismatch", "Sandbox model grant belongs to another target tenant");
      }
      if (grant.status !== "active" || grant.expiresAt.getTime() <= Date.now()) {
        return reject(409, "grant_stale", "Sandbox model grant is revoked or expired");
      }
      if (grant.calls >= grant.maxCalls) {
        return reject(429, "grant_budget_exhausted", "Sandbox model-call allowance is exhausted");
      }
      let request: ChatRequest;
      let gateway: ReturnType<typeof getLLMGateway>;
      try {
        request = validatedRequest(body.request, grant);
        gateway = getLLMGateway();
        assertRealLLMGateway("Factory sandbox model proxy", gateway);
      } catch (error) {
        return reject(
          422,
          "model_request_rejected",
          String((error as Error).message ?? error).slice(0, 300),
        );
      }
      const totalReservation = totalTokenReservation(request);
      if (
        !Number.isSafeInteger(totalReservation)
        || totalReservation < 1
        || grant.reservedTotalTokens + totalReservation > grant.maxTotalTokens
      ) {
        return reject(429, "grant_budget_exhausted", "Sandbox total-token allowance is exhausted");
      }
      const callStartedAt = new Date();
      const consumed = consumeGrant(
        grant.attemptId,
        grant.bundleHash,
        totalReservation,
        callStartedAt,
      );
      if (!consumed) {
        return reject(429, "grant_budget_exhausted", "Sandbox model call/total-token allowance is exhausted");
      }
      const agentRef = sandboxAgentRef(request);
      let response: ChatResponse;
      try {
        response = await gateway.chat(request);
      } catch (error) {
        try {
          recordModelCall({
            grant,
            callOrdinal: consumed.callOrdinal,
            status: "failed",
            agentRef,
            reasonCode: "model_call_failed",
            startedAt: callStartedAt,
            completedAt: new Date(),
          });
        } catch (usageError) {
          req.log.error({ err: usageError, attemptId: grant.attemptId }, "sandbox model proxy usage persistence failed");
        }
        req.log.warn({ err: error, attemptId: grant.attemptId }, "sandbox model proxy call failed");
        return sendSignedModelResponse({
          reply,
          secret: token,
          grant,
          statusCode: 502,
          reservation: totalReservation,
          requestDigest,
          body: { error: { code: "model_call_failed", message: "The configured model provider did not complete this sandbox request" } },
        });
      }
      try {
        recordModelCall({
          grant,
          callOrdinal: consumed.callOrdinal,
          status: "succeeded",
          agentRef,
          response,
          startedAt: callStartedAt,
          completedAt: new Date(),
        });
      } catch (usageError) {
        req.log.error({ err: usageError, attemptId: grant.attemptId }, "sandbox model proxy usage persistence failed");
        return sendSignedModelResponse({
          reply,
          secret: token,
          grant,
          statusCode: 503,
          reservation: totalReservation,
          requestDigest,
          body: { error: { code: "model_usage_unavailable", message: "Sandbox model usage could not be persisted" } },
        });
      }
      const safe: ChatResponse = {
        text: response.text,
        provider: response.provider,
        model: response.model,
        tokensIn: response.tokensIn,
        tokensOut: response.tokensOut,
        finishReason: response.finishReason,
        latencyMs: response.latencyMs,
        ...(response.toolCalls ? { toolCalls: response.toolCalls } : {}),
      };
      return sendSignedModelResponse({
        reply,
        secret: token,
        grant,
        statusCode: 200,
        reservation: totalReservation,
        requestDigest,
        body: safe,
      });
    },
  );
}
