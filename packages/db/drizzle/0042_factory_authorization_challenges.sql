-- Bind integration profiles to the exact definition/config and authorization
-- protocol that a human reviewed. Legacy rows remain inspectable but carry
-- protocol 0 / empty digests, so design/preflight/sandbox fail them closed.
ALTER TABLE `factory_integration_profiles` ADD `tool_definition_digest` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `factory_integration_profiles` ADD `config_digest` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `factory_integration_profiles` ADD `authorization_protocol_version` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `factory_integration_profiles_confirmed_by_insert`
BEFORE INSERT ON `factory_integration_profiles`
WHEN NEW.`confirmed_by` IS NULL OR trim(NEW.`confirmed_by`) = ''
BEGIN
	SELECT RAISE(ABORT, 'factory integration profile requires confirmed_by');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `factory_integration_profiles_confirmed_by_update`
BEFORE UPDATE OF `confirmed_by` ON `factory_integration_profiles`
WHEN NEW.`confirmed_by` IS NULL OR trim(NEW.`confirmed_by`) = ''
BEGIN
	SELECT RAISE(ABORT, 'factory integration profile requires confirmed_by');
END;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `factory_authorization_challenges` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`domain_key` text NOT NULL,
	`kind` text NOT NULL,
	`protocol_version` integer NOT NULL,
	`digest` text NOT NULL,
	`subject_digest` text NOT NULL,
	`token_digest` text NOT NULL,
	`question` text NOT NULL,
	`context` text NOT NULL,
	`options_json` text NOT NULL,
	`run_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`answered_by` text,
	`answered_at` integer,
	`consumed_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `factory_authorization_challenges_scope_digest_uq`
	ON `factory_authorization_challenges` (`tenant_id`,`domain_key`,`kind`,`digest`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `factory_authorization_challenges_conversation_idx`
	ON `factory_authorization_challenges` (`tenant_id`,`domain_key`,`conversation_id`);
