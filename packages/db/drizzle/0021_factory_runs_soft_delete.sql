PRAGMA foreign_keys=OFF;--> statement-breakpoint
UPDATE `factory_runs` SET `tenant_id` = (SELECT `id` FROM `tenants` ORDER BY `rowid` LIMIT 1) WHERE `tenant_id` IS NULL;--> statement-breakpoint
CREATE TABLE `__new_factory_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`domain` text NOT NULL,
	`goal` text NOT NULL,
	`status` text NOT NULL,
	`tokens_used` integer DEFAULT 0 NOT NULL,
	`turns` integer DEFAULT 0 NOT NULL,
	`agents_count` integer DEFAULT 0 NOT NULL,
	`reached_terminal` integer DEFAULT false NOT NULL,
	`error_message` text,
	`transcript_json` text,
	`deleted_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
INSERT INTO `__new_factory_runs`(`id`, `tenant_id`, `domain`, `goal`, `status`, `tokens_used`, `turns`, `agents_count`, `reached_terminal`, `error_message`, `transcript_json`, `created_at`, `updated_at`) SELECT `id`, `tenant_id`, `domain`, `goal`, `status`, `tokens_used`, `turns`, `agents_count`, `reached_terminal`, `error_message`, `transcript_json`, `created_at`, `updated_at` FROM `factory_runs`;--> statement-breakpoint
DROP TABLE `factory_runs`;--> statement-breakpoint
ALTER TABLE `__new_factory_runs` RENAME TO `factory_runs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `factory_runs_domain_idx` ON `factory_runs` (`domain`,`created_at`);--> statement-breakpoint
CREATE INDEX `factory_runs_deleted_at_idx` ON `factory_runs` (`deleted_at`);
