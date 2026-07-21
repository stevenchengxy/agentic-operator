/**
 * Workflow editor draft state (P3-FE-01).
 *
 * The DAG canvas reads its agents from `useDag()` — a live read of the
 * `/v1/workflows/dag` payload. To support editing without round-tripping
 * to the server on every keystroke, we maintain an in-memory
 * `WorkflowDraft`:
 *
 *   - `agents`  : map of agent.id → mutable `DraftAgent` (overrides live data)
 *   - `removed` : ids deleted in this session
 *   - `added`   : ids inserted in this session
 *
 * Pure helpers exposed here so the unit tests pin behavior:
 *
 *   - `applyDraft(agents, draft)` — merge view: returns the agents list
 *      with overrides applied + removed entries filtered out.
 *   - `toManifest(applied)`       — convert the agents list to a complete
 *      WorkflowManifest payload for the workflow draft API.
 *
 * Saving creates an immutable workflow-version revision with optimistic
 * concurrency. Publishing that saved revision is a separate operation.
 */

import type { DagAgent } from "@/lib/hooks/useAgents";
import type { AgentSpec } from "@agentic/contracts";

export type AgentActor = "Agent" | "Human";

/** Persisted free-form canvas coordinates. Execution still uses events. */
export interface CanvasPosition {
  x: number;
  y: number;
}

/**
 * The runtime schemas deliberately allow additive manifest fields. Keep the
 * editor's definition type equally open so a read/edit/write cycle never
 * strips fields introduced by a newer runtime or a tenant extension.
 */
export type CompleteAgentDefinition = AgentSpec & Record<string, unknown>;

/** A DAG projection carrying the complete source definition when editable. */
export type WorkflowDagAgent = DagAgent & {
  description?: string;
  definition?: CompleteAgentDefinition;
  position?: CanvasPosition;
  /** Only these agents may receive a factory-generated definition. */
  isDraftNew?: boolean;
};

/**
 * Sparse patch for one agent. `definition` is the lossless source of truth;
 * the scalar fields are convenient canvas/inspector projections. `null` on
 * optional manifest fields explicitly removes the field.
 */
export interface DraftAgent {
  id: string;
  title?: string;
  name?: string;
  description?: string | null;
  actor?: AgentActor;
  stage?: number;
  position?: CanvasPosition | null;
  /** Events this agent listens for (mirrors `trigger` in the manifest). */
  triggers?: string[];
  /** Events this agent emits on success (mirrors `triggered_event`). */
  emits?: string[];
  ontology_instructions?: string | null;
  user_prompt_template?: string | null;
  inputs?: unknown[] | null;
  outputs?: unknown[] | null;
  actions?: unknown[];
  tool_use?: unknown[] | null;
  provider?: string | null;
  model?: string | null;
  temperature?: number | null;
  max_tokens?: number | null;
  retries?: number | null;
  timeout_s?: number | null;
  concurrency?: unknown | null;
  /** Complete, additive manifest entry including fields unknown to this UI. */
  definition?: CompleteAgentDefinition;
}

export interface WorkflowDraft {
  agents: Record<string, DraftAgent>;
  added: Set<string>;
  removed: Set<string>;
}

export function emptyDraft(): WorkflowDraft {
  return { agents: {}, added: new Set(), removed: new Set() };
}

const hasOwn = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

function optionalField(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  if (value === null || value === undefined) delete target[key];
  else target[key] = value;
}

function definitionActor(
  definition: CompleteAgentDefinition | undefined,
  fallback: AgentActor,
): AgentActor {
  const actor = definition?.actor?.[0];
  return actor === "Human" || actor === "Agent" ? actor : fallback;
}

function stringArray(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canvasPosition(value: unknown): CanvasPosition | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as { x?: unknown; y?: unknown };
  return typeof candidate.x === "number" && typeof candidate.y === "number"
    ? { x: candidate.x, y: candidate.y }
    : undefined;
}

/** Canonical v2 location first; top-level position is read-only legacy input. */
function definitionPosition(
  definition: CompleteAgentDefinition | undefined,
): CanvasPosition | undefined {
  if (!definition) return undefined;
  const extensions = isRecord(definition.extensions)
    ? definition.extensions
    : undefined;
  const canvas = isRecord(extensions?.canvas) ? extensions.canvas : undefined;
  return (
    canvasPosition(canvas?.position) ?? canvasPosition(definition.position)
  );
}

