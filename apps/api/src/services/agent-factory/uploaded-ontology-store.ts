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
import { createHash, randomUUID } from "node:crypto";
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
  if (!name.trim()) throw new Error("ontology name is required");
  return `ont-${createHash("sha256").update(name, "utf8").digest("hex").slice(0, 16)}`;
}

/** Coerce a trigger/emit/target field to string[] — tolerant of `["E"]`, `"E"`, and `[{name:"E"}]`
 *  (a common ontology export shape). An object element becomes its `.name`/`.id`, NEVER the useless
 *  "[object Object]" that a naive String() would produce (which would poison the event graph). */
const oneStr = (x: unknown): string => {
  if (x && typeof x === "object") return String((x as { name?: unknown; id?: unknown }).name ?? (x as { id?: unknown }).id ?? "").trim();
  return String(x ?? "").trim();
};
function asStrArr(v: unknown, field: string): string[] {
  if (v == null || v === "") return [];
  const raw = Array.isArray(v) ? v : [v];
  const values = raw.map(oneStr);
  if (values.some((value) => !value)) {
    throw new Error(`${field} contains an entry without a name/id`);
  }
  return values;
}

function optionalArray<T>(value: unknown, field: string): T[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value as T[];
}

/** Normalize one uploaded action without inventing execution metadata. */
function normalizeAction(a: Record<string, unknown>, i: number): OntologyAction {
  const name = String(a.name ?? a.id ?? "").trim();
  if (!name) throw new Error(`actions[${i}] requires name or id`);
  const actor = asStrArr(a.actor, `actions[${i}].actor`);
  if (actor.length === 0) throw new Error(`actions[${i}].actor is required`);
  if (a.integration !== undefined && (!a.integration || typeof a.integration !== "object" || Array.isArray(a.integration))) {
    throw new Error(`actions[${i}].integration must be an object`);
  }
  if (a.side_effects !== undefined && (!a.side_effects || typeof a.side_effects !== "object" || Array.isArray(a.side_effects))) {
    throw new Error(`actions[${i}].side_effects must be an object`);
  }
  return {
    id: String(a.id ?? name),
    name,
    description: a.description ? String(a.description) : undefined,
    category: a.category ? String(a.category) : undefined,
    actor,
    trigger: asStrArr(a.trigger, `actions[${i}].trigger`),
    triggered_event: asStrArr(a.triggered_event ?? a.emit ?? a.triggered_events, `actions[${i}].triggered_event`),
    target_objects: asStrArr(a.target_objects ?? a.targets, `actions[${i}].target_objects`),
    tool_use: asStrArr(a.tool_use, `actions[${i}].tool_use`),
    system_prompt: String(a.system_prompt ?? ""),
    user_prompt: String(a.user_prompt ?? ""),
    inputs: optionalArray<Record<string, unknown>>(a.inputs, `actions[${i}].inputs`),
    outputs: optionalArray<Record<string, unknown>>(a.outputs, `actions[${i}].outputs`),
    submission_criteria: a.submission_criteria ? String(a.submission_criteria) : undefined,
    instruction: a.instruction ? String(a.instruction) : undefined,
    on_success: a.on_success ? String(a.on_success) : undefined,
    on_failure: a.on_failure ? String(a.on_failure) : undefined,
    side_effects: (a.side_effects as Record<string, unknown>) ?? undefined,
    // Preserve the two structured blocks downstream consumers read off the action verbatim:
    // action_steps[].rules[] feeds fetchActionRules (rule gates), integration.systems[] feeds
    // business-flow's DECLARED path. Dropping them here silently degraded every uploaded bundle.
    action_steps: optionalArray<Record<string, unknown>>(a.action_steps, `actions[${i}].action_steps`),
    integration: a.integration as Record<string, unknown> | undefined,
  };
}

