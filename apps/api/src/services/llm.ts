/**
 * Singleton LLM gateway for the API process.
 *
 * Constructed lazily on first access from `process.env` overlaid with the
 * provider-key vault (so keys saved via the Settings UI take effect without
 * editing `.env`). `resetLLMGateway()` drops the singleton so the next call
 * picks up vault changes — invoked after POST /v1/llm/providers/:id/key.
 */

import { LLMGateway, registerAllProviders, resolveConfig, setGatewayCallSink } from "@agentic/llm-gateway";
import { getProviderKeyEnvOverlay } from "./provider-keys";
import { writeLlmCall } from "./agent-factory/llm-telemetry";

let _gateway: LLMGateway | null = null;

function buildEnv(): Record<string, string | undefined> {
  return { ...process.env, ...getProviderKeyEnvOverlay() };
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
    writeLlmCall({
      conversationId: "runtime",
      tenantId: rec.tenantId,
      purpose: rec.purpose ?? "runtime",
      requestedModel: rec.requestedModel,
      servedModel: rec.servedModel,
      provider: rec.provider,
      fallback: !!(rec.requestedModel && rec.servedModel && rec.requestedModel !== rec.servedModel),
      approxTokensIn: rec.tokensIn ?? undefined,
      approxTokensOut: rec.tokensOut ?? undefined,
      latencyMs: rec.latencyMs,
      ok: rec.ok,
      failureReason: rec.failureReason,
    } as Parameters<typeof writeLlmCall>[0]);
  });
  _gateway = g;
  return g;
}

/**
 * Drop the cached gateway so the next `getLLMGateway()` call rebuilds with
 * the current vault contents. Called after a provider key is saved/rotated.
 */
export function resetLLMGateway(): void {
  _gateway = null;
}

/** Test-only — replace the singleton with a custom instance. */
export function _setLLMGatewayForTests(g: LLMGateway | null): void {
  _gateway = g;
}