/** Write the canonical v2 canvas location without flattening extension data. */
function patchDefinitionPosition(
  target: Record<string, unknown>,
  value: CanvasPosition | null | undefined,
): void {
  const extensions = isRecord(target.extensions)
    ? target.extensions
    : undefined;
  const canvas = isRecord(extensions?.canvas) ? extensions.canvas : undefined;

  if (value == null) {
    if (extensions && canvas && hasOwn(canvas, "position")) {
      const nextCanvas = { ...canvas };
      delete nextCanvas.position;
      target.extensions = { ...extensions, canvas: nextCanvas };
    }
    // Clearing a migrated legacy coordinate must not let the fallback revive
    // it. This is the only time the compatibility field is removed.
    delete target.position;
    return;
  }

  target.extensions = {
    ...(extensions ?? {}),
    canvas: {
      ...(canvas ?? {}),
      position: { ...value },
    },
  };
}

/** Patch only fields represented by a sparse draft, preserving everything else. */
export function patchAgentDefinition(
  original: CompleteAgentDefinition,
  patch: DraftAgent,
): CompleteAgentDefinition {
  const out: Record<string, unknown> = {
    ...(patch.definition ?? original),
  };
  out.id = patch.id;

  if (hasOwn(patch, "name")) out.name = patch.name;
  if (hasOwn(patch, "title")) out.title = patch.title;
  if (hasOwn(patch, "description")) {
    optionalField(out, "description", patch.description);
  }
  if (hasOwn(patch, "actor") && patch.actor) out.actor = [patch.actor];
  if (hasOwn(patch, "stage")) out.stage = patch.stage;
  if (hasOwn(patch, "position")) {
    patchDefinitionPosition(out, patch.position);
  }
  if (hasOwn(patch, "triggers")) out.trigger = patch.triggers ?? [];
  if (hasOwn(patch, "emits")) out.triggered_event = patch.emits ?? [];
  if (hasOwn(patch, "ontology_instructions")) {
    optionalField(out, "ontology_instructions", patch.ontology_instructions);
  }
  if (hasOwn(patch, "user_prompt_template")) {
    optionalField(out, "user_prompt_template", patch.user_prompt_template);
  }
  if (hasOwn(patch, "inputs")) optionalField(out, "inputs", patch.inputs);
  if (hasOwn(patch, "outputs")) optionalField(out, "outputs", patch.outputs);
  if (hasOwn(patch, "actions")) out.actions = patch.actions ?? [];
  if (hasOwn(patch, "tool_use")) {
    optionalField(out, "tool_use", patch.tool_use);
  }
  if (hasOwn(patch, "provider")) optionalField(out, "provider", patch.provider);
  if (hasOwn(patch, "model")) optionalField(out, "model", patch.model);
  if (hasOwn(patch, "temperature")) {
    optionalField(out, "temperature", patch.temperature);
  }
  if (hasOwn(patch, "max_tokens")) {
    optionalField(out, "max_tokens", patch.max_tokens);
  }
  if (hasOwn(patch, "retries")) optionalField(out, "retries", patch.retries);
  if (hasOwn(patch, "timeout_s")) {
    optionalField(out, "timeout_s", patch.timeout_s);
  }
  if (hasOwn(patch, "concurrency")) {
    optionalField(out, "concurrency", patch.concurrency);
  }

  return out as CompleteAgentDefinition;
}

export interface NewAgentDefinitionOptions {
  id: string;
  name?: string;
  title?: string;
  description?: string;
  triggers?: string[];
  emits?: string[];
  stage?: number;
  position?: CanvasPosition;
  actionDescription?: string;
  actionPrompt?: string;
  ontologyInstructions?: string;
  overrides?: Record<string, unknown>;
}

function camelName(id: string): string {
  const words = id.split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (words.length === 0) return "newAgent";
  return words
    .map((word, index) =>
      index === 0
        ? word.charAt(0).toLowerCase() + word.slice(1)
        : word.charAt(0).toUpperCase() + word.slice(1),
    )
    .join("");
}

