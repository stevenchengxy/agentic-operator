import {
  findCatalogModel,
  type CatalogPricing,
  type ProviderId,
} from "@agentic/contracts";
import type { ChatResponse, CostBreakdown, TokenUsage } from "./types";

const USD_NANOS = 1_000_000_000;

function nonNegative(value: number | null | undefined): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value ?? 0)) : 0;
}

/** Fill the detailed usage shape for legacy adapters while retaining raw data. */
export function normalizeUsage(response: ChatResponse): TokenUsage {
  if (response.usage) {
    const usage = response.usage;
    const inputTokens = nonNegative(usage.inputTokens);
    const outputTokens = nonNegative(usage.outputTokens);
    return {
      available: true,
      inputTokens,
      outputTokens,
      totalTokens: nonNegative(usage.totalTokens) || inputTokens + outputTokens,
      cachedInputTokens: nonNegative(usage.cachedInputTokens),
      cacheWriteInputTokens: nonNegative(usage.cacheWriteInputTokens),
      cacheWrite5mInputTokens: nonNegative(usage.cacheWrite5mInputTokens),
      cacheWrite1hInputTokens: nonNegative(usage.cacheWrite1hInputTokens),
      reasoningTokens: nonNegative(usage.reasoningTokens),
      inputAudioTokens: nonNegative(usage.inputAudioTokens),
      outputAudioTokens: nonNegative(usage.outputAudioTokens),
      raw: usage.raw,
    };
  }
  const inputTokens = nonNegative(response.tokensIn);
  const outputTokens = nonNegative(response.tokensOut);
  return {
    available: response.tokensIn !== null && response.tokensOut !== null,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    cacheWrite5mInputTokens: 0,
    cacheWrite1hInputTokens: 0,
    reasoningTokens: 0,
    inputAudioTokens: 0,
    outputAudioTokens: 0,
  };
}

function activePrice(
  prices: CatalogPricing[],
  at: Date,
): CatalogPricing | undefined {
  const timestamp = at.getTime();
  return prices.find((price) => {
    const from = price.effectiveFrom
      ? Date.parse(price.effectiveFrom)
      : -Infinity;
    const to = price.effectiveTo ? Date.parse(price.effectiveTo) : Infinity;
    return timestamp >= from && timestamp <= to;
  });
}

function nanos(tokens: number, usdPerMillionTokens: number): number {
  // USD/Mtoken × tokens × 1e9 nanos/USD ÷ 1e6 tokens = ×1000.
  return Math.round(tokens * usdPerMillionTokens * 1_000);
}

export function calculateCost(args: {
  provider: ProviderId;
  model: string;
  usage: TokenUsage;
  providerReportedCostUsd?: number;
  at?: Date;
}): CostBreakdown {
  if (
    args.providerReportedCostUsd !== undefined &&
    Number.isFinite(args.providerReportedCostUsd) &&
    args.providerReportedCostUsd >= 0
  ) {
    return {
      totalUsdNanos: Math.round(args.providerReportedCostUsd * USD_NANOS),
      inputUsdNanos: null,
      cachedInputUsdNanos: null,
      cacheWriteUsdNanos: null,
      outputUsdNanos: null,
      source: "provider",
    };
  }

  if (args.usage.available === false) {
    return {
      totalUsdNanos: null,
      inputUsdNanos: null,
      cachedInputUsdNanos: null,
      cacheWriteUsdNanos: null,
      outputUsdNanos: null,
      source: "unpriced",
    };
  }

  const model = findCatalogModel(args.provider, args.model);
  const price = model?.pricing
    ? activePrice(model.pricing, args.at ?? new Date())
    : undefined;
  if (!model || !price) {
    return {
      totalUsdNanos: null,
      inputUsdNanos: null,
      cachedInputUsdNanos: null,
      cacheWriteUsdNanos: null,
      outputUsdNanos: null,
      source: "unpriced",
    };
  }

  const usage = args.usage;
  const selected =
    price.longContext && usage.inputTokens > price.longContext.inputTokensAbove
      ? { ...price, ...price.longContext }
      : price;
  const cached = Math.min(usage.inputTokens, usage.cachedInputTokens);
  const write5m = Math.min(
    Math.max(usage.inputTokens - cached, 0),
    usage.cacheWrite5mInputTokens,
  );
  const write1h = Math.min(
    Math.max(usage.inputTokens - cached - write5m, 0),
    usage.cacheWrite1hInputTokens,
  );
  const genericWrite = Math.min(
    Math.max(usage.inputTokens - cached - write5m - write1h, 0),
    Math.max(usage.cacheWriteInputTokens - write5m - write1h, 0),
  );
  const uncached = Math.max(
    usage.inputTokens - cached - write5m - write1h - genericWrite,
    0,
  );

  const inputUsdNanos = nanos(uncached, selected.input);
  const cachedInputUsdNanos = nanos(
    cached,
    selected.cachedInput ?? selected.input,
  );
  const cacheWriteUsdNanos =
    nanos(genericWrite, selected.cacheWrite ?? selected.input) +
    nanos(
      write5m,
      selected.cacheWrite5m ?? selected.cacheWrite ?? selected.input,
    ) +
    nanos(
      write1h,
      selected.cacheWrite1h ?? selected.cacheWrite ?? selected.input,
    );
  const outputUsdNanos = nanos(usage.outputTokens, selected.output);

  return {
    totalUsdNanos:
      inputUsdNanos + cachedInputUsdNanos + cacheWriteUsdNanos + outputUsdNanos,
    inputUsdNanos,
    cachedInputUsdNanos,
    cacheWriteUsdNanos,
    outputUsdNanos,
    source: "catalog",
    priceSource: model.priceSource,
    priceAsOf: model.priceAsOf,
  };
}

export const USD_NANOS_PER_CENT = 10_000_000;
