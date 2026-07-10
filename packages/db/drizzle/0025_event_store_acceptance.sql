-- #P1-1 — durable, queryable event store (mirrors every emitted inter-agent event with full payload
-- inline + causation lineage). #P1-6 — denormalized acceptance verdicts (one row per criterion/run).
CREATE TABLE `event_store` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text,
	`name` text NOT NULL,
	`subject` text,
	`source_run_id` text,
	`source_agent` text,
	`causation_id` text,
	`correlation_id` text,
	`payload_json` text,
	`ts` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `event_store_subject_idx` ON `event_store` (`subject`);--> statement-breakpoint
CREATE INDEX `event_store_causation_idx` ON `event_store` (`causation_id`);--> statement-breakpoint
CREATE INDEX `event_store_correlation_idx` ON `event_store` (`correlation_id`);--> statement-breakpoint
CREATE TABLE `acceptance_scores` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`tenant_id` text,
	`domain` text,
	`criterion_key` text NOT NULL,
	`label` text,
	`pass` integer NOT NULL,
	`detail` text,
	`computed_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `acceptance_scores_run_idx` ON `acceptance_scores` (`run_id`);--> statement-breakpoint
CREATE INDEX `acceptance_scores_domain_idx` ON `acceptance_scores` (`domain`);
