ALTER TABLE `runs` ADD `request_id` text;
--> statement-breakpoint
ALTER TABLE `runs` ADD `interaction_id` text;
--> statement-breakpoint
ALTER TABLE `runs` ADD `product_surface` text;
--> statement-breakpoint
ALTER TABLE `runs` ADD `product_action` text;
--> statement-breakpoint
CREATE INDEX `runs_interaction_idx` ON `runs` (`interaction_id`);
--> statement-breakpoint
ALTER TABLE `llm_calls` ADD `billing_account_id` text;
--> statement-breakpoint
ALTER TABLE `llm_calls` ADD `provider_account_id` text;
--> statement-breakpoint
ALTER TABLE `llm_calls` ADD `actor_type` text;
--> statement-breakpoint
ALTER TABLE `llm_calls` ADD `actor_id` text;
--> statement-breakpoint
ALTER TABLE `llm_calls` ADD `credential_id` text;
--> statement-breakpoint
ALTER TABLE `llm_calls` ADD `provider_credential_id` text;
--> statement-breakpoint
ALTER TABLE `llm_calls` ADD `product` text;
--> statement-breakpoint
ALTER TABLE `llm_calls` ADD `product_surface` text;
--> statement-breakpoint
ALTER TABLE `llm_calls` ADD `product_action` text;
--> statement-breakpoint
ALTER TABLE `llm_calls` ADD `interaction_id` text;
--> statement-breakpoint
ALTER TABLE `llm_calls` ADD `function_name` text;
--> statement-breakpoint
ALTER TABLE `llm_calls` ADD `api_route` text;
--> statement-breakpoint
ALTER TABLE `llm_calls` ADD `http_method` text;
--> statement-breakpoint
ALTER TABLE `llm_calls` ADD `request_id` text;
--> statement-breakpoint
ALTER TABLE `llm_calls` ADD `correlation_id` text;
--> statement-breakpoint
ALTER TABLE `llm_calls` ADD `invocation_source` text;
--> statement-breakpoint
UPDATE `llm_calls`
SET `billing_account_id` = `tenant_id`,
    `actor_type` = 'system',
    `product` = 'agentic-operator',
    `product_surface` = coalesce(`purpose`, 'llm-gateway'),
    `product_action` = coalesce(`purpose`, 'llm.call'),
    `function_name` = coalesce(`purpose`, 'llm.call')
WHERE `billing_account_id` IS NULL;
--> statement-breakpoint
CREATE INDEX `llm_calls_account_started_idx` ON `llm_calls` (`billing_account_id`,`started_at`);
--> statement-breakpoint
CREATE INDEX `llm_calls_request_idx` ON `llm_calls` (`request_id`);
--> statement-breakpoint
CREATE INDEX `llm_calls_interaction_idx` ON `llm_calls` (`interaction_id`);
--> statement-breakpoint
CREATE TABLE `usage_events` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`schema_version` integer DEFAULT 1 NOT NULL,
	`event_type` text NOT NULL,
	`status` text NOT NULL,
	`tenant_id` text NOT NULL,
	`billing_account_id` text NOT NULL,
	`actor_type` text NOT NULL,
	`actor_id` text,
	`credential_id` text,
	`provider_credential_id` text,
	`provider_account_id` text,
	`request_id` text,
	`correlation_id` text,
	`interaction_id` text,
	`run_id` text,
	`step_id` text,
	`product` text DEFAULT 'agentic-operator' NOT NULL,
	`product_surface` text NOT NULL,
	`product_action` text NOT NULL,
	`function_name` text NOT NULL,
	`api_route` text,
	`http_method` text,
	`invocation_source` text,
	`llm_call_id` text,
	`quantity_json` text NOT NULL,
	`provider_cost_usd_nanos` integer,
	`billable_charge_usd_nanos` integer,
	`cost_liability` text NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`rate_card_version` text DEFAULT 'pass-through-v1' NOT NULL,
	`occurred_at` integer NOT NULL,
	`recorded_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`exported_at` integer,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`step_id`) REFERENCES `steps`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`llm_call_id`) REFERENCES `llm_calls`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `usage_events_id_unique` ON `usage_events` (`id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `usage_events_llm_call_uq` ON `usage_events` (`llm_call_id`);
--> statement-breakpoint
CREATE INDEX `usage_events_tenant_sequence_idx` ON `usage_events` (`tenant_id`,`sequence`);
--> statement-breakpoint
CREATE INDEX `usage_events_account_occurred_idx` ON `usage_events` (`billing_account_id`,`occurred_at`);
--> statement-breakpoint
CREATE INDEX `usage_events_export_idx` ON `usage_events` (`exported_at`,`sequence`);
--> statement-breakpoint
CREATE INDEX `usage_events_interaction_idx` ON `usage_events` (`interaction_id`);
