/**
 * LLMGateway — single entry point for all LLM calls.
 *
 * Responsibilities:
 *   - Provider registry (in-process Map of ProviderId → Adapter)
 *   - chat() dispatch with provider resolution, failover, timeout, retry
 *   - Surface configured providers (for /v1/llm/providers)
 *
 * Not responsible for: persistence (BaseAgent + step engine handle that),
 * audit logging (caller writes to audit_log with the response metadata),
 * cost calculation (derived elsewhere from tokens × prices).
 */

import { PROVIDER_MODEL_CATALOG, type ProviderId } from "@agentic/contracts";
import type {
  ChatRequest,
  ChatResponse,
  GatewayConfig,
  ProviderAdapter,
  ProviderInfo,
} from "./types";
import { LLMError, isLLMError } from "./errors";
import {
  releaseBudgetReservation,
  reserveBudget,
  settleBudgetReservation,
} from "./budget";

// ── G6 双推理面统一遥测（附录 B）——系统 B 的推理面也进 llm_calls ────────────────────
// stream-gateway（系统 A）早已全量落表；这里给运行时面同款钩子：apps/api 在构造单例时
// setGatewayCallSink(writeLlmCall 适配器)，每次 chat() 成/败都必须进入一个耐久存储层。

export interface GatewayCallRecord {
  provider: string;
  requestedModel?: string;
  servedModel?: string;
  latencyMs: number;
  tokensIn?: number | null;
  tokensOut?: number | null;
  ok: boolean;
  failureReason?: string;
  purpose?: string;
  tenantId?: string;
  runId?: string;
}

let gatewayCallSink: ((rec: GatewayCallRecord) => void | Promise<void>) | null =
  null;
export function setGatewayCallSink(
  fn: ((rec: GatewayCallRecord) => void | Promise<void>) | null,
): void {
  gatewayCallSink = fn;
}

export class LLMGateway {
  private readonly providers = new Map<ProviderId, ProviderAdapter>();

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

  /** Whether this process explicitly permits the deterministic test adapter. */
  get allowMock(): boolean {
    // Config is not an authority to enable synthetic inference in a real process. Hand-constructed
    // gateways are held to the same invariant as resolveConfig(); only the test process may opt in.
    return (
      process.env.NODE_ENV === "test" &&
      (this.config.allowMock === true || this.config.defaultProvider === "mock")
    );
  }

