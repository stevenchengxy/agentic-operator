CREATE TABLE `factory_tools` (
	`name` text PRIMARY KEY NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`method` text DEFAULT 'GET' NOT NULL,
	`url_template` text DEFAULT '' NOT NULL,
	`headers` text,
	`body_template` text,
	`side_effect` text DEFAULT 'read' NOT NULL,
	`domain` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `factory_tools_domain_idx` ON `factory_tools` (`domain`);
