CREATE TABLE `factory_sandbox_model_grants` (
	`attempt_id` text PRIMARY KEY NOT NULL,
	`bundle_hash` text NOT NULL,
	`tenant_id` text NOT NULL,
	`tenant_slug` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`max_calls` integer NOT NULL,
	`calls` integer DEFAULT 0 NOT NULL,
	`max_total_tokens` integer NOT NULL,
	`reserved_total_tokens` integer DEFAULT 0 NOT NULL,
	`measured_input_tokens` integer DEFAULT 0 NOT NULL,
	`measured_output_tokens` integer DEFAULT 0 NOT NULL,
	`unmeasured_usage_calls` integer DEFAULT 0 NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	CONSTRAINT `factory_sandbox_model_grants_status_check` CHECK (`status` IN ('active','revoked')),
	CONSTRAINT `factory_sandbox_model_grants_max_calls_check` CHECK (`max_calls` >= 1 AND `max_calls` <= 1024),
	CONSTRAINT `factory_sandbox_model_grants_calls_check` CHECK (`calls` >= 0 AND `calls` <= `max_calls`),
	CONSTRAINT `factory_sandbox_model_grants_max_total_tokens_check` CHECK (`max_total_tokens` >= 1 AND `max_total_tokens` <= 100000000),
	CONSTRAINT `factory_sandbox_model_grants_reserved_total_tokens_check` CHECK (`reserved_total_tokens` >= 0 AND `reserved_total_tokens` <= `max_total_tokens`),
	CONSTRAINT `factory_sandbox_model_grants_measured_input_tokens_check` CHECK (`measured_input_tokens` >= 0),
	CONSTRAINT `factory_sandbox_model_grants_measured_output_tokens_check` CHECK (`measured_output_tokens` >= 0),
	CONSTRAINT `factory_sandbox_model_grants_unmeasured_usage_calls_check` CHECK (`unmeasured_usage_calls` >= 0 AND `unmeasured_usage_calls` <= `calls`)
);
--> statement-breakpoint
CREATE INDEX `factory_sandbox_model_grants_active_expiry_idx` ON `factory_sandbox_model_grants` (`status`,`expires_at`);
--> statement-breakpoint
CREATE INDEX `factory_sandbox_model_grants_tenant_idx` ON `factory_sandbox_model_grants` (`tenant_id`,`tenant_slug`);
--> statement-breakpoint
CREATE TABLE `factory_sandbox_model_call_usage` (
	`id` text PRIMARY KEY NOT NULL,
	`attempt_id` text NOT NULL,
	`bundle_hash` text NOT NULL,
	`call_ordinal` integer,
	`status` text NOT NULL,
	`agent_ref` text NOT NULL,
	`reason_code` text,
	`provider` text,
	`model` text,
	`tokens_in` integer,
	`tokens_out` integer,
	`total_tokens` integer,
	`created_at` integer NOT NULL,
	`completed_at` integer NOT NULL,
	FOREIGN KEY (`attempt_id`) REFERENCES `factory_sandbox_model_grants`(`attempt_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `factory_sandbox_model_call_usage_status_check` CHECK (`status` IN ('succeeded','failed','rejected')),
	CONSTRAINT `factory_sandbox_model_call_usage_ordinal_check` CHECK (`call_ordinal` IS NULL OR `call_ordinal` >= 1),
	CONSTRAINT `factory_sandbox_model_call_usage_tokens_in_check` CHECK (`tokens_in` IS NULL OR `tokens_in` >= 0),
	CONSTRAINT `factory_sandbox_model_call_usage_tokens_out_check` CHECK (`tokens_out` IS NULL OR `tokens_out` >= 0),
	CONSTRAINT `factory_sandbox_model_call_usage_total_check` CHECK (`total_tokens` IS NULL OR `total_tokens` >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `factory_sandbox_model_call_usage_attempt_ordinal_uq` ON `factory_sandbox_model_call_usage` (`attempt_id`,`call_ordinal`);
--> statement-breakpoint
CREATE INDEX `factory_sandbox_model_call_usage_attempt_bundle_idx` ON `factory_sandbox_model_call_usage` (`attempt_id`,`bundle_hash`);
