PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `__new_factory_tools` (
	`id` text PRIMARY KEY NOT NULL,
	`scope_key` text NOT NULL,
	`domain_key` text DEFAULT '' NOT NULL,
	`name` text NOT NULL,
	`tenant_id` text,
	`description` text DEFAULT '' NOT NULL,
	`method` text DEFAULT 'GET' NOT NULL,
	`url_template` text DEFAULT '' NOT NULL,
	`headers` text,
	`body_template` text,
	`request_spec` text,
	`response_spec` text,
	`examples` text,
	`side_effect` text NOT NULL CHECK (`side_effect` IN ('read','write','dual')),
	`domain` text,
	`params_schema` text,
	`returns_schema` text,
	`capabilities` text,
	`probe_status` text DEFAULT 'required' NOT NULL,
	`definition_hash` text,
	`probe_evidence` text,
	`verified_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_factory_tools` (`id`,`scope_key`,`domain_key`,`name`,`tenant_id`,`description`,`method`,`url_template`,`headers`,`body_template`,`request_spec`,`response_spec`,`examples`,`side_effect`,`domain`,`params_schema`,`returns_schema`,`capabilities`,`probe_status`,`definition_hash`,`probe_evidence`,`verified_at`,`created_at`,`updated_at`)
SELECT `id`,`scope_key`,`domain_key`,`name`,`tenant_id`,`description`,`method`,`url_template`,`headers`,`body_template`,`request_spec`,`response_spec`,`examples`,`side_effect`,`domain`,`params_schema`,`returns_schema`,`capabilities`,`probe_status`,`definition_hash`,`probe_evidence`,`verified_at`,`created_at`,`updated_at` FROM `factory_tools`;
--> statement-breakpoint
DROP TABLE `factory_tools`;
--> statement-breakpoint
ALTER TABLE `__new_factory_tools` RENAME TO `factory_tools`;
--> statement-breakpoint
CREATE UNIQUE INDEX `factory_tools_scope_domain_name_uq` ON `factory_tools` (`scope_key`,`domain_key`,`name`);
--> statement-breakpoint
CREATE INDEX `factory_tools_domain_idx` ON `factory_tools` (`domain`);
--> statement-breakpoint
CREATE INDEX `factory_tools_tenant_domain_idx` ON `factory_tools` (`tenant_id`,`domain`);
--> statement-breakpoint
PRAGMA foreign_keys=ON;