/** Pull a list out of either a top-level key or a bare array (tolerant of {payload:[...]}). */
function pickList(raw: Record<string, unknown>, ...keys: string[]): Record<string, unknown>[] {
  for (const k of keys) {
    const v = raw[k];
    if (v === undefined) continue;
    const list = Array.isArray(v)
      ? v
      : v && typeof v === "object" && Array.isArray((v as Record<string, unknown>).payload)
        ? (v as Record<string, unknown>).payload as unknown[]
        : null;
    if (!list) throw new Error(`${k} must be an array or {payload: []}`);
    if (list.some((entry) => !entry || typeof entry !== "object" || Array.isArray(entry))) {
      throw new Error(`${k} entries must be objects`);
    }
    return list as Record<string, unknown>[];
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
  if (!Array.isArray(raw) && (!raw || typeof raw !== "object")) {
    throw new Error("uploaded ontology must be a JSON object or action array");
  }
  const obj = (Array.isArray(raw) ? {} : raw) as Record<string, unknown>;
  // A forced id is already the catalog's canonical identity. Only sanitize the
  // filename in file(); lowercasing it here used to split one domain into
  // differently cased domain histories.
  const domainId = forcedDomainId?.trim() || slugifyDomain(name);
  // A bare top-level array IS the actions list (the common "actions-only export" shape) —
  // don't force callers to wrap it in {actions:[…]}.
  const rawActions = Array.isArray(raw) ? raw : pickList(obj, "actions", "action");
  if (rawActions.some((entry) => !entry || typeof entry !== "object" || Array.isArray(entry))) {
    throw new Error("actions entries must be objects");
  }
  const actions = (rawActions as Record<string, unknown>[]).map(normalizeAction);
  if (!actions.length) throw new Error("上传的本体里没有任何 action（actions 为空）——工厂不会对空壳生成（避免幻觉）。请至少提供一个动作。");
  const events = pickList(obj, "events", "event") as unknown as DomainOntology["events"];
  const objects = pickList(obj, "dataObjects", "objects", "object", "entities") as unknown as DomainOntology["objects"];
  const topRules = pickList(obj, "rules", "rule") as unknown as DomainOntology["rules"];
  // Bundles often nest rules per action step (action_steps[].rules[]) instead of top-level.
  // Lift them so read_ontology counts them and the rules experts see them; fetchActionRules
  // still prefers the nested copies, so nothing double-binds.
  const embeddedRules = actions.flatMap((a) =>
    (a.action_steps ?? []).flatMap((s) => (Array.isArray(s.rules) ? (s.rules as DomainOntology["rules"]) : [])),
  );
  const rules = topRules.length ? topRules : embeddedRules;
  const workflow = pickList(obj, "workflow", "workflows", "agents");
  const hasLinks = ["links", "link"].some((key) => Object.prototype.hasOwnProperty.call(obj, key));
  const links = hasLinks
    ? pickList(obj, "links", "link") as unknown as NonNullable<DomainOntology["links"]>
    : undefined;
  const ontology: DomainOntology = {
    domainId,
    objects,
    rules,
    actions,
    events,
    ...(links !== undefined ? { links } : {}),
    workflow,
    source: "snapshot",
  };
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
    // The slug is readable but not an identity (A_B, a-b and many non-ASCII
    // ids can collapse to the same value). Include an exact-id digest so one
    // ontology can never overwrite/read/delete another through a slug alias.
    const digest = createHash("sha256").update(domainId, "utf8").digest("hex").slice(0, 16);
    return path.join(dir(tenant), `${slugifyDomain(domainId)}-${digest}.json`);
  }

  /** Pre-hardening filename, retained only for exact-id migration reads. */
  private legacyFile(tenant: string, domainId: string): string {
    return path.join(dir(tenant), `${slugifyDomain(domainId)}.json`);
  }

  private async readExact(file: string, domainId: string): Promise<StoredFile | null> {
    try {
      const stored = JSON.parse(await fs.readFile(file, "utf8")) as StoredFile;
      return stored?.ontology?.domainId === domainId ? stored : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new Error(`cannot read uploaded ontology ${file}`, { cause: error });
    }
  }

  /** Validate + persist a raw uploaded bundle for `tenant`. Returns the meta (id = slugified name,
   *  or slugified `forcedDomainId` when attaching to an existing/selected domain). */
  async save(tenant: string, name: string, raw: unknown, forcedDomainId?: string): Promise<UploadedOntologyMeta> {
    const { ontology, meta } = normalizeBundle(name, raw, forcedDomainId);
    const targetDir = dir(tenant);
    await fs.mkdir(targetDir, { recursive: true });
    const payload: StoredFile = { name, updatedAt: meta.updatedAt, ontology };
    const target = this.file(tenant, ontology.domainId);
    const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    let renamed = false;
    try {
      handle = await fs.open(temp, "wx", 0o600);
      await handle.writeFile(JSON.stringify(payload, null, 2), "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.rename(temp, target);
      renamed = true;

      // fsyncing the file alone is not enough: without syncing the parent directory, a power loss
      // can acknowledge save() and still lose the rename. A successful response therefore means
      // both the payload and the directory entry reached durable storage.
      const directoryHandle = await fs.open(targetDir, "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } catch (error) {
      const failures: unknown[] = [error];
      if (handle) {
        try {
          await handle.close();
        } catch (closeError) {
          failures.push(closeError);
        }
      }
      if (!renamed) {
        try {
          await fs.unlink(temp);
        } catch (cleanupError) {
          if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") failures.push(cleanupError);
        }
      }
      if (failures.length > 1) {
        throw new AggregateError(failures, `cannot durably save uploaded ontology ${ontology.domainId}`);
      }
      throw error;
    }
    return meta;
  }

  async list(tenant: string): Promise<UploadedOntologyMeta[]> {
    let files: string[];
    try {
      files = (await fs.readdir(dir(tenant))).filter((f) => f.endsWith(".json"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const out = new Map<string, UploadedOntologyMeta>();
    for (const f of files) {
      try {
        const s = JSON.parse(await fs.readFile(path.join(dir(tenant), f), "utf8")) as StoredFile;
        const o = s.ontology;
        if (!o?.domainId) throw new Error(`uploaded ontology ${f} has no canonical domainId`);
        const meta = { id: o.domainId, name: s.name, updatedAt: s.updatedAt, counts: { actions: o.actions.length, events: o.events.length, objects: o.objects.length, rules: o.rules.length, workflow: o.workflow.length } };
        const prior = out.get(o.domainId);
        if (!prior || prior.updatedAt <= meta.updatedAt) out.set(o.domainId, meta);
      } catch (error) {
        throw new Error(`cannot list uploaded ontology ${path.join(dir(tenant), f)}`, { cause: error });
      }
    }
    return [...out.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  async get(tenant: string, domainId: string): Promise<DomainOntology | null> {
    const exact = await this.readExact(this.file(tenant, domainId), domainId);
    if (exact) return exact.ontology;
    const legacy = await this.readExact(this.legacyFile(tenant, domainId), domainId);
    return legacy?.ontology ?? null;
  }

  /** The id-set for one tenant — used by the prioritized source's routing. */
  async ids(tenant: string): Promise<Set<string>> {
    return new Set((await this.list(tenant)).map((m) => m.id));
  }

  async delete(tenant: string, domainId: string): Promise<boolean> {
    let removed = false;
    const targetDir = dir(tenant);
    for (const file of [this.file(tenant, domainId), this.legacyFile(tenant, domainId)]) {
      // Never unlink a legacy slug-collision unless its embedded canonical id
      // exactly matches what the caller requested.
      if (!(await this.readExact(file, domainId))) continue;
      try {
        await fs.unlink(file);
        removed = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (removed) {
      // A successful delete response must survive power loss just like save().
      // fsync the directory entry after unlinking the exact-id file(s).
      const directoryHandle = await fs.open(targetDir, "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    }
    return removed;
  }
}
