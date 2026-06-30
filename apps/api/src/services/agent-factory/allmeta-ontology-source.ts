// AllmetaOntologySource — the LIVE OntologySource port backed by AllmetaOntology
// Studio's HTTP API (the "Neo4j 唯一入口" at :3500).
//
// The new monorepo originally dropped Neo4j/Allmeta and read ontology from JSON
// under models/<slug>/ (see ManifestOntologySource). This source restores the OLD
// operator's live read: a domain's objects/events/actions/rules are fetched from
// Allmeta over HTTP on every call, so a domain like "Agents-generation" is grounded
// in the REAL ontology rather than a stale local snapshot.
//
// Ported from the old operator's lib/ontology-generator/ontology-source.ts
// (allmetaList / resolveAllmetaDomainId / normalizeAllmeta* / fetchLiveOntologyStrict).
// STRICT by contract: fetchOntology throws when Allmeta is unreachable or returns
// an empty graph — the factory must not hallucinate against a stub (live-only, no
// snapshot fallback). DomainOntology.source is "allmeta".

import type {
  OntologySource,
  DomainOntology,
  OntologyAction,
  OntologyObject,
  OntologyEvent,
  OntologyRule,
} from "@agentic/agent-factory";

export interface AllmetaConfig {
  /** Studio base URL, e.g. http://localhost:3500. Empty = unconfigured. */
  baseUrl: string;
  /** Bearer token (Studio's ONTOLOGY_API_TOKEN). Empty = no auth header. */
  apiKey: string;
  /** Request timeout — generous, Studio lazy-compiles on first hit. */
  timeoutMs: number;
}

export function allmetaConfigFromEnv(): AllmetaConfig {
  return {
    baseUrl: (process.env.ALLMETA_BASE_URL ?? "").replace(/\/+$/, ""),
    apiKey: process.env.ALLMETA_API_KEY ?? "",
    timeoutMs: Number(process.env.ALLMETA_TIMEOUT_MS ?? 8000) || 8000,
  };
}

type Node = Record<string, unknown>;
export type AllmetaDomain = { id: string; name?: string };

// ── pure normalizers (exported for unit tests) ─────────────────────────────────
//
// Allmeta stores ontology data as graph NODES whose shape differs from the local
// JSON: stringified `*_json` fields, `uid`/`action_id` instead of `id`,
// `trigger_json` (consumed) on the action and no plain emitted field. These map an
// Allmeta node back to our OntologyObject/Event/Action shape.

export function parseJsonField<T>(v: unknown, fallback: T): T {
  let parsed: unknown;
  if (v == null) return fallback;
  if (typeof v === "object") parsed = v;
  else if (typeof v === "string") {
    try {
      parsed = JSON.parse(v);
    } catch {
      return fallback;
    }
  } else return fallback;
  // If the caller expects an array (fallback is `[]`) but Allmeta returned a plain
  // object, use the fallback so downstream `.map()`/`.length` never crash.
  if (Array.isArray(fallback) && !Array.isArray(parsed)) return fallback;
  return parsed as T;
}

const asArray = (v: unknown): string[] =>
  Array.isArray(v) ? (v.filter((x) => typeof x === "string") as string[]) : [];

/** Normalize an AO domain id to a comparison key (case/space/_/- insensitive). */
export const normDomainId = (s: string): string =>
  s.toLowerCase().normalize("NFKC").replace(/[\s_-]+/g, "");

export function normalizeAllmetaObject(n: Node): OntologyObject {
  return {
    id: String(n.id ?? n.uid ?? ""),
    name: String(n.name ?? n.id ?? n.uid ?? ""),
    description: typeof n.description === "string" ? n.description : undefined,
    type: typeof n.type === "string" ? n.type : undefined,
    primary_key: typeof n.primary_key === "string" ? n.primary_key : undefined,
    // Live Allmeta serializes properties as a stringified `properties` field;
    // older exports used `properties_json`. Accept either.
    properties: parseJsonField(n.properties ?? n.properties_json, [] as OntologyObject["properties"]),
  };
}

export function normalizeAllmetaEvent(n: Node): OntologyEvent {
  // Live Allmeta nests the payload as a stringified `payload` field
  // ({source_action, event_data, state_mutations}); older exports carried bare
  // `event_data_json` / `mutations_json`. Parse the envelope, fall back to bare.
  const payload = parseJsonField(n.payload, {} as Record<string, unknown>);
  const topSrc = typeof n.source_action === "string" && n.source_action ? n.source_action : null;
  const paySrc =
    typeof payload.source_action === "string" && payload.source_action ? payload.source_action : null;
  return {
    name: String(n.name ?? ""),
    description: typeof n.description === "string" ? n.description : undefined,
    payload: {
      source_action: topSrc ?? paySrc,
      event_data: Array.isArray(payload.event_data)
        ? (payload.event_data as OntologyEvent["payload"]["event_data"])
        : parseJsonField(n.event_data_json, [] as OntologyEvent["payload"]["event_data"]),
      state_mutations: Array.isArray(payload.state_mutations)
        ? (payload.state_mutations as OntologyEvent["payload"]["state_mutations"])
        : parseJsonField(n.mutations_json, [] as OntologyEvent["payload"]["state_mutations"]),
    },
  };
}

