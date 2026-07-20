-- Persist the runtime Domain (tenant) ↔ ontology Domain relationship. Before
-- this migration it was inferred from labels/aliases in the browser.
CREATE TABLE `factory_domain_bindings` (
	`tenant_id` text PRIMARY KEY NOT NULL,
	`ontology_domain_id` text NOT NULL,
	`ontology_domain_name` text,
	`source` text DEFAULT 'explicit' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `factory_domain_bindings_ontology_idx` ON `factory_domain_bindings` (`ontology_domain_id`);
--> statement-breakpoint
ALTER TABLE `factory_conversations` ADD `tenant_id` text REFERENCES tenants(id) ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE `factory_reflections` ADD `tenant_id` text REFERENCES tenants(id) ON DELETE cascade;
--> statement-breakpoint
CREATE INDEX `factory_conversations_tenant_domain_idx` ON `factory_conversations` (`tenant_id`,`domain`);
--> statement-breakpoint
CREATE INDEX `factory_reflections_tenant_domain_idx` ON `factory_reflections` (`tenant_id`,`domain`);
--> statement-breakpoint
CREATE TABLE `__new_factory_skills` (
	`id` text PRIMARY KEY NOT NULL,
	`scope_key` text NOT NULL,
	`slug` text NOT NULL,
	`tenant_id` text,
	`name` text NOT NULL,
	`purpose` text NOT NULL,
	`prompt_fragment` text DEFAULT '' NOT NULL,
	`tools` text NOT NULL,
	`decision_rule` text DEFAULT '' NOT NULL,
	`domain` text,
	`use_count` integer DEFAULT 0 NOT NULL,
	`eval_count` integer DEFAULT 0 NOT NULL,
	`success_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_factory_skills` (`id`,`scope_key`,`slug`,`tenant_id`,`name`,`purpose`,`prompt_fragment`,`tools`,`decision_rule`,`domain`,`use_count`,`eval_count`,`success_count`,`created_at`,`updated_at`)
SELECT 'legacy:' || `slug`, 'legacy', `slug`, NULL, `name`,`purpose`,`prompt_fragment`,`tools`,`decision_rule`,`domain`,`use_count`,`eval_count`,`success_count`,`created_at`,`updated_at` FROM `factory_skills`;
--> statement-breakpoint
DROP TABLE `factory_skills`;
--> statement-breakpoint
ALTER TABLE `__new_factory_skills` RENAME TO `factory_skills`;
--> statement-breakpoint
CREATE UNIQUE INDEX `factory_skills_scope_slug_uq` ON `factory_skills` (`scope_key`,`slug`);
--> statement-breakpoint
CREATE INDEX `factory_skills_domain_idx` ON `factory_skills` (`domain`);
--> statement-breakpoint
CREATE INDEX `factory_skills_tenant_domain_idx` ON `factory_skills` (`tenant_id`,`domain`);
--> statement-breakpoint
CREATE TABLE `__new_factory_tools` (
	`id` text PRIMARY KEY NOT NULL,
	`scope_key` text NOT NULL,
	`name` text NOT NULL,
	`tenant_id` text,
	`description` text DEFAULT '' NOT NULL,
	`method` text DEFAULT 'GET' NOT NULL,
	`url_template` text DEFAULT '' NOT NULL,
	`headers` text,
	`body_template` text,
	`side_effect` text DEFAULT 'read' NOT NULL,
	`domain` text,
	`params_schema` text,
	`returns_schema` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_factory_tools` (`id`,`scope_key`,`name`,`tenant_id`,`description`,`method`,`url_template`,`headers`,`body_template`,`side_effect`,`domain`,`params_schema`,`returns_schema`,`created_at`,`updated_at`)
SELECT 'legacy:' || `name`, 'legacy', `name`, NULL, `description`,`method`,`url_template`,`headers`,`body_template`,`side_effect`,`domain`,`params_schema`,`returns_schema`,`created_at`,`updated_at` FROM `factory_tools`;
--> statement-breakpoint
DROP TABLE `factory_tools`;
--> statement-breakpoint
ALTER TABLE `__new_factory_tools` RENAME TO `factory_tools`;
--> statement-breakpoint
CREATE UNIQUE INDEX `factory_tools_scope_name_uq` ON `factory_tools` (`scope_key`,`name`);
--> statement-breakpoint
CREATE INDEX `factory_tools_domain_idx` ON `factory_tools` (`domain`);
--> statement-breakpoint
CREATE INDEX `factory_tools_tenant_domain_idx` ON `factory_tools` (`tenant_id`,`domain`);
--> statement-breakpoint
-- Conversation id equals run id in the current registry, which gives strong
-- ownership evidence for legacy rows.
UPDATE `factory_conversations`
SET `tenant_id` = (SELECT `tenant_id` FROM `factory_runs` WHERE `factory_runs`.`id` = `factory_conversations`.`id` LIMIT 1)
WHERE `tenant_id` IS NULL;
--> statement-breakpoint
-- Reflections/skills/tools have no reliable legacy ownership signal: the same
-- ontology domain was used from several tenants. Keep those rows quarantined
-- (tenant_id NULL / scope_key='legacy'), including old domain-NULL rows; an
-- operator must explicitly republish a row before it becomes tenant/shared.
-- Auto-bind only high-confidence legacy pairs that were actually run using the
-- tenant's own slug. Everything else is intentionally left for explicit choice.
INSERT OR IGNORE INTO `factory_domain_bindings` (`tenant_id`,`ontology_domain_id`,`ontology_domain_name`,`source`,`created_at`,`updated_at`)
SELECT t.`id`, fr.`domain`, t.`name`, 'auto', (unixepoch() * 1000), (unixepoch() * 1000)
FROM `tenants` t
JOIN `factory_runs` fr ON fr.`id` = (
	SELECT newest.`id` FROM `factory_runs` newest
	WHERE newest.`tenant_id` = t.`id` AND lower(newest.`domain`) = lower(t.`slug`)
	ORDER BY newest.`updated_at` DESC LIMIT 1
)
WHERE t.`archived_at` IS NULL AND t.`slug` NOT LIKE '%-sb' AND t.`slug` != '__system';
