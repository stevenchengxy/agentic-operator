import {
  PROVIDER_MODEL_CATALOG,
  type CatalogModel,
  type ProviderId,
} from "@agentic/contracts";
import { LLMError } from "./errors";
import type { ChatRequest } from "./types";

function catalogModel(provider: ProviderId, model: string): CatalogModel | undefined {
  const normalized = model.startsWith("~") ? model.slice(1) : model;
  return PROVIDER_MODEL_CATALOG[provider]?.find(
    (candidate) => candidate.name === normalized,
  );
}

function unsupported(
  provider: ProviderId,
  model: string,
  control: string,
  value: string,
  supported: readonly string[] = [],
): never {
  const suffix = supported.length > 0
    ? ` Supported values: ${supported.join(", ")}.`
    : " This model does not advertise that control.";
  throw new LLMError(
    `${provider}/${model} does not support ${control}=${value}.${suffix}`,
    "bad_request",
    provider,
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
  req: Pick<ChatRequest, "reasoning" | "verbosity" | "store">,
): void {
  const catalog = catalogModel(provider, model);
  if (!catalog) return;

  const reasoning = req.reasoning;
  if (reasoning?.effort !== undefined) {
    const supported = catalog.reasoningEfforts ?? [];
    if (!supported.includes(reasoning.effort)) {
      unsupported(provider, model, "reasoning.effort", reasoning.effort, supported);
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

  if (req.store !== undefined && provider !== "openai" && provider !== "openrouter") {
    unsupported(provider, model, "store", String(req.store));
  }
  if (provider === "openrouter" && req.store === true) {
    unsupported(provider, model, "store", "true", ["false"]);
  }
}
