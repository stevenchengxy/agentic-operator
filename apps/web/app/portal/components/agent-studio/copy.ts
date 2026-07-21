import type { Language } from "@/lib/i18n/types";

export type StudioTranslate = (
  key: string,
  vars?: Record<string, string | number>,
) => string;

type StudioCopyNamespace = "agentStudioUi" | "agentStudioHelp";

/**
 * Agent Studio contains a large amount of deliberately conversational copy.
 * Keep the English source beside the UI that uses it while resolving the
 * localized value from the shared dictionaries. The stable FNV-1a key avoids
 * turning prose into fragile dot-paths and keeps examples/protocol values out
 * of the translation layer.
 */
export function studioCopyKey(
  namespace: StudioCopyNamespace,
  source: string,
): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${namespace}.copy.k${(hash >>> 0).toString(36)}`;
}

export function studioUi(
  t: StudioTranslate,
  source: string,
  vars?: Record<string, string | number>,
): string {
  return t(studioCopyKey("agentStudioUi", source), vars);
}

export function studioHelp(
  t: StudioTranslate,
  source: string,
  vars?: Record<string, string | number>,
): string {
  return t(studioCopyKey("agentStudioHelp", source), vars);
}

export function studioLocale(language: Language): string {
  return language === "zh" ? "zh-CN" : "en-US";
}
