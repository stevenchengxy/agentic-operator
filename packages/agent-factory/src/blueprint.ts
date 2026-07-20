// Ontology-grounded workflow / business-flow / agent blueprint.
//
// Pure + deterministic (no LLM, no IO). An AI planner proposes phases and
// steps; THIS module is the grounding gate: every phase and every step must
// cite at least one ontology anchor (entity / action / rule / event) whose id
// actually exists in the authoritative ontology. Anything that cannot be
// grounded is moved to `unresolved` and never silently invented — the same
// fail-closed contract the rest of the factory uses for evidence.

export type OntologyAnchorKind = "entity" | "action" | "rule" | "event";

export interface OntologyAnchor {
  kind: OntologyAnchorKind;
  /** The exact ontology id (object/action/rule/event). Grounding verifies it. */
  id: string;
  /** Short human evidence: why this element points at this anchor. */
  evidence?: string;
}

export interface BlueprintStep {
  label: string;
  /** Optional generated-agent / actor name that performs this step. */
  agent?: string;
  reads?: string[];
  writes?: string[];
  emits?: string[];
  anchors: OntologyAnchor[];
}

export interface BlueprintPhase {
  id: string;
  title: string;
  intent?: string;
  steps: BlueprintStep[];
  anchors: OntologyAnchor[];
  /** #BLUEPRINT — the reasoning kernel's per-phase deliberation (cot/reflection …), streamed live as
   * a reasoning.step and kept here as the visible "一步step细化" narrative for this phase. */
  deliberation?: string;
}

export type DiagramKind = "phase-flow" | "sequence" | "swimlane" | "mermaid" | "html";

export interface BlueprintDiagram {
  kind: DiagramKind;
  title: string;
  /** Deterministic pre-rendered SVG (or self-contained HTML) bytes. */
  svg?: string;
  /** Optional diagram source (e.g. mermaid text) for audit/debug. */
  source?: string;
  /** Why the AI chose this diagram kind — itself ontology-grounded. */
  rationale?: string;
}

export interface BlueprintModel {
  domain: string;
  /** Authoritative ontology content signature bound at build time. */
  ontologySig?: string;
  phases: BlueprintPhase[];
  diagrams: BlueprintDiagram[];
  /** Elements dropped because no anchor resolved against the ontology. */
  unresolved: BlueprintUnresolved[];
}

export interface BlueprintUnresolved {
  scope: "phase" | "step";
  ref: string;
  reason: string;
  /** The anchors that were cited but did not resolve. */
  citedAnchors: OntologyAnchor[];
}

/** Structural view of the ontology needed for grounding. Kept minimal so the
 * blueprint module does not couple to the full ontology type. */
export interface OntologyGroundingSource {
  objects?: Array<{ id?: string; name?: string }>;
  actions?: Array<{ id?: string; name?: string }>;
  rules?: Array<{ id?: string; name?: string }>;
  events?: Array<{ id?: string; name?: string }>;
}

export interface OntologyAnchorIndex {
  entity: Set<string>;
  action: Set<string>;
  rule: Set<string>;
  event: Set<string>;
}

const normalize = (value: unknown): string =>
  typeof value === "string" ? value.normalize("NFKC").trim() : "";

function collectIds(items: Array<{ id?: string; name?: string }> | undefined): Set<string> {
  const set = new Set<string>();
  for (const item of items ?? []) {
    const id = normalize(item?.id);
    const name = normalize(item?.name);
    if (id) set.add(id);
    // Anchors may cite either the label id or the display name; both are the
    // ontology's own identifiers, so accept either as valid evidence.
    if (name) set.add(name);
  }
  return set;
}

export function buildOntologyAnchorIndex(source: OntologyGroundingSource): OntologyAnchorIndex {
  return {
    entity: collectIds(source.objects),
    action: collectIds(source.actions),
    rule: collectIds(source.rules),
    event: collectIds(source.events),
  };
}

/** An anchor resolves only if its id exists in the ontology for its kind. */
export function anchorResolves(anchor: OntologyAnchor, index: OntologyAnchorIndex): boolean {
  const id = normalize(anchor.id);
  if (!id) return false;
  return index[anchor.kind]?.has(id) ?? false;
}

function resolvedAnchors(anchors: OntologyAnchor[], index: OntologyAnchorIndex): OntologyAnchor[] {
  return anchors.filter((anchor) => anchorResolves(anchor, index));
}

/** Keep only the reads/writes/emits values that exist in the ontology (entity ids
 * for reads/writes, event ids for emits). A fabricated id is silently dropped —
 * the same fail-closed contract the anchors use: rendered detail is ontology-true. */
function groundRefs(values: string[] | undefined, index: Set<string>): string[] | undefined {
  if (!Array.isArray(values)) return undefined;
  const kept = values.map((v) => normalize(v)).filter((v) => v && index.has(v));
  return kept.length ? [...new Set(kept)] : undefined;
}

export interface BlueprintProposal {
  domain: string;
  ontologySig?: string;
  phases: BlueprintPhase[];
  diagrams?: BlueprintDiagram[];
}

/**
 * Ground an AI-proposed blueprint against the ontology. A phase survives only
 * if it has ≥1 resolving anchor AND ≥1 surviving step; a step survives only if
 * it has ≥1 resolving anchor. Everything else is recorded in `unresolved`.
 * Diagrams are carried through as-is (their content is grounded upstream by the
 * phases/steps they render).
 */
export function groundBlueprint(
  proposal: BlueprintProposal,
  index: OntologyAnchorIndex,
): BlueprintModel {
  const unresolved: BlueprintUnresolved[] = [];
  const phases: BlueprintPhase[] = [];

  for (const phase of proposal.phases) {
    const phaseAnchors = resolvedAnchors(phase.anchors ?? [], index);
    const steps: BlueprintStep[] = [];
    for (const step of phase.steps ?? []) {
      const stepAnchors = resolvedAnchors(step.anchors ?? [], index);
      if (stepAnchors.length === 0) {
        unresolved.push({
          scope: "step",
          ref: `${phase.id}/${step.label}`,
          reason: "步骤没有任何可在本体中解析的锚点（entity/action/rule/event）",
          citedAnchors: step.anchors ?? [],
        });
        continue;
      }
      steps.push({
        ...step,
        anchors: stepAnchors,
        reads: groundRefs(step.reads, index.entity),
        writes: groundRefs(step.writes, index.entity),
        emits: groundRefs(step.emits, index.event),
      });
    }
    if (phaseAnchors.length === 0) {
      unresolved.push({
        scope: "phase",
        ref: phase.id,
        reason: "阶段没有任何可在本体中解析的锚点",
        citedAnchors: phase.anchors ?? [],
      });
      continue;
    }
    if (steps.length === 0) {
      unresolved.push({
        scope: "phase",
        ref: phase.id,
        reason: "阶段的所有步骤都无法接地，阶段被整体丢弃",
        citedAnchors: phase.anchors ?? [],
      });
      continue;
    }
    phases.push({ ...phase, anchors: phaseAnchors, steps });
  }

  return {
    domain: proposal.domain,
    ontologySig: proposal.ontologySig,
    phases,
    diagrams: proposal.diagrams ?? [],
    unresolved,
  };
}

/** A blueprint is deliverable only when at least one phase grounded. Callers
 * surface `unresolved` to the human rather than pretending coverage. */
export function blueprintIsGrounded(model: BlueprintModel): boolean {
  return model.phases.length > 0;
}
