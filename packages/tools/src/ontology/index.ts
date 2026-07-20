/**
 * @agentic/tools/ontology — runtime ontology access for generated agents (rule fetch etc.).
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
