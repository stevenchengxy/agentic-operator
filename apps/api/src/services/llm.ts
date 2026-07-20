/**
 * Singleton LLM gateway for the API process.
 *
 * Constructed lazily on first access from `process.env` overlaid with the
 * provider-key vault (so keys saved via the Settings UI take effect without
 * editing `.env`). `resetLLMGateway()` drops the singleton so the next call
 * picks up vault changes — invoked after POST /v1/llm/providers/:id/key.
 */

import {
  LLMGateway,
  registerAllProviders,
  resolveConfig,
  setGatewayCallSink,
} from "@agentic/llm-gateway";
import type { ProviderId } from "@agentic/contracts";
import { getProviderKeyEnvOverlay } from "./provider-keys";
import { writeLlmCall } from "./agent-factory/llm-telemetry";
import { testProviderKey } from "./provider-test";

let _gateway: LLMGateway | null = null;
let _providerReadiness: DefaultProviderReadiness | null = null;
let _providerProbe: Promise<DefaultProviderReadiness> | null = null;

function buildEnv(): Record<string, string | undefined> {
  return { ...process.env, ...getProviderKeyEnvOverlay() };
}

const PROVIDER_KEY_ENV: Partial<Record<ProviderId, string>> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  gemini: "GOOGLE_API_KEY",
  mistral: "MISTRAL_API_KEY",
  groq: "GROQ_API_KEY",
  together: "TOGETHER_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  qwen: "QWEN_API_KEY",
  azure: "AZURE_OPENAI_API_KEY",
  custom: "CUSTOM_LLM_API_KEY",
};

export interface DefaultProviderReadiness {
  ok: boolean;
  provider: ProviderId;
  model: string | null;
  reachable: boolean;
  checkedAt: number;
  latencyMs: number;
  statusCode: number | null;
  /** Stable, non-sensitive classification; upstream bodies are never exposed. */
  note?:
    | "credential_missing"
    | "auth_rejected"
    | "rate_limited"
    | "upstream_error"
    | "unreachable";
}

/**
 * Prove the configured default provider accepts the real credential without
 * spending completion tokens. The provider test uses a list-models/auth
 * endpoint. Results are cached briefly for /health, while bootstrap forces a
 * fresh probe. No key, URL query, or upstream response body leaves this module.
 */
export async function probeDefaultLLMProvider(
  opts: {
    force?: boolean;
    maxAgeMs?: number;
  } = {},
): Promise<DefaultProviderReadiness> {
  const maxAgeMs = Math.max(0, opts.maxAgeMs ?? 60_000);
  if (
    !opts.force &&
    _providerReadiness &&
    Date.now() - _providerReadiness.checkedAt <= maxAgeMs
  ) {
    return _providerReadiness;
  }
  if (_providerProbe) return _providerProbe;
  _providerProbe = (async () => {
    const gateway = getLLMGateway();
    const provider = gateway.defaultProvider;
    const model = gateway.defaultModel;
    const checkedAt = Date.now();
    const env = buildEnv();
    const keyName = PROVIDER_KEY_ENV[provider];
    const key =
      provider === "mock"
        ? "test-only-probe"
        : keyName
          ? env[keyName]?.trim()
          : undefined;
    if (!key) {
      return {
        ok: false,
        provider,
        model,
        reachable: false,
        checkedAt,
        latencyMs: 0,
        statusCode: null,
        note: "credential_missing" as const,
      };
    }
    const result = await testProviderKey(provider, key);
    const note = result.ok
      ? undefined
      : result.statusCode === 401 || result.statusCode === 403
        ? ("auth_rejected" as const)
        : result.statusCode === 429
          ? ("rate_limited" as const)
          : result.statusCode != null && result.statusCode >= 500
            ? ("upstream_error" as const)
            : ("unreachable" as const);
    return {
      ok: result.ok,
      provider,
      model,
      reachable: result.statusCode != null,
      checkedAt,
      latencyMs: result.latencyMs,
      statusCode: result.statusCode,
      ...(note ? { note } : {}),
    };
  })();
  try {
    _providerReadiness = await _providerProbe;
    return _providerReadiness;
  } finally {
    _providerProbe = null;
  }
}

