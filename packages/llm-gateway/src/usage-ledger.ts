import { getDb, getRawSqlite, llmCalls, runs, usageEvents } from "@agentic/db";
import { makeId } from "@agentic/shared";
import { and, eq } from "drizzle-orm";
import type {
  ChatResponse,
  CostBreakdown,
  ProviderId,
  ReasoningConfig,
  TextVerbosity,
  TokenUsage,
  UsageAttribution,
  LlmRoutingMetadata,
} from "./types";
import type { LLMErrorCode } from "./errors";
import { recordActualSpend } from "./budget";
import { exportPendingUsageEvents } from "./usage-export";

export interface AttemptIdentity {
  id: string;
  logicalCallId: string;
  attempt: number;
}

export function newLogicalCallId(): string {
  return makeId("llc");
}

export function startAttempt(args: {
  logicalCallId: string;
  attempt: number;
  tenantId?: string;
  runId?: string;
  stepId?: string;
  purpose?: string;
  provider: ProviderId;
  requestedModel: string;
  reasoning?: ReasoningConfig;
  verbosity?: TextVerbosity;
  store?: boolean;
  attribution?: UsageAttribution;
  routing?: LlmRoutingMetadata;
}): AttemptIdentity | null {
  if (!args.tenantId) return null;
  const run = args.runId
    ? getDb()
        .select({
          requestedBy: runs.requestedBy,
          correlationId: runs.correlationId,
          invocationSource: runs.invocationSource,
          requestId: runs.requestId,
          interactionId: runs.interactionId,
          productSurface: runs.productSurface,
          productAction: runs.productAction,
        })
        .from(runs)
        .where(and(eq(runs.id, args.runId), eq(runs.tenantId, args.tenantId)))
        .all()[0]
    : undefined;
  const attribution = args.attribution ?? {};
  const actorId = attribution.actorId ?? run?.requestedBy ?? undefined;
  const actorType = attribution.actorType ?? (actorId ? "user" : "system");
  const functionName = attribution.functionName ?? args.purpose ?? "llm.call";
  const productSurface =
    attribution.productSurface ?? inferSurface(args.purpose);
  const productAction = attribution.productAction ?? args.purpose ?? "llm.call";
  const id = makeId("llc");
  getDb()
    .insert(llmCalls)
    .values({
      id,
      logicalCallId: args.logicalCallId,
      tenantId: args.tenantId,
      runId: args.runId,
      stepId: args.stepId,
      purpose: args.purpose,
      billingAccountId: attribution.billingAccountId ?? args.tenantId,
      providerAccountId: attribution.providerAccountId,
      actorType,
      actorId,
      credentialId: attribution.credentialId,
      providerCredentialId: attribution.providerCredentialId,
      product: attribution.product ?? "agentic-operator",
      productSurface:
        attribution.productSurface ?? run?.productSurface ?? productSurface,
      productAction:
        attribution.productAction ?? run?.productAction ?? productAction,
      interactionId: attribution.interactionId ?? run?.interactionId,
      functionName,
      apiRoute: attribution.apiRoute,
      httpMethod: attribution.httpMethod,
      requestId: attribution.requestId ?? run?.requestId,
      correlationId: attribution.correlationId ?? run?.correlationId,
      invocationSource: attribution.invocationSource ?? run?.invocationSource,
      provider: args.provider,
      requestedModel: args.requestedModel,
      requestedRoute: args.routing?.requestedRoute,
      effectiveRoute: args.routing?.effectiveRoute,
      gatewayInstanceId: args.routing?.gatewayInstanceId,
      gatewayKind: args.routing?.gatewayKind,
      modelFamily: args.routing?.modelFamily,
      taskType: args.routing?.taskType,
      matchedTaskType: args.routing?.matchedTaskType,
      routingProfileId: args.routing?.profileId,
      routingRevision: args.routing?.settingsRevision,
      resolutionReason: args.routing?.resolutionReason,
      fallbackIndex: args.routing?.fallbackIndex,
      transport: args.routing?.transport,
      effectiveTimeoutMs: args.routing?.effectiveTimeoutMs,
      overallDeadlineMs: args.routing?.overallDeadlineMs,
      controlsJson: args.routing?.controls,
      retryReason: args.routing?.retryReason,
      reasoningMode: args.reasoning?.mode,
      reasoningEffort: args.reasoning?.effort,
      reasoningSummary: args.reasoning?.summary,
      reasoningContext: args.reasoning?.context,
      textVerbosity: args.verbosity,
      storeResponse: args.store,
      attempt: args.attempt,
      status: "started",
      startedAt: new Date(),
    })
    .run();
  return { id, logicalCallId: args.logicalCallId, attempt: args.attempt };
}

