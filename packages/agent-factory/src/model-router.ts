// #7 — task-difficulty model routing with fallback chains. Config-driven, NO hardcoded final
// model ids: each tier reads a comma-separated env chain (first = preferred, rest = fallbacks),
// validated against the gateway's LIVE catalog (model-catalog.ts), and everything falls back to
// the base FACTORY model so the product runs out-of-the-box and any deployment can tune per tier
// without a code change.
//
//   FACTORY_MODEL_FAST=google/gemini-3-flash-preview,anthropic/claude-haiku-4.5   # reading / planning
//   FACTORY_MODEL_DEFAULT=google/gemini-3.1-pro-preview-customtools                # design
//   FACTORY_MODEL_HARD=anthropic/claude-sonnet-4.6,openai/gpt-5.4                  # code / refine / review
//
// When a tier's env chain is UNSET, the chain is DERIVED from the live catalog by preference
// patterns (also env-overridable), so a fresh deployment routes by difficulty without any config.
// streamTurn tries the chain in order, falling through on a model the gateway doesn't serve, and
// reports which model actually served the turn so the activity log can annotate it.

import { resolveFactoryGateway } from "./stream-gateway";
import { cachedModelIds } from "./model-catalog";

// Tiers, cheapest → strongest. `review` is the CRITIC tier (AI quality-judge / failure-diagnosis /
// post-run analysis) — the roles where a wrong verdict is most expensive, so they get the best
// model even though routine codegen stays on the `hard` main (质量优先·混合: strong-but-not-opus-
// every-turn). tierForContext never auto-routes to `review`; only explicit critic callers ask for it.
export type ModelTier = "fast" | "default" | "hard" | "review";

/** Built-in preference patterns used to DERIVE a tier chain from the live catalog when no env
 *  chain is pinned. Overridable per tier via FACTORY_MODEL_<TIER>_PREFER (comma-separated
 *  substrings/regex). These are heuristics over whatever the gateway serves — never hardcoded ids. */
const DEFAULT_PREFER: Record<ModelTier, string[]> = {
  fast: ["flash", "haiku", "mini", "nano", "lite", "small"],
  default: ["gemini-3.1-pro", "gpt-5.4", "sonnet", "pro", "gpt-5"],
  hard: ["sonnet", "kimi", "gpt-5.4", "opus", "gpt-5", "deepseek-v4-pro", "reason"],
  review: ["opus", "gpt-5.5", "gpt-5", "sonnet", "reason"],
};

/** Models that are clearly not chat/reasoning models — excluded from catalog derivation. */
const NON_CHAT = /image|embed|tts|audio|whisper|rerank|moderation|vision-ocr|speech/i;

function preferPatterns(tier: ModelTier, env: Record<string, string | undefined>): string[] {
  const raw = env[`FACTORY_MODEL_${tier.toUpperCase()}_PREFER`];
  const custom = (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return custom.length ? custom : DEFAULT_PREFER[tier];
}

/** Derive an ordered chain for a tier from the live catalog by preference patterns. */
function deriveFromCatalog(tier: ModelTier, catalog: string[], env: Record<string, string | undefined>): string[] {
  const chat = catalog.filter((id) => !NON_CHAT.test(id));
  const ranked: string[] = [];
  for (const pat of preferPatterns(tier, env)) {
    const re = new RegExp(pat, "i");
    for (const id of chat) if (re.test(id) && !ranked.includes(id)) ranked.push(id);
  }
  return ranked.slice(0, 3);
}

/** The ordered model chain for a tier — preferred first, then fallbacks, always ending in the
 *  base factory model (deduped) so there is always at least one model to try. */
export function modelChain(tier: ModelTier, env: Record<string, string | undefined> = process.env): string[] {
  const base = resolveFactoryGateway(env).model;
  const raw =
    tier === "hard" ? env.FACTORY_MODEL_HARD
    : tier === "fast" ? env.FACTORY_MODEL_FAST
    : tier === "review" ? (env.FACTORY_MODEL_REVIEW ?? env.FACTORY_MODEL_HARD) // review falls back to hard's chain if unpinned
    : env.FACTORY_MODEL_DEFAULT;
  let chain = (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);

  const catalog = cachedModelIds(env);
  // No env chain pinned → derive from the live catalog (config-driven defaults, no hardcoded ids).
  if (!chain.length && catalog && catalog.length) chain = deriveFromCatalog(tier, catalog, env);
  // Validate a pinned chain against the live catalog: drop ids the gateway doesn't serve so a
  // typo/decommissioned id doesn't burn a fallback attempt. Null-safe (skip when catalog unknown);
  // never let validation empty the chain (a partial catalog shouldn't strand a real id).
  if (catalog && catalog.length) {
    const served = chain.filter((m) => catalog.includes(m));
    if (served.length) chain = served;
  }

  const out = [...chain, base].filter((m, i, a) => m && a.indexOf(m) === i);
  return out.length ? out : [base];
}

/** Pick a tier from the brain's live context: cheap/fast while reading + planning, strong once
 *  it's designing/coding/refining/validating (where output quality matters most). Heuristic, not
 *  hardcoded routing — any turn can still call any tool; this only sets the model budget. */
export function tierForContext(ctx: { specs: { length: number }; currentPlan: unknown }): ModelTier {
  if (ctx.specs.length > 0) return "hard"; // designing / coding / refining / validating
  if (ctx.currentPlan) return "default"; // plan exists, about to design
  return "fast"; // reading ontology / initial planning
}