function eventPrefix(id: string): string {
  const normalized = id
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
  return normalized || "AGENT";
}

/** A complete, immediately editable automated-agent definition. */
export function createAutomatedAgentDefinition(
  options: NewAgentDefinitionOptions,
): CompleteAgentDefinition {
  const name = options.name ?? camelName(options.id);
  const title = options.title ?? "New automated step";
  const prefix = eventPrefix(options.id);
  const definition = {
    ...options.overrides,
    id: options.id,
    name,
    title,
    description:
      options.description ??
      "Process the incoming workflow request and return a verified result.",
    actor: ["Agent"],
    trigger: options.triggers ?? [`${prefix}_REQUESTED`],
    actions: [
      {
        order: "1",
        name: "execute",
        description:
          options.actionDescription ??
          "Process the request and verify the result before emitting success.",
        type: "logic",
        action_prompt:
          options.actionPrompt ??
          "Use the agent instructions and supplied inputs. Do not invent missing facts. Return a concise, verifiable result.",
      },
    ],
    triggered_event: options.emits ?? [`${prefix}_COMPLETED`],
    ontology_instructions:
      options.ontologyInstructions ??
      `You are ${title}. Validate the incoming data, perform only the requested work, ` +
        "and report uncertainty or missing information explicitly.",
    generated: true,
    stage: options.stage ?? 0,
  } as CompleteAgentDefinition;
  if (options.position) patchDefinitionPosition(definition, options.position);
  return definition;
}

/** A complete human-task definition with an auditable manual action. */
export function createHumanAgentDefinition(
  options: NewAgentDefinitionOptions,
): CompleteAgentDefinition {
  const name = options.name ?? camelName(options.id);
  const title = options.title ?? "Human review";
  const prefix = eventPrefix(options.id);
  const definition = {
    ...options.overrides,
    id: options.id,
    name,
    title,
    description:
      options.description ??
      "Review the supplied evidence and record an accountable decision.",
    actor: ["Human"],
    trigger: options.triggers ?? [`${prefix}_REQUESTED`],
    actions: [
      {
        order: "1",
        name: "review",
        description:
          options.actionDescription ??
          "Review the evidence and submit a decision with rationale.",
        type: "manual",
        task_type: "approval",
        awaiting_role: "operator",
        form_schema: {
          type: "object",
          properties: {
            decision: { type: "string", enum: ["approve", "reject", "revise"] },
            rationale: { type: "string" },
          },
          required: ["decision", "rationale"],
        },
      },
    ],
    triggered_event: options.emits ?? [`${prefix}_RESOLVED`],
    generated: false,
    stage: options.stage ?? 0,
  } as CompleteAgentDefinition;
  if (options.position) patchDefinitionPosition(definition, options.position);
  return definition;
}

/**
 * Apply a draft to a base agent list. Returns the new effective list.
 * Pure — order-stable for unchanged entries.
 *
 * Agents on the canvas are keyed by `kebabId` (the manifest slug) so the
 * draft maps line up with the DAG payload's `agents[].kebabId` field.
 */
