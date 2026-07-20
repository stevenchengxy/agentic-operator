import type { DomainOntology, OntologyReferencedDomain } from "./ontology-types";
import type { OntologySource } from "./ports";

const clean = (value: unknown): string => typeof value === "string" ? value.trim() : "";
const key = (value: string): string => value.normalize("NFKC").toLocaleLowerCase().replace(/[\s_-]+/g, "");

/** Resolve every Event source_domain through the configured OntologySource.
 * Resolution is deliberately strict: failures are retained in the bundle and
 * become readiness blockers. This helper never erases source provenance and
 * never substitutes a same-named local Action. */
export async function resolveOntologyReferences(
  ontology: DomainOntology,
  source: OntologySource,
): Promise<DomainOntology> {
  const localKey = key(ontology.domainId);
  const domains = new Map<string, string>();
  for (const event of ontology.events) {
    const domainId = clean(event.payload?.source_domain);
    if (!domainId || key(domainId) === localKey) continue;
    domains.set(key(domainId), domainId);
  }

  const referencedDomains = await Promise.all(
    [...domains.values()].map(async (domainId): Promise<OntologyReferencedDomain> => {
      try {
        const resolved = await source.fetchOntology(domainId);
        return {
          domainId,
          source: resolved.source,
          resolved: true,
          actions: resolved.actions,
        };
      } catch (error) {
        return {
          domainId,
          source: ontology.source,
          resolved: false,
          actions: [],
          error: String((error as Error)?.message ?? error).slice(0, 500),
        };
      }
    }),
  );

  return { ...ontology, referencedDomains };
}
