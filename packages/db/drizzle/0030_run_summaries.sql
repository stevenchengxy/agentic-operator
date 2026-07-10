-- #W2 — cached AI summary of a PRODUCTION run. One row per run (run_id PK):
-- a natural-language narrative of what happened, business details on success,
-- or problem + likely-cause guesses on failure. Generated lazily on first open
-- and cached here so re-opening a run doesn't re-spend tokens; regenerate
-- upserts. run_id FK cascade cleans it up on run delete/purge.
CREATE TABLE `run_summaries` (
	`run_id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`summary_json` text NOT NULL,
	`model` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `run_summaries_tenant_idx` ON `run_summaries` (`tenant_id`,`created_at`);
