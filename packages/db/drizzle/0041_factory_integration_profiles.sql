-- Human-confirmed, non-secret integration configuration. Environment values
-- stay server-owned; config_json stores only env variable names and ordinary
-- allowlists/runtime options scoped to one tenant + ontology domain.
CREATE TABLE IF NOT EXISTS `factory_integration_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`domain_key` text DEFAULT '' NOT NULL,
	`tool_name` text NOT NULL,
	`profile_key` text NOT NULL,
	`config_json` text NOT NULL,
	`confirmed_by` text,
	`confirmed_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `factory_integration_profiles_scope_key_uq`
	ON `factory_integration_profiles` (`tenant_id`,`domain_key`,`tool_name`,`profile_key`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `factory_integration_profiles_tenant_domain_idx`
	ON `factory_integration_profiles` (`tenant_id`,`domain_key`);