export function applyDraft(
  base: DagAgent[],
  draft: WorkflowDraft,
): WorkflowDagAgent[] {
  const out: WorkflowDagAgent[] = [];
  for (const a of base) {
    if (draft.removed.has(a.kebabId)) continue;
    const d = draft.agents[a.kebabId];
    if (d) {
      const full = a as WorkflowDagAgent;
      const sourceDefinition = d.definition ?? full.definition;
      const definition = sourceDefinition
        ? patchAgentDefinition(sourceDefinition, d)
        : undefined;
      const actor = d.actor ?? definitionActor(definition, a.actor);
      const position = hasOwn(d, "position")
        ? (d.position ?? undefined)
        : (definitionPosition(definition) ?? full.position);
      const description = hasOwn(d, "description")
        ? (d.description ?? undefined)
        : typeof definition?.description === "string"
          ? definition.description
          : full.description;
      out.push({
        ...a,
        title:
          d.title ??
          (typeof definition?.title === "string" ? definition.title : a.title),
        name:
          d.name ??
          (typeof definition?.name === "string" ? definition.name : a.name),
        description,
        actor,
        stage:
          d.stage ??
          (typeof definition?.stage === "number" ? definition.stage : a.stage),
        triggers: d.triggers ?? stringArray(definition?.trigger, a.triggers),
        emits: d.emits ?? stringArray(definition?.triggered_event, a.emits),
        ...(definition ? { definition } : {}),
        ...(position ? { position } : {}),
      });
    } else {
      out.push(a as WorkflowDagAgent);
    }
  }
  // New agents (not in `base`) appended at the end.
  for (const id of draft.added) {
    const d = draft.agents[id];
    if (!d) continue;
    if (base.some((b) => b.kebabId === id)) continue; // already present
    const seed =
      d.definition ??
      (d.actor === "Human"
        ? createHumanAgentDefinition({
            id,
            name: d.name,
            title: d.title,
            description: d.description ?? undefined,
            triggers: d.triggers,
            emits: d.emits,
            stage: d.stage,
            position: d.position ?? undefined,
          })
        : createAutomatedAgentDefinition({
            id,
            name: d.name,
            title: d.title,
            description: d.description ?? undefined,
            triggers: d.triggers,
            emits: d.emits,
            stage: d.stage,
            position: d.position ?? undefined,
          }));
    const definition = patchAgentDefinition(seed, d);
    const actor = definitionActor(definition, d.actor ?? "Agent");
    const position = definitionPosition(definition);
    out.push({
      id,
      kebabId: id,
      name: String(definition.name),
      title:
        typeof definition.title === "string"
          ? definition.title
          : String(definition.name),
      description:
        typeof definition.description === "string"
          ? definition.description
          : undefined,
      actor,
      stage: typeof definition.stage === "number" ? definition.stage : 0,
      triggers: stringArray(definition.trigger, []),
      emits: stringArray(definition.triggered_event, []),
      recentRunCount: 0,
      isLive: false,
      definition,
      ...(position ? { position } : {}),
      isDraftNew: true,
    });
  }
  return out;
}

/**
 * Build the complete WorkflowManifest agent array for the draft-save API.
 *
 * Existing nodes MUST carry their complete source definition. Failing closed
 * here is intentional: a DAG projection cannot reconstruct prompts, actions,
 * tools, runtime controls, or unknown extension fields without data loss.
 */
export class MissingAgentDefinitionError extends Error {
  constructor(agentId: string) {
    super(
      `Cannot save agent "${agentId}" because its complete manifest definition was not loaded. Refresh the workflow before saving.`,
    );
    this.name = "MissingAgentDefinitionError";
  }
}

export function toManifest(applied: DagAgent[]): CompleteAgentDefinition[] {
  return applied.map((agent) => {
    const a = agent as WorkflowDagAgent;
    let definition = a.definition;
    if (!definition) {
      if (!a.isDraftNew) throw new MissingAgentDefinitionError(a.kebabId);
      definition =
        a.actor === "Human"
          ? createHumanAgentDefinition({
              id: a.kebabId,
              name: a.name,
              title: a.title,
              description: a.description,
              triggers: a.triggers,
              emits: a.emits,
              stage: a.stage,
              position: a.position,
            })
          : createAutomatedAgentDefinition({
              id: a.kebabId,
              name: a.name,
              title: a.title,
              description: a.description,
              triggers: a.triggers,
              emits: a.emits,
              stage: a.stage,
              position: a.position,
            });
    }

    const out: CompleteAgentDefinition = { ...definition };
    // Required projection fields always track the canvas state.
    out.id = a.kebabId;
    out.name = a.name;
    out.actor = [a.actor];
    out.trigger = dedupeEvents(a.triggers);
    out.triggered_event = dedupeEvents(a.emits);

    out.title = a.title;
    out.stage = a.stage;
    // `description` is not part of every DAG projection. A cleared draft has
    // already removed it from `definition`, so absence here means preserve.
    if (a.description !== undefined) out.description = a.description;
    // A definition patched by `applyDraft` has already removed an explicitly
    // cleared position. When the projection has no position for any other
    // reason, retain the complete definition's value rather than guessing.
    if (a.position !== undefined) patchDefinitionPosition(out, a.position);
    return out;
  });
}

