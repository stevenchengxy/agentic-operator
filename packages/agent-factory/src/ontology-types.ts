// Ontology shape the factory reads (objects / actions / events / rules / workflow).
//
// Ported from the OLD repo's lib/ontology-generator/ontology-source.ts — ONLY the
// pure type declarations. The loaders that fetch these from Neo4j/Allmeta become the
// injected `OntologySource` port in M1-b (the new monorepo dropped Neo4j/Allmeta, so
// the live implementation reads from manifest JSON under models/<tenant>/ instead).

export type OntologyObject = {
  id: string; // label id, e.g. "Power_Station"
  name: string; // CJK display, e.g. "电站"
  description?: string;
  type?: string;
  primary_key?: string;
  properties?: Array<{ name: string; type?: string; description?: string }>;
};

export type OntologyAction = {
  id: string;
  name: string; // camelCase, e.g. "forecastOutput"
  description?: string;
  category?: string;
  actor: string[]; // ["Agent"] | ["Human"] | ...
  trigger: string[]; // consumed event names
  triggered_event: string[]; // emitted event names
  target_objects: string[];
  tool_use: string[];
  system_prompt: string;
  user_prompt: string;
  /** BUSINESS input schema (DataObject-grounded: name/type/description/source_object/
   *  required). The agent's inputs at the event level — NOT a tool's I/O (that lives
   *  in the tool library). */
  inputs?: Array<Record<string, unknown>>;
  outputs?: Array<Record<string, unknown>>;
  /** preconditions that must hold before the action runs (numbered prose). */
  submission_criteria?: string;
  side_effects?: Record<string, unknown>;
};

export type OntologyEvent = {
  name: string;
  description?: string;
  payload: {
    source_action: string | null;
    event_data: Array<{ name: string; type: string; target_object: string | null }>;
    state_mutations: Array<{
      target_object: string;
      mutation_type: string;
      impacted_properties: string[];
    }>;
  };
};

export type OntologyRule = Record<string, unknown>;
export type OntologyWorkflowItem = Record<string, unknown>;
/** A domain's workflow definitions. Modeled as a LIST (like objects/rules/
 *  actions/events) so it's counted by length, not by mere presence. */
export type OntologyWorkflow = OntologyWorkflowItem[];

export type DomainOntology = {
  domainId: string;
  objects: OntologyObject[];
  rules: OntologyRule[];
  actions: OntologyAction[];
  events: OntologyEvent[];
  workflow: OntologyWorkflow;
  source: "allmeta" | "snapshot";
  /** #AUDIT-FIX(P2-04) — 严格源(Allmeta)失败后退化到薄 manifest artifact 的标记。set 时说明
   *  本体不完整（可能缺 events/objects/rules），read_ontology 会向 AI/用户明示，禁止据此自动 publish。 */
  degraded?: { from: string; reason: string };
};
