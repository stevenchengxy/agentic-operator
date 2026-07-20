/**
 * LLMGateway — single entry point for all LLM calls.
 *
 * Responsibilities:
 *   - Provider registry (in-process Map of ProviderId → Adapter)
 *   - chat() dispatch with provider resolution, failover, timeout, retry
 *   - Surface configured providers (for /v1/llm/providers)
 *
 * Every attributed provider attempt is persisted before dispatch and then
 * finalized with normalized usage and exact/dated cost information.
 */

import {
  selectableModelsForProvider,
  type ProviderId,
} from "@agentic/contracts";
import type {
  ChatRequest,
  ChatResponse,
  GatewayConfig,
  ProviderAdapter,
  ProviderInfo,
} from "./types";
import { LLMError, isLLMError } from "./errors";
import { assertBudgetAvailable } from "./budget";
import { calculateCost, normalizeUsage } from "./pricing";
import {
  assertModelControls,
  assertModelSelectable,
  isUnsupportedTemperatureError,
  normalizeModelRequest,
  omitTemperature,
} from "./capabilities";
import {
  failAttempt,
  finishAttempt,
  newLogicalCallId,
  startAttempt,
} from "./usage-ledger";
import {
  currentUsageAttribution,
  mergeUsageAttribution,
} from "./usage-attribution";

export class LLMGateway {
  private readonly providers = new Map<ProviderId, ProviderAdapter>();
  private readonly learnedTemperatureUnsupported = new Set<string>();

  constructor(private readonly config: GatewayConfig) {}

  registerProvider(adapter: ProviderAdapter): void {
    this.providers.set(adapter.id, adapter);
  }

  hasProvider(id: ProviderId): boolean {
    return this.providers.has(id);
  }

  getProvider(id: ProviderId): ProviderAdapter | undefined {
    return this.providers.get(id);
  }

  get defaultProvider(): ProviderId {
    return this.config.defaultProvider;
  }

  get defaultModel(): string | null {
    return this.config.defaultModel;
  }

  listProviders(): ProviderInfo[] {
    const out: ProviderInfo[] = [];
    for (const [id, adapter] of this.providers) {
      const catalog = selectableModelsForProvider(id);
      out.push({
        id,
        name: adapter.name,
        hasKey: adapter.hasKey,
        defaultModel: adapter.defaultModel,
        models: catalog.map((m) => m.name),
      });
    }
    return out;
  }

