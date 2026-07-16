import { findCatalogModel, type ProviderId } from "@agentic/contracts";
import { LLMError } from "./errors";
import type { ChatRequest } from "./types";

function unsupported(
  provider: ProviderId,
  model: string,
  control: string,
  value: string,
  supported: readonly string[] = [],
): never {
  const suffix =
    supported.length > 0
      ? ` Supported values: ${supported.join(", ")}.`
      : " This model does not advertise that control.";
  throw new LLMError(
    `${provider}/${model} does not support ${control}=${value}.${suffix}`,
    "bad_request",
    provider,
  );
}

export function omitTemperature(req: ChatRequest): ChatRequest {
  if (req.temperature === undefined) return req;
  const normalized = { ...req };
  delete normalized.temperature;
  return normalized;
}

/**
 * Agent definitions historically carry a temperature default even when a
 * one-off provider/model override is selected. Catalog-known models that
 * reject the field must receive no `temperature` key at all.
 */
export function normalizeModelRequest(
  provider: ProviderId,
  model: string,
  req: ChatRequest,
): ChatRequest {
  const catalog = findCatalogModel(provider, model);
  return catalog?.temperatureRange === null ? omitTemperature(req) : req;
}

/**
 * Narrow compatibility fallback for live/custom model ids that are newer
 * than the catalog. Only an explicit 400-style unsupported-temperature error
 * qualifies; value/range errors and unrelated bad requests are not retried.
 */
export function isUnsupportedTemperatureError(error: LLMError): boolean {
  if (error.code !== "bad_request") return false;
  const message = error.message.toLowerCase();
  if (!message.includes("temperature")) return false;
  return (
    message.includes("unsupported") ||
    message.includes("not supported") ||
    message.includes("not allowed") ||
    message.includes("cannot be modified") ||
    message.includes("unknown parameter") ||
    message.includes("unrecognized parameter")
  );
}

/**
 * Reject invalid catalog-known combinations before they can spend money.
 * Unknown model ids are left to the provider because live-discovered and
 * custom deployments may be newer than the checked-in catalog.
 */
export function assertModelControls(
  provider: ProviderId,
  model: string,
  req: Pick<ChatRequest, "reasoning" | "verbosity" | "store" | "temperature">,
): void {
  const catalog = findCatalogModel(provider, model);
  if (!catalog) return;

  if (req.temperature !== undefined) {
    const range = catalog.temperatureRange;
    if (range === null) {
      unsupported(provider, model, "temperature", String(req.temperature));
    }
    if (range && (req.temperature < range.min || req.temperature > range.max)) {
      unsupported(provider, model, "temperature", String(req.temperature), [
        `${range.min}..${range.max}`,
      ]);
    }
  }

  const reasoning = req.reasoning;
  if (reasoning?.effort !== undefined) {
    const supported = catalog.reasoningEfforts ?? [];
    if (!supported.includes(reasoning.effort)) {
      unsupported(
        provider,
        model,
        "reasoning.effort",
        reasoning.effort,
        supported,
      );
    }
  }
  if (reasoning?.mode !== undefined) {
    const supported = catalog.reasoningModes ?? [];
    if (!supported.includes(reasoning.mode)) {
      unsupported(provider, model, "reasoning.mode", reasoning.mode, supported);
    }
  }
  if (reasoning?.summary !== undefined) {
    const supported = catalog.reasoningSummaries ?? [];
    if (!supported.includes(reasoning.summary)) {
      unsupported(
        provider,
        model,
        "reasoning.summary",
        reasoning.summary,
        supported,
      );
    }
  }
  if (reasoning?.context !== undefined) {
    const supported = catalog.reasoningContexts ?? [];
    if (!supported.includes(reasoning.context)) {
      unsupported(
        provider,
        model,
        "reasoning.context",
        reasoning.context,
        supported,
      );
    }
  }
  if (req.verbosity !== undefined) {
    const supported = catalog.textVerbosities ?? [];
    if (!supported.includes(req.verbosity)) {
      unsupported(provider, model, "text.verbosity", req.verbosity, supported);
    }
  }

  if (
    req.store !== undefined &&
    provider !== "openai" &&
    provider !== "openrouter"
  ) {
    unsupported(provider, model, "store", String(req.store));
  }
  if (provider === "openrouter" && req.store === true) {
    unsupported(provider, model, "store", "true", ["false"]);
  }
}