/** Stable event-list normalization used by connect and serialization. */
export function dedupeEvents(events: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of events) {
    const event = raw.trim();
    if (!event || seen.has(event)) continue;
    seen.add(event);
    out.push(event);
  }
  return out;
}

export interface WorkflowEventEdge {
  src: string;
  dst: string;
  event: string;
}

/**
 * Derive the visual workflow topology from the same event contract the
 * runtime uses: an edge exists when one agent emits the exact event another
 * agent listens for.
 *
 * Event names are trimmed and duplicate declarations are collapsed, but
 * casing remains significant. Runtime dispatch is case-sensitive, so making
 * the canvas more permissive than execution would display connections that
 * cannot actually run.
 */
export function deriveEventEdges(
  effectiveAgents: Array<Pick<DagAgent, "kebabId" | "triggers" | "emits">>,
): WorkflowEventEdge[] {
  const listenersByEvent = new Map<string, Array<Pick<DagAgent, "kebabId">>>();
  for (const agent of effectiveAgents) {
    for (const event of dedupeEvents(agent.triggers)) {
      const listeners = listenersByEvent.get(event) ?? [];
      listeners.push(agent);
      listenersByEvent.set(event, listeners);
    }
  }

  const edges: WorkflowEventEdge[] = [];
  const seen = new Set<string>();
  for (const source of effectiveAgents) {
    for (const event of dedupeEvents(source.emits)) {
      for (const target of listenersByEvent.get(event) ?? []) {
        const key = JSON.stringify([source.kebabId, target.kebabId, event]);
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({
          src: source.kebabId,
          dst: target.kebabId,
          event,
        });
      }
    }
  }
  return edges;
}

/** Add one complete definition to a draft without mutating the caller. */
export function addAgentToDraft(
  draft: WorkflowDraft,
  definition: CompleteAgentDefinition,
): WorkflowDraft {
  const id = definition.id;
  const actor = definitionActor(definition, "Agent");
  const nextRemoved = new Set(draft.removed);
  nextRemoved.delete(id);
  return {
    agents: {
      ...draft.agents,
      [id]: {
        id,
        definition,
        name: definition.name,
        title:
          typeof definition.title === "string"
            ? definition.title
            : definition.name,
        description:
          typeof definition.description === "string"
            ? definition.description
            : undefined,
        actor,
        stage: typeof definition.stage === "number" ? definition.stage : 0,
        position: definitionPosition(definition),
        triggers: stringArray(definition.trigger, []),
        emits: stringArray(definition.triggered_event, []),
      },
    },
    added: new Set([...draft.added, id]),
    removed: nextRemoved,
  };
}

/**
 * Apply an Agent Studio definition to an existing workflow node.
 *
 * The workflow remains the publishing boundary, so a definition saved in
 * Agent Studio returns here as a normal workflow modification. A node that
 * was already a local addition stays an addition instead of being counted
 * twice as a modification.
 */
export function mergeAgentDefinitionIntoDraft(
  draft: WorkflowDraft,
  definition: CompleteAgentDefinition,
): WorkflowDraft {
  const wasAdded = draft.added.has(definition.id);
  const next = addAgentToDraft(draft, definition);
  if (wasAdded) return next;
  const added = new Set(next.added);
  added.delete(definition.id);
  return { ...next, added };
}

/**
 * Connect two effective agents by adding one emitted/listened event. Repeated
 * connections are idempotent and preserve every other draft field.
 */
