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
    private readonly manifest: OntologySource & { listArtifactDomains?: () => Promise<Array<{ id: string; name: string; counts: { actions: number; events: number; objects: number; rules: number; workflow: number } }>> },
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
    // DEGRADED FALLBACK — Allmeta configured but returned nothing (unreachable): surface the local
    // promoted workflow artifacts so the factory keeps its domains instead of collapsing to the 2
    // hand-authored local ontologies. Tagged source:"snapshot" so listDomains stays typed; the
    // per-domain fetch derives a thin ontology from the workflow agents.
    if (!remote.length && this.manifest.listArtifactDomains) {
      const artifacts = await this.manifest.listArtifactDomains().catch(() => []);
      for (const d of artifacts) {
        if (seen.has(normDomainId(d.id))) continue;
        seen.add(normDomainId(d.id));
        merged.push(d);
      }
    }
    return merged;
  }

  async fetchOntology(domainId: string): Promise<DomainOntology> {
    if (!(await this.isAllmetaDomain(domainId))) return this.manifest.fetchOntology(domainId);
    try {
      return await this.allmeta.fetchOntology(domainId);
    } catch (e) {
      // Allmeta down → degrade to the local promoted artifact (manifest derives thin actions from
      // the workflow agents). Surfaces the same domain listDomains showed as a fallback, coherently.
      // #AUDIT-FIX(P2-04) — 退化不再静默：标记 degraded（薄 artifact 可能缺 events/objects/rules），
      // 让 read_ontology 明示"本体不完整、非严格源"，避免据此设计/自动发布而不自知。
      try {
        const thin = await this.manifest.fetchOntology(domainId);
        try { console.warn(`[ontology] Allmeta 严格源失败，退化到本地 artifact：${domainId} — ${String((e as Error)?.message ?? e).slice(0, 120)}`); } catch { /* best-effort */ }
        return { ...thin, degraded: { from: "allmeta", reason: String((e as Error)?.message ?? e).slice(0, 160) } };
      } catch {
        throw e; // no local artifact either → the original Allmeta error is the honest one
      }
    }
  }

  async fetchActionRules(domainId: string, actionName: string): Promise<unknown[]> {
    return (await this.isAllmetaDomain(domainId))
      ? this.allmeta.fetchActionRules(domainId, actionName)
      : this.manifest.fetchActionRules(domainId, actionName);
  }
}
