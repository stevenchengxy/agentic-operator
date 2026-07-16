import { getDb, llmCalls } from "@agentic/db";
import { makeId } from "@agentic/shared";
import { eq } from "drizzle-orm";
import type {
  ChatResponse,
  CostBreakdown,
  ProviderId,
  ReasoningConfig,
  TextVerbosity,
  TokenUsage,
} from "./types";
import type { LLMErrorCode } from "./errors";

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
}): AttemptIdentity | null {
  if (!args.tenantId) return null;
  const id = makeId("llc");
  getDb().insert(llmCalls).values({
    id,
    logicalCallId: args.logicalCallId,
    tenantId: args.tenantId,
    runId: args.runId,
    stepId: args.stepId,
    purpose: args.purpose,
    provider: args.provider,
    requestedModel: args.requestedModel,
    reasoningMode: args.reasoning?.mode,
    reasoningEffort: args.reasoning?.effort,
    reasoningSummary: args.reasoning?.summary,
    reasoningContext: args.reasoning?.context,
    textVerbosity: args.verbosity,
    storeResponse: args.store,
    attempt: args.attempt,
    status: "started",
    startedAt: new Date(),
  }).run();
  return { id, logicalCallId: args.logicalCallId, attempt: args.attempt };
}

function serializableUsage(usage: TokenUsage): unknown {
  try {
    return JSON.parse(JSON.stringify(usage.raw ?? usage)) as unknown;
  } catch {
    return undefined;
  }
}

export function finishAttempt(
  attempt: AttemptIdentity | null,
  response: ChatResponse,
  usage: TokenUsage,
  cost: CostBreakdown,
): void {
  if (!attempt) return;
  const usageAvailable = usage.available !== false;
  getDb().update(llmCalls).set({
    status: "ok",
    responseModel: response.model,
    providerRequestId: response.providerRequestId,
    inputTokens: usageAvailable ? usage.inputTokens : null,
    outputTokens: usageAvailable ? usage.outputTokens : null,
    totalTokens: usageAvailable ? usage.totalTokens : null,
    cachedInputTokens: usageAvailable ? usage.cachedInputTokens : null,
    cacheWriteInputTokens: usageAvailable ? usage.cacheWriteInputTokens : null,
    cacheWrite5mInputTokens: usageAvailable ? usage.cacheWrite5mInputTokens : null,
    cacheWrite1hInputTokens: usageAvailable ? usage.cacheWrite1hInputTokens : null,
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
    endedAt: new Date(),
  }).where(eq(llmCalls.id, attempt.id)).run();
}

export function failAttempt(
  attempt: AttemptIdentity | null,
  error: { code?: LLMErrorCode; message: string },
): void {
  if (!attempt) return;
  getDb().update(llmCalls).set({
    status: "failed",
    errorCode: error.code,
    errorMessage: error.message.slice(0, 8_000),
    endedAt: new Date(),
  }).where(eq(llmCalls.id, attempt.id)).run();
}