function serializableUsage(usage: TokenUsage): unknown {
  // Provider usage envelopes can contain request echoes or future fields we
  // have not reviewed. Persist only the normalized, explicitly enumerated
  // counters needed for reconciliation.
  return {
    available: usage.available !== false,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    cachedInputTokens: usage.cachedInputTokens,
    cacheWriteInputTokens: usage.cacheWriteInputTokens,
    cacheWrite5mInputTokens: usage.cacheWrite5mInputTokens,
    cacheWrite1hInputTokens: usage.cacheWrite1hInputTokens,
    reasoningTokens: usage.reasoningTokens,
    inputAudioTokens: usage.inputAudioTokens,
    outputAudioTokens: usage.outputAudioTokens,
  };
}

export function finishAttempt(
  attempt: AttemptIdentity | null,
  response: ChatResponse,
  usage: TokenUsage,
  cost: CostBreakdown,
): void {
  if (!attempt) return;
  const usageAvailable = usage.available !== false;
  const endedAt = new Date();
  const transaction = getRawSqlite().transaction(() => {
    getDb()
      .update(llmCalls)
      .set({
        status: "ok",
        responseModel: response.model,
        providerRequestId: response.providerRequestId,
        inputTokens: usageAvailable ? usage.inputTokens : null,
        outputTokens: usageAvailable ? usage.outputTokens : null,
        totalTokens: usageAvailable ? usage.totalTokens : null,
        cachedInputTokens: usageAvailable ? usage.cachedInputTokens : null,
        cacheWriteInputTokens: usageAvailable
          ? usage.cacheWriteInputTokens
          : null,
        cacheWrite5mInputTokens: usageAvailable
          ? usage.cacheWrite5mInputTokens
          : null,
        cacheWrite1hInputTokens: usageAvailable
          ? usage.cacheWrite1hInputTokens
          : null,
        reasoningTokens: usageAvailable ? usage.reasoningTokens : null,
        inputAudioTokens: usageAvailable ? usage.inputAudioTokens : null,
        outputAudioTokens: usageAvailable ? usage.outputAudioTokens : null,
        costUsdNanos: cost.totalUsdNanos,
        inputUsdNanos: cost.inputUsdNanos,
        cachedInputUsdNanos: cost.cachedInputUsdNanos,
        cacheWriteUsdNanos: cost.cacheWriteUsdNanos,
        outputUsdNanos: cost.outputUsdNanos,
        costSource: cost.source,
        priceSource: cost.priceSource,
        priceAsOf: cost.priceAsOf,
        finishReason: response.finishReason,
        latencyMs: response.latencyMs,
        usageJson: serializableUsage(usage),
        endedAt,
      })
      .where(eq(llmCalls.id, attempt.id))
      .run();
    appendUsageEvent(
      attempt.id,
      "ok",
      endedAt,
      normalizedQuantity(usage),
      cost,
    );
    const call = getDb()
      .select({ tenantId: llmCalls.tenantId })
      .from(llmCalls)
      .where(eq(llmCalls.id, attempt.id))
      .all()[0];
    recordActualSpend({ tenantId: call?.tenantId, usage, cost });
  });
  transaction();
  exportAttemptTenant(attempt.id);
}

export function failAttempt(
  attempt: AttemptIdentity | null,
  error: { code?: LLMErrorCode; message: string },
): void {
  if (!attempt) return;
  const endedAt = new Date();
  const transaction = getRawSqlite().transaction(() => {
    getDb()
      .update(llmCalls)
      .set({
        status: "failed",
        errorCode: error.code,
        // Arbitrary provider prose can echo prompts, URLs, or credentials.
        // Persist a stable category only; detailed provider bodies stay out
        // of the billing/usage ledger by design.
        errorMessage: safeAttemptError(error.code),
        endedAt,
      })
      .where(eq(llmCalls.id, attempt.id))
      .run();
    appendUsageEvent(
      attempt.id,
      "failed",
      endedAt,
      { authoritative: false },
      null,
    );
  });
  transaction();
  exportAttemptTenant(attempt.id);
}

