// FsUploadedOntologyStore — persists a user-UPLOADED ontology bundle as a reusable LOCAL domain.
//
// Sometimes the live Ontology (Allmeta) has no data for a domain, but the FDE already has a hand-
// authored bundle of actions / events / rules / dataObjects. They upload that JSON; we normalize it
// to the factory's DomainOntology shape, validate it's non-empty, and persist it as a file under
// <dataRoot>/factory-ontologies/<domainId>.json. It then shows up in the domain switcher and the
// factory reads IT (via read_ontology) instead of the live source — re-runnable, re-uploadable.
//
// File-backed (like FsAgentDraftStore) deliberately: no DB migration, inspectable on disk, and a
// clean parallel to how drafts persist.

import { promises as fs } from "node:fs";
import path from "node:path";
import type { DomainOntology, OntologyAction } from "@agentic/agent-factory";

function dataRoot(): string {
  const r = process.env.AGENTIC_DATA_ROOT?.trim() || "./data";
  return path.isAbsolute(r) ? r : path.resolve(process.cwd(), r);
}
const safeSeg = (s: string) => (s || "_").replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 64) || "_";
// TENANT-SCOPED: each tenant's uploads live under their own subdir, so an upload by one tenant is
// neither visible nor fetchable by another (the review flagged cross-tenant ontology leakage), and
// two tenants can reuse the same display name without colliding on disk.
const dir = (tenant: string) => path.join(dataRoot(), "factory-ontologies", safeSeg(tenant));
/** Slugify a display name to a stable domain id: lowercase, [a-z0-9-], collapsed. A name with no
 *  ASCII alphanumerics (e.g. an all-CJK name like 我的招聘域) would otherwise collapse to a single
 *  shared id and COLLIDE with every other such upload — so fall back to a deterministic hash of the
 *  original name, keeping distinct names distinct + the same name stable across re-uploads. */
