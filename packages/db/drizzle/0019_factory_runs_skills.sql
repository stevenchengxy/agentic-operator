CREATE TABLE `factory_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text,
	`domain` text NOT NULL,
	`goal` text NOT NULL,
	`status` text NOT NULL,
	`tokens_used` integer DEFAULT 0 NOT NULL,
	`turns` integer DEFAULT 0 NOT NULL,
	`agents_count` integer DEFAULT 0 NOT NULL,
	`reached_terminal` integer DEFAULT false NOT NULL,
	`error_message` text,
	`transcript_json` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `factory_runs_domain_idx` ON `factory_runs` (`domain`,`created_at`);
--> statement-breakpoint
CREATE TABLE `factory_skills` (
	`slug` text PRIMARY KEY NOT NULL,
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
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `factory_skills_domain_idx` ON `factory_skills` (`domain`);
