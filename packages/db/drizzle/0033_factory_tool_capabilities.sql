-- Declarative tools may satisfy Ontology integration requirements only through
-- explicit machine-readable capabilities and current probe evidence.
ALTER TABLE `factory_tools` ADD `capabilities` text;
--> statement-breakpoint
ALTER TABLE `factory_tools` ADD `probe_status` text DEFAULT 'required' NOT NULL;
--> statement-breakpoint
ALTER TABLE `factory_tools` ADD `definition_hash` text;
--> statement-breakpoint
ALTER TABLE `factory_tools` ADD `probe_evidence` text;
--> statement-breakpoint
ALTER TABLE `factory_tools` ADD `verified_at` integer;
--> statement-breakpoint
CREATE TABLE `factory_tool_probes` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`domain_key` text DEFAULT '' NOT NULL,
	`tool_name` text NOT NULL,
	`status` text DEFAULT 'required' NOT NULL,
	`definition_hash` text NOT NULL,
	`schema_hash` text,
	`evidence` text,
	`verified_at` integer,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `factory_tool_probes_scope_tool_uq` ON `factory_tool_probes` (`tenant_id`,`domain_key`,`tool_name`);
--> statement-breakpoint
CREATE INDEX `factory_tool_probes_tenant_domain_idx` ON `factory_tool_probes` (`tenant_id`,`domain_key`);