export function connectAgents(
  draft: WorkflowDraft,
  effectiveAgents: DagAgent[],
  sourceId: string,
  targetId: string,
  eventName: string,
): WorkflowDraft {
  const event = eventName.trim();
  if (!event) throw new Error("A connection requires a non-empty event name.");
  const source = effectiveAgents.find((agent) => agent.kebabId === sourceId);
  const target = effectiveAgents.find((agent) => agent.kebabId === targetId);
  if (!source) throw new Error(`Unknown source agent: ${sourceId}`);
  if (!target) throw new Error(`Unknown target agent: ${targetId}`);

  const agents = { ...draft.agents };
  const sourcePatch = agents[sourceId] ?? { id: sourceId };
  agents[sourceId] = {
    ...sourcePatch,
    id: sourceId,
    emits: dedupeEvents([...(sourcePatch.emits ?? source.emits), event]),
  };
  const targetPatch = agents[targetId] ?? { id: targetId };
  agents[targetId] = {
    ...targetPatch,
    id: targetId,
    triggers: dedupeEvents([
      ...(targetPatch.triggers ?? target.triggers),
      event,
    ]),
  };
  return {
    agents,
    added: new Set(draft.added),
    removed: new Set(draft.removed),
  };
}

/** Persist a canvas move (and optional business stage) as a sparse patch. */
export function moveAgent(
  draft: WorkflowDraft,
  agentId: string,
  position: CanvasPosition,
  stage?: number,
): WorkflowDraft {
  if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) {
    throw new Error("Canvas coordinates must be finite numbers.");
  }
  if (stage !== undefined && (!Number.isInteger(stage) || stage < 0)) {
    throw new Error("Agent stage must be a non-negative integer.");
  }
  const current = draft.agents[agentId] ?? { id: agentId };
  return {
    agents: {
      ...draft.agents,
      [agentId]: {
        ...current,
        id: agentId,
        position: { ...position },
        ...(stage === undefined ? {} : { stage }),
      },
    },
    added: new Set(draft.added),
    removed: new Set(draft.removed),
  };
}

export interface DraftCounts {
  added: number;
  modified: number;
  removed: number;
}

export function countDraftChanges(draft: WorkflowDraft): DraftCounts {
  return {
    added: draft.added.size,
    modified: Object.keys(draft.agents).filter(
      (id) => !draft.added.has(id) && !draft.removed.has(id),
    ).length,
    removed: draft.removed.size,
  };
}

// ─── localStorage persistence (UC-V11-13) ───────────────────────────────────
// Sets don't survive JSON.stringify natively; serialize to arrays + a small
// envelope that records when the draft was saved so the restore banner can
// show "from 2 hours ago". The key is namespaced by tenant + workflow slug
// (tenants share the same dev DB; we don't want a cross-tenant collision).

export interface SerializedDraft {
  v: 2;
  savedAt: number;
  /** Optimistic-concurrency anchor captured when browser editing began. */
  baseVersionId: string | null;
  agents: Record<string, DraftAgent>;
  added: string[];
  removed: string[];
}

export function serializeDraft(
  draft: WorkflowDraft,
  baseVersionId: string | null = null,
): SerializedDraft {
  return {
    v: 2,
    savedAt: Date.now(),
    baseVersionId,
    agents: draft.agents,
    added: Array.from(draft.added),
    removed: Array.from(draft.removed),
  };
}

export function deserializeDraft(serialized: SerializedDraft): WorkflowDraft {
  return {
    agents: serialized.agents,
    added: new Set(serialized.added),
    removed: new Set(serialized.removed),
  };
}

/**
 * Best-effort JSON parse + shape check. Returns `null` on any parse / shape
 * error so callers can treat invalid stored data as "no saved draft".
 */
export function tryReadSerializedDraft(raw: string): SerializedDraft | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      ((parsed as { v?: unknown }).v === 1 ||
        (parsed as { v?: unknown }).v === 2) &&
      typeof (parsed as { savedAt?: unknown }).savedAt === "number" &&
      typeof (parsed as { agents?: unknown }).agents === "object" &&
      Array.isArray((parsed as { added?: unknown }).added) &&
      Array.isArray((parsed as { removed?: unknown }).removed)
    ) {
      const candidate = parsed as Omit<
        SerializedDraft,
        "v" | "baseVersionId"
      > & {
        v: 1 | 2;
        baseVersionId?: unknown;
      };
      return {
        ...candidate,
        v: 2,
        baseVersionId:
          typeof candidate.baseVersionId === "string"
            ? candidate.baseVersionId
            : null,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/** Build the localStorage key for a given (tenant, workflow) pair. */
export function draftStorageKey(tenant: string, workflowId: string): string {
  return `workflow-draft:${tenant}:${workflowId}`;
}
