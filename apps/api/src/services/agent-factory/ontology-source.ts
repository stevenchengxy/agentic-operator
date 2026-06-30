// ManifestOntologySource — the OntologySource port for the new arch.
//
// The new monorepo dropped Neo4j/Allmeta; a domain's ontology lives as JSON under
// models/<slug>-v<n>/ (actions[-_]v<N>.json, events_v*.json, objects_v*.json,
// rules_v*.json, workflow_v*.json). This reads those files directly and maps them to
// the factory's DomainOntology / OntologyAction shape. Strict: a missing/empty domain
// throws (the factory must not hallucinate against a stub).

import fs from "node:fs";
import path from "node:path";
import type {
  OntologySource,
  DomainOntology,
  OntologyAction,
  OntologyObject,
  OntologyEvent,
  OntologyRule,
} from "@agentic/agent-factory";

function resolveModelsRoot(): string {
  const env = process.env.AGENTIC_MODELS_DIR;
  if (env && fs.existsSync(env)) return env;
  // apps/api dev cwd is apps/api; the models dir sits at the repo root.
  const candidates = [
    path.resolve(process.cwd(), "models"),
    path.resolve(process.cwd(), "../../models"),
    path.resolve(process.cwd(), "../../../models"),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return candidates[0] ?? path.resolve(process.cwd(), "models");
}

/** "RAAS-v1" → "raas"; "finance" → "finance". Mirrors runtime tenantSlugFromFolder. */
const tenantSlugFromFolder = (folder: string): string => folder.toLowerCase().replace(/-v\d+(\.\d+)*$/i, "");

/** Pick the highest-versioned `base[-_]v<N>.json` (handles both hyphen + underscore
 *  naming present in models/), falling back to `base.json`. */
function pickVersioned(dir: string, base: string): string | null {
  let best: { n: number; file: string } | null = null;
  let plain: string | null = null;
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const re = new RegExp(`^${base}[-_]v(\\d+)\\.json$`, "i");
  for (const f of files) {
    if (f === `${base}.json`) plain = path.join(dir, f);
    const m = f.match(re);
    if (m) {
      const n = Number(m[1]);
      if (!best || n > best.n) best = { n, file: path.join(dir, f) };
    }
  }
  return best?.file ?? plain;
}

function readJson(file: string | null): unknown {
  if (!file || !fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Pull the inner array out of `{<key>:[...]}` / `{payload:[...]}` / `{events:[...]}` / a bare array. */
function unwrap(raw: unknown, key: string): Record<string, unknown>[] {
  if (Array.isArray(raw)) return raw as Record<string, unknown>[];
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    if (Array.isArray(obj[key])) return obj[key] as Record<string, unknown>[];
    for (const v of Object.values(obj)) if (Array.isArray(v)) return v as Record<string, unknown>[];
  }
  return [];
}

const asStrArr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : v ? [String(v)] : []);

function toOntologyAction(a: Record<string, unknown>): OntologyAction {
  return {
    id: String(a.id ?? a.name ?? ""),
    name: String(a.name ?? ""),
    description: a.description ? String(a.description) : undefined,
    category: a.category ? String(a.category) : undefined,
    actor: a.actor ? asStrArr(a.actor) : ["Agent"],
    trigger: asStrArr(a.trigger),
    triggered_event: asStrArr(a.triggered_event),
    target_objects: asStrArr(a.target_objects),
    // tool_use on disk is Array<{name}> | string[] | "" — normalize to string[].
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

export class ManifestOntologySource implements OntologySource {
  constructor(private readonly root: string = resolveModelsRoot()) {}

  private folders(): string[] {
    try {
      return fs.readdirSync(this.root).filter((f) => {
        if (f.startsWith(".")) return false;
        try {
          return fs.statSync(path.join(this.root, f)).isDirectory();
        } catch {
          return false;
        }
      });
    } catch {
      return [];
    }
  }

  private folderFor(domainId: string): string | null {
    const fl = this.folders();
    return (
      fl.find((f) => f === domainId) ??
      fl.find((f) => tenantSlugFromFolder(f) === domainId.toLowerCase()) ??
      null
    );
  }

  async listDomains() {
    return this.folders()
      .map((folder) => {
        const dir = path.join(this.root, folder);
        const actions = unwrap(readJson(pickVersioned(dir, "actions")), "actions");
        const events = unwrap(readJson(pickVersioned(dir, "events")), "events");
        const objects = unwrap(readJson(pickVersioned(dir, "objects")), "payload");
        const rules = unwrap(readJson(pickVersioned(dir, "rules")), "payload");
        const workflow = unwrap(readJson(pickVersioned(dir, "workflow")), "agents");
        return {
          id: tenantSlugFromFolder(folder),
          name: folder,
          counts: { actions: actions.length, events: events.length, objects: objects.length, rules: rules.length, workflow: workflow.length },
        };
      })
      // Hide throwaway SANDBOX tenants from the picker (`-sb`: each sandbox_run writes a new
      // workflow_vN.json — pure noise). The OTHER artifact case — a promoted workflow-only folder
      // (e.g. `agents-generation-v1`) shadowing a live Allmeta domain — is handled in the COMPOSITE
      // (Allmeta wins for a shared id), so a legit local-only 0-ontology domain still shows here.
      .filter((d) => !/-sb$/.test(d.id));
  }

  async fetchOntology(domainId: string): Promise<DomainOntology> {
    const folder = this.folderFor(domainId);
    if (!folder) throw new Error(`本体源里找不到业务域「${domainId}」——models/ 下没有匹配的目录。`);
    const dir = path.join(this.root, folder);

    let actions = unwrap(readJson(pickVersioned(dir, "actions")), "actions").map(toOntologyAction);
    // Fallback for tenants with only a workflow manifest (no actions_v*.json): derive
    // thin actions from the manifest agents (they carry id/name/actor/trigger/emit).
    if (!actions.length) {
      const agents = unwrap(readJson(pickVersioned(dir, "workflow")), "agents");
      actions = agents.map((g) => toOntologyAction(g));
    }
    if (!actions.length) throw new Error(`业务域「${domainId}」没有可用的动作定义——不生成空壳（避免幻觉）。`);

    const objects = unwrap(readJson(pickVersioned(dir, "objects")), "payload") as unknown as OntologyObject[];
    const events = unwrap(readJson(pickVersioned(dir, "events")), "events") as unknown as OntologyEvent[];
    const rules = unwrap(readJson(pickVersioned(dir, "rules")), "payload") as unknown as OntologyRule[];
    const workflow = unwrap(readJson(pickVersioned(dir, "workflow")), "agents");
    return { domainId, objects, rules, actions, events, workflow, source: "snapshot" };
  }

  async fetchActionRules(domainId: string, actionName: string): Promise<unknown[]> {
    const folder = this.folderFor(domainId);
    if (!folder) return [];
    const dir = path.join(this.root, folder);
    const actions = unwrap(readJson(pickVersioned(dir, "actions")), "actions");
    const action = actions.find((a) => a.name === actionName);
    // Preferred: rules nested under the action's steps.
    if (action && Array.isArray(action.action_steps)) {
      return (action.action_steps as Array<Record<string, unknown>>).flatMap((s) => (Array.isArray(s.rules) ? (s.rules as unknown[]) : []));
    }
    // Fallback: rules_v*.json, prefix-matched on the hierarchical id (action "3" owns "3-1"…).
    if (action?.id) {
      const rules = unwrap(readJson(pickVersioned(dir, "rules")), "payload");
      return rules.filter((r) => typeof r?.id === "string" && (r.id as string).startsWith(`${String(action.id)}-`));
    }
    return [];
  }
}
