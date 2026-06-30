CREATE TABLE `factory_conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`domain` text NOT NULL,
	`messages_json` text NOT NULL,
	`ctx_json` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `factory_conversations_domain_idx` ON `factory_conversations` (`domain`);
--> statement-breakpoint
CREATE TABLE `factory_reflections` (
	`id` text PRIMARY KEY NOT NULL,
	`domain` text NOT NULL,
	`kind` text NOT NULL,
	`summary` text NOT NULL,
	`root_cause` text,
	`lesson` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `factory_reflections_domain_idx` ON `factory_reflections` (`domain`);