  listProviders(): ProviderInfo[] {
    const out: ProviderInfo[] = [];
    for (const [id, adapter] of this.providers) {
      const catalog = PROVIDER_MODEL_CATALOG[id] ?? [];
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
    const started = Date.now();
    let res: ChatResponse;
    try {
      res = await this.chatInner(req);
    } catch (err) {
      try {
        const le = err as {
          provider?: string;
          code?: string;
          message?: string;
        };
        await gatewayCallSink?.({
          provider: le?.provider ?? "unknown",
          requestedModel: req.model ?? undefined,
          latencyMs: Date.now() - started,
          ok: false,
          failureReason: (le?.code ?? le?.message ?? String(err)).slice(0, 120),
          purpose: req.purpose,
          tenantId: req.tenantId,
          runId: req.runId,
        });
      } catch (telemetryError) {
        throw new AggregateError(
          [err, telemetryError],
          "LLM call failed and its telemetry could not be durably recorded",
        );
      }
      throw err;
    }

    // A successful provider response is not reported as successful until its
    // telemetry sink confirms durability (database or its durable outbox).
    await gatewayCallSink?.({
      provider: res.provider,
      requestedModel: req.model ?? undefined,
      servedModel: res.model,
      latencyMs: Date.now() - started,
      tokensIn: res.tokensIn ?? null,
      tokensOut: res.tokensOut ?? null,
      ok: true,
      purpose: req.purpose,
      tenantId: req.tenantId,
      runId: req.runId,
    });
    return res;
  }

  private async chatInner(req: ChatRequest): Promise<ChatResponse> {
    const providers = this.resolveProviderChain(req);
    const timeoutMs = req.timeoutMs ?? this.config.timeoutMs;
    // Env-supplied model wins over adapter's catalog default when caller didn't specify.
    const resolvedModel = req.model ?? this.config.defaultModel ?? undefined;
    let lastError: unknown = null;

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

      const signal = combineSignals(req.signal, timeoutMs);
      const subReq: ChatRequest = {
        ...req,
        model: resolvedModel,
        signal,
        providers: undefined,
        provider: id,
      };

      const validate = (response: ChatResponse): ChatResponse => {
        if (response.provider !== id) {
          throw new LLMError(
            `Provider adapter '${id}' returned mismatched provider '${response.provider}'`,
            "provider_error",
            id,
          );
        }
        if (!response.model || !response.model.trim()) {
          throw new LLMError(
            `Provider adapter '${id}' returned an empty served model`,
            "provider_error",
            id,
          );
        }
        for (const [label, value] of [
          ["tokensIn", response.tokensIn],
          ["tokensOut", response.tokensOut],
        ] as const) {
          if (value !== null && (!Number.isFinite(value) || value < 0)) {
            throw new LLMError(
              `Provider adapter '${id}' returned invalid ${label}=${String(value)}`,
              "provider_error",
              id,
            );
          }
        }
        return response;
      };

      // Reserve two complete attempt envelopes before touching the provider.
      // A timed-out first attempt can still be billed upstream before retry.
      const reservation = reserveBudget({
        tenantId: req.tenantId,
        provider: id,
        model: resolvedModel ?? adapter.defaultModel,
        request: subReq,
        timeoutMs,
        maxAttempts: 2,
      });
      let settled = false;
      let preserveLease = false;
      let releaseOutcome = "provider_failed";
      let uncertainAttempts = 0;

      const settle = (args: {
        servedModel: string;
        tokensIn: number;
        tokensOut: number;
      }): void => {
        try {
          settleBudgetReservation({
            reservation,
            ...args,
            uncertainAttempts,
          });
        } catch (error) {
          // A provider may already have billed the call. If durable settlement
          // is unavailable, leave the lease active so expiry accounts the full
          // envelope; releasing it here would silently reopen spend capacity.
          if (isLLMError(error) && error.code === "budget_storage") {
            preserveLease = true;
          }
          throw error;
        }
        settled = true;
      };

      const finish = (response: ChatResponse): ChatResponse => {
        settle({
          servedModel: response.model,
          tokensIn: response.tokensIn ?? 0,
          tokensOut: response.tokensOut ?? 0,
        });
        return response;
      };

      try {
        try {
          return finish(validate(await adapter.chat(subReq)));
        } catch (err1) {
          const e1 = toLLMError(err1, id);
          releaseOutcome = e1.code;
          if (!e1.transient) throw e1;
          if (couldHaveBeenBilled(e1)) uncertainAttempts += 1;
          // One retry with backoff. Both potentially billable attempts have a
          // separate envelope inside the same atomic reservation.
          await delay(250);
          try {
            const signal2 = combineSignals(req.signal, timeoutMs);
            return finish(
              validate(await adapter.chat({ ...subReq, signal: signal2 })),
            );
          } catch (err2) {
            const e2 = toLLMError(err2, id);
            releaseOutcome = e2.code;
            if (couldHaveBeenBilled(e2)) uncertainAttempts += 1;
            if (uncertainAttempts > 0) {
              // Both failure and fallback paths must account for requests
              // that may have completed upstream after our connection died.
              settle({
                servedModel: reservation?.model ?? resolvedModel ?? "",
                tokensIn: 0,
                tokensOut: 0,
              });
            }
            lastError = e2;
            if (!e2.transient) throw e2;
            // Continue to next provider after finally releases this provider's
            // capacity; the next candidate gets its own priced reservation.
          }
        }
      } finally {
        if (!settled && !preserveLease) {
          releaseBudgetReservation(reservation, releaseOutcome);
        }
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
    const chain =
      req.providers && req.providers.length > 0
        ? [...req.providers]
        : req.provider
          ? [req.provider]
          : [this.config.defaultProvider];
    if (!this.allowMock && chain.includes("mock")) {
      throw new LLMError(
        "Mock provider is disabled in this process; configure a real provider or run tests with NODE_ENV=test",
        "not_configured",
        "mock",
      );
    }
    return chain;
  }
}

function couldHaveBeenBilled(error: LLMError): boolean {
  return (
    error.code === "timeout" ||
    error.code === "network" ||
    error.code === "provider_error"
  );
}

function toLLMError(err: unknown, provider: ProviderId): LLMError {
  if (isLLMError(err)) return err;
  const msg = err instanceof Error ? err.message : String(err);
  return new LLMError(msg, "provider_error", provider, err);
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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
