import { PROVIDER_MODEL_CATALOG, type ProviderId } from "@agentic/contracts";

export const CUSTOM_MODEL_OPTION = "__agentic_custom_model_id__";

export interface TestModelOption {
  value: string;
  label: string;
  disabled?: boolean;
}

function isProviderId(value: string): value is ProviderId {
  return value in PROVIDER_MODEL_CATALOG;
}

const NON_CHAT_MODEL_ID =
  /(^|[/:._-])(audio|bge|clip|dall-e|embed|embedding|embeddings|flux|guard|image|imagen|moderation|ocr|rerank|reranker|speech|stable-diffusion|transcribe|transcription|tts|veo|video|whisper)([/:._-]|$)/i;

export function isLikelyChatModelId(id: string): boolean {
  return !NON_CHAT_MODEL_ID.test(id);
}

/**
 * Combine live discovery with the curated catalog. The API already performs
 * this merge, but retaining the local catalog as a fallback keeps the picker
 * usable while discovery is loading or when the API is temporarily
 * unavailable. Live discovery endpoints can also return embeddings, image,
 * audio, moderation, and reranking models; those stay available through the
 * explicit custom-ID path rather than appearing as runnable chat choices.
 */
export function providerModelIds(
  provider: string,
  discoveredModels: readonly { id: string }[] = [],
): string[] {
  const ids = new Set(
    discoveredModels
      .map((model) => model.id.trim())
      .filter((id) => id.length > 0 && isLikelyChatModelId(id)),
  );
  if (isProviderId(provider)) {
    for (const model of PROVIDER_MODEL_CATALOG[provider]) {
      ids.add(model.name);
    }
  }
  return [...ids].sort((left, right) => left.localeCompare(right));
}

export function testModelOptions({
  providerOverride,
  effectiveProvider,
  inheritedModel,
  modelIds,
}: {
  providerOverride: string;
  effectiveProvider: string;
  inheritedModel: string;
  modelIds: readonly string[];
}): TestModelOption[] {
  const firstOption = providerOverride
    ? {
        value: "",
        label: `Choose a model from ${effectiveProvider}`,
        disabled: true,
      }
    : {
        value: "",
        label: inheritedModel
          ? `Use agent / workspace (${inheritedModel})`
          : "Use agent / workspace model",
      };
  return [
    firstOption,
    ...modelIds.map((id) => ({ value: id, label: id })),
    {
      value: CUSTOM_MODEL_OPTION,
      label: "Enter a custom model ID…",
    },
  ];
}

/**
 * A provider-only override would otherwise retain the authored model on the
 * server, creating a potentially invalid cross-provider pair.
 */
export function providerOverrideNeedsModel(
  providerOverride: string,
  model: string,
): boolean {
  return Boolean(providerOverride && !model.trim());
}
