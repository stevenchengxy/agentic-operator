/**
 * Provider + served-model pricing resolution.
 *
 * This is the only runtime price resolver used by gateway budget deduction
 * and API usage reconciliation. It deliberately has no provider-average or
 * unknown-model fallback: applying a plausible-looking default price makes a
 * USD budget unenforceable while presenting the result as real accounting.
 *
 * Operators can override or add authoritative prices without a code release:
 *
 *   AGENTIC_LLM_MODEL_PRICING_JSON='{
 *     "custom/my-model":{"inCents":120,"outCents":480},
 *     "openrouter/*":{"inCents":200,"outCents":800}
 *   }'
 *
 * Values are integer/fractional USD cents per one million tokens. Exact
 * provider/model entries win over provider wildcards, which win over the
 * shared catalog. Unknown models remain unpriced unless explicitly configured.
 */

import {
  PROVIDER_IDS,
  PROVIDER_MODEL_CATALOG,
  type ProviderId,
} from "@agentic/contracts";

export interface ModelTokenPricing {
  provider: ProviderId;
  model: string;
  inCentsPerMTok: number;
  outCentsPerMTok: number;
  source: "operator_override" | "catalog";
}

export interface EstimatedTokenCost {
  usdCents: number;
  pricing: ModelTokenPricing;
}

interface PricePair {
  inCents: number;
  outCents: number;
}

const PROVIDER_SET = new Set<string>(PROVIDER_IDS);
let cachedRaw: string | undefined;
let cachedOverrides = new Map<string, PricePair>();

function pricingEnvRaw(): string | undefined {
  const raw = process.env.AGENTIC_LLM_MODEL_PRICING_JSON;
  return raw?.trim() ? raw.trim() : undefined;
}

function overrideKey(provider: ProviderId, model: string): string {
  return `${provider}/${model}`;
}

function parseOverrideKey(raw: string): { provider: ProviderId; model: string } {
  const slash = raw.indexOf("/");
  const provider = slash > 0 ? raw.slice(0, slash).trim() : "";
  const model = slash > 0 ? raw.slice(slash + 1).trim() : "";
  if (!PROVIDER_SET.has(provider) || !model) {
    throw new Error(
      `AGENTIC_LLM_MODEL_PRICING_JSON key '${raw}' must be '<provider>/<served-model>' or '<provider>/*'`,
    );
  }
  return { provider: provider as ProviderId, model };
}

function overrides(): Map<string, PricePair> {
  const raw = pricingEnvRaw();
  if (raw === cachedRaw) return cachedOverrides;
  if (!raw) {
    cachedRaw = undefined;
    cachedOverrides = new Map();
    return cachedOverrides;
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch (error) {
    throw new Error("AGENTIC_LLM_MODEL_PRICING_JSON must be valid JSON", {
      cause: error,
    });
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new Error("AGENTIC_LLM_MODEL_PRICING_JSON must be a JSON object");
  }

  const next = new Map<string, PricePair>();
  for (const [rawKey, rawValue] of Object.entries(decoded)) {
    const { provider, model } = parseOverrideKey(rawKey);
    if (!rawValue || typeof rawValue !== "object" || Array.isArray(rawValue)) {
      throw new Error(`pricing override '${rawKey}' must be an object`);
    }
    const value = rawValue as Record<string, unknown>;
    const inCents = Number(value.inCents);
    const outCents = Number(value.outCents);
    if (
      !Number.isFinite(inCents) ||
      inCents < 0 ||
      !Number.isFinite(outCents) ||
      outCents < 0
    ) {
      throw new Error(
        `pricing override '${rawKey}' requires finite non-negative inCents/outCents`,
      );
    }
    next.set(overrideKey(provider, model), { inCents, outCents });
  }
  cachedRaw = raw;
  cachedOverrides = next;
  return cachedOverrides;
}

function providerId(value: string | null | undefined): ProviderId | null {
  const normalized = value?.trim().toLowerCase() ?? "";
  return PROVIDER_SET.has(normalized) ? (normalized as ProviderId) : null;
}

function fromProvider(
  provider: ProviderId,
  model: string,
  allowWildcard = true,
): ModelTokenPricing | null {
  const configured = overrides();
  const exact = configured.get(overrideKey(provider, model));
  const wildcard = allowWildcard
    ? configured.get(overrideKey(provider, "*"))
    : undefined;
  const override = exact ?? wildcard;
  if (override) {
    return {
      provider,
      model,
      inCentsPerMTok: override.inCents,
      outCentsPerMTok: override.outCents,
      source: "operator_override",
    };
  }

  const catalog = PROVIDER_MODEL_CATALOG[provider].find(
    (candidate) => candidate.name === model,
  );
  if (!catalog) return null;
  return {
    provider,
    model,
    inCentsPerMTok: catalog.inP * 100,
    outCentsPerMTok: catalog.outP * 100,
    source: "catalog",
  };
}

/** Resolve an exact provider + served model. When provider is unavailable
 * (legacy runs), a model is accepted only if every matching provider has the
 * same price; ambiguous model names remain unpriced. */
export function resolveModelTokenPricing(args: {
  provider?: string | null;
  model?: string | null;
}): ModelTokenPricing | null {
  const model = args.model?.trim() ?? "";
  if (!model) return null;
  const provider = providerId(args.provider);
  if (provider) return fromProvider(provider, model);

  const matches: ModelTokenPricing[] = [];
  for (const candidateProvider of PROVIDER_IDS) {
    // A provider wildcard is authoritative only when that provider identity
    // is present. Applying it to a legacy provider-less run would guess which
    // upstream served the model and recreate the very fake fallback this
    // resolver exists to remove.
    const match = fromProvider(candidateProvider, model, false);
    if (match) matches.push(match);
  }
  if (matches.length === 0) return null;
  const first = matches[0]!;
  const unambiguous = matches.every(
    (match) =>
      match.inCentsPerMTok === first.inCentsPerMTok &&
      match.outCentsPerMTok === first.outCentsPerMTok,
  );
  return unambiguous ? first : null;
}

/** Estimate using the exact resolved price. Null means pricing is unknown;
 * callers must surface that incompleteness or fail closed for a USD cap. */
export function estimateTokenCostCents(args: {
  provider?: string | null;
  model?: string | null;
  tokensIn: number;
  tokensOut: number;
}): EstimatedTokenCost | null {
  const pricing = resolveModelTokenPricing(args);
  if (!pricing) return null;
  const tokensIn = Number.isFinite(args.tokensIn) ? Math.max(0, args.tokensIn) : 0;
  const tokensOut = Number.isFinite(args.tokensOut) ? Math.max(0, args.tokensOut) : 0;
  return {
    // Round each durable accounting unit upward so repeated small calls do not
    // systematically evade a cents-denominated budget.
    usdCents: Math.ceil(
      (tokensIn * pricing.inCentsPerMTok +
        tokensOut * pricing.outCentsPerMTok) /
        1_000_000,
    ),
    pricing,
  };
}