export function normalizeAllmetaAction(n: Node, emitByAction: Map<string, string[]>): OntologyAction {
  const name = String(n.name ?? "");
  // Live Allmeta serializes list/object fields as stringified `*_json` and uses
  // `trigger_json` (consumed) + `triggered_event_json` (emitted) + `actor_json`.
  // Older exports carried bare fields. Parse `*_json` first, fall back. The actor
  // parse is load-bearing: the brain filters Agent actions via actor.includes("Agent").
  const actor = asArray(parseJsonField(n.actor_json ?? n.actor, [] as string[]));
  const trigger = asArray(parseJsonField(n.trigger_json ?? n.trigger_events, [] as string[]));
  const emitted = asArray(parseJsonField(n.triggered_event_json ?? n.triggered_event, [] as string[]));
  return {
    id: String(n.id ?? n.action_id ?? ""),
    name,
    description: typeof n.description === "string" ? n.description : undefined,
    category: typeof n.category === "string" ? n.category : undefined,
    actor,
    trigger,
    // Prefer the action's own emitted list; fall back to deriving from each
    // event's source_action when the node doesn't carry it.
    triggered_event: emitted.length ? emitted : emitByAction.get(name) ?? [],
    target_objects: asArray(parseJsonField(n.target_objects_json ?? n.target_objects, [] as string[])),
    // Allmeta nodes don't carry prompts/tools (only needed to RUN, not to infer);
    // tool_use is usually empty live — the factory binds tools from the registry.
    tool_use: asArray(parseJsonField(n.tool_use_json ?? n.tool_use, [] as string[])),
    system_prompt: typeof n.system_prompt === "string" ? n.system_prompt : "",
    user_prompt: typeof n.user_prompt === "string" ? n.user_prompt : "",
    inputs: parseJsonField(n.inputs_json, [] as OntologyAction["inputs"]),
    outputs: parseJsonField(n.outputs_json, [] as OntologyAction["outputs"]),
    submission_criteria: typeof n.submission_criteria === "string" ? n.submission_criteria : undefined,
    side_effects: parseJsonField(n.side_effects_json, {} as OntologyAction["side_effects"]),
  };
}

/** Collapse same-named actions (name is the React key + Inngest slug, so it must
 *  be unique). Keep the first occurrence, preserving order. */
export function dedupeActionsByName(actions: OntologyAction[]): OntologyAction[] {
  const seen = new Set<string>();
  const out: OntologyAction[] = [];
  for (const a of actions) {
    if (seen.has(a.name)) continue;
    seen.add(a.name);
    out.push(a);
  }
  return out;
}

/** Build the action→emitted-events map from normalized events (an event names the
 *  action that emits it via payload.source_action). */
export function buildEmitByAction(events: OntologyEvent[]): Map<string, string[]> {
  const emitByAction = new Map<string, string[]>();
  for (const e of events) {
    const sa = e.payload.source_action;
    if (sa) {
      const arr = emitByAction.get(sa) ?? [];
      arr.push(e.name);
      emitByAction.set(sa, arr);
    }
  }
  return emitByAction;
}

// ── the live source ────────────────────────────────────────────────────────────

export class AllmetaOntologySource implements OntologySource {
  private readonly cfg: AllmetaConfig;
  private domainCache: { at: number; list: AllmetaDomain[]; ok: boolean } | null = null;
  /** Success cached for a minute; a failure is cached only briefly so a freshly
   *  started Studio is picked up within seconds — without hammering an 8s-timeout
   *  fetch on every /domains call while it's down. */
  private static readonly DOMAIN_TTL_OK_MS = 60_000;
  private static readonly DOMAIN_TTL_FAIL_MS = 5_000;

  constructor(cfg: AllmetaConfig = allmetaConfigFromEnv()) {
    this.cfg = cfg;
  }

  /** True when a base URL is configured — lets the composite skip this source. */
  get configured(): boolean {
    return !!this.cfg.baseUrl;
  }

