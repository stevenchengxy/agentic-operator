-- A runtime tenant may be rebound from ontology A to ontology B. Ownership by
-- tenant alone is therefore insufficient for same-slug/name factory assets:
-- 0031's (scope_key, slug/name) unique keys would update A's row in place when
-- B authored the same identifier. Keep nullable `domain` as display/selection
-- metadata and add a non-null conflict key because SQLite considers every NULL
-- distinct inside a UNIQUE index.
ALTER TABLE `factory_skills` ADD `domain_key` text DEFAULT '' NOT NULL;
--> statement-breakpoint
UPDATE `factory_skills` SET `domain_key` = COALESCE(`domain`, '');
--> statement-breakpoint
DROP INDEX `factory_skills_scope_slug_uq`;
--> statement-breakpoint
CREATE UNIQUE INDEX `factory_skills_scope_domain_slug_uq` ON `factory_skills` (`scope_key`,`domain_key`,`slug`);
--> statement-breakpoint
ALTER TABLE `factory_tools` ADD `domain_key` text DEFAULT '' NOT NULL;
--> statement-breakpoint
UPDATE `factory_tools` SET `domain_key` = COALESCE(`domain`, '');
--> statement-breakpoint
DROP INDEX `factory_tools_scope_name_uq`;
--> statement-breakpoint
CREATE UNIQUE INDEX `factory_tools_scope_domain_name_uq` ON `factory_tools` (`scope_key`,`domain_key`,`name`);
--> statement-breakpoint
-- Historical effectiveness rows have neither tenant nor ontology provenance.
-- Preserve them for audit, but quarantine them so they cannot influence a new
-- tenant/domain's ranking until an operator deliberately republishes evidence.
CREATE TABLE `__new_tool_stats` (
	`id` text PRIMARY KEY NOT NULL,
	`scope_key` text NOT NULL,
	`domain_key` text DEFAULT '' NOT NULL,
	`tenant_id` text,
	`tool_name` text NOT NULL,
	`invoked` integer DEFAULT 0 NOT NULL,
	`succeeded` integer DEFAULT 0 NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_tool_stats` (`id`,`scope_key`,`domain_key`,`tenant_id`,`tool_name`,`invoked`,`succeeded`,`updated_at`)
SELECT 'legacy:' || `tool_name`, 'legacy', '', NULL, `tool_name`,`invoked`,`succeeded`,`updated_at` FROM `tool_stats`;
--> statement-breakpoint
DROP TABLE `tool_stats`;
--> statement-breakpoint
ALTER TABLE `__new_tool_stats` RENAME TO `tool_stats`;
--> statement-breakpoint
CREATE UNIQUE INDEX `tool_stats_scope_domain_tool_uq` ON `tool_stats` (`scope_key`,`domain_key`,`tool_name`);
--> statement-breakpoint
CREATE INDEX `tool_stats_tenant_domain_idx` ON `tool_stats` (`tenant_id`,`domain_key`);