function safeAttemptError(code: LLMErrorCode | undefined): string {
  const labels: Record<LLMErrorCode, string> = {
    auth: "provider authentication failed",
    rate_limit: "provider rate limit exceeded",
    timeout: "provider request timed out",
    model_not_found: "provider model was not found",
    bad_request: "provider rejected the request parameters",
    provider_error: "provider returned an upstream error",
    network: "provider network request failed",
    not_configured: "provider or credential is not configured",
    accounting_error: "usage accounting failed",
    cost_limit_exceeded: "account cost limit exceeded",
  };
  return code ? labels[code] : "provider attempt failed";
}

function appendUsageEvent(
  callId: string,
  status: "ok" | "failed",
  occurredAt: Date,
  quantityJson: unknown,
  cost: CostBreakdown | null,
): void {
  const call = getDb()
    .select()
    .from(llmCalls)
    .where(eq(llmCalls.id, callId))
    .all()[0];
  if (!call)
    throw new Error(`LLM call ${callId} disappeared during accounting`);
  const liability =
    status === "failed"
      ? "unknown"
      : cost?.totalUsdNanos === null
        ? "unpriced"
        : "known";
  getDb()
    .insert(usageEvents)
    .values({
      id: makeId("use"),
      eventType: "llm.attempt",
      status,
      tenantId: call.tenantId,
      billingAccountId: call.billingAccountId ?? call.tenantId,
      actorType: call.actorType ?? "system",
      actorId: call.actorId,
      credentialId: call.credentialId,
      providerCredentialId: call.providerCredentialId,
      providerAccountId: call.providerAccountId,
      requestId: call.requestId,
      correlationId: call.correlationId,
      interactionId: call.interactionId,
      runId: call.runId,
      stepId: call.stepId,
      product: call.product ?? "agentic-operator",
      productSurface:
        call.productSurface ?? inferSurface(call.purpose ?? undefined),
      productAction: call.productAction ?? call.purpose ?? "llm.call",
      functionName: call.functionName ?? call.purpose ?? "llm.call",
      apiRoute: call.apiRoute,
      httpMethod: call.httpMethod,
      invocationSource: call.invocationSource,
      llmCallId: call.id,
      quantityJson,
      providerCostUsdNanos: cost?.totalUsdNanos,
      billableChargeUsdNanos: cost?.totalUsdNanos,
      costLiability: liability,
      occurredAt,
    })
    .run();
}

function normalizedQuantity(
  usage: TokenUsage,
): Record<string, number | boolean> {
  return {
    authoritative: usage.available !== false,
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    total_tokens: usage.totalTokens,
    cached_input_tokens: usage.cachedInputTokens,
    cache_write_input_tokens: usage.cacheWriteInputTokens,
    cache_write_5m_input_tokens: usage.cacheWrite5mInputTokens,
    cache_write_1h_input_tokens: usage.cacheWrite1hInputTokens,
    reasoning_tokens: usage.reasoningTokens,
    input_audio_tokens: usage.inputAudioTokens,
    output_audio_tokens: usage.outputAudioTokens,
  };
}

function inferSurface(purpose: string | undefined): string {
  if (!purpose) return "llm-gateway";
  if (purpose.startsWith("studio") || purpose.includes("authoring")) {
    return "agent-studio";
  }
  if (purpose.startsWith("workflow")) return "workflow-authoring";
  if (purpose.startsWith("manifest") || purpose === "code-agent") {
    return "agent-runtime";
  }
  return purpose;
}

function exportAttemptTenant(callId: string): void {
  // Unit/integration suites must opt into a temporary export root. This keeps
  // unrelated accounting tests from writing portable artifacts into the repo.
  if (
    process.env.NODE_ENV === "test" &&
    !process.env.AGENTIC_USAGE_EXPORT_ROOT?.trim()
  ) {
    return;
  }
  const call = getDb()
    .select({ tenantId: llmCalls.tenantId })
    .from(llmCalls)
    .where(eq(llmCalls.id, callId))
    .all()[0];
  if (!call) return;
  try {
    exportPendingUsageEvents(call.tenantId);
  } catch (error) {
    if (process.env.LLM_USAGE_EXPORT_REQUIRED === "true") throw error;
    console.error(
      `[llm-gateway] usage export pending for ${call.tenantId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
