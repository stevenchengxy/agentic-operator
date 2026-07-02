-- #SCALE-TOOLS — per-tool sandbox effectiveness for empirical ranking demotion.
CREATE TABLE `tool_stats` (
	`tool_name` text PRIMARY KEY NOT NULL,
	`invoked` integer DEFAULT 0 NOT NULL,
	`succeeded` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
