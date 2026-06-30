// UploadedOntologySource — an OntologySource backed by FsUploadedOntologyStore, so a user-uploaded
// ontology bundle behaves like any other domain: it appears in the domain switcher and the factory
// reads it via read_ontology. Composed AHEAD of the live/manifest sources so an uploaded domain (and
// an uploaded override of an existing id) wins.

import type { OntologySource, DomainOntology } from "@agentic/agent-factory";
import { FsUploadedOntologyStore, slugifyDomain } from "./uploaded-ontology-store";

/** TENANT-SCOPED uploaded-ontology source. `tenant` is required to surface anything — a missing
 *  tenant (an unscoped port) sees NO uploads (so the catalog can never leak another tenant's). */
export class UploadedOntologySource implements OntologySource {
  constructor(
    private readonly tenant: string | undefined,
    private readonly store = new FsUploadedOntologyStore(),
  ) {}

  async listDomains() {
    if (!this.tenant) return [];
    return (await this.store.list(this.tenant)).map((m) => ({ id: m.id, name: `${m.name}（上传）`, counts: m.counts }));
  }

  async fetchOntology(domainId: string): Promise<DomainOntology> {
    const o = this.tenant ? await this.store.get(this.tenant, domainId) : null;
    if (!o) throw new Error(`上传的本体里找不到业务域「${domainId}」。`);
    return o;
  }

  async fetchActionRules(domainId: string, actionName: string): Promise<unknown[]> {
    const o = this.tenant ? await this.store.get(this.tenant, domainId) : null;
    if (!o) return [];
    const action = o.actions.find((a) => a.name === actionName || a.id === actionName);
    // Preferred: rules nested under the action's steps (same contract as ManifestOntologySource).
    const steps = (action as unknown as { action_steps?: Array<Record<string, unknown>> })?.action_steps;
    if (Array.isArray(steps)) return steps.flatMap((s) => (Array.isArray(s.rules) ? (s.rules as unknown[]) : []));
    // Fallback: prefix-match rules on the action's hierarchical id (action "3" owns "3-1"…).
    if (action?.id) return o.rules.filter((r) => typeof (r as { id?: unknown })?.id === "string" && ((r as { id: string }).id).startsWith(`${action.id}-`));
    return [];
  }

  /** True if an uploaded bundle exists for this domain id (used for priority routing). */
  async has(domainId: string): Promise<boolean> {
    if (!this.tenant) return false;
    return (await this.store.ids(this.tenant)).has(slugifyDomain(domainId));
  }
}

/** Wrap a base OntologySource so an UPLOADED domain (by id) takes priority, while every other
 *  domain falls through to the base (manifest / Allmeta) unchanged. listDomains() unions them,
 *  uploaded first; a duplicate id is reported once (uploaded wins). */
export class UploadedFirstOntologySource implements OntologySource {
  constructor(
    private readonly uploaded: UploadedOntologySource,
    private readonly base: OntologySource,
  ) {}

  async listDomains() {
    const up = await this.uploaded.listDomains().catch(() => []);
    const seen = new Set(up.map((d) => d.id.toLowerCase()));
    const baseList = await this.base.listDomains().catch(() => []);
    return [...up, ...baseList.filter((d) => !seen.has(d.id.toLowerCase()))];
  }

  async fetchOntology(domainId: string): Promise<DomainOntology> {
    return (await this.uploaded.has(domainId)) ? this.uploaded.fetchOntology(domainId) : this.base.fetchOntology(domainId);
  }

  async fetchActionRules(domainId: string, actionName: string): Promise<unknown[]> {
    return (await this.uploaded.has(domainId)) ? this.uploaded.fetchActionRules(domainId, actionName) : this.base.fetchActionRules(domainId, actionName);
  }
}