export async function assertDefaultLLMProviderReachable(
  context: string,
): Promise<DefaultProviderReadiness> {
  const readiness = await probeDefaultLLMProvider({ force: true, maxAgeMs: 0 });
  if (!readiness.ok) {
    throw new Error(
      `${context}: default LLM provider ${readiness.provider} failed its credential/connectivity probe` +
        `${readiness.statusCode == null ? "" : ` (HTTP ${readiness.statusCode})`}`,
    );
  }
  return readiness;
}

export function getLLMGateway(): LLMGateway {
  if (_gateway) return _gateway;
  const { gateway: cfg, adapterEnv } = resolveConfig(buildEnv());
  const g = new LLMGateway(cfg);
  registerAllProviders(g, adapterEnv);
  // G6 双推理面统一遥测（附录 B）：运行时面（llm-gateway）的每次调用也进 llm_calls——
  // 与系统 A 的 stream-gateway 并表，全平台 LLM 开销/降级/失败一张表可答。
  // conversationId 固定 "runtime" 作面标记；purpose 由调用方标注（agent:xxx）。best-effort。
  setGatewayCallSink((rec) => {
    const providerMeasured =
      Number.isSafeInteger(rec.tokensIn) &&
      (rec.tokensIn ?? -1) >= 0 &&
      Number.isSafeInteger(rec.tokensOut) &&
      (rec.tokensOut ?? -1) >= 0;
    writeLlmCall({
      conversationId: "runtime",
      tenantId: rec.tenantId,
      runId: rec.runId,
      purpose: rec.purpose ?? "runtime",
      requestedModel: rec.requestedModel,
      servedModel: rec.servedModel,
      provider: rec.provider,
      fallback: !!(
        rec.requestedModel &&
        rec.servedModel &&
        rec.requestedModel !== rec.servedModel
      ),
      approxTokensIn: rec.tokensIn ?? undefined,
      approxTokensOut: rec.tokensOut ?? undefined,
      // A successful model response does not imply that the provider exposed
      // usage. Only mark a row as provider-measured when both token counters
      // are actually present; otherwise provenance remains unknown.
      tokenSource: providerMeasured ? "provider" : undefined,
      latencyMs: rec.latencyMs,
      ok: rec.ok,
      failureReason: rec.failureReason,
    } as Parameters<typeof writeLlmCall>[0]);
  });
  _gateway = g;
  return g;
}

/**
 * Fail closed when a production-reachable action would run on the canned
 * mock adapter or on an adapter without credentials. Test processes retain
 * the explicit mock provider for deterministic fixtures.
 */
export function assertRealLLMGateway(
  context: string,
  gateway: LLMGateway = getLLMGateway(),
): void {
  if (process.env.NODE_ENV === "test") return;
  const provider = gateway.defaultProvider;
  const model = gateway.defaultModel?.trim() ?? "";
  if (provider === "mock" || /(^|[\s/_-])mock([\s/_-]|$)/i.test(model)) {
    throw new Error(
      `${context}: 拒绝使用 mock LLM（provider=${provider}, model=${model || "(unset)"}）。` +
        "请配置真实 LLM_DEFAULT_PROVIDER/LLM_DEFAULT_MODEL 后重试。",
    );
  }
  const info = gateway.listProviders().find((p) => p.id === provider);
  if (!info?.hasKey) {
    throw new Error(
      `${context}: LLM provider ${provider} 未配置可用凭据/端点，拒绝启动会退化的运行。`,
    );
  }
  if (!model) {
    throw new Error(
      `${context}: LLM_DEFAULT_MODEL 未配置，无法证明请求会落到真实模型。`,
    );
  }
}

/**
 * Drop the cached gateway so the next `getLLMGateway()` call rebuilds with
 * the current vault contents. Called after a provider key is saved/rotated.
 */
export function resetLLMGateway(): void {
  _gateway = null;
  _providerReadiness = null;
  _providerProbe = null;
}

/** Test-only — replace the singleton with a custom instance. */
export function _setLLMGatewayForTests(g: LLMGateway | null): void {
  _gateway = g;
  _providerReadiness = null;
  _providerProbe = null;
}