  private async http(pathAndQuery: string): Promise<unknown | null> {
    if (!this.cfg.baseUrl) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs);
    try {
      const res = await fetch(`${this.cfg.baseUrl}${pathAndQuery}`, {
        headers: this.cfg.apiKey ? { Authorization: `Bearer ${this.cfg.apiKey}` } : {},
        signal: controller.signal,
        cache: "no-store",
      });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** GET /api/v1/ontology/<resource>?domain=<id>&limit=1000 → items[]. */
  private async list(resource: string, domainId: string): Promise<Node[]> {
    const body = (await this.http(
      `/api/v1/ontology/${resource}?domain=${encodeURIComponent(domainId)}&limit=1000`,
    )) as { items?: unknown[] } | null;
    return body && Array.isArray(body.items) ? (body.items as Node[]) : [];
  }

  /** All business domains Allmeta knows about (id + display name), cached. */
  private async domains(): Promise<AllmetaDomain[]> {
    if (!this.cfg.baseUrl) return [];
    const now = Date.now();
    if (this.domainCache) {
      const ttl = this.domainCache.ok
        ? AllmetaOntologySource.DOMAIN_TTL_OK_MS
        : AllmetaOntologySource.DOMAIN_TTL_FAIL_MS;
      if (now - this.domainCache.at < ttl) return this.domainCache.list;
    }
    const body = (await this.http(`/api/domains`)) as { domains?: AllmetaDomain[] } | null;
    if (!body || !Array.isArray(body.domains)) {
      // Throttle retries while down; keep the last good list if we have one.
      this.domainCache = { at: now, list: this.domainCache?.list ?? [], ok: false };
      return this.domainCache.list;
    }
    this.domainCache = { at: now, list: body.domains, ok: true };
    return body.domains;
  }

  /** Resolve an AO domain id to the canonical Allmeta id (the resource endpoints
   *  match `?domain=` case-sensitively). Returns the input unchanged when no list
   *  is available or nothing matches (fail-safe). */
  private async resolveDomainId(domainId: string): Promise<string> {
    const list = await this.domains();
    if (!list.length) return domainId;
    const want = normDomainId(domainId);
    const hit = list.find(
      (d) => normDomainId(d.id) === want || (d.name ? normDomainId(d.name) === want : false),
    );
    return hit?.id ?? domainId;
  }

  async listDomains(): Promise<Array<{ id: string; name?: string; counts?: Record<string, number> }>> {
    // No per-domain counts here: that would mean N extra round-trips. The picker
    // tolerates absent counts; the manifest source still supplies them for local
    // domains via the composite.
    return (await this.domains()).map((d) => ({ id: d.id, name: d.name }));
  }

  /** Fetch + normalize a domain's ontology from Allmeta. Returns null when the
   *  domain isn't served / the graph is empty (no actions) — fetchOntology turns
   *  that into a strict throw. */
  private async fetchLive(aoDomainId: string): Promise<DomainOntology | null> {
    const domainId = await this.resolveDomainId(aoDomainId);
    const [actionsRaw, eventsRaw] = await Promise.all([
      this.list("actions", domainId),
      this.list("events", domainId),
    ]);
    if (actionsRaw.length === 0) return null;

    const [objectsRaw, rulesRaw] = await Promise.all([
      this.list("objects", domainId),
      this.list("rules", domainId),
    ]);

    const events = eventsRaw.map(normalizeAllmetaEvent);
    const emitByAction = buildEmitByAction(events);
    return {
      domainId: aoDomainId, // keep the AO-facing id so downstream keying stays stable
      objects: objectsRaw.map(normalizeAllmetaObject),
      rules: rulesRaw as OntologyRule[],
      actions: dedupeActionsByName(actionsRaw.map((n) => normalizeAllmetaAction(n, emitByAction))),
      events,
      workflow: [], // Allmeta has no workflow resource (the factory generates it)
      source: "allmeta",
    };
  }

  /** STRICT live read — throws when Allmeta is unreachable / the domain id is
   *  wrong / the graph is empty. No snapshot fallback (the user chose live-only). */
  async fetchOntology(domainId: string): Promise<DomainOntology> {
    if (!this.cfg.baseUrl) {
      throw new Error(
        `本体读取失败：ALLMETA_BASE_URL 未配置，无法从 Allmeta 读取域「${domainId}」。`,
      );
    }
    let live: DomainOntology | null;
    try {
      live = await this.fetchLive(domainId);
    } catch (e) {
      throw new Error(
        `本体读取失败：无法从 Allmeta 读取域「${domainId}」(${(e as Error).message})。已阻断生成——不回退 snapshot。请检查 ALLMETA_BASE_URL 是否可达、域 id 是否正确、Neo4j 是否有该域本体。`,
      );
    }
    if (!live || live.actions.length === 0) {
      throw new Error(
        `本体读取失败：Allmeta 未返回域「${domainId}」的可用本体(actions=${live?.actions.length ?? 0})。已阻断生成——不回退 snapshot。请确认 ALLMETA_BASE_URL 可达、域 id 正确、Neo4j 里灌了该域本体。`,
      );
    }
    return live;
  }

  /** Action→step→Rule edges, fetched live so rule-check binds rules at run time.
   *  Preferred: the dedicated per-action rules endpoint; on any failure → []. */
  async fetchActionRules(domainId: string, actionName: string): Promise<unknown[]> {
    if (!this.cfg.baseUrl) return [];
    const id = await this.resolveDomainId(domainId);
    const body = (await this.http(
      `/api/v1/ontology/actions/${encodeURIComponent(actionName)}/rules?domain=${encodeURIComponent(id)}`,
    )) as { rules?: unknown[] } | null;
    return body && Array.isArray(body.rules) ? body.rules : [];
  }
}
