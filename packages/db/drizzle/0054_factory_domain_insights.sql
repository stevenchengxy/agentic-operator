CREATE TABLE `factory_domain_insights` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`domain` text NOT NULL,
	`ontology_sig` text NOT NULL,
	`mode` text NOT NULL,
	`digest` text NOT NULL,
	`coverage_json` text,
	`perspectives_json` text,
	`ambiguity_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `factory_domain_insights_tenant_domain_sig_uq` ON `factory_domain_insights` (`tenant_id`,`domain`,`ontology_sig`);
--> statement-breakpoint
CREATE INDEX `factory_domain_insights_tenant_domain_idx` ON `factory_domain_insights` (`tenant_id`,`domain`);
