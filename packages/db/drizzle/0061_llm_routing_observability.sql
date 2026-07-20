ALTER TABLE `llm_calls` ADD `requested_route` text;
--> statement-breakpoint
ALTER TABLE `llm_calls` ADD `effective_route` text;
--> statement-breakpoint
ALTER TABLE `llm_calls` ADD `gateway_instance_id` text;
--> statement-breakpoint
ALTER TABLE `llm_calls` ADD `gateway_kind` text;
--> statement-breakpoint
ALTER TABLE `llm_calls` ADD `model_family` text;
--> statement-breakpoint
ALTER TABLE `llm_calls` ADD `task_type` text;
--> statement-breakpoint
ALTER TABLE `llm_calls` ADD `matched_task_type` text;
--> statement-breakpoint
ALTER TABLE `llm_calls` ADD `routing_profile_id` text;
--> statement-breakpoint
ALTER TABLE `llm_calls` ADD `routing_revision` integer;
--> statement-breakpoint
ALTER TABLE `llm_calls` ADD `resolution_reason` text;
--> statement-breakpoint
ALTER TABLE `llm_calls` ADD `fallback_index` integer;
--> statement-breakpoint
ALTER TABLE `llm_calls` ADD `transport` text;
--> statement-breakpoint
ALTER TABLE `llm_calls` ADD `effective_timeout_ms` integer;
--> statement-breakpoint
ALTER TABLE `llm_calls` ADD `overall_deadline_ms` integer;
--> statement-breakpoint
ALTER TABLE `llm_calls` ADD `controls_json` text;
--> statement-breakpoint
ALTER TABLE `llm_calls` ADD `retry_reason` text;
--> statement-breakpoint
UPDATE `llm_calls`
SET `requested_route` = `provider` || '/' || `requested_model`,
    `effective_route` = `provider` || '/' || coalesce(`response_model`, `requested_model`),
    `gateway_instance_id` = `provider`,
    `gateway_kind` = CASE
      WHEN `provider` = 'openrouter' THEN 'openrouter'
      WHEN `provider` = 'custom' THEN 'openai-compatible'
      WHEN `provider` = 'mock' THEN 'mock'
      ELSE 'direct'
    END,
    `resolution_reason` = 'legacy',
    `fallback_index` = 0
WHERE `requested_route` IS NULL;
--> statement-breakpoint
CREATE INDEX `llm_calls_task_started_idx` ON `llm_calls` (`tenant_id`,`task_type`,`started_at`);
--> statement-breakpoint
CREATE INDEX `llm_calls_gateway_started_idx` ON `llm_calls` (`tenant_id`,`gateway_instance_id`,`started_at`);
