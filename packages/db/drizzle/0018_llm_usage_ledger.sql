ALTER TABLE `tenant_budgets` ADD `used_usd_nanos` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE `tenant_budgets` SET `used_usd_nanos` = `used_usd_month` * 10000000 WHERE `used_usd_nanos` = 0 AND `used_usd_month` > 0;
--> statement-breakpoint
CREATE TABLE `llm_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`logical_call_id` text NOT NULL,
	`tenant_id` text NOT NULL,
	`run_id` text,
	`step_id` text,
	`purpose` text,
	`provider` text NOT NULL,
	`requested_model` text NOT NULL,
	`response_model` text,
	`provider_request_id` text,
	`attempt` integer NOT NULL,
	`status` text DEFAULT 'started' NOT NULL,
	`input_tokens` integer,
	`output_tokens` integer,
	`total_tokens` integer,
	`cached_input_tokens` integer,
	`cache_write_input_tokens` integer,
	`cache_write_5m_input_tokens` integer,
	`cache_write_1h_input_tokens` integer,
	`reasoning_tokens` integer,
	`input_audio_tokens` integer,
	`output_audio_tokens` integer,
	`cost_usd_nanos` integer,
	`input_usd_nanos` integer,
	`cached_input_usd_nanos` integer,
	`cache_write_usd_nanos` integer,
	`output_usd_nanos` integer,
	`cost_source` text,
	`price_source` text,
	`price_as_of` text,
	`finish_reason` text,
	`latency_ms` integer,
	`error_code` text,
	`error_message` text,
	`usage_json` text,
	`started_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`ended_at` integer,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`step_id`) REFERENCES `steps`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `llm_calls_logical_attempt_uq` ON `llm_calls` (`logical_call_id`,`attempt`);
--> statement-breakpoint
CREATE INDEX `llm_calls_tenant_started_idx` ON `llm_calls` (`tenant_id`,`started_at`);
--> statement-breakpoint
CREATE INDEX `llm_calls_run_idx` ON `llm_calls` (`run_id`);
--> statement-breakpoint
CREATE INDEX `llm_calls_step_idx` ON `llm_calls` (`step_id`);
