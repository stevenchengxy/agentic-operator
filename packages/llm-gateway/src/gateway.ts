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
import { assertBudgetAvailable, recordActualSpend } from "./budget";


// ── G6 双推理面统一遥测（附录 B）——系统 B 的推理面也进 llm_calls ────────────────────
// stream-gateway（系统 A）早已全量落表；这里给运行时面同款钩子：apps/api 在构造单例时
// setGatewayCallSink(writeLlmCall 适配器)，每次 chat() 成/败都出一条记录。best-effort。

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
}

let gatewayCallSink: ((rec: GatewayCallRecord) => void) | null = null;
export function setGatewayCallSink(fn: ((rec: GatewayCallRecord) => void) | null): void {
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
    try {
      const res = await this.chatInner(req);
      try {
        gatewayCallSink?.({ provider: res.provider, requestedModel: req.model ?? undefined, servedModel: res.model, latencyMs: Date.now() - started, tokensIn: res.tokensIn ?? null, tokensOut: res.tokensOut ?? null, ok: true, purpose: req.purpose, tenantId: req.tenantId });
      } catch { /* telemetry best-effort */ }
      return res;
    } catch (err) {
      try {
        const le = err as { provider?: string; code?: string; message?: string };
        gatewayCallSink?.({ provider: le?.provider ?? "unknown", requestedModel: req.model ?? undefined, latencyMs: Date.now() - started, ok: false, failureReason: (le?.code ?? le?.message ?? String(err)).slice(0, 120), purpose: req.purpose, tenantId: req.tenantId });
      } catch { /* telemetry best-effort */ }
      throw err;
    }
  }

  private async chatInner(req: ChatRequest): Promise<ChatResponse> {
    const providers = this.resolveProviderChain(req);
    const timeoutMs = req.timeoutMs ?? this.config.timeoutMs;
    // Env-supplied model wins over adapter's catalog default when caller didn't specify.
    const resolvedModel = req.model ?? this.config.defaultModel ?? undefined;
    let lastError: unknown = null;

    // P1-LLM-05: per-tenant budget hook. Throws cost_limit_exceeded BEFORE
    // we run any adapter when the tenant is already over either cap. The
    // post-call deduction uses the adapter's actual token usage.
    if (req.tenantId) {
      assertBudgetAvailable(req.tenantId, providers[0] ?? this.config.defaultProvider);
    }

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

      const finish = (response: ChatResponse): ChatResponse => {
        if (req.tenantId) {
          recordActualSpend({
            tenantId: req.tenantId,
            provider: id,
            tokensIn: response.tokensIn ?? 0,
            tokensOut: response.tokensOut ?? 0,
          });
        }
        return response;
      };

      try {
        return finish(await adapter.chat(subReq));
      } catch (err1) {
        const e1 = toLLMError(err1, id);
        if (!e1.transient) throw e1;
        // One retry with backoff
        await delay(250);
        try {
          const signal2 = combineSignals(req.signal, timeoutMs);
          return finish(await adapter.chat({ ...subReq, signal: signal2 }));
        } catch (err2) {
          const e2 = toLLMError(err2, id);
          lastError = e2;
          if (!e2.transient) throw e2;
          // Continue to next provider
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

/**
 * Compose a caller-provided AbortSignal with a timeout. Returns a fresh
 * signal aborted when EITHER fires. Uses native AbortSignal.any when
 * available (Node ≥20), with a polyfill for older runtimes.
 */
function combineSignals(caller: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!caller) return timeout;
  const anyFn = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (typeof anyFn === "function") return anyFn([caller, timeout]);
  // Polyfill
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  caller.addEventListener("abort", onAbort, { once: true });
  timeout.addEventListener("abort", onAbort, { once: true });
  return ac.signal;
}
