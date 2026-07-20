-- A single global adapter can be bound with several independently reviewed
-- runtime configurations in one ontology domain.  Probe evidence is therefore
-- immutable per exact definition/config hash instead of a mutable "latest
-- receipt" slot per tool.
DROP INDEX IF EXISTS `factory_tool_probes_scope_tool_uq`;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `factory_tool_probes_scope_tool_definition_uq`
  ON `factory_tool_probes` (`tenant_id`,`domain_key`,`tool_name`,`definition_hash`);
