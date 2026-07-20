ALTER TABLE `llm_calls` ADD `run_id` text REFERENCES runs(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `llm_calls` ADD `token_source` text;--> statement-breakpoint
CREATE INDEX `llm_calls_run_idx` ON `llm_calls` (`run_id`);
