// #BIZFLOW — derive the COMPLETE business-flow model (external platforms + per-agent
// reads/calls/writes/notifies + branch semantics) from what the factory already knows:
// specs (tools/trigger/emit), the ontology (side_effects.data_changes / notifications /
// event_data / optional declared `integration`), and the user's boundary classification.
//
// WHY: the ontology describes the BUSINESS world (objects/events/rules) but not the
// INTEGRATION world — nothing in the action JSON says "RoboHire parses this resume,
// MinIO stores the file, Partner PG receives the write, RAAS emits the trigger". The
// hand-drawn 6-agent flow diagram encodes exactly that missing layer. This module
// closes the gap two ways:
//   1. DECLARED — when an action carries an `integration` block (recommended ontology
//      extension: { systems: [{ name, kind, role, capability?, objects? }] }), trust it.
//   2. INFERRED — otherwise classify the agent's bound tools by name/config, lift
//      writes from side_effects.data_changes, notifications from side_effects
//      .notifications, and external event sources from entry/boundary analysis.
// Pure + deterministic (no LLM, no IO) → unit-testable; the conductor emits the model
// as a `flow.business` BrainEvent so the UI renders the business-flow diagram.

import type { GeneratedAgentSpec } from "./spec-types";
import type { DomainOntology, OntologyAction } from "./ontology-types";
import type { BoundaryEvent } from "./brain-types";
import { FAILISH } from "./contract"; // #SIMPLIFY 单一来源，别在两处维护同一正则

// #OPEN-VOCAB（内部小本体去写死）— kind/role/semantic 是工厂的【认知词汇】，不是协议：
// 已知值仅提供补全锚点与 UI 归一化视图；AI/声明方提出词表外的新词【原样保留】，绝不静默
// 归并成"最近似的格子"（那会丢信息且把认知锁死在写代码这天）。归一化只发生在消费端
// （normalizeSystemKind → UI 上色/分组），未知词优雅降级为默认渲染。
export type KnownSystemRole = "reads" | "calls" | "writes" | "notifies" | "triggers" | "consumes";
export type SystemRole = KnownSystemRole | (string & {});
export type KnownExternalSystemKind = "external_api" | "file_store" | "rulebase" | "email" | "external_platform" | "datastore" | "internal";
export type ExternalSystemKind = KnownExternalSystemKind | (string & {});

const KNOWN_KINDS: ReadonlySet<string> = new Set(["external_api", "file_store", "rulebase", "email", "external_platform", "datastore", "internal"]);
const KNOWN_ROLES: ReadonlySet<string> = new Set(["reads", "calls", "writes", "notifies", "triggers", "consumes"]);

/** UI 归一化视图：已知 kind 原样返回，未知 → "other"（消费端据此走默认渲染，原词仍在数据里）。 */
export function normalizeSystemKind(kind: string): KnownExternalSystemKind | "other" {
  return KNOWN_KINDS.has(kind) ? (kind as KnownExternalSystemKind) : "other";
}

export type ExternalSystem = {
  name: string;
  kind: ExternalSystemKind;
  /** actionNames of the agents touching this system. */
  usedBy: string[];
  roles: SystemRole[];
};

export type FlowEmitSemantic = "success" | "failure" | "park" | "external" | "terminal" | "internal";

export type FlowEmit = { event: string; semantic: FlowEmitSemantic; consumers: string[]; externalConsumer?: string };

export type FlowAgent = {
  actionName: string;
  slug: string;
  nameZh: string;
  isSubAgent: boolean;
  triggers: Array<{ event: string; external: boolean; source?: string }>;
  /** what this agent READS (file stores, rulebases, input objects). */
  reads: string[];
  /** external API calls (platform / capability). */
  calls: string[];
  /** data writes lifted from ontology side_effects.data_changes. */
  writes: Array<{ object: string; action: string }>;
  /** notifications lifted from side_effects.notifications. */
  notifies: string[];
  emits: FlowEmit[];
};

export type BusinessFlowModel = {
  domain: string;
  externals: ExternalSystem[];
  agents: FlowAgent[];
  entries: Array<{ event: string; consumers: string[] }>;
  /** #OPEN-VOCAB · Constraint Drag 仪表 — 本次推导中出现的【词表外】认知词汇（原样保留的
   *  新 kind/role）。高频出现 = 已知词表该扩了；这是"内部本体是否在勒住 AI"的监控信号。 */
  unmodeled?: { kinds: string[]; roles: string[] };
};

const PARKISH = /PARK|PENDING|RETRY|REVIEW|HOLD/i;

/** Classify one bound tool into the system it touches + the role. Pure name/config
 *  heuristics — kept deliberately simple; a declared `integration` block overrides. */