export function slugifyDomain(name: string): string {
  const base = (name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  if (base) return base;
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return `ont-${h.toString(36)}`;
}

/** Coerce a trigger/emit/target field to string[] — tolerant of `["E"]`, `"E"`, and `[{name:"E"}]`
 *  (a common ontology export shape). An object element becomes its `.name`/`.id`, NEVER the useless
 *  "[object Object]" that a naive String() would produce (which would poison the event graph). */
const oneStr = (x: unknown): string => {
  if (x && typeof x === "object") return String((x as { name?: unknown; id?: unknown }).name ?? (x as { id?: unknown }).id ?? "").trim();
  return String(x ?? "").trim();
};
const asStrArr = (v: unknown): string[] => (Array.isArray(v) ? v.map(oneStr).filter(Boolean) : v ? [oneStr(v)].filter(Boolean) : []);

/** Normalize one loosely-shaped action object into the factory's OntologyAction. Lenient: fills the
 *  required fields with sensible defaults so a hand-authored bundle doesn't need every key. */
function normalizeAction(a: Record<string, unknown>, i: number): OntologyAction {
  return {
    id: String(a.id ?? a.name ?? `action-${i}`),
    name: String(a.name ?? a.id ?? `action_${i}`),
    description: a.description ? String(a.description) : undefined,
    category: a.category ? String(a.category) : undefined,
    actor: a.actor ? asStrArr(a.actor) : ["Agent"],
    trigger: asStrArr(a.trigger),
    triggered_event: asStrArr(a.triggered_event ?? a.emit ?? a.triggered_events),
    target_objects: asStrArr(a.target_objects ?? a.targets),
    tool_use: Array.isArray(a.tool_use)
      ? (a.tool_use as unknown[]).map((t) => (typeof t === "string" ? t : String((t as { name?: string })?.name ?? ""))).filter(Boolean)
      : [],
    system_prompt: String(a.system_prompt ?? ""),
    user_prompt: String(a.user_prompt ?? ""),
    inputs: Array.isArray(a.inputs) ? (a.inputs as Array<Record<string, unknown>>) : undefined,
    outputs: Array.isArray(a.outputs) ? (a.outputs as Array<Record<string, unknown>>) : undefined,
    submission_criteria: a.submission_criteria ? String(a.submission_criteria) : undefined,
    side_effects: (a.side_effects as Record<string, unknown>) ?? undefined,
  };
}

/** Pull a list out of either a top-level key or a bare array (tolerant of {payload:[...]}). */
function pickList(raw: Record<string, unknown>, ...keys: string[]): Record<string, unknown>[] {
  for (const k of keys) {
    const v = raw[k];
    if (Array.isArray(v)) return v as Record<string, unknown>[];
    if (v && typeof v === "object" && Array.isArray((v as Record<string, unknown>).payload)) return (v as Record<string, unknown>).payload as Record<string, unknown>[];
  }
  return [];
}

export interface UploadedOntologyMeta { id: string; name: string; counts: { actions: number; events: number; objects: number; rules: number; workflow: number }; updatedAt: string }

/** Normalize a raw uploaded bundle → DomainOntology. Throws (fail-closed) if there are no actions
 *  (the factory must not hallucinate against an empty stub). When `forcedDomainId` is given the
 *  bundle is stored UNDER that domain (slugified) instead of one derived from `name` — this is how an
 *  upload ATTACHES to the currently-selected 业务域 (overriding/updating it) rather than minting a new
 *  file-named domain. Always a slug, so the store's slug-based has()/ids() stay consistent. */
export function normalizeBundle(name: string, raw: unknown, forcedDomainId?: string): { ontology: DomainOntology; meta: UploadedOntologyMeta } {
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const domainId = forcedDomainId ? slugifyDomain(forcedDomainId) : slugifyDomain(name);
  const actions = pickList(obj, "actions", "action").map(normalizeAction);
  if (!actions.length) throw new Error("上传的本体里没有任何 action（actions 为空）——工厂不会对空壳生成（避免幻觉）。请至少提供一个动作。");
  const events = pickList(obj, "events", "event") as unknown as DomainOntology["events"];
  const objects = pickList(obj, "dataObjects", "objects", "object", "entities") as unknown as DomainOntology["objects"];
  const rules = pickList(obj, "rules", "rule") as unknown as DomainOntology["rules"];
  const workflow = pickList(obj, "workflow", "workflows", "agents");
  const ontology: DomainOntology = { domainId, objects, rules, actions, events, workflow, source: "snapshot" };
  const meta: UploadedOntologyMeta = {
    id: domainId,
    name,
    counts: { actions: actions.length, events: events.length, objects: objects.length, rules: rules.length, workflow: workflow.length },
    updatedAt: new Date().toISOString(),
  };
  return { ontology, meta };
}

interface StoredFile { name: string; updatedAt: string; ontology: DomainOntology }

/** Tenant-scoped store. Every method takes the owning tenant slug; uploads never cross tenants. */
export class FsUploadedOntologyStore {
  private file(tenant: string, domainId: string): string {
    return path.join(dir(tenant), `${slugifyDomain(domainId)}.json`);
  }

  /** Validate + persist a raw uploaded bundle for `tenant`. Returns the meta (id = slugified name,
   *  or slugified `forcedDomainId` when attaching to an existing/selected domain). */
  async save(tenant: string, name: string, raw: unknown, forcedDomainId?: string): Promise<UploadedOntologyMeta> {
    const { ontology, meta } = normalizeBundle(name, raw, forcedDomainId);
    await fs.mkdir(dir(tenant), { recursive: true });
    const payload: StoredFile = { name, updatedAt: meta.updatedAt, ontology };
    await fs.writeFile(this.file(tenant, ontology.domainId), JSON.stringify(payload, null, 2), "utf8");
    return meta;
  }

  async list(tenant: string): Promise<UploadedOntologyMeta[]> {
    let files: string[];
    try {
      files = (await fs.readdir(dir(tenant))).filter((f) => f.endsWith(".json"));
    } catch {
      return [];
    }
    const out: UploadedOntologyMeta[] = [];
    for (const f of files) {
      try {
        const s = JSON.parse(await fs.readFile(path.join(dir(tenant), f), "utf8")) as StoredFile;
        const o = s.ontology;
        out.push({ id: o.domainId, name: s.name, updatedAt: s.updatedAt, counts: { actions: o.actions.length, events: o.events.length, objects: o.objects.length, rules: o.rules.length, workflow: o.workflow.length } });
      } catch {
        /* skip a corrupt file */
      }
    }
    return out.sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  async get(tenant: string, domainId: string): Promise<DomainOntology | null> {
    try {
      const s = JSON.parse(await fs.readFile(this.file(tenant, domainId), "utf8")) as StoredFile;
      return s.ontology;
    } catch {
      return null;
    }
  }

  /** The id-set for one tenant — used by the prioritized source's routing. */
  async ids(tenant: string): Promise<Set<string>> {
    return new Set((await this.list(tenant)).map((m) => m.id));
  }

  async delete(tenant: string, domainId: string): Promise<boolean> {
    try {
      await fs.unlink(this.file(tenant, domainId));
      return true;
    } catch {
      return false;
    }
  }
}
