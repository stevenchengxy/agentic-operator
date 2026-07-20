/**
 * Uniform error model. Every adapter wraps its native errors into LLMError
 * with one of these discriminated codes so the gateway can decide failover
 * (transient codes only) vs fail-fast (non-transient).
 */

import type { ProviderId } from "./types";

export type LLMErrorCode =
  | "auth"               // 401/403, bad API key
  | "rate_limit"         // 429
  | "timeout"            // request exceeded timeoutMs
  | "model_not_found"    // 404 / unknown model
  | "bad_request"        // 400 / invalid params
  | "provider_error"     // 5xx from upstream
  | "network"            // ECONNRESET, DNS failure
  | "not_configured"     // real adapter lacks required credentials/config
  | "cost_limit_exceeded" // P1-LLM-05 — tenant exceeded monthly budget cap
  | "budget_storage";    // durable reservation/accounting store unavailable

const TRANSIENT: ReadonlySet<LLMErrorCode> = new Set([
  "rate_limit",
  "timeout",
  "network",
  "provider_error",
]);

export class LLMError extends Error {
  override readonly name = "LLMError";

  constructor(
    message: string,
    readonly code: LLMErrorCode,
    readonly provider: ProviderId,
    override readonly cause?: unknown,
  ) {
    super(message);
  }

  get transient(): boolean {
    return TRANSIENT.has(this.code);
  }

  toJSON(): {
    name: string;
    code: LLMErrorCode;
    provider: ProviderId;
    message: string;
  } {
    return {
      name: this.name,
      code: this.code,
      provider: this.provider,
      message: this.message,
    };
  }
}

export function isLLMError(err: unknown): err is LLMError {
  return err instanceof LLMError;
}

/**
 * Best-effort classification for unknown SDK errors. Used by adapters when
 * the underlying SDK throws a generic Error / status-bearing object.
 */
export function classifyHttpError(
  status: number | undefined,
  provider: ProviderId,
  message: string,
  cause?: unknown,
): LLMError {
  if (status === undefined) {
    return new LLMError(message, "provider_error", provider, cause);
  }
  if (status === 401 || status === 403)
    return new LLMError(message, "auth", provider, cause);
  if (status === 404)
    return new LLMError(message, "model_not_found", provider, cause);
  if (status === 429)
    return new LLMError(message, "rate_limit", provider, cause);
  if (status >= 400 && status < 500)
    return new LLMError(message, "bad_request", provider, cause);
  if (status >= 500)
    return new LLMError(message, "provider_error", provider, cause);
  return new LLMError(message, "provider_error", provider, cause);
}