export function classifyTool(name: string): { system: string; kind: ExternalSystemKind; role: SystemRole } | null {
  const n = name.trim();
  if (!n) return null;
  if (/^(meta|viz|report|logic)\./.test(n)) return null; // internal utilities — not integrations
  if (n.startsWith("fs.")) {
    return { system: "文件收件箱 (data/)", kind: "file_store", role: /read|list|fetch/i.test(n) ? "reads" : "writes" };
  }
  if (n.startsWith("ontology.")) {
    return { system: "本体/规则库", kind: "rulebase", role: "reads" };
  }
  if (/mail|smtp|notify/i.test(n)) {
    return { system: "邮件/通知通道", kind: "email", role: "notifies" };
  }
  if (n === "http.fetch" || /^https?\./.test(n)) {
    return { system: "外部 HTTP API", kind: "external_api", role: "calls" };
  }
  if (/api$|^api|request|webhook/i.test(n)) {
    // parseResumeApi → "parseResume 外部服务" — strip the Api suffix for a readable platform label
    const stem = n.replace(/Api$/i, "").replace(/^api/i, "");
    return { system: `${stem || n} 外部服务`, kind: "external_api", role: "calls" };
  }
  return null; // unclassified → not surfaced as an external system
}

type IntegrationDecl = { name?: unknown; kind?: unknown; role?: unknown; capability?: unknown; objects?: unknown };

/** Read an action's OPTIONAL declared `integration.systems[]` (the recommended ontology
 *  extension). Malformed entries are skipped — declaration is trusted but never crashes.
 *  #OPEN-VOCAB 修订：词表外的 kind/role【原样保留】（旧版会静默归并成 external_platform/calls，
 *  丢掉"消息队列/审批流"这类新型集成的真实身份）；只有空值才落默认。 */
function declaredSystems(action: OntologyAction | undefined): Array<{ system: string; kind: ExternalSystemKind; role: SystemRole; capability?: string }> {
  const integ = (action as unknown as { integration?: { systems?: IntegrationDecl[] } } | undefined)?.integration;
  if (!integ || !Array.isArray(integ.systems)) return [];
  const out: Array<{ system: string; kind: ExternalSystemKind; role: SystemRole; capability?: string }> = [];
  for (const s of integ.systems) {
    const name = typeof s?.name === "string" ? s.name.trim() : "";
    if (!name) continue;
    const kind = (typeof s.kind === "string" && s.kind.trim()) || "external_platform";
    const role = (typeof s.role === "string" && s.role.trim()) || "calls";
    out.push({ system: name, kind, role, capability: typeof s?.capability === "string" ? s.capability : undefined });
  }
  return out;
}

/** Lift writes from the ontology's side_effects.data_changes (object + CREATE/MODIFY). */
function writesOf(action: OntologyAction | undefined): Array<{ object: string; action: string }> {
  const se = action?.side_effects as { data_changes?: Array<{ object_type?: unknown; action?: unknown }> } | undefined;
  if (!se || !Array.isArray(se.data_changes)) return [];
  return se.data_changes
    .map((d) => ({ object: String(d?.object_type ?? "").trim(), action: String(d?.action ?? "WRITE").trim() }))
    .filter((d) => d.object);
}

/** Lift notification side effects (recipient · channel). */
function notifiesOf(action: OntologyAction | undefined): string[] {
  const se = action?.side_effects as { notifications?: Array<{ recipient?: unknown; channel?: unknown }> } | undefined;
  if (!se || !Array.isArray(se.notifications)) return [];
  return se.notifications
    .map((n) => [n?.recipient, n?.channel].filter(Boolean).map(String).join(" · "))
    .filter(Boolean);
}

function emitSemantic(event: string, consumers: string[], boundary: Map<string, BoundaryEvent>): FlowEmitSemantic {
  const b = boundary.get(event);
  if (b?.kind === "external") return "external";
  if (FAILISH.test(event)) return "failure";
  if (PARKISH.test(event)) return "park";
  if (b?.kind === "terminal") return "terminal";
  if (!consumers.length) return "terminal";
  return consumers.length ? "internal" : "terminal";
}

