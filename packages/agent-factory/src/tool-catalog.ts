// Tool grounding for design_agent — ported from the OLD lib/tools/registry.ts
// (resolveToolName / suggestToolsForAction / groundToolPicks), but ONTOLOGY-DRIVEN
// for the new arch.
//
// The OLD repo grounded picks against a hand-coded ToolRegistry. The new monorepo has
// no such registry at design time; the source of truth for "what tools exist" is the
// domain ontology's `tool_use` (the real tool names each action declares) plus any
// names the brain itself introduces. So we build the catalog from the ontology and
// fuzzy-bind the brain's picks to it — de-hallucinating invented tool names — while
// staying robust when the catalog is empty (picks pass through as-is, marked).

import type { DomainOntology, OntologyAction } from "./ontology-types";

/** Every distinct tool name the domain's actions declare — the grounding catalog. */
export function buildToolCatalog(ontology: DomainOntology): string[] {
  const set = new Set<string>();
  for (const a of ontology.actions) for (const t of a.tool_use ?? []) if (t) set.add(t);
  return [...set].sort();
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
// Split on non-alphanumerics AND camelCase boundaries, so "parseResume" → {parse, resume} and ranks
// against "parseResumeApi" → {parse, resume, api}. (#C — the action→real-tool match depends on this.)
const tokens = (s: string) => new Set(s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));

/** Resolve a (possibly invented) tool name to a real catalog name. Exact match first,
 *  then normalized match, then a token-superset fuzzy bridge (e.g. "parseResumeFile"
 *  → "robohire.parseResume" when one name's tokens are a superset of the other's). */
export function resolveToolName(name: string, catalog: string[]): string | null {
  if (!name) return null;
  const exact = catalog.find((c) => c === name);
  if (exact) return exact;
  const n = norm(name);
  const normMatch = catalog.find((c) => norm(c) === n);
  if (normMatch) return normMatch;
  // token-superset fuzzy: the real name's tail tokens ⊆ the pick's tokens, or vice versa
  const picked = tokens(name);
  let best: { c: string; overlap: number } | null = null;
  for (const c of catalog) {
    const tail = c.includes(".") ? c.slice(c.indexOf(".") + 1) : c;
    const ct = tokens(tail);
    if (!ct.size) continue;
    const overlap = [...ct].filter((t) => picked.has(t)).length;
    // Require MORE than one shared token for the fuzzy bridge — else a lone generic token (read /
    // write / get / url / inbox) would silently rebind a placeholder pick onto an unrelated real
    // tool (exact/normalized matches above already handle legitimate single-token names).
    const subset = (overlap === ct.size || overlap === picked.size) && overlap > 1;
    if (subset && (!best || overlap > best.overlap)) best = { c, overlap };
  }
  return best?.c ?? null;
}

/** A real tool from the global registry (injected via the FactoryPorts.toolRegistry port so the
 *  pure factory package never imports @agentic/tools). configKeys = the per-tenant config the FDE
 *  must supply (e.g. api_key_env). */
export interface RealTool {
  name: string;
  summary?: string;
  aliases?: string[];
  configKeys?: string[];
  category?: string;
}

/** #C — semantic ranking (restored from old AO): score each REAL tool by token-overlap of the
 *  action's name + target_objects against the tool's name + summary (+3 action token in the NAME,
 *  +2 a target-object token in the name, +1 in the summary). Returns the top-N real tool NAMES — so
 *  an action that declares NO tools still gets a real recommendation (parseResume → parseResumeApi). */
