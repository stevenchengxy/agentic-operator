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

  // Memoized per instance (the composite is built per run/request) — the Allmeta domain set doesn't
  // change mid-run, and fetchActionRules is called per-action, so we must not re-hit Allmeta each time.
  private _allmetaIds?: Promise<Set<string>>;
  /** Normalized ids Allmeta LIVE-serves (empty if Allmeta is down → degrade to local). */
  private allmetaIds(): Promise<Set<string>> {
    if (!this._allmetaIds) {
      this._allmetaIds = this.allmeta
        .listDomains()
        .then((ds) => new Set(ds.map((d) => normDomainId(d.id))))
        .catch(() => new Set<string>());
    }
    return this._allmetaIds;
  }

  /** A domain routes to Allmeta when Allmeta serves it — so a live domain WINS over a stale local
   *  promoted/sandbox artifact of the same id (was: "served by Allmeta unless a local folder exists",
   *  which let the artifact `agents-generation-v1` shadow live `Agents-generation`). */
  private async isAllmetaDomain(domainId: string): Promise<boolean> {
    return (await this.allmetaIds()).has(normDomainId(domainId));
  }

  async listDomains() {
    // Allmeta (LIVE) first; local folders only for ids Allmeta does NOT serve — so a stale promoted
    // artifact never shadows the live domain, while local-only domains still show. Allmeta down →
    // remote=[] → local-only (unchanged degrade path).
    const remote = await this.allmeta.listDomains().catch(() => []);
    const remoteIds = new Set(remote.map((d) => normDomainId(d.id)));
    const local = await this.manifest.listDomains().catch(() => []);
    return [...remote, ...local.filter((d) => !remoteIds.has(normDomainId(d.id)))];
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