/** Derive the full business-flow model. */
export function deriveBusinessFlow(
  specs: GeneratedAgentSpec[],
  ontology: DomainOntology | null,
  boundaryEvents?: BoundaryEvent[],
): BusinessFlowModel {
  const actionByName = new Map<string, OntologyAction>((ontology?.actions ?? []).map((a) => [a.name, a]));
  const boundary = new Map<string, BoundaryEvent>((boundaryEvents ?? []).map((b) => [b.event, b]));
  // DECLARED event sources: actions may carry integration.event_sources = { EVENT: "RAAS/HSM" }
  // (which platform/human step produces the event). Boundary classification still wins.
  const eventSources = new Map<string, string>();
  for (const a of ontology?.actions ?? []) {
    const es = (a as unknown as { integration?: { event_sources?: Record<string, unknown> } }).integration?.event_sources;
    if (es && typeof es === "object") {
      for (const [ev, src] of Object.entries(es)) if (typeof src === "string" && src.trim()) eventSources.set(ev, src.trim());
    }
  }
  const consumersOf = (event: string) => specs.filter((s) => (s.trigger ?? []).includes(event)).map((s) => s.actionName);
  const producedEvents = new Set(specs.flatMap((s) => s.emit ?? []));

  // accumulate the external-system catalog as agents touch systems
  const systems = new Map<string, ExternalSystem>();
  const touch = (system: string, kind: ExternalSystemKind, role: SystemRole, by: string) => {
    const cur = systems.get(system) ?? { name: system, kind, usedBy: [], roles: [] };
    if (!cur.usedBy.includes(by)) cur.usedBy.push(by);
    if (!cur.roles.includes(role)) cur.roles.push(role);
    systems.set(system, cur);
  };

  const agents: FlowAgent[] = specs.map((s) => {
    const action = actionByName.get(s.actionName);
    const declared = declaredSystems(action);
    const reads: string[] = [];
    const calls: string[] = [];
    const notifies: string[] = notifiesOf(action);
    if (declared.length) {
      // 1. DECLARED integration wins
      for (const d of declared) {
        touch(d.system, d.kind, d.role, s.actionName);
        const label = d.capability ? `${d.system} · ${d.capability}` : d.system;
        if (d.role === "reads") reads.push(label);
        else if (d.role === "writes") { /* merged with ontology writes below */ }
        else if (d.role === "notifies") notifies.push(label);
        else calls.push(label);
      }
    } else {
      // 2. INFERRED from bound tools
      for (const t of s.tools ?? []) {
        const c = classifyTool(t);
        if (!c) continue;
        touch(c.system, c.kind, c.role, s.actionName);
        if (c.role === "reads") reads.push(`${c.system} · ${t}`);
        else if (c.role === "notifies") notifies.push(`${c.system} · ${t}`);
        else if (c.role === "calls") calls.push(`${c.system} · ${t}`);
        else if (c.role === "writes") reads.includes(t) || calls.push(`${c.system} · ${t}`);
      }
    }
    const writes = writesOf(action);

    const triggers = (s.trigger ?? []).map((event) => {
      const external = !producedEvents.has(event); // nobody in this workflow emits it → external source
      // source attribution precedence: user's boundary classification > declared event_sources > generic
      const source = boundary.get(event)?.consumer || eventSources.get(event) || undefined;
      if (external) touch(source || "外部业务系统", "external_platform", "triggers", s.actionName);
      return { event, external, source: external ? source : undefined };
    });

    const emits: FlowEmit[] = (s.emit ?? []).filter((e) => e && e !== "—").map((event) => {
      const consumers = consumersOf(event);
      const semantic = emitSemantic(event, consumers, boundary);
      const b = boundary.get(event);
      if (semantic === "external" && b?.consumer) touch(b.consumer, "external_platform", "consumes", s.actionName);
      return { event, semantic, consumers, externalConsumer: b?.consumer };
    });

    return {
      actionName: s.actionName,
      slug: s.slug,
      nameZh: s.nameZh,
      isSubAgent: s.isSubAgent === true,
      triggers,
      reads,
      calls,
      writes,
      notifies,
      emits,
    };
  });

  const entries = [...new Set(specs.flatMap((s) => s.trigger ?? []).filter((e) => !producedEvents.has(e)))].map((event) => ({
    event,
    consumers: consumersOf(event),
  }));

  // #OPEN-VOCAB — 词表外新词清点（去重）：作为 Constraint Drag 信号随模型下发。
  const allSystems = [...systems.values()];
  const unmodeledKinds = [...new Set(allSystems.map((x) => x.kind).filter((k) => !KNOWN_KINDS.has(k)))];
  const unmodeledRoles = [...new Set(allSystems.flatMap((x) => x.roles).filter((r) => !KNOWN_ROLES.has(r)))];

  return {
    domain: ontology?.domainId ?? "",
    externals: allSystems,
    agents,
    entries,
    ...(unmodeledKinds.length || unmodeledRoles.length ? { unmodeled: { kinds: unmodeledKinds, roles: unmodeledRoles } } : {}),
  };
}