export function rankRealTools(action: OntologyAction, realTools: RealTool[], limit = 4): string[] {
  if (!realTools.length) return [];
  const actToks = tokens(action.name);
  const objToks = new Set((action.target_objects ?? []).flatMap((o) => [...tokens(String(o))]));
  const scored = realTools
    .map((t) => {
      const bare = t.name.includes(".") ? t.name.slice(t.name.indexOf(".") + 1) : t.name;
      const nameToks = new Set([...tokens(bare), ...(t.aliases ?? []).flatMap((a) => [...tokens(a)])]);
      const sumToks = tokens(t.summary ?? "");
      let score = 0;
      for (const tk of actToks) { if (nameToks.has(tk)) score += 3; else if (sumToks.has(tk)) score += 1; }
      for (const tk of objToks) { if (nameToks.has(tk)) score += 2; else if (sumToks.has(tk)) score += 1; }
      return { name: t.name, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  return scored.map((x) => x.name);
}

/** The tools suggested for an action: the ontology's declared tool_use FIRST, then (when a real
 *  registry is available) the top semantically-ranked real tools. Restores action→real-tool mapping. */
export function suggestToolsForAction(action: OntologyAction, realTools: RealTool[] = []): string[] {
  return [...new Set([...(action.tool_use ?? []).filter(Boolean), ...rankRealTools(action, realTools)])];
}

// Side-effect class derived from a tool's name/category (the catalog carries no explicit field) —
// mirrors the tool-library page so a search filter agrees with what the FDE sees in the UI.
const READ_RE = /read|parse|get|list|fetch|health|match|search|describe|inspect|lookup|query|load|probe/i;
const WRITE_RE = /write|create|invite|send|post|delete|update|save|append|put|upload|emit|publish|sync/i;
export function toolSideEffect(t: { name: string; category?: string }): "read" | "write" | "dual" | "call" {
  const s = `${t.name} ${t.category ?? ""}`;
  const r = READ_RE.test(s), w = WRITE_RE.test(s);
  if (r && w) return "dual";
  if (w) return "write";
  if (r) return "read";
  return "call";
}

export interface ToolSearchHit { name: string; summary?: string; category?: string; configKeys: string[]; sideEffect: string; score: number; }

/** Progressive tool search: rank the REAL registry by a free-text intent (token overlap of the
 *  query against name+aliases+summary+category), optionally filtered by category / side-effect. Lets
 *  the brain DISCOVER tools per-action (渐进式披露) instead of being handed the whole catalog at once. */
export function searchRealTools(
  query: string,
  realTools: RealTool[],
  opts: { category?: string; sideEffect?: string; limit?: number } = {},
): ToolSearchHit[] {
  const qToks = tokens(query);
  const cat = opts.category?.toLowerCase();
  const filtering = !!cat || !!opts.sideEffect;
  return realTools
    .filter((t) => !cat || (t.category ?? "").toLowerCase() === cat)
    .filter((t) => !opts.sideEffect || toolSideEffect(t) === opts.sideEffect)
    .map((t) => {
      const bare = t.name.includes(".") ? t.name.slice(t.name.indexOf(".") + 1) : t.name;
      const nameToks = new Set([...tokens(bare), ...(t.aliases ?? []).flatMap((a) => [...tokens(a)])]);
      const sumToks = tokens(t.summary ?? "");
      const catToks = tokens(t.category ?? "");
      let score = 0;
      for (const tk of qToks) { if (nameToks.has(tk)) score += 3; else if (sumToks.has(tk)) score += 1; else if (catToks.has(tk)) score += 1; }
      return { name: t.name, summary: t.summary, category: t.category, configKeys: t.configKeys ?? [], sideEffect: toolSideEffect(t), score };
    })
    // when a category/side-effect filter is set, list even score-0 matches (browse mode);
    // otherwise require at least one shared token (a real semantic hit).
    .filter((x) => x.score > 0 || filtering)
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.limit ?? 6);
}

export interface GroundResult {
  /** picks resolved to real catalog names (deduped, order-preserved) */
  resolved: string[];
  /** picks that were a non-real name bridged onto a real tool */
  bridged: Array<{ raw: string; resolved: string }>;
  /** picks that resolved to nothing in the catalog (kept as-is for human review) */
  unresolved: string[];
}

/** Ground the brain's tool picks against the catalog: resolve, bridge, or mark
 *  unresolved. When the catalog is empty (common for new-arch manifest domains whose
 *  tools live as code), picks pass through unresolved rather than being dropped. */
export function groundToolPicks(picks: string[], catalog: string[]): GroundResult {
  const resolved: string[] = [];
  const bridged: Array<{ raw: string; resolved: string }> = [];
  const unresolved: string[] = [];
  const seen = new Set<string>();
  for (const raw of picks) {
    if (!raw) continue;
    const hit = catalog.length ? resolveToolName(raw, catalog) : null;
    if (hit) {
      if (hit !== raw) bridged.push({ raw, resolved: hit });
      if (!seen.has(hit)) {
        seen.add(hit);
        resolved.push(hit);
      }
    } else {
      // no catalog (or no match): keep the brain's name so the agent still binds it,
      // but flag it for human review (the new arch resolves tools at deploy time).
      if (!seen.has(raw)) {
        seen.add(raw);
        resolved.push(raw);
      }
      unresolved.push(raw);
    }
  }
  return { resolved, bridged, unresolved };
}

const EVENT_TOKEN_ALLOW = new Set(["SYSTEM_PROMPT", "JSON", "TODO", "FIXME", "HTTP", "HTTPS", "API", "URL", "URI", "UUID", "SQL", "CSV", "PDF", "AI"]);

/** ALL_CAPS_UNDERSCORE tokens in free text that aren't in the ontology's events — the
 *  brain's hallucination vector (RESUME_PARSED vs the real RESUME_PROCESSED). Warning. */
export function ungroundedEventTokens(texts: string[], knownEvents: Set<string>): string[] {
  const found = new Set<string>();
  for (const t of texts) {
    for (const m of (t || "").matchAll(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g)) {
      const tok = m[0];
      if (!EVENT_TOKEN_ALLOW.has(tok) && !knownEvents.has(tok)) found.add(tok);
    }
  }
  return [...found];
}
