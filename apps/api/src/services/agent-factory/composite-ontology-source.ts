// CompositeOntologySource — routes OntologySource calls between the live Allmeta
// source and the local manifest source, so the factory sees BOTH live AllmetaOntology
// domains (e.g. "Agents-generation") and the existing local models/<slug>/ domains.
//
// Routing (regression-free):
//   • A domain that has a LOCAL models/ folder  → manifest (unchanged behavior for
//     raas / zhaopin / RAAS-v1 / …).
//   • Any other domain Allmeta serves           → Allmeta, STRICT live (throws on
//     unreachable / empty). "Agents-generation" has no local folder → live Allmeta.
//
// listDomains() returns the UNION (deduped by normalized id), and is resilient: if
// Allmeta is down it silently degrades to the local domains rather than throwing —
// only the per-domain fetchOntology is strict.

import type { OntologySource, DomainOntology } from "@agentic/agent-factory";
import { normDomainId } from "./allmeta-ontology-source";

export class CompositeOntologySource implements OntologySource {
  constructor(
    private readonly allmeta: OntologySource,
    private readonly manifest: OntologySource,
  ) {}

  /** Normalized ids of domains backed by a local models/ folder (a REAL ontology folder — the
   *  manifest source already drops `-sb` + ontology-less deployment artifacts, so a stale promoted
   *  artifact like `agents-generation-v1` is NOT here and therefore routes to live Allmeta). */
  private async localIds(): Promise<Set<string>> {
    try {
      const local = await this.manifest.listDomains();
      return new Set(local.map((d) => normDomainId(d.id)));
    } catch {
      return new Set();
    }
  }

  /** A domain is served by Allmeta unless it has a (real) local folder. Local ontology folders keep
   *  winning (they may be richer / hand-tuned, e.g. RAAS-v1) — we only let Allmeta serve a domain
   *  whose local presence is a DEPLOYMENT ARTIFACT that the manifest source already filtered out. */
  private async isAllmetaDomain(domainId: string): Promise<boolean> {
    return !(await this.localIds()).has(normDomainId(domainId));
  }

  async listDomains() {
    // Manifest first so local domains keep their cheap counts; append Allmeta domains not already
    // present (the manifest source drops `-sb` + artifact folders, so a live domain like
    // `Agents-generation` is no longer shadowed). Allmeta failures degrade to local-only.
    const local = await this.manifest.listDomains().catch(() => []);
    const seen = new Set(local.map((d) => normDomainId(d.id)));
    let remote: Awaited<ReturnType<OntologySource["listDomains"]>> = [];
    try {
      remote = await this.allmeta.listDomains();
    } catch {
      remote = [];
    }
    const merged = [...local];
    for (const d of remote) {
      if (seen.has(normDomainId(d.id))) continue;
      seen.add(normDomainId(d.id));
      merged.push(d);
    }
    return merged;
  }

  async fetchOntology(domainId: string): Promise<DomainOntology> {
    return (await this.isAllmetaDomain(domainId))
      ? this.allmeta.fetchOntology(domainId)
      : this.manifest.fetchOntology(domainId);
  }

  async fetchActionRules(domainId: string, actionName: string): Promise<unknown[]> {
    return (await this.isAllmetaDomain(domainId))
      ? this.allmeta.fetchActionRules(domainId, actionName)
      : this.manifest.fetchActionRules(domainId, actionName);
  }
}
