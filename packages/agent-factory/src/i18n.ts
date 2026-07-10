// #9 (i18n) — the brain's working language. Lets the Agent Factory serve non-Chinese domains:
// the system prompt, role names, and run-critic all render in the resolved language. Default is
// `zh` (unchanged behavior for the current Chinese-content domains); set FACTORY_BRAIN_LANG=en for
// English, or =auto to let the language FOLLOW the ontology/domain content.

export type BrainLang = "zh" | "en";

/** CJK-ratio detection — `zh` when the text carries meaningful CJK, else `en`. */
export function detectLang(text: string): BrainLang {
  const cjk = (text.match(/[一-鿿぀-ヿ가-힯]/g) ?? []).length;
  const latin = (text.match(/[a-zA-Z]/g) ?? []).length;
  // Any non-trivial CJK presence relative to Latin → treat as a CJK domain.
  return cjk > 0 && cjk * 3 >= latin ? "zh" : "en";
}

type OntologyLike = {
  actions?: Array<{ name?: string; description?: string }>;
  objects?: Array<{ name?: string; description?: string }>;
  events?: Array<{ name?: string }>;
} | null | undefined;

/** Resolve the brain's language. `FACTORY_BRAIN_LANG` (zh|en) is authoritative; `auto` detects
 *  from the ontology content (preferred) or the domain id; anything else defaults to `zh` so the
 *  current Chinese deployments are untouched. */
export function resolveBrainLang(domain: string, ontology?: OntologyLike, processEnv: Record<string, string | undefined> = process.env): BrainLang {
  const env = (processEnv.FACTORY_BRAIN_LANG ?? "").trim().toLowerCase();
  if (env === "zh" || env === "en") return env;
  if (env !== "auto") return "zh"; // default: preserve existing behavior
  if (ontology) {
    const sample = [
      ...(ontology.actions ?? []).slice(0, 20).flatMap((a) => [a.name ?? "", a.description ?? ""]),
      ...(ontology.objects ?? []).slice(0, 20).flatMap((o) => [o.name ?? "", o.description ?? ""]),
      ...(ontology.events ?? []).slice(0, 20).map((e) => e.name ?? ""),
    ].join(" ").trim();
    if (sample) return detectLang(sample);
  }
  return detectLang(domain);
}