  /**
   * Main dispatch. Resolves provider chain, model, timeout, then iterates
   * providers, retrying once on transient errors and falling through to
   * the next provider on subsequent transient failures.
   *
   * Throws LLMError on terminal failure (last provider's error).
   */
  async chat(req: ChatRequest): Promise<ChatResponse> {
    const providers = this.resolveProviderChain(req);
    if (this.config.requireUsageAttribution && !req.tenantId) {
      throw new LLMError(
        "tenantId is required for durable LLM usage accounting",
        "accounting_error",
        providers[0] ?? this.config.defaultProvider,
      );
    }
    const timeoutMs = req.timeoutMs ?? this.config.timeoutMs;
    let lastError: unknown = null;
    const logicalCallId = req.routing?.logicalCallId ?? newLogicalCallId();
    let attemptNumber = req.routing?.attemptBase ?? 0;
    const attribution = mergeUsageAttribution(
      req.tenantId ? { billingAccountId: req.tenantId } : undefined,
      req.attribution,
      // Authenticated server context wins over caller-supplied account and
      // principal dimensions whenever a call originates in an API request.
      currentUsageAttribution(),
    );

    for (const id of providers) {
      const adapter = this.providers.get(id);
      if (!adapter) {
        lastError = new LLMError(
          `Provider not registered: ${id}`,
          "bad_request",
          id,
        );
        continue;
      }

      // A gateway-global default belongs only to its configured provider.
      // Fallback providers use their own catalog default unless the caller
      // explicitly supplied a model.
      const resolvedModel =
        req.model ??
        (id === this.config.defaultProvider
          ? this.config.defaultModel
          : null) ??
        adapter.defaultModel ??
        undefined;

      const temperatureCapabilityKey = resolvedModel
        ? `${id}:${resolvedModel.replace(/^~/, "")}`
        : null;
      let effectiveReq = resolvedModel
        ? normalizeModelRequest(id, resolvedModel, req)
        : req;
      if (
        temperatureCapabilityKey &&
        this.learnedTemperatureUnsupported.has(temperatureCapabilityKey)
      ) {
        effectiveReq = omitTemperature(effectiveReq);
      }
      if (resolvedModel) {
        assertModelSelectable(id, resolvedModel);
        assertModelControls(id, resolvedModel, effectiveReq);
      }
      assertBudgetAvailable(req.tenantId, id);

      const signal = combineSignals(req.signal, timeoutMs);
      const subReq: ChatRequest = {
        ...effectiveReq,
        model: resolvedModel,
        signal,
        providers: undefined,
        provider: id,
        routing: {
          ...req.routing,
          effectiveTimeoutMs: timeoutMs,
          controls: {
            ...(effectiveReq.temperature !== undefined
              ? { temperature: effectiveReq.temperature }
              : {}),
            ...(effectiveReq.maxTokens !== undefined
              ? { maxTokens: effectiveReq.maxTokens }
              : {}),
            ...(effectiveReq.jsonMode !== undefined
              ? { jsonMode: effectiveReq.jsonMode }
              : {}),
            ...(effectiveReq.reasoning !== undefined
              ? { reasoning: effectiveReq.reasoning }
              : {}),
            ...(effectiveReq.verbosity !== undefined
              ? { verbosity: effectiveReq.verbosity }
              : {}),
            ...(effectiveReq.store !== undefined
              ? { store: effectiveReq.store }
              : {}),
          },
        },
      };

      const executeAttempt = async (
        attemptReq: ChatRequest,
      ): Promise<ChatResponse> => {
        attemptNumber += 1;
        const attemptAttribution = mergeUsageAttribution(
          attribution,
          this.config.resolveProviderAttribution?.(id, req.tenantId),
        );
        let ledgerAttempt;
        try {
          ledgerAttempt = startAttempt({
            logicalCallId,
            attempt: attemptNumber,
            tenantId: req.tenantId,
            runId: req.runId,
            stepId: req.stepId,
            purpose: req.purpose,
            provider: id,
            requestedModel: resolvedModel ?? "<unspecified>",
            reasoning: attemptReq.reasoning,
            verbosity: attemptReq.verbosity,
            store: attemptReq.store,
            attribution: attemptAttribution,
            routing: attemptReq.routing,
          });
        } catch (error) {
          throw new LLMError(
            `could not start durable LLM accounting: ${error instanceof Error ? error.message : String(error)}`,
            "accounting_error",
            id,
            error,
          );
        }

        let response: ChatResponse;
        try {
          response = await adapter.chat(attemptReq);
        } catch (error) {
          const providerError = toLLMError(error, id);
          try {
            failAttempt(ledgerAttempt, providerError);
          } catch (ledgerError) {
            throw new LLMError(
              `could not record failed LLM attempt: ${ledgerError instanceof Error ? ledgerError.message : String(ledgerError)}`,
              "accounting_error",
              id,
              ledgerError,
            );
          }
          throw providerError;
        }

        const usage = normalizeUsage(response);
        const cost = calculateCost({
          provider: id,
          model: response.model || resolvedModel || "<unspecified>",
          usage,
          providerReportedCostUsd: response.providerReportedCostUsd,
        });
        const normalized: ChatResponse = {
          ...response,
          tokensIn: usage.available === false ? null : usage.inputTokens,
          tokensOut: usage.available === false ? null : usage.outputTokens,
          usage,
          cost,
          routing: attemptReq.routing,
        };
        try {
          finishAttempt(ledgerAttempt, normalized, usage, cost);
        } catch (error) {
          // This is deliberately non-transient: the provider already ran, so
          // an accounting failure must never trigger an internal model retry.
          throw new LLMError(
            `could not finalize durable LLM accounting: ${error instanceof Error ? error.message : String(error)}`,
            "accounting_error",
            id,
            error,
          );
        }
        return normalized;
      };

      try {
        return await executeAttempt(subReq);
      } catch (err1) {
        let e1 = toLLMError(err1, id);
        let retryReq = subReq;
        if (
          retryReq.temperature !== undefined &&
          isUnsupportedTemperatureError(e1)
        ) {
          if (temperatureCapabilityKey) {
            this.learnedTemperatureUnsupported.add(temperatureCapabilityKey);
          }
          retryReq = omitTemperature(retryReq);
          try {
            return await executeAttempt({
              ...retryReq,
              routing: {
                ...retryReq.routing,
                retryReason: "unsupported_temperature_parameter",
              },
            });
          } catch (compatibilityErr) {
            e1 = toLLMError(compatibilityErr, id);
          }
        }
        if (!e1.transient) throw e1;
        const maxAttempts = boundedAttempts(
          req.retryPolicy?.maxAttempts ?? this.config.maxAttempts ?? 2,
        );
        const baseBackoffMs = boundedBackoff(
          req.retryPolicy?.baseBackoffMs ?? this.config.baseBackoffMs ?? 250,
        );
        lastError = e1;
        for (let transientAttempt = 2; transientAttempt <= maxAttempts; transientAttempt += 1) {
          await delay(baseBackoffMs * 2 ** (transientAttempt - 2));
          try {
            const signal2 = combineSignals(req.signal, timeoutMs);
            return await executeAttempt({
              ...retryReq,
              signal: signal2,
              routing: {
                ...retryReq.routing,
                retryReason: `transient_${e1.code}`,
              },
            });
          } catch (retryError) {
            const normalizedRetry = toLLMError(retryError, id);
            lastError = normalizedRetry;
            if (!normalizedRetry.transient) throw normalizedRetry;
          }
        }
        // Continue to the next provider after this provider's policy is spent.
      }
    }

    if (isLLMError(lastError)) throw lastError;
    throw new LLMError(
      "All providers failed",
      "provider_error",
      providers[0] ?? this.config.defaultProvider,
      lastError,
    );
  }

  private resolveProviderChain(req: ChatRequest): ProviderId[] {
    if (req.providers && req.providers.length > 0) return [...req.providers];
    if (req.provider) return [req.provider];
    return [this.config.defaultProvider];
  }
}

function toLLMError(err: unknown, provider: ProviderId): LLMError {
  if (isLLMError(err)) return err;
  const msg = err instanceof Error ? err.message : String(err);
  return new LLMError(msg, "provider_error", provider, err);
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function boundedAttempts(value: number): number {
  return Number.isInteger(value) ? Math.max(1, Math.min(5, value)) : 2;
}

function boundedBackoff(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(30_000, value)) : 250;
}

/**
 * Compose a caller-provided AbortSignal with a timeout. Returns a fresh
 * signal aborted when EITHER fires. Uses native AbortSignal.any when
 * available (Node ≥20), with a polyfill for older runtimes.
 */
function combineSignals(
  caller: AbortSignal | undefined,
  timeoutMs: number,
): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!caller) return timeout;
  const anyFn = (
    AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }
  ).any;
  if (typeof anyFn === "function") return anyFn([caller, timeout]);
  // Polyfill
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  caller.addEventListener("abort", onAbort, { once: true });
  timeout.addEventListener("abort", onAbort, { once: true });
  return ac.signal;
}
