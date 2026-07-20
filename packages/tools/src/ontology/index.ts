/**
 * @agentic/tools/ontology — runtime ontology access for generated agents
 * (rule fetch, instance writes, read-only graph queries).
 */
export { fetchActionRules } from "./fetch-action-rules";
export {
  ontologyWriteInstance,
  ontologyWriteInstanceWriteProbeLifecycle,
  ONTOLOGY_WRITE_INSTANCE_PROBE_SAFETY,
  writeAllmetaInstance,
  normalizeAllmetaObjectSchema,
  validateInstanceAgainstSchema,
  OntologyWriteInstanceError,
  type OntologyWriteInstanceOptions,
  type OntologyWriteInstanceContext,
} from "./write-instance";
export { ontologyQuery, buildOntologyQuery } from "./query";
export type { OntologyOperation } from "./query";
